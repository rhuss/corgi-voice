//! The voice session's link to Corgi through its CLI: the poller says where
//! text would go, and each dictated utterance is typed with
//! `corgi [--machine X] pane send ID --stdin` (FR-010 to FR-014). Deliveries
//! run one at a time in order; each is answered or abandoned within 2 s, and
//! an abandoned one's process is gone before the next starts.
import * as subprocess from "../util/subprocess";
import { Events, deadline_ms, type LinkEvents, type Seen, type Typed, type VoiceLink } from "../voice/link";
import { Poller, on } from "./poller";
import { reasonFor, notFound } from "./errors";
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

/** What the window shows for a resolution. */
export function seen(r: Resolution): Seen {
  return r.target
    ? { viewer: true, focus: r.target.label, machine: r.target.machine, reason: null }
    : { viewer: false, focus: null, machine: null, reason: r.reason };
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
  private readonly log: (line: string) => void;
  constructor(opts: CorgiLinkOptions) {
    this.cmd = opts.cmd;
    this.ownPane = opts.ownPane ?? null;
    this.deliverMs = opts.deliverMs ?? deadline_ms;
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
      // The queue goes on once this delivery's process is gone, answered or not.
      this.queue = this.queue.then(() => this.deliver(text, resolve, reject));
    });
  }
  private async deliver(text: string, resolve: (t: Typed) => void, reject: (e: Error) => void): Promise<void> {
    if (this.closed) return reject(Error("NoViewer"));
    // Resolved again as it starts: the newest data counts, and stale data does not.
    const r = this.poller.resolve();
    if (!r.target) return reject(Error("NoViewer"));
    const target = r.target;
    if (target.machine === "local" && this.ownPane !== null && target.pane === this.ownPane)
      return reject(Error("VoicePane"));
    const pane = this.poller.machines.find(m => m.name === target.machine)?.panes.get(target.pane);
    // An exited or hibernated pane takes no text: "pane gone", as corgi says it (FR-013).
    if (pane?.exited || pane?.dormant) return reject(Error("pane gone"));
    const sent = (this.joins(target) ? " " : "") + text,
      argv = on(this.cmd, target.machine, "pane", "send", String(target.pane), "--stdin"),
      abort = (this.running = new AbortController());
    // Abandoned at the bound: the session hears at once, and the queue waits
    // until the process is killed.
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(Error("Timeout"));
      abort.abort();
    }, this.deliverMs);
    try {
      const out = await subprocess.run(argv, { stdin: sent, timeoutMs: this.deliverMs, signal: abort.signal });
      if (settled) return;
      // Failed and abandoned deliveries leave the last successful one in place (FR-011).
      if (out.timedOut) return reject(Error("Timeout"));
      if (out.code !== 0) return reject(Error(reasonFor(out.stderr, target.machine, out.code)));
      this.last = { machine: target.machine, viewer: target.viewer, pane: target.pane, active: target.active };
      this.poller.previous = target.machine;
      resolve({ machine: target.machine, pane: target.pane, viewer: target.viewer });
    } catch (error) {
      if (settled) return;
      const name = (error as Error)?.message;
      reject(Error(name === "FileNotFound" || name === "AccessDenied" ? notFound(this.cmd) : String(name)));
    } finally {
      clearTimeout(timer);
      if (this.running === abort) this.running = null;
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
    this.events.emitClosed("closed");
  }
}
