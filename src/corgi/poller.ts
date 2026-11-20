//! Viewer data per machine (FR-007): one loop per machine runs
//! `corgi [--machine NAME] list --json` every second, each call bounded at
//! 1.5 s, so a slow machine never holds up another. The machines come from
//! `corgi machine list`, asked on start and every 30 s. Without it, only the
//! local machine gets a loop and `list --all-machines --json` fills in the
//! others every second, bounded like any viewer fetch (it waits for every
//! machine, so one slow machine leaves the others without data meanwhile). A change in the resolved target, its label or the
//! reason there is none is announced.
import * as subprocess from "../util/subprocess";
import { firstLine, notFound } from "./errors";
import {
  parseReply,
  resolve,
  not_understood,
  type Machine,
  type Resolution,
} from "./viewers";

export type PollerOptions = {
  cmd: string;
  /** How often each machine is asked, in ms. */
  intervalMs?: number;
  /** How long one `list --json` may take, in ms. */
  boundMs?: number;
  /** How often the machine list is asked again, in ms. */
  machineListMs?: number;
  /** How often `list --all-machines` runs when there is no machine list, in ms. */
  fallbackMs?: number;
  now?: () => number;
  log?: (line: string) => void;
};
type Loop = { machine: Machine; abort: AbortController; timer?: ReturnType<typeof setTimeout>; stopped: boolean };

export const interval_ms = 1000,
  bound_ms = 1500,
  machine_list_ms = 30_000,
  /** `list --all-machines` as a fallback: as often as the per-machine loops,
   * so its data stays fresh (FR-007), and bounded below 2 s like them. */
  fallback_ms = interval_ms,
  /** The bound of `machine list`. */
  slow_bound_ms = 3000;

/** A machine before its first answer. */
export function blank(name: string): Machine {
  return { name, state: "unreachable", error: "no answer yet", fetchedAt: 0, viewers: [], panes: new Map() };
}
/** The argv for `cmd` on `machine`: `--machine` is left out for the local one. */
export function on(cmd: string, machine: string, ...args: string[]): string[] {
  return machine === "local" ? [cmd, ...args] : [cmd, "--machine", machine, ...args];
}
/** The JSON object in `text` from its first `{`, past any notice before it, or null. */
export function jsonFrom(text: string): unknown {
  const at = text.indexOf("{");
  if (at < 0) return null;
  try {
    return JSON.parse(text.slice(at));
  } catch {
    return null;
  }
}
/** Whether `name` can go after `--machine` as a value: never an option, no spaces or controls. */
export function machineName(name: unknown): name is string {
  return typeof name === "string" && /^[^\s\x00-\x1f\x7f-\x9f-][^\s\x00-\x1f\x7f-\x9f]*$/.test(name);
}
/** The machine names in a `machine list` reply, or null when it is not one. */
export function machineNames(text: string): string[] | null {
  const reply = jsonFrom(text) as { machines?: unknown } | null;
  if (!reply || !Array.isArray(reply.machines)) return null;
  const names: string[] = [];
  for (const m of reply.machines) {
    const name = m && typeof m === "object" ? (m as { name?: unknown }).name : null;
    if (machineName(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

export class Poller {
  /** The machines in Corgi's listing order. */
  machines: Machine[] = [];
  /** The machine of the last successful delivery, for the tie-break. */
  previous: string | null = null;
  private loops = new Map<string, Loop>();
  private listeners: ((r: Resolution) => void)[] = [];
  private shown: string | null = null;
  private tick?: ReturnType<typeof setInterval>;
  private listing?: ReturnType<typeof setInterval>;
  /** Whether `list --all-machines` stands in for a machine list, and its next call. */
  private falling = false;
  private fallback?: ReturnType<typeof setTimeout>;
  /** Kills the `machine list` and `--all-machines` calls in flight on stop. */
  private abort = new AbortController();
  /** The order `machine list` gave, or null while there is none. */
  private order: string[] | null = null;
  private stopped = false;
  private readonly cmd: string;
  private readonly intervalMs: number;
  private readonly boundMs: number;
  private readonly machineListMs: number;
  private readonly fallbackMs: number;
  readonly now: () => number;
  private readonly log: (line: string) => void;
  constructor(opts: PollerOptions) {
    this.cmd = opts.cmd;
    this.intervalMs = opts.intervalMs ?? interval_ms;
    this.boundMs = opts.boundMs ?? bound_ms;
    this.machineListMs = opts.machineListMs ?? machine_list_ms;
    this.fallbackMs = opts.fallbackMs ?? fallback_ms;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }
  /** Starts polling; resolves once the local machine answered (or failed)
   * the first time. The machine list is asked meanwhile, never waited for. */
  async start(): Promise<void> {
    const first = this.add("local");
    void this.refresh();
    this.listing = setInterval(() => void this.refresh(), this.machineListMs);
    // Data ages even when no answer comes: staleness is checked every interval.
    this.tick = setInterval(() => this.evaluate(), this.intervalMs);
    await first;
  }
  on(_event: "change", fn: (r: Resolution) => void): void {
    this.listeners.push(fn);
  }
  /** The target now, from the newest data of every machine. */
  resolve(): Resolution {
    return resolve(this.machines, this.previous, this.now());
  }
  /** Stops every loop and kills the calls in flight. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.tick);
    clearInterval(this.listing);
    clearTimeout(this.fallback);
    this.abort.abort();
    for (const name of [...this.loops.keys()]) this.drop(name);
  }
  /** Asks `machine list` and gives each listed machine a loop, dropping the
   * machines no longer listed. Without an answer, falls back to `--all-machines`. */
  private async refresh(): Promise<void> {
    let names: string[] | null = null;
    try {
      const out = await subprocess.run([this.cmd, "machine", "list"], {
        timeoutMs: slow_bound_ms,
        signal: this.abort.signal,
      });
      if (!out.timedOut && out.code === 0) names = machineNames(out.stdout);
    } catch {}
    if (this.stopped) return;
    if (!names) {
      // The machines known so far keep their loops until a list says otherwise.
      if (this.order === null && !this.falling) {
        this.falling = true;
        void this.fallBack();
      }
      return;
    }
    if (this.falling) {
      this.falling = false;
      clearTimeout(this.fallback);
      // Machines the fallback filled in get loops of their own now.
      this.machines = this.machines.filter(m => this.loops.has(m.name));
    }
    if (this.order === null || this.order.join("\n") !== names.join("\n")) this.log(`corgi: machines ${names.join(", ")}`);
    this.order = names;
    for (const name of names) void this.add(name);
    for (const name of [...this.loops.keys()]) if (name !== "local" && !names.includes(name)) this.drop(name);
    this.sort();
    this.evaluate();
  }
  /** Keeps `machines` in the listing's order; local, when unlisted, first. */
  private sort(): void {
    const order = this.order ?? [];
    this.machines.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }
  /** `list --all-machines --json`: every machine but the local one, which has
   * its own loop. Its exit code counts for nothing when its JSON parses. */
  private async fallBack(): Promise<void> {
    const started = this.now();
    let out: subprocess.Result;
    try {
      out = await subprocess.run([this.cmd, "list", "--all-machines", "--json"], {
        timeoutMs: this.boundMs,
        signal: this.abort.signal,
      });
    } catch {
      return this.again(started);
    }
    if (this.stopped || !this.falling) return;
    this.again(started);
    const reply = jsonFrom(out.stdout) as { machines?: unknown } | null;
    if (!reply || !Array.isArray(reply.machines)) return;
    const listed = new Set<string>(["local"]);
    for (const entry of reply.machines) {
      const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null,
        name = machineName(e?.machine) ? e.machine : null;
      if (!e || !name || name === "local") continue;
      listed.add(name);
      let m = this.machines.find(x => x.name === name);
      if (!m) this.machines.push((m = blank(name)));
      if (e.ok === false) this.fail(m, typeof e.err === "string" ? e.err : "unreachable");
      else this.take(m, e);
    }
    this.machines = this.machines.filter(m => listed.has(m.name));
    this.evaluate();
  }
  /** The next `--all-machines` call, an interval after the last one started. */
  private again(started: number): void {
    if (this.stopped || !this.falling) return;
    this.fallback = setTimeout(() => void this.fallBack(), Math.max(0, this.fallbackMs - (this.now() - started)));
  }
  /** Starts a loop for `name`; resolves after its first poll. */
  private add(name: string): Promise<void> {
    if (this.loops.has(name) || this.stopped) return Promise.resolve();
    const machine = this.machines.find(m => m.name === name) ?? blank(name),
      loop: Loop = { machine, abort: new AbortController(), stopped: false };
    if (!this.machines.includes(machine)) this.machines.push(machine);
    this.loops.set(name, loop);
    return this.run(loop);
  }
  /** Stops polling `name`, killing a call in flight, and forgets its data. */
  private drop(name: string): void {
    const loop = this.loops.get(name);
    if (!loop) return;
    loop.stopped = true;
    loop.abort.abort();
    clearTimeout(loop.timer);
    this.loops.delete(name);
    this.machines = this.machines.filter(m => m !== loop.machine);
    if (!this.stopped) this.log(`corgi: ${name} no longer listed`);
  }
  private async run(loop: Loop): Promise<void> {
    const started = this.now();
    await this.poll(loop);
    if (loop.stopped) return;
    this.evaluate();
    const wait = Math.max(0, this.intervalMs - (this.now() - started));
    loop.timer = setTimeout(() => void this.run(loop), wait);
  }
  /** One `list --json` for the loop's machine. */
  private async poll(loop: Loop): Promise<void> {
    const m = loop.machine;
    let out: subprocess.Result;
    try {
      out = await subprocess.run(on(this.cmd, m.name, "list", "--json"), {
        timeoutMs: this.boundMs,
        signal: loop.abort.signal,
      });
    } catch (error) {
      if (loop.stopped) return;
      const name = (error as Error)?.message;
      this.fail(m, name === "FileNotFound" || name === "AccessDenied" ? notFound(this.cmd) : String(name));
      return;
    }
    if (loop.stopped) return;
    if (out.timedOut) return this.fail(m, "no answer in time");
    if (out.code !== 0) return this.fail(m, refused(jsonFrom(out.stdout)) ?? firstLine(out.stderr, out.code));
    this.take(m, jsonFrom(out.stdout));
  }
  /** A machine's `list --json` reply, parsed (from its own call or `--all-machines`). */
  private take(m: Machine, reply: unknown): void {
    const parsed = parseReply(reply);
    if (!parsed.ok) {
      const why = refused(reply);
      if (why) return this.fail(m, why);
      if (m.state !== "not-understood") this.log(`corgi: ${m.name}: ${not_understood}`);
      m.state = "not-understood";
      m.error = not_understood;
      return;
    }
    if (m.state !== "ok") this.log(`corgi: ${m.name}: answering`);
    m.state = "ok";
    m.error = null;
    m.fetchedAt = this.now();
    m.viewers = parsed.viewers;
    m.panes = parsed.panes;
  }
  private fail(m: Machine, why: string): void {
    if (m.error !== why) this.log(`corgi: ${m.name}: ${why}`);
    m.state = "unreachable";
    m.error = why;
  }
  /** Announces the target when it, its label or the reason changed. */
  private evaluate(): void {
    if (this.stopped) return;
    const r = this.resolve(),
      key = JSON.stringify(r.target ? [r.target.machine, r.target.pane, r.target.label] : [r.reason]);
    if (key === this.shown) return;
    this.shown = key;
    for (const fn of this.listeners) fn(r);
  }
}
/** The `err` of a reply with `ok: false`, if that is what `reply` is. */
function refused(reply: unknown): string | null {
  const r = reply && typeof reply === "object" ? (reply as Record<string, unknown>) : null;
  return r && r.ok === false && typeof r.err === "string" ? r.err : null;
}
