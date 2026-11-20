//! Voice mode's pipeline: microphone frames become utterances, Whisper's text
//! is cleaned and classified, and one delivery at a time goes to Corgi. The
//! link (CorgiLink) holds each delivery to 2 s; the session's own bound is a
//! safety net. Mute lives here alone: nothing about it goes to Corgi.
import * as wav from "./wav";
import * as text from "./text";
import * as level from "./level";
import * as gauge from "./gauge";
import * as whisper from "./whisper";
import * as errors from "../util/errors";
import { Failure } from "../util/failure";
import { no_answer } from "../corgi/errors";
import { bounded, type Seen, type VoiceLink } from "./link";
import type { Segmenter, Segment } from "./segmenter";
import type { MicProblem } from "./capture";
import type { Recorder, Recording } from "./recorder";

/** "muted": dropped by a mute, on purpose; "discarded": dropped for `reason`;
 * "recorded": written to a transcript but not typed, for `reason`. */
export type UtteranceStatus =
  "recording" | "transcribing" | "delivering" | "delivered" | "failed" | "muted" | "discarded" | "dropped" | "recorded";
export type Utterance = {
  id: number;
  captured_at: number;
  duration: number;
  status: UtteranceStatus;
  text: string | null;
  reason: string | null;
  timings: { transcribe_ms?: number; deliver_ms?: number };
  /** The transcript recording this passage goes to, decided when its speech ended. */
  record: Recording | null;
  /** Why it is no longer typed; null while it may still be. */
  untyped: Untyped | null;
  /** Sent to be typed, but no answer came in time: it may have been typed. */
  maybe_typed: boolean;
  /** When its loud audio began and ended, where the cap cut it (if it did),
   * and whether it carries on such a cut. */
  speech_start: number;
  speech_end: number;
  cut_at: number | null;
  continues: boolean;
  /** Its speech's peak level, 0 to 100, which a gauge compares its result with:
   * up to the end of its last loud stretch, pre-roll in, the kept pause out. */
  peak?: number;
  /** What the segmenter's cut kept, once the utterance ended. */
  cut?: Pick<Segment, "post_roll" | "kept" | "dropped" | "capped">;
  /** The speech filter's padding Whisper was given, in seconds. */
  pad?: number;
  /** Where Whisper's last segment ends, in seconds into the audio, when it says. */
  whisper_end?: number;
};
/** Whisper: `pad` is the speech filter's padding for this utterance, in seconds. */
export type Transcriber = {
  transcribe(wav: Uint8Array, opts: { pad: number }): Promise<{ text: string; speech_end?: number }>;
  on(event: "crashed", fn: (code: number | null) => void): void;
};
/** A gauge that finished or failed: `old` and the `threshold` it left, the
 * `loudest` level it heard, and how long it `took_ms` from the key press. */
export type GaugeRow = {
  at: number;
  old: number;
  threshold: number;
  loudest: number;
  outcome: gauge.Outcome;
  took_ms: number;
};
/** The level, 0 to 100, the loudest tenth of `pcm`'s 20 ms frames (320
 * samples, 50 a second) all reach. */
export function peakOf(pcm: Int16Array): number {
  const levels: number[] = [];
  for (let at = 0; at + 320 <= pcm.length; at += 320) levels.push(level.rmsToPercent(level.rms(pcm.subarray(at, at + 320))));
  if (!levels.length) return 0;
  levels.sort((a, b) => b - a);
  return levels[Math.min(levels.length - 1, Math.floor(levels.length / 10))];
}
/** Why a passage is not typed. */
export type Untyped = "muted" | "no_viewer" | "backlog";
/** What the history says for each, after "recorded, not typed" or "discarded". */
const untyped_reason: Record<Untyped, string> = {
  muted: "muted",
  no_viewer: "no viewer attached",
  backlog: "backlog",
};
/** "connected" while Corgi answers (at least one machine within 2 s); "lost" while it does not. */
export type LinkState = "connecting" | "connected" | "lost" | "closed";
export type Unavailable = MicProblem | "server_down";

/** Why a delivery failed, as the history says it. */
export function reason(error: unknown): string {
  switch (errors.name(error)) {
    case "NoViewer":
      return "no viewer attached";
    case "VoicePane":
      return "focused pane is the voice pane";
    case "Timeout":
      return "timed out";
    case "ServerDown":
      return "server crashed";
    case "ServerRestarting":
      return "filter switching";
    default:
      return errors.name(error) ?? String(error);
  }
}
/** How many utterances may wait for Whisper or Corgi; past that, speech fails instead of piling up. */
const max_backlog = 4;
/** How many passages, each holding its audio, may wait for Whisper in all,
 * recorded ones included: about 5 minutes of 10 s chunks, some 10 MB. Past
 * that a passage is left out, and the recording says so, rather than memory
 * growing for as long as Whisper stays behind. */
export const max_queued = 30;
/** The session's own bound around a delivery: a safety net over CorgiLink's 2 s. */
export const safety_ms = 2500;
/** Whether a reason says Corgi (or the machine a viewer shows) does not
 * answer, rather than that no viewer is attached. */
function unreachable(reason: string | null): boolean {
  return !!reason && /\bunreachable\b/.test(reason);
}

export class VoiceSession {
  history: Utterance[] = [];
  muted = false;
  link_state: LinkState = "connecting";
  /** "crashed" until a fresh server takes over (switching the filter starts one). */
  server: "ready" | "crashed" = "ready";
  private mic: MicProblem | null = null;
  /** The last frame's level on the threshold scale. */
  level = 0;
  /** How far into the silence window the utterance in progress is, 0 to 1. */
  pause = 0;
  /** Whether a viewer would take text (without one, voice holds off), the
   * label of the pane text would go to, its machine, and why there is none. */
  viewer = true;
  focus: string | null = null;
  machine: string | null = null;
  reason: string | null = null;
  /** A gauge listening to the background: what it heard, the loudest level
   * so far, and how far it is, 0 to 1. */
  gauge: { frames: Int16Array[]; loudest: number; progress: number } | null = null;
  /** Gauges that finished or failed; a cancelled one leaves none. */
  gauges: GaugeRow[] = [];
  private gauge_started = 0;
  private link: VoiceLink | null = null;
  private next_id = 1;
  /** Passages handed to Whisper and not yet done with it, each holding its audio. */
  private queued = 0;
  private current: Utterance | null = null;
  private transcriptions: Promise<void> = Promise.resolve();
  private deliveries: Promise<void> = Promise.resolve();
  private retry?: ReturnType<typeof setTimeout>;
  /** Retries every 5 s log a failure once, until it changes or the link is back. */
  private link_failure = new Failure();
  private listeners: (() => void)[] = [];
  constructor(
    private deps: {
      link: () => Promise<VoiceLink>;
      transcriber: Transcriber;
      segmenter: Segmenter;
      now: () => number;
      /** The session's safety bound around a delivery; 2.5 s by default. */
      deliverTimeoutMs?: number;
      retryMs?: number;
      log?: (line: string) => void;
      /** Takes the passages of a transcript recording. */
      recorder?: Recorder;
      /** Sets the threshold a gauge found; the segmenter's own by default. */
      setThreshold?: (pct: number) => void;
    },
  ) {
    deps.transcriber.on("crashed", () => this.crashed());
    // A pause or stop keeps the passage being spoken for its recording (FR-004a).
    deps.recorder?.track(
      () => this.current,
      () => this.deps.segmenter.speechEnd,
    );
  }
  get available(): boolean {
    return !this.mic && this.server === "ready";
  }
  /** Why voice cannot listen; the server going down outranks the microphone. */
  get unavailable(): Unavailable | null {
    return this.server === "crashed" ? "server_down" : this.mic;
  }
  on(_event: "change", fn: () => void): void {
    this.listeners.push(fn);
  }
  private changed(): void {
    for (const fn of this.listeners) fn();
  }
  /** Starts the link to Corgi, or throws what went wrong. A failure
   * schedules a retry, so a caller that gives up must close(). */
  async connect(): Promise<void> {
    if (this.link_state === "closed") return;
    this.link_state = "connecting";
    this.changed();
    let link: VoiceLink | null = null;
    try {
      link = await this.deps.link();
      if (this.isClosed()) return link.close();
      const attached = link;
      attached.on("viewer", state => {
        if (this.link === attached) this.applyViewer(state);
      });
      attached.on("closed", why => this.lost(attached, why));
      const reply = await attached.watch();
      if (this.isClosed()) return attached.close();
      this.link = attached;
      this.link_state = "connected";
      this.link_failure.clear();
      this.deps.log?.("link: connected");
      this.applyViewer(reply);
      this.changed();
    } catch (error) {
      link?.close();
      if (this.isClosed()) return;
      this.link_state = "lost";
      this.schedule();
      if (this.link_failure.changed(error)) this.deps.log?.(`link: ${errors.name(error) ?? error}`);
      this.changed();
      throw error;
    }
  }
  /** Checked again after each wait: quitting can happen meanwhile. */
  private isClosed(): boolean {
    return this.link_state === "closed";
  }
  private lost(link: VoiceLink, why: string): void {
    if (this.link !== link || this.link_state === "closed") return;
    this.link = null;
    this.link_state = "lost";
    this.deps.log?.(`link: lost (${why})`);
    this.changed();
    this.schedule();
  }
  private schedule(): void {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect().catch(() => {}), this.deps.retryMs ?? 5000);
  }
  frame(f: Int16Array): void {
    this.level = level.rmsToPercent(level.rms(f));
    // Frames again after a microphone failure: it is back.
    if (this.mic) this.setAvailable(true, null);
    // A gauge needs only the microphone: mute, the viewer, the link and the server don't stop it.
    if (this.gauge) return this.listen(f);
    // A running recording keeps listening while muted or without a viewer.
    if (!this.available || (!this.recordingRuns && (this.muted || !this.viewer))) {
      // The recording paused or stopped in the middle of a muted passage.
      if (this.current) {
        this.deps.segmenter.abort();
        this.current.status = this.muted ? "muted" : "discarded";
        this.current.reason = this.muted ? null : "no viewer";
        this.letGo();
        this.changed();
      }
      this.pause = 0;
      return;
    }
    const done = this.deps.segmenter.push(f);
    this.pause = this.deps.segmenter.pause;
    for (const segment of done) this.segmented(segment);
    if (this.deps.segmenter.recording && !this.current) {
      this.current = this.utterance("recording");
      // Speech that began muted or without a viewer stays untyped, even if
      // that changes before it ends: only a recording was listening.
      if (this.muted) this.untype(this.current, "muted");
      else if (!this.viewer) this.untype(this.current, "no_viewer");
      this.changed();
    } else if (!this.deps.segmenter.recording && this.current) {
      // Too little speech to count.
      this.current.status = "dropped";
      this.current.reason = "too short";
      this.letGo();
      this.changed();
    }
  }
  /** Gauges the threshold against the background, or says why it cannot:
   * the microphone, or a recording (which has a threshold of its own). What
   * is being said is dropped, as a mute drops it; what Whisper or Corgi
   * already has goes on. */
  startGauge(): MicProblem | "recording" | null {
    if (this.mic) return this.mic;
    if (this.deps.recorder?.current) return "recording";
    if (this.gauge) return null;
    this.deps.segmenter.abort();
    if (this.current) this.current.status = "dropped";
    this.letGo();
    this.pause = 0;
    this.gauge = { frames: [], loudest: 0, progress: 0 };
    this.gauge_started = this.deps.now();
    this.changed();
    return null;
  }
  /** Stops a gauge, leaving the threshold and no row. */
  cancelGauge(): void {
    if (!this.gauge) return;
    this.gauge = null;
    this.changed();
  }
  /** A gauge's frame; the last one sets the threshold. */
  private listen(f: Int16Array): void {
    const g = this.gauge!;
    this.pause = 0;
    g.frames.push(f);
    g.loudest = Math.max(g.loudest, this.level);
    g.progress = g.frames.length / gauge.listen_frames;
    if (g.frames.length < gauge.listen_frames) return;
    const segmenter = this.deps.segmenter,
      old = segmenter.percent,
      { threshold, loudest, outcome } = gauge.choose(g.frames, segmenter.timing, old);
    if (outcome === "too_loud") return this.endGauge({ old, threshold, loudest, outcome });
    if (this.deps.setThreshold) this.deps.setThreshold(threshold);
    else segmenter.setThreshold(threshold);
    const peaks = this.history.flatMap(u => (u.status === "delivered" && u.peak !== undefined ? [u.peak] : []));
    this.endGauge({ old, threshold, loudest, outcome: gauge.warn(peaks, threshold) });
  }
  private endGauge(row: Omit<GaugeRow, "at" | "took_ms">): void {
    const at = this.deps.now(),
      took_ms = Math.round(at - this.gauge_started);
    this.gauge = null;
    this.gauges.push({ at, ...row, took_ms });
    if (this.gauges.length > 100) this.gauges.splice(0, this.gauges.length - 100);
    this.deps.log?.(
      `gauge: threshold ${row.old} → ${row.threshold} loudest=${Math.round(row.loudest * 10) / 10}` +
        ` outcome=${row.outcome} took_ms=${took_ms}`,
    );
    this.changed();
  }
  private utterance(status: UtteranceStatus): Utterance {
    const u: Utterance = {
      id: this.next_id++,
      captured_at: this.deps.now(),
      duration: 0,
      status,
      text: null,
      reason: null,
      timings: {},
      record: null,
      untyped: null,
      maybe_typed: false,
      speech_start: 0,
      speech_end: 0,
      cut_at: null,
      continues: false,
    };
    this.history.push(u);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    return u;
  }
  private segmented(segment: Segment): void {
    const u = this.current ?? this.utterance("recording");
    this.current = null;
    u.captured_at = segment.started_at;
    u.duration = segment.duration;
    u.speech_start = segment.speech_start;
    u.speech_end = segment.speech_end;
    u.cut_at = segment.cut_at;
    u.continues = segment.continues;
    u.cut = { post_roll: segment.post_roll, kept: segment.kept, dropped: segment.dropped, capped: segment.capped };
    // The kept pause is not speech: a gauge compares the speech alone.
    u.peak = peakOf(segment.pcm.subarray(0, segment.pcm.length - Math.round(segment.kept * 50) * 320));
    this.deps.recorder?.claim(u);
    // Neither typed nor written: Whisper is not asked for text nothing would use.
    if (!u.record && u.untyped) return this.finish(u, ...this.untypedEnd(u, u.untyped));
    if (!u.record && (this.muted || !this.viewer))
      return this.finish(u, this.muted ? "muted" : "discarded", this.muted ? null : "no viewer");
    // A recorded passage is written whether or not it can be typed; the link
    // is checked when it is typed, as for any passage.
    const why: Untyped | null = this.muted ? "muted" : !this.viewer ? "no_viewer" : null;
    if (u.record && why) this.untype(u, why);
    // Speech this far behind Whisper or the runtime is not kept on top; a
    // recorded passage is still written, only not typed.
    if (this.pending >= max_backlog) {
      if (!u.record) return this.finish(u, "failed", "backlog");
      this.untype(u, "backlog");
    }
    // Counted apart from the history, which drops old rows.
    if (this.queued >= max_queued) {
      if (u.record) {
        this.deps.recorder?.release(u);
        this.deps.recorder?.notice("error", "a passage was left out of the transcript: Whisper is too far behind");
        u.record = null;
      }
      return this.finish(u, "failed", "backlog");
    }
    u.status = "transcribing";
    this.changed();
    this.queued++;
    this.transcriptions = this.transcriptions.then(() => this.transcribe(u, segment));
  }
  /** `u` is no longer typed, for `why`; the first reason stays. */
  private untype(u: Utterance, why: Untyped): void {
    if (u.untyped) return;
    u.untyped = why;
    u.reason = why === "no_viewer" ? this.noViewer() : untyped_reason[why];
  }
  /** Why nothing can be typed without a target: Corgi or a machine that does
   * not answer, named, else that no viewer is attached. */
  private noViewer(): string {
    return this.reason && this.reason !== untyped_reason.no_viewer ? this.reason : untyped_reason.no_viewer;
  }
  /** A recording is running, or holds the passage being spoken since it
   * paused or stopped, so speech is heard even when it cannot be typed. */
  private get recordingRuns(): boolean {
    return this.deps.recorder?.current?.state === "running" || !!this.current?.record;
  }
  /** Drops the utterance in progress; a recording holding it stops waiting for it. */
  private letGo(): void {
    const u = this.current;
    this.current = null;
    if (u?.record) {
      this.deps.recorder?.release(u);
      u.record = null;
    }
  }
  /** Utterances waiting for Whisper or for the runtime, each holding its audio or text. */
  private get pending(): number {
    let n = 0;
    for (const u of this.history) if (u.status === "transcribing" || u.status === "delivering") n++;
    return n;
  }
  private async transcribe(u: Utterance, segment: Segment): Promise<void> {
    try {
      await this.heard(u, segment);
    } finally {
      this.queued--;
      // Whatever ended it without a write, a stop need not wait for it.
      this.deps.recorder?.release(u);
    }
  }
  private async heard(u: Utterance, segment: Segment): Promise<void> {
    if (u.status !== "transcribing") return;
    const started = this.deps.now();
    let heard: string;
    try {
      // The filter pads by the post-roll this utterance ended with.
      u.pad = whisper.padMs(segment.post_roll) / 1000;
      const reply = await this.deps.transcriber.transcribe(wav.encode(segment.pcm), { pad: segment.post_roll });
      heard = reply.text;
      u.whisper_end = reply.speech_end;
    } catch (error) {
      if (u.status === "transcribing")
        this.finish(u, "failed", this.server === "crashed" ? "server crashed" : reason(error));
      return;
    }
    u.timings.transcribe_ms = this.deps.now() - started;
    if (u.status !== "transcribing") return;
    const cleaned = text.clean(heard);
    if (cleaned === null) return this.finish(u, "dropped", heard.trim() ? "not speech" : "empty");
    u.text = cleaned;
    if (u.record && !this.deps.recorder?.write(u, cleaned)) u.record = null;
    this.changed();
    this.deliveries = this.deliveries.then(() => this.deliver(u));
  }
  private async deliver(u: Utterance): Promise<void> {
    if (u.status !== "transcribing") return;
    if (u.untyped) return this.finish(u, ...this.untypedEnd(u, u.untyped));
    const link = this.link;
    if (!link || this.link_state !== "connected")
      return this.finish(u, u.record ? "recorded" : "failed", this.reason ?? "not connected");
    u.status = "delivering";
    this.changed();
    const started = this.deps.now();
    try {
      await bounded(link.type(u.text!), this.deps.deliverTimeoutMs ?? safety_ms);
      u.timings.deliver_ms = this.deps.now() - started;
      this.finish(u, "delivered", null);
    } catch (error) {
      u.timings.deliver_ms = this.deps.now() - started;
      // The text was sent; only the answer is missing, so it may still arrive.
      const timeout = errors.is(error, "Timeout");
      u.maybe_typed = timeout;
      // Written to the transcript, so it is kept as recorded, with why it was not typed.
      if (u.record) this.finish(u, "recorded", timeout ? no_answer : reason(error));
      else if (timeout) this.finish(u, "failed", no_answer);
      else this.finish(u, "failed", reason(error));
    }
  }
  /** How a passage that is not typed ends: recorded when it was written. The
   * reason is the one it was untyped for, not the one now. */
  private untypedEnd(u: Utterance, why: Untyped): [UtteranceStatus, string | null] {
    const because = u.reason ?? untyped_reason[why];
    if (u.record) return ["recorded", because];
    if (why === "muted") return ["muted", null];
    return ["discarded", because === untyped_reason.no_viewer ? "no viewer" : because];
  }
  private finish(u: Utterance, status: UtteranceStatus, why: string | null): void {
    u.status = status;
    u.reason = why;
    const t = u.timings,
      cut = u.cut,
      shown = (seconds: number) => `${Math.round(seconds * 100) / 100}s`;
    this.deps.log?.(
      `utterance ${u.id}: ${status}${why ? ` (${why})` : ""} duration=${shown(u.duration)}` +
        (t.transcribe_ms !== undefined ? ` transcribe_ms=${t.transcribe_ms}` : "") +
        (t.deliver_ms !== undefined ? ` deliver_ms=${t.deliver_ms}` : "") +
        // One cut at the cap went out whole, with no post-roll applied.
        (cut ? (cut.capped ? " capped" : ` post_roll=${shown(cut.post_roll)}`) : "") +
        (cut ? ` kept=${shown(cut.kept)} dropped=${shown(cut.dropped)}` : "") +
        (u.pad !== undefined ? ` pad=${shown(u.pad)}` : "") +
        (u.whisper_end !== undefined ? ` speech_end=${shown(u.whisper_end)}` : ""),
    );
    this.changed();
  }
  /** Mute or unmute (`m` in the window). It stays in corgi-voice; muting
   * drops what was not yet delivered. */
  setMuted(muted: boolean, restore = false): void {
    // Unmuting needs a voice that can listen; a recording's end restores the
    // earlier state anyway, and MUTED shows while voice cannot listen.
    if (!muted && !this.available && !restore) return;
    if (this.muted === muted) return;
    this.muted = muted;
    if (muted) this.discard("muted", null, "muted");
    this.changed();
  }
  /** A viewer attached or went away, the target moved, or Corgi stopped or
   * started answering; what is said without a viewer has nowhere to go. */
  private applyViewer(state: Seen): void {
    const link_state: LinkState = unreachable(state.reason) ? "lost" : "connected";
    if (
      this.viewer === state.viewer &&
      this.focus === state.focus &&
      this.machine === state.machine &&
      this.reason === state.reason &&
      this.link_state === link_state
    )
      return;
    // The reason first: what is dropped now names it (a machine that stopped answering, say).
    this.reason = state.reason;
    if (this.viewer && !state.viewer) {
      const why = this.noViewer();
      this.discard("discarded", why === untyped_reason.no_viewer ? "no viewer" : why, "no_viewer");
    }
    this.viewer = state.viewer;
    this.focus = state.focus;
    this.machine = state.machine;
    if (this.link_state !== "closed") this.link_state = link_state;
    this.changed();
  }
  /** Speech is being recorded. */
  get recording(): boolean {
    return this.history.some(u => u.status === "recording");
  }
  get transcribing(): boolean {
    return this.history.some(u => u.status === "transcribing");
  }
  /** Drops what was not yet typed. A passage for a transcript is still
   * written, only not typed (for `untyped`); while a recording runs, the
   * passage in progress goes on, to be written when it ends. */
  private discard(status: "muted" | "discarded", why: string | null, untyped: Untyped): void {
    const listening = this.recordingRuns;
    if (!listening) {
      this.deps.segmenter.abort();
      this.letGo();
    } else if (this.current) this.untype(this.current, untyped);
    for (const u of this.history)
      if (u.record && u.status === "transcribing") this.untype(u, untyped);
      else if (u.status === "transcribing" || (u.status === "recording" && !listening)) {
        u.status = status;
        u.reason = why;
      }
  }
  /** The microphone stopped (`available` false, and why) or came back. */
  setAvailable(available: boolean, why: MicProblem | null): void {
    const next = available ? null : (why ?? "mic_missing");
    if (this.mic === next) return;
    this.mic = next;
    // A gauge that loses the microphone ends, and the threshold stays.
    if (next && this.gauge) {
      const old = this.deps.segmenter.percent;
      this.endGauge({ old, threshold: old, loudest: this.gauge.loudest, outcome: "mic_failed" });
    }
    this.availability();
  }
  private availability(): void {
    if (!this.available) {
      this.deps.segmenter.abort();
      if (this.current) this.current.status = "dropped";
      this.letGo();
    }
    this.deps.log?.(this.available ? "listening again" : `cannot listen: ${this.unavailable}`);
    this.changed();
  }
  private crashed(): void {
    this.server = "crashed";
    // Text already transcribed can still be delivered.
    for (const u of this.history)
      if ((u.status === "transcribing" && u.text === null) || u.status === "recording") {
        u.status = "failed";
        u.reason = "server crashed";
        this.deps.recorder?.release(u);
      }
    this.availability();
  }
  /** A fresh server took over; after a crash, voice listens again. */
  serverReady(): void {
    if (this.server === "ready") return;
    this.server = "ready";
    this.availability();
  }
  close(): void {
    this.link_state = "closed";
    this.gauge = null;
    clearTimeout(this.retry);
    this.link?.close();
    this.link = null;
  }
}
