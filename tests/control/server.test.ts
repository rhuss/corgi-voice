import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startServer, ops, max_line, idle_ms, max_unsent, type SessionLike, type RecorderLike } from "../../src/control/server";
import type { RecordingState } from "../../src/voice/recorder";
import type { Unavailable } from "../../src/voice/session";
import { VoiceSession } from "../../src/voice/session";
import { Segmenter } from "../../src/voice/segmenter";
import { Recorder } from "../../src/voice/recorder";
import type { VoiceLink } from "../../src/voice/link";
import type { Tuning } from "../../src/voice/tuning";
import { muteWhileRecording } from "../../src/main";

const dirs: string[] = [],
  servers: { close(): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A socket path in a fresh folder. */
function socket(): string {
  const dir = mkdtempSync(join(tmpdir(), "cv-ctl-"));
  dirs.push(dir);
  return join(dir, "control.sock");
}

/** The session as the channel sees it: `setMuted` follows `m`'s rules. */
class StubSession implements SessionLike {
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
  changed() {
    for (const fn of this.listeners) fn();
  }
}
class StubRecorder implements RecorderLike {
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
async function serve(over: { idleMs?: number; maxUnsent?: number; session?: SessionLike; recorder?: RecorderLike } = {}) {
  const path = socket(),
    session = (over.session ?? new StubSession()) as StubSession,
    recorder = (over.recorder ?? new StubRecorder()) as StubRecorder,
    server = await startServer({ path, session, recorder, pid: 4242, idleMs: over.idleMs, maxUnsent: over.maxUnsent });
  servers.push(server);
  return { path, session, recorder, server };
}

const decoder = new TextDecoder();
/** Connects to `path`, sends `text` (nothing when null), and collects the
 * answer lines until the server closes, `lines` lines came, or `ms` passed. */
function talk(
  path: string,
  text: string | null,
  opts: { lines?: number; ms?: number } = {},
): Promise<{ lines: any[]; closed: boolean; ms: number }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let buf = "",
      closed = false,
      done = false,
      sock: { end(): void } | null = null;
    const lines: any[] = [],
      finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          sock?.end();
        } catch {}
        resolve({ lines, closed, ms: performance.now() - started });
      },
      timer = setTimeout(finish, opts.ms ?? 3000);
    Bun.connect({
      unix: path,
      socket: {
        open(s) {
          sock = s;
          if (text !== null) s.write(text);
        },
        data(_s, chunk) {
          buf += decoder.decode(chunk);
          for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
            lines.push(JSON.parse(buf.slice(0, i)));
            buf = buf.slice(i + 1);
          }
          if (opts.lines && lines.length >= opts.lines) finish();
        },
        close() {
          closed = true;
          finish();
        },
        error(_s, e) {
          reject(e);
        },
      },
    }).catch(reject);
  });
}
const ask = (path: string, op: string) => talk(path, JSON.stringify({ op }) + "\n");

test("the socket is the user's alone, a stale one is replaced, and close() removes it", async () => {
  const path = socket();
  // A dead corgi-voice's socket file.
  writeFileSync(path, "");
  const server = await startServer({ path, session: new StubSession(), recorder: new StubRecorder(), pid: 1 });
  servers.push(server);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect((await ask(path, "status")).lines).toHaveLength(1);
  server.close();
  expect(existsSync(path)).toBe(false);
  // Twice is fine.
  server.close();
});

test("status answers the state and closes the connection", async () => {
  const { path } = await serve(),
    { lines, closed } = await ask(path, "status");
  expect(closed).toBe(true);
  expect(lines).toEqual([
    {
      ok: true,
      state: {
        pid: 4242,
        muted: false,
        mode: "listening",
        unavailable: null,
        reason: null,
        recording: "none",
        target: { machine: "local", label: "bat · corgi-voice" },
        updated_at: expect.any(Number),
      },
    },
  ]);
});

test("mute and unmute go through setMuted and add a row only when the setting changed", async () => {
  const { path, session } = await serve();
  let a = await ask(path, "mute");
  expect([a.lines[0].ok, a.lines[0].state.muted, a.lines[0].state.mode]).toEqual([true, true, "muted"]);
  expect(session.muted).toBe(true);
  // Already muted: answered, no row.
  a = await ask(path, "mute");
  expect([a.lines[0].ok, a.lines[0].state.muted]).toEqual([true, true]);
  a = await ask(path, "unmute");
  expect([a.lines[0].ok, a.lines[0].state.mode]).toEqual([true, "listening"]);
  a = await ask(path, "unmute");
  expect(a.lines[0].ok).toBe(true);
  expect(session.sets).toEqual([true, true, false, false]);
  expect(session.events).toEqual(["muted from outside", "unmuted from outside"]);
});

test("toggle follows the mode the window shows", async () => {
  const { path, session } = await serve();
  expect((await ask(path, "toggle")).lines[0].state.mode).toBe("muted");
  expect(session.muted).toBe(true);
  expect((await ask(path, "toggle")).lines[0].state.mode).toBe("listening");
  expect(session.events).toEqual(["muted from outside", "unmuted from outside"]);
});

test("unmuting while voice cannot listen is refused, with no change and no row (US1 scenario 3)", async () => {
  const { path, session } = await serve();
  session.muted = true;
  session.unavailable = "mic_missing";
  for (const op of ["unmute", "toggle"]) {
    const { lines, closed } = await ask(path, op);
    expect(closed).toBe(true);
    expect(lines[0]).toMatchObject({ ok: false, err: "cannot_listen", state: { muted: true, mode: "muted", unavailable: "mic_missing" } });
  }
  expect(session.muted).toBe(true);
  expect(session.events).toEqual([]);
  // Not muted, but MUTED shows: toggle still means unmute, and is refused.
  session.muted = false;
  expect((await ask(path, "toggle")).lines[0]).toMatchObject({ ok: false, err: "cannot_listen" });
  expect(session.muted).toBe(false);
  // Muting is allowed, and decides the mode once voice can listen again.
  expect((await ask(path, "mute")).lines[0]).toMatchObject({ ok: true, state: { muted: true } });
  expect(session.events).toEqual(["muted from outside"]);
});

test("bad JSON, an unknown op and an overlong line are answered with their error and closed", async () => {
  const { path, session } = await serve();
  const cases: [string, string][] = [
    ["not json\n", "bad_json"],
    ['"status"\n', "bad_json"],
    ["[1]\n", "bad_json"],
    ['{"op":"dance"}\n', "unknown_op"],
    ["{}\n", "unknown_op"],
    ['{"op":5}\n', "unknown_op"],
    [JSON.stringify({ op: "status", pad: "x".repeat(5000) }) + "\n", "too_long"],
    // No newline yet, but past the limit already.
    ["x".repeat(5000), "too_long"],
  ];
  for (const [text, err] of cases) {
    const { lines, closed } = await talk(path, text);
    expect([text.slice(0, 20), closed, lines.length, lines[0]?.ok, lines[0]?.err]).toEqual([text.slice(0, 20), true, 1, false, err]);
    expect(lines[0].state.pid).toBe(4242);
  }
  // A line of exactly 4 KiB is still read.
  const exact = JSON.stringify({ op: "status", pad: "" }),
    padded = JSON.stringify({ op: "status", pad: "x".repeat(4096 - exact.length) });
  expect(Buffer.byteLength(padded)).toBe(4096);
  expect((await talk(path, padded + "\n")).lines[0].ok).toBe(true);
  // One byte more is refused.
  const over = JSON.stringify({ op: "status", pad: "x".repeat(4097 - exact.length) });
  expect(Buffer.byteLength(over)).toBe(4097);
  expect((await talk(path, over + "\n")).lines[0].err).toBe("too_long");
  expect(session.muted).toBe(false);
  expect((await ask(path, "status")).lines[0].ok).toBe(true);
});

test("a request split over several writes is read whole", async () => {
  const { path } = await serve();
  const answer = await new Promise<any>((resolve, reject) => {
    let buf = "";
    Bun.connect({
      unix: path,
      socket: {
        async open(s) {
          s.write('{"op":');
          await Bun.sleep(30);
          s.write('"status"}\n');
        },
        data(_s, chunk) {
          buf += decoder.decode(chunk);
        },
        close() {
          resolve(JSON.parse(buf));
        },
        error: (_s, e) => reject(e),
      },
    }).catch(reject);
  });
  expect(answer.ok).toBe(true);
});

test("a silent client is closed after the idle time, and the channel goes on", async () => {
  const { path } = await serve({ idleMs: 100 }),
    silent = await talk(path, null, { ms: 2000 });
  expect(silent.closed).toBe(true);
  expect(silent.lines).toEqual([]);
  expect(silent.ms).toBeGreaterThanOrEqual(90);
  expect(silent.ms).toBeLessThan(1000);
  // Half a request, then nothing: closed too.
  const half = await talk(path, '{"op":"sta', { ms: 2000 });
  expect([half.closed, half.lines]).toEqual([true, []]);
  expect((await ask(path, "status")).lines[0].ok).toBe(true);
});

test("the channel carries only state and mute: no typing, no recording, no settings (FR-006)", async () => {
  expect([...ops]).toEqual(["status", "mute", "unmute", "toggle", "watch"]);
  const { path, session, recorder } = await serve();
  for (const op of ["type", "send", "record", "stop", "pause", "set", "threshold"])
    expect((await ask(path, op)).lines[0]).toMatchObject({ ok: false, err: "unknown_op" });
  // Extra fields carry nothing either.
  expect((await talk(path, JSON.stringify({ op: "status", text: "hello", muted: true }) + "\n")).lines[0].state.muted).toBe(false);
  expect([session.muted, session.events, recorder.current]).toEqual([false, [], null]);
});

test("two toggles at once each get their own answer, applied in arrival order", async () => {
  const { path, session } = await serve();
  const first = ask(path, "toggle");
  await Bun.sleep(20);
  const second = ask(path, "toggle");
  const [a, b] = await Promise.all([first, second]);
  expect([a.lines[0].state.mode, b.lines[0].state.mode]).toEqual(["muted", "listening"]);
  expect(session.events).toEqual(["muted from outside", "unmuted from outside"]);
});

const idle: VoiceLink = {
  watch: () => new Promise(() => {}),
  type: async () => {
    throw Error("NoViewer");
  },
  on: () => {},
  close: () => {},
};
/** corgi-voice's own session and recorder, wired as main.ts wires them. */
function real() {
  const dir = mkdtempSync(join(tmpdir(), "cv-ctl-rec-"));
  dirs.push(dir);
  let muting: (on: boolean) => void = () => {};
  const tuning = { pause_break: 2, begin: () => {}, end: () => {} } as unknown as Tuning,
    recorder = new Recorder({ tuning, now: () => Date.now(), active: on => muting(on) }),
    session = new VoiceSession({
      link: idle,
      transcriber: { transcribe: async () => ({ text: "" }), on: () => {} },
      segmenter: new Segmenter({ threshold: 44, now: () => 0 }),
      now: () => Date.now(),
      recorder,
    });
  muting = muteWhileRecording(session);
  return { session, recorder, file: join(dir, "t.txt") };
}

test("unmuting from outside during a recording, then stopping it, restores the mute from before (US1 scenario 5)", async () => {
  for (const before of [false, true]) {
    const { session, recorder, file } = real();
    session.muted = before;
    const { path } = await serve({ session, recorder });
    recorder.start(file);
    expect(session.muted).toBe(true);
    const a = await ask(path, "unmute");
    expect(a.lines[0]).toMatchObject({ ok: true, state: { muted: false, recording: "running" } });
    expect(session.muted).toBe(false);
    await recorder.stop();
    expect([before, session.muted]).toEqual([before, before]);
    expect(session.events.map(e => e.text)).toEqual(["unmuted from outside"]);
  }
});

/** A watch: the lines so far, and whether the server closed it. */
function watching(path: string) {
  const lines: any[] = [];
  let buf = "",
    closed = false,
    sock: { end(): void } | null = null;
  const ended = new Promise<void>((resolve, reject) => {
    Bun.connect({
      unix: path,
      socket: {
        open(s) {
          sock = s;
          s.write('{"op":"watch"}\n');
        },
        data(_s, chunk) {
          buf += decoder.decode(chunk);
          for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
            lines.push(JSON.parse(buf.slice(0, i)));
            buf = buf.slice(i + 1);
          }
        },
        close() {
          closed = true;
          resolve();
        },
        error: (_s, e) => reject(e),
      },
    }).catch(reject);
  });
  return { lines, ended, closed: () => closed, stop: () => sock?.end() };
}
async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
}

test("watch sends the state now, then each change once, in order (SC-003)", async () => {
  const { path, session, recorder } = await serve(),
    w = watching(path);
  await until(() => w.lines.length === 1);
  expect(w.lines[0]).toMatchObject({ ok: true, state: { mode: "listening", recording: "none" } });
  const steps: [() => void, (s: any) => unknown, unknown][] = [
    [() => session.setMuted(true), s => s.mode, "muted"],
    [() => session.setMuted(false), s => s.mode, "listening"],
    [
      () => {
        session.unavailable = "mic_missing";
        session.changed();
      },
      s => [s.mode, s.unavailable],
      ["muted", "mic_missing"],
    ],
    [
      () => {
        session.unavailable = null;
        session.changed();
      },
      s => [s.mode, s.unavailable],
      ["listening", null],
    ],
    [() => recorder.set("running"), s => s.recording, "running"],
    [() => recorder.set("paused"), s => s.recording, "paused"],
    // Stopping hides REC at once.
    [() => recorder.set("stopping"), s => s.recording, "none"],
    [
      () => {
        session.focus = "api · logs";
        session.changed();
      },
      s => s.target.label,
      "api · logs",
    ],
    [
      () => {
        session.viewer = false;
        session.focus = null;
        session.reason = "no viewer attached";
        session.changed();
      },
      s => [s.target, s.reason],
      [null, "no viewer attached"],
    ],
    [
      () => {
        session.reason = "marovo unreachable: timed out";
        session.changed();
      },
      s => s.reason,
      "marovo unreachable: timed out",
    ],
  ];
  for (const [i, [act]] of steps.entries()) {
    act();
    // Events that change nothing the state shows send nothing: no duplicates.
    session.changed();
    recorder.set(recorder.current?.state ?? null);
    await until(() => w.lines.length === i + 2);
  }
  await Bun.sleep(50);
  expect(w.lines).toHaveLength(11);
  for (const [i, [, pick, want]] of steps.entries()) expect([i, pick(w.lines[i + 1].state)]).toEqual([i, want]);
  // updated_at moves with each change, and never back.
  const times = w.lines.map(l => l.state.updated_at);
  expect([...times].sort((a, b) => a - b)).toEqual(times);
  expect(w.lines.every(l => l.ok === true)).toBe(true);
  // A mute from outside reaches the watcher once, row and all.
  await ask(path, "mute");
  await until(() => w.lines.length === 12);
  await Bun.sleep(50);
  expect(w.lines).toHaveLength(12);
  // The idle close does not apply to a watch.
  expect(w.closed()).toBe(false);
  w.stop();
});

test("a watch outlives the idle time, and ends when the server closes", async () => {
  const { path, server } = await serve({ idleMs: 50 }),
    w = watching(path);
  await until(() => w.lines.length === 1);
  await Bun.sleep(200);
  expect(w.closed()).toBe(false);
  server.close();
  await w.ended;
  expect(w.lines).toHaveLength(1);
});

test("a watcher that stops reading is dropped past the unsent limit, without holding up anyone", async () => {
  const { path, session } = await serve({ maxUnsent: 2048 });
  const net = await import("node:net");
  let received = 0,
    closed = false;
  const slow = net.createConnection(path);
  await new Promise<void>(resolve => slow.once("connect", resolve));
  slow.write('{"op":"watch"}\n');
  await new Promise<void>(resolve => slow.once("data", () => resolve()));
  // From here on it reads nothing.
  slow.pause();
  slow.on("data", chunk => void (received += chunk.length));
  slow.on("close", () => void (closed = true));
  slow.on("error", () => {});
  for (let i = 0; i < 2000; i++) {
    session.focus = `pane ${i} ${"x".repeat(200)}`;
    session.changed();
  }
  // corgi-voice answers others meanwhile, at once.
  const started = performance.now(),
    a = await ask(path, "status");
  expect(a.lines[0].ok).toBe(true);
  expect(performance.now() - started).toBeLessThan(500);
  // Reading again, it finds the end: dropped, after far fewer than all the changes.
  slow.resume();
  await until(() => closed, 3000);
  expect(received).toBeLessThan(2000 * 200);
});

test("a watcher that goes away is forgotten", async () => {
  const { path, session } = await serve(),
    w = watching(path);
  await until(() => w.lines.length === 1);
  w.stop();
  await w.ended;
  session.setMuted(true);
  expect((await ask(path, "status")).lines[0].state.muted).toBe(true);
});

test("a new watcher gets a change nobody announced once, as its first line", async () => {
  const { path, session } = await serve(),
    first = watching(path);
  await until(() => first.lines.length === 1);
  // Changed without a change event: the next look finds it.
  session.muted = true;
  const second = watching(path);
  await until(() => second.lines.length >= 1);
  await Bun.sleep(50);
  expect(second.lines.map(l => l.state.mode)).toEqual(["muted"]);
  expect(first.lines.map(l => l.state.mode)).toEqual(["listening", "muted"]);
  first.stop();
  second.stop();
});

test("the limits are the spec's: 4 KiB requests, 2 s to send one, 64 KiB unsent for a watcher", () => {
  expect([max_line, idle_ms, max_unsent]).toEqual([4096, 2000, 64 * 1024]);
});

test("the socket is made 0600 under any umask, which is put back, in a state folder made 0700", async () => {
  const path = join(dirname(socket()), "state", "corgi-voice", "control.sock"),
    before = process.umask(0),
    listen = Bun.listen;
  // The mask in force when the socket is made: no looser moment before chmod.
  let at_bind = -1;
  (Bun as { listen: unknown }).listen = (o: Parameters<typeof Bun.listen>[0]) => {
    at_bind = process.umask();
    return listen(o);
  };
  try {
    const server = await startServer({ path, session: new StubSession(), recorder: new StubRecorder(), pid: 1 });
    servers.push(server);
    expect(at_bind).toBe(0o177);
    expect(process.umask()).toBe(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  } finally {
    (Bun as { listen: unknown }).listen = listen;
    process.umask(before);
  }
});

test("mutes from outside, refusals and dropped clients go to the log", async () => {
  const path = socket(),
    session = new StubSession(),
    log: string[] = [],
    server = await startServer({ path, session, recorder: new StubRecorder(), pid: 1, idleMs: 100, log: l => void log.push(l) });
  servers.push(server);
  await ask(path, "mute");
  await ask(path, "dance");
  await talk(path, null);
  expect(log.filter(l => !l.includes("listening on"))).toEqual([
    "control: muted from outside",
    "control: refused: unknown_op",
    "control: dropped a client: no request within 100 ms",
  ]);
});

test("a mute from outside while a gauge runs is taken, as m is, and the gauge goes on", async () => {
  const { session, recorder } = real();
  const { path } = await serve({ session, recorder });
  expect(session.startGauge()).toBeNull();
  expect((await ask(path, "mute")).lines[0]).toMatchObject({ ok: true, state: { muted: true, mode: "muted" } });
  expect(session.gauge).not.toBeNull();
  expect((await ask(path, "unmute")).lines[0]).toMatchObject({ ok: true, state: { muted: false, mode: "listening" } });
  expect(session.gauge).not.toBeNull();
  expect(session.events.map(e => e.text)).toEqual(["muted from outside", "unmuted from outside"]);
});
