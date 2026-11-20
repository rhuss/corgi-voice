//! The voice session's link to Corgi through its CLI: the poller says where
//! text would go, and each dictated utterance is typed with
//! `corgi [--machine X] pane send ID --stdin` (FR-010 to FR-014). Deliveries
//! run one at a time in order; each is answered or abandoned within 2 s, and
//! an abandoned one's process is gone before the next starts. Each delivery
//! leaves one line in the log, which never holds the text.
import * as subprocess from "../util/subprocess";
import { ellipsis, spaced } from "../util/text";
import { Events, deadline_ms, type LinkEvents, type Seen, type Typed, type VoiceLink } from "../voice/link";
import { Poller, on } from "./poller";
import { lines, reasonFor, notFound } from "./errors";
import type { Resolution, Target } from "./viewers";

export type CorgiLinkOptions = {
  cmd: string;
  /** The pane corgi-voice runs in on the local machine (`CORGI_PANE`), never typed into. */
  ownPane?: number | null;
  intervalMs?: number;
  boundMs?: number;
  deliverMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** A poller of its own, for tests. */
  poller?: Poller;
};
/** The last successful delivery, for the leading space (FR-011). */
type Last = { machine: string; viewer: number; pane: number; active: number };
/** How a delivery ended, for the log: "abandoned" got no answer by the bound. */
type Outcome = "delivered" | "failed" | "abandoned";
/** The most of corgi's own words a log line takes, in columns. */
const max_said = 120;

/** What the window shows for a resolution. */
export function seen(r: Resolution): Seen {
  return r.target
    ? { viewer: true, focus: r.target.label, machine: r.target.machine, reason: null, why: null }
    : { viewer: false, focus: null, machine: null, reason: r.reason, why: r.why };
}

export class CorgiLink implements VoiceLink {
  readonly poller: Poller;
  private events = new Events();
  private queue: Promise<void> = Promise.resolve();
  private last: Last | null = null;
  private running: AbortController | null = null;
  private closed = false;
  private readonly cmd: string;
  private readonly ownPane: number | null;
  private readonly deliverMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  constructor(opts: CorgiLinkOptions) {
    this.cmd = opts.cmd;
    this.ownPane = opts.ownPane ?? null;
    this.deliverMs = opts.deliverMs ?? deadline_ms;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.poller =
      opts.poller ??
      new Poller({ cmd: opts.cmd, intervalMs: opts.intervalMs, boundMs: opts.boundMs, now: opts.now, log: this.log });
    this.poller.on("change", r => {
      if (!this.closed) this.events.emitViewer(seen(r));
    });
  }
  /** Starts polling; resolves with the first view of the target. */
  async watch(): Promise<Seen> {
    await this.poller.start();
    return seen(this.poller.resolve());
  }
  on<K extends keyof LinkEvents>(event: K, fn: LinkEvents[K]): void {
    this.events.on(event, fn);
  }
  /** Types `text` into the target, after the deliveries before it. */
  type(text: string): Promise<Typed> {
    return new Promise<Typed>((resolve, reject) => {
      // The queue goes on once this delivery's process is gone, answered or
      // not. It never breaks: whatever a delivery throws that it should not
      // rejects that delivery alone, and the next one still runs.
      this.queue = this.queue
        .then(() => this.deliver(text, resolve, reject))
        .catch(error => {
          reject(error instanceof Error ? error : Error(String(error)));
          try {
            this.log(`delivery: failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
          } catch {}
        });
    });
  }
  private async deliver(text: string, resolve: (t: Typed) => void, reject: (e: Error) => void): Promise<void> {
    const started = this.now();
    // A delivery no `pane send` runs for: rejected, and logged with why.
    const unsent = (why: string, target?: Target) => {
      this.report("failed", started, target, `error=${why}`);
      reject(Error(why));
    };
    if (this.closed) return unsent("NoViewer");
    // Resolved again as it starts: the newest data counts, and stale data does not.
    const r = this.poller.resolve();
    if (!r.target) return unsent("NoViewer");
    const target = r.target;
    if (target.machine === "local" && this.ownPane !== null && target.pane === this.ownPane)
      return unsent("VoicePane", target);
    // An exited or hibernated pane takes no text: "pane gone", as corgi says it (FR-013).
    if (target.gone) return unsent("pane gone", target);
    const sent = (this.joins(target) ? " " : "") + text,
      argv = on(this.cmd, target.machine, "pane", "send", String(target.pane), "--stdin"),
      abort = (this.running = new AbortController());
    // This timer is the delivery's bound, and the one that decides: at the
    // bound the session hears at once, the process is killed through `abort`,
    // and the queue waits until it is gone. The call below has no time bound
    // of its own, and the session's safety net comes later.
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(Error("Timeout"));
      abort.abort();
    }, this.deliverMs);
    try {
      const out = await subprocess.run(argv, { stdin: sent, signal: abort.signal }),
        code = `code=${out.code ?? "signal"}`;
      // Failed and abandoned deliveries leave the last successful one in place (FR-011).
      if (settled || out.timedOut) {
        this.report("abandoned", started, target, code);
        // Killed by close() before the bound: no answer either, and the text may have arrived.
        if (!settled) reject(Error("Timeout"));
        return;
      }
      if (out.code !== 0) {
        const said = lines(out.stderr)[0];
        this.report("failed", started, target, code + (said ? ` stderr=${ellipsis(spaced(said), max_said)}` : ""));
        return reject(Error(reasonFor(out.stderr, target.machine, out.code)));
      }
      this.last = { machine: target.machine, viewer: target.viewer, pane: target.pane, active: target.active };
      this.poller.delivered(target.machine);
      this.report("delivered", started, target, code);
      resolve({ machine: target.machine, pane: target.pane, viewer: target.viewer });
    } catch (error) {
      // The command could not be started.
      const name = String((error as Error)?.message);
      this.report("failed", started, target, `error=${name}`);
      if (settled) return;
      reject(Error(name === "FileNotFound" || name === "AccessDenied" ? notFound(this.cmd) : name));
    } finally {
      clearTimeout(timer);
      if (this.running === abort) this.running = null;
    }
  }
  /** The log line of one delivery: how it ended, where it went, how long it
   * took until its process was gone, and `detail` (the exit code, and the
   * first line corgi said when it failed). Never the text. */
  private report(outcome: Outcome, started: number, target: Target | undefined, detail: string): void {
    const where = target ? ` machine=${target.machine} pane=${target.pane}` : "";
    try {
      this.log(`delivery: ${outcome}${where} ms=${Math.round(this.now() - started)} ${detail}`);
    } catch {
      // A log that fails must not turn a delivery into a failure.
    }
  }
  /** One leading space when the last delivery went to this pane of this
   * viewer, and the viewer saw no input since (its `active` is unchanged). */
  private joins(t: Target): boolean {
    const l = this.last;
    return !!l && l.machine === t.machine && l.viewer === t.viewer && l.pane === t.pane && l.active === t.active;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.poller.stop();
    this.running?.abort();
  }
}
