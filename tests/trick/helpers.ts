//! What the trick tests share: a real control server on a short socket path
//! with a session and recorder the test moves, `until`, and a fake Corgi on
//! the trick's other end (its input lines, and what it writes and logs).
import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type SessionLike, type RecorderLike } from "../../src/control/server";
import type { RecordingState } from "../../src/voice/recorder";
import type { Unavailable } from "../../src/voice/session";

const dirs: string[] = [],
  cleanups: (() => void)[] = [];
/** Runs the `later` cleanups and removes the `folder`s. Each test file that
 * uses these helpers registers it with its own `afterEach(cleanup)`: Bun
 * loads this module once per run, so a hook here would bind to the first
 * file only. */
export function cleanup(): void {
  for (const fn of cleanups.splice(0).reverse())
    try {
      fn();
    } catch {}
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
/** Runs `fn` after the current test, newest first. */
export function later(fn: () => void): void {
  cleanups.push(fn);
}
/** A fresh folder, removed after the test. */
export function folder(prefix = "cv-trick-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
/** A socket path in a fresh folder, short enough for any system. */
export function socket(): string {
  return join(folder("cv-tr-"), "control.sock");
}

/** The session as the channel sees it: `setMuted` follows `m`'s rules. */
export class StubSession implements SessionLike {
  muted = false;
  unavailable: Unavailable | null = null;
  viewer = true;
  focus: string | null = "bat · corgi-voice";
  machine: string | null = "local";
  reason: string | null = null;
  link_state = "connected" as const;
  events: string[] = [];
  sets: boolean[] = [];
  private listeners: (() => void)[] = [];
  get available() {
    return this.unavailable === null;
  }
  setMuted(muted: boolean, restore = false) {
    this.sets.push(muted);
    if (!muted && !this.available && !restore) return;
    if (this.muted === muted) return;
    this.muted = muted;
    this.changed();
  }
  note(text: string) {
    this.events.push(text);
    this.changed();
  }
  on(_event: "change", fn: () => void) {
    this.listeners.push(fn);
  }
  /** Says the session changed, as the window's events do. */
  changed() {
    for (const fn of this.listeners) fn();
  }
  /** Voice can or cannot listen now. */
  setUnavailable(why: Unavailable | null) {
    this.unavailable = why;
    this.changed();
  }
}
export class StubRecorder implements RecorderLike {
  current: { state: RecordingState } | null = null;
  private listeners: (() => void)[] = [];
  on(_event: "change", fn: () => void) {
    this.listeners.push(fn);
  }
  set(state: RecordingState | null) {
    this.current = state && { state };
    for (const fn of this.listeners) fn();
  }
}
export type Served = { path: string; session: StubSession; recorder: StubRecorder; close(): void };
/** A real control server at `path` (a fresh one by default), closed after the test. */
export async function serve(over: { path?: string; session?: StubSession; recorder?: StubRecorder } = {}): Promise<Served> {
  const path = over.path ?? socket(),
    session = over.session ?? new StubSession(),
    recorder = over.recorder ?? new StubRecorder(),
    server = await startServer({ path, session, recorder, pid: 4242 });
  later(() => server.close());
  return { path, session, recorder, close: () => server.close() };
}

/** Waits until `check` holds, at most `ms`, and fails the test when it never does. */
export async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
}

/** Corgi's side of a trick: lines to send it, and what it wrote and logged. */
export function fakeCorgi() {
  const queue: string[] = [],
    out: any[] = [],
    raw: string[] = [],
    logs: string[] = [];
  let wake: (() => void) | null = null,
    ended = false;
  const input: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>(resolve => (wake = resolve));
        wake = null;
      }
    },
  };
  const poke = () => wake?.();
  return {
    input,
    /** Parsed lines the trick wrote, in order. */
    out,
    /** The same lines as written. */
    raw,
    logs,
    write: (line: string) => {
      raw.push(line);
      out.push(JSON.parse(line));
    },
    log: (line: string) => void logs.push(line),
    /** Sends one line (an object is sent as its JSON). */
    send(line: string | object) {
      queue.push(typeof line === "string" ? line : JSON.stringify(line));
      poke();
    },
    ready(config: Record<string, unknown> = {}) {
      this.send({ event: "ready", version: 2, config, kv: {} });
    },
    press(action: string) {
      this.send({ event: "ui.press", action, viewer: "v1" });
    },
    /** Closes the trick's input. */
    end() {
      ended = true;
      poke();
    },
    /** The `ui.set` lines so far. */
    sets: () => out.filter(l => l.op === "ui.set"),
    /** The `ui.remove` lines so far. */
    removes: () => out.filter(l => l.op === "ui.remove"),
    /** The last line written, if any. */
    last: () => out[out.length - 1],
  };
}
