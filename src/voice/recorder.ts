//! Transcript recording: the passages Whisper hears while a recording runs go
//! to its file one line at a time, split into contributions by `Turns`. A
//! passage belongs to the recording that ran when its speech ended, so a
//! stopping recording still takes its own passages after a new one starts. A
//! stop cuts the passage in progress, so what was said before it is written.
import { TranscriptFile } from "./transcript";
import { Turns, speakerDash } from "./turns";
import type { Tuning } from "./tuning";
import type { Utterance } from "./session";

export type RecordingState = "running" | "paused" | "stopping" | "closed";
export type Recording = {
  /** The resolved file path. */
  path: string;
  state: RecordingState;
  /** When it was last paused (ms): speech that began earlier is not after the resume. */
  paused_at: number;
  /** When it ran (ms), from start or resume to pause or stop; the last one is
   * open while it runs. A passage belongs to it when its speech ended in one. */
  spans: { from: number; to: number | null }[];
  /** Contribution breaks, and the contributions the reading view shows. */
  turns: Turns;
  /** Passages claimed by this recording, not yet written or given up. */
  pending: Set<Utterance>;
  /** Called once `pending` empties, by a stop waiting for it. */
  drained: (() => void)[];
  file: TranscriptFile;
  /** Once stopping: when it stopped, and what settles when the file is closed,
   * with the passages left out. */
  stopped_at: number;
  done: Promise<{ path: string; late: number }> | null;
  late: number;
};
export type Notice = { at: number; kind: "info" | "error"; text: string };

/** How many notices the history keeps. */
const max_notices = 200;
/** How long a stop waits for the passages still being transcribed before it
 * closes the file without them. */
export const stop_wait_ms = 10_000;

/** The OS message of a file error, without the stack. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Recorder {
  /** The recording that is running or paused. */
  current: Recording | null = null;
  /** Stopped recordings still waiting for their passages. */
  stopping = new Set<Recording>();
  /** Why the last recording could not start or stopped writing. */
  error: string | null = null;
  notices: Notice[] = [];
  private listeners: (() => void)[] = [];
  constructor(
    private deps: {
      tuning: Tuning;
      now: () => number;
      log?: (line: string) => void;
      /** A recording began (true), or the current one ended (false): stopped, or closed by a write error. */
      active?: (on: boolean) => void;
    },
  ) {}
  /** `fn` runs after a recording starts, pauses, resumes, stops or closes. */
  on(_event: "change", fn: () => void): void {
    this.listeners.push(fn);
  }
  private changed(): void {
    for (const fn of this.listeners) fn();
  }
  /** Adds a line to the history. */
  notice(kind: Notice["kind"], text: string): void {
    this.notices.push({ at: this.deps.now(), kind, text });
    if (this.notices.length > max_notices) this.notices.splice(0, this.notices.length - max_notices);
  }
  /** Opens `path` for appending and starts recording into it; an open error
   * changes nothing and is returned. */
  start(path: string): { path: string } | { error: string } {
    if (this.current) return this.refuse(path, "a recording is already running");
    // Two writers on one file would get its blank lines wrong.
    for (const r of this.stopping)
      if (r.path === path) return this.refuse(path, "this file is still being finished; try again in a moment");
    let file: TranscriptFile;
    try {
      file = TranscriptFile.open(path);
    } catch (error) {
      return this.refuse(path, message(error));
    }
    this.current = {
      path,
      state: "running",
      paused_at: 0,
      spans: [{ from: this.deps.now(), to: null }],
      turns: new Turns(this.deps.tuning.pause_break),
      pending: new Set(),
      drained: [],
      file,
      stopped_at: 0,
      done: null,
      late: 0,
    };
    this.error = null;
    this.deps.tuning.begin();
    this.deps.log?.(`recording: started ${path}`);
    this.notice("info", `recording started: ${path}`);
    this.deps.active?.(true);
    this.changed();
    return { path };
  }
  private refuse(path: string, why: string): { error: string } {
    this.error = why;
    this.deps.log?.(`recording: cannot start ${path}: ${why}`);
    this.notice("error", `recording not started: ${why}`);
    return { error: why };
  }
  pause(): void {
    const r = this.current;
    if (r?.state !== "running") return;
    r.state = "paused";
    r.paused_at = this.deps.now();
    this.endSpan(r, r.paused_at);
    this.reserve(r);
    this.deps.log?.(`recording: paused ${r.path}`);
    this.notice("info", "paused");
    this.changed();
  }
  /** Back into the same file; the first passage spoken since the pause starts
   * a contribution. */
  resume(): void {
    const r = this.current;
    if (r?.state !== "paused") return;
    r.state = "running";
    r.spans.push({ from: this.deps.now(), to: null });
    r.turns.breakAt(r.paused_at);
    this.deps.log?.(`recording: resumed ${r.path}`);
    this.notice("info", "resumed");
    this.changed();
  }
  /** Stops the current recording at once and closes its file once its pending
   * passages are written, or after `timeoutMs` (10 s unless given); `late`
   * counts those left out. A running recording cuts the passage in progress
   * at the stop (FR-001): its part so far is the recording's, the rest is
   * not. Null when nothing was recording. */
  stop(timeoutMs = stop_wait_ms): Promise<{ path: string; late: number }> | null {
    const r = this.current;
    if (!r) return null;
    r.stopped_at = this.deps.now();
    if (r.state === "running") {
      // Before the span ends: the cut part's speech can end at the stop
      // itself, or a frame after it on the segmenter's count, and `claim`
      // gives it to `r` only while `r` still runs.
      const u = this.inProgress();
      if (u) {
        this.deps.log?.(`recording: cut utterance ${u.id} at the stop of ${r.path}`);
        this.cut();
      }
      this.endSpan(r, r.stopped_at);
    }
    r.state = "stopping";
    this.current = null;
    this.stopping.add(r);
    this.deps.tuning.end();
    this.deps.active?.(false);
    r.done = this.close(r, timeoutMs);
    this.changed();
    return r.done;
  }
  private async close(r: Recording, timeoutMs: number): Promise<{ path: string; late: number }> {
    if (r.pending.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>(resolve => {
        r.drained.push(resolve);
        timer = setTimeout(resolve, timeoutMs);
      });
      clearTimeout(timer);
    }
    // Quitting may have closed it meanwhile.
    return this.stopping.has(r) ? this.closed(r) : { path: r.path, late: r.late };
  }
  /** Closes `r` now, counting what it still waits for as late. */
  private closed(r: Recording): { path: string; late: number } {
    this.unreserve(r);
    // Passages a write error left out are counted already; add what is still awaited.
    const late = (r.late += r.pending.size),
      waited = this.deps.now() - r.stopped_at,
      // A write error may have closed it already; that was reported then.
      failed = r.state === "closed";
    r.pending.clear();
    this.stopping.delete(r);
    r.state = "closed";
    this.deps.log?.(`recording: stopped ${r.path} waited_ms=${Math.round(waited)} late=${late}`);
    if (!failed) {
      try {
        r.file.close();
        this.notice("info", `stopped: ${r.path}`);
      } catch (error) {
        // What was written is synced already; the close itself failed.
        const why = message(error);
        this.error = why;
        this.deps.log?.(`recording: close failed ${r.path}: ${why}`);
        this.notice("error", `recording stopped: ${why}`);
      }
      if (late) this.notice("error", `${late} passage${late === 1 ? "" : "s"} did not finish in time`);
    }
    this.changed();
    return { path: r.path, late };
  }
  /** Quitting without waiting any longer: stops the current recording and
   * closes every stopping one at once, with what each still waited for. */
  finish(): { path: string; late: number }[] {
    void this.stop();
    return [...this.stopping].map(r => {
      const result = this.closed(r);
      // Their waits end too; they find the file closed.
      for (const fn of r.drained.splice(0)) fn();
      return result;
    });
  }
  /** Tells the recorder which passage is being spoken, if any (the session's
   * utterance in progress), so a pause keeps it for the recording when its
   * speech may already have ended; and how to `cut` it, which a stop does:
   * the part so far ends there and is claimed as any passage that ended. */
  track(
    inProgress: () => Utterance | null,
    speechEnd: () => number | null = () => null,
    cut: () => void = () => {},
  ): void {
    this.inProgress = inProgress;
    this.speechEnd = speechEnd;
    this.cut = cut;
  }
  private inProgress: () => Utterance | null = () => null;
  private cut: () => void = () => {};
  /** Where the speech of the passage in progress ended so far (ms), or null. */
  private speechEnd: () => number | null = () => null;
  private endSpan(r: Recording, at: number): void {
    const last = r.spans.at(-1);
    if (last && last.to === null) last.to = at;
  }
  /** Lets go of the passage in progress that `r` holds since its pause
   * unless its speech, as far as it went, ended while `r` ran: speech that
   * went on past the pause is no passage of `r`'s, and not late.
   * One that did end in time stays held and counts as late when `r` closes
   * without it. `letGoIfContinued` lets go of the first kind as soon as the
   * speech gets there; this catches what is left when `r` closes. */
  private unreserve(r: Recording): void {
    const u = this.inProgress(),
      end = this.speechEnd();
    if (u?.record === r && (end === null || !this.ranAt(r, end)) && r.pending.delete(u)) u.record = null;
  }
  /** Lets go of the passage in progress held by a recording since its pause
   * (stopped since, or not) once its speech, as the segmenter measures it
   * (short bursts do not count), reaches or passes the pause: from then on it
   * can no longer have ended while that recording ran, so the recording need
   * not wait for it, nor count it as late. A stop with nothing else pending
   * closes at once. The session calls this on each frame while a passage is
   * in progress. */
  letGoIfContinued(): void {
    const u = this.inProgress(),
      r = u?.record;
    if (!u || !r || (r.state !== "paused" && r.state !== "stopping")) return;
    const end = this.speechEnd(),
      held_at = r.spans.at(-1)?.to;
    // The same boundary as `ranAt`: speech that ends at the pause ended after it.
    if (end === null || held_at == null || end < held_at) return;
    this.deps.log?.(`recording: let go of utterance ${u.id}, its speech went on past the pause of ${r.path}`);
    this.release(u);
    u.record = null;
  }
  /** Whether `r` was running at `at` (ms). */
  private ranAt(r: Recording, at: number): boolean {
    return r.spans.some(s => s.from <= at && (s.to === null || at < s.to));
  }
  /** Holds the passage in progress for `r` as it pauses: its speech may have
   * ended while `r` ran, and the file must stay open for it should `r` stop.
   * `claim` settles it once the speech is known to have ended;
   * `letGoIfContinued` lets go of it as soon as the speech goes on past the
   * pause. */
  private reserve(r: Recording): void {
    const u = this.inProgress();
    if (!u || u.record) return;
    u.record = r;
    r.pending.add(u);
  }
  /**
   * Assigns `u`, whose speech just ended, to the recording that was running
   * when it ended (FR-004a): the current one, or one that stopped or paused
   * since, which waits for it. A passage held at a pause whose speech went on
   * past it is let go and assigned like any other.
   */
  claim(u: Utterance): void {
    const at = u.speech_end;
    if (u.record) {
      if (u.record.state !== "closed" && this.ranAt(u.record, at)) return;
      this.release(u);
      u.record = null;
    }
    for (const r of [this.current, ...this.stopping])
      if (r && r.state !== "closed" && this.ranAt(r, at)) {
        u.record = r;
        r.pending.add(u);
        return;
      }
  }
  /** Writes `u`'s cleaned `text` to its recording; false when nothing was
   * written (only a speaker dash, or the recording is closed). */
  write(u: Utterance, text: string): boolean {
    const r = u.record;
    if (!r || !r.pending.has(u)) return false;
    r.pending.delete(u);
    const said = speakerDash(text);
    let written = false;
    if (said.text) {
      const starts = r.turns.next({
        text: said.text,
        speech_start: u.speech_start,
        speech_end: u.speech_end,
        cut_at: u.cut_at,
        continues: u.continues,
        dash: said.dash,
      });
      try {
        r.file.write(said.text, starts);
        written = true;
      } catch (error) {
        this.failed(r, error, 1);
      }
    }
    this.settle(r);
    return written;
  }
  /** `u` ends without text for its recording. */
  release(u: Utterance): void {
    const r = u.record;
    if (r?.pending.delete(u)) this.settle(r);
  }
  private settle(r: Recording): void {
    if (r.pending.size) return;
    for (const fn of r.drained.splice(0)) fn();
  }
  /** A write failed: the recording closes, and dictation goes on. */
  private failed(r: Recording, error: unknown, failing = 0): void {
    this.unreserve(r);
    const why = message(error),
      // The passage whose write failed and those still awaited will never be
      // written: they count as left out.
      lost = r.pending.size + failing;
    r.state = "closed";
    r.late += lost;
    try {
      r.file.close();
    } catch {}
    r.pending.clear();
    this.settle(r);
    if (this.current === r) {
      this.current = null;
      this.deps.tuning.end();
      this.deps.active?.(false);
    }
    this.error = why;
    this.deps.log?.(`recording: write failed ${r.path}: ${why}`);
    this.notice(
      "error",
      `recording stopped: ${why}` + (lost ? `; ${lost} passage${lost === 1 ? "" : "s"} not written` : ""),
    );
    this.changed();
  }
}
