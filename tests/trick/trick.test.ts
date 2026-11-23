import { test, expect, afterEach } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runTrick, retry_ms, type TrickIo } from "../../src/trick/trick";
import { cleanup, fakeCorgi, folder, later, serve, until } from "./helpers";

afterEach(cleanup);

/** The trick over a fake Corgi, ended after the test. Its own environment
 * points the computed channel path into a private folder, never at a real
 * corgi-voice. */
function run(over: Partial<TrickIo> = {}) {
  const corgi = fakeCorgi();
  let code: number | null = null;
  const done = runTrick({
    input: corgi.input,
    write: corgi.write,
    log: corgi.log,
    env: { HOME: folder(), XDG_RUNTIME_DIR: folder("cv-rt-") },
    retryMs: 50,
    ...over,
  }).then(c => (code = c));
  later(() => corgi.end());
  return { corgi, done, code: () => code };
}
const note = (color: string, action: string) => ({
  op: "ui.set",
  key: "voice",
  view: { kind: "title", spans: [{ text: "♫" }], color, action, slot: "voice" },
});
const dot = (color: string) => ({ op: "ui.set", key: "voice", view: { kind: "title", spans: [{ text: "●" }], color } });
const remove = { op: "ui.remove", key: "voice" };

test("nothing is drawn before ready; then the listening note (US1 scenario 1)", async () => {
  const served = await serve(),
    { corgi } = run();
  await Bun.sleep(100);
  expect(corgi.out).toEqual([]);
  corgi.ready({ socket: served.path });
  await until(() => corgi.out.length === 1);
  expect(corgi.raw).toEqual([JSON.stringify(note("accent", "toggle-1"))]);
  expect(corgi.logs).toEqual([]);
});

test("mute, recording, pause and end each redraw once, within a second (US1 scenarios 2 and 3, SC-001)", async () => {
  const { path, session, recorder } = await serve(),
    { corgi } = run();
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  const steps: [() => void, object][] = [
    [() => session.setMuted(true), note("faint", "toggle-2")],
    [() => recorder.set("running"), dot("hot")],
    [() => recorder.set("paused"), dot("warm")],
    [() => recorder.set("running"), dot("hot")],
    // Stopping counts as none: back to the note in the mute state's color.
    [() => recorder.set("stopping"), note("faint", "toggle-3")],
    [() => session.setMuted(false), note("accent", "toggle-4")],
  ];
  for (const [i, [act, want]] of steps.entries()) {
    const started = performance.now();
    act();
    await until(() => corgi.out.length === i + 2, 1000);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(corgi.last()).toEqual(want);
  }
  await Bun.sleep(50);
  expect(corgi.out).toHaveLength(steps.length + 1);
});

test("a recording shows while voice cannot listen, and the item goes and comes back with availability (US1 scenario 6)", async () => {
  const { path, session, recorder } = await serve(),
    { corgi } = run();
  session.unavailable = "mic_missing";
  corgi.ready({ socket: path });
  await Bun.sleep(150);
  expect(corgi.out).toEqual([]);
  recorder.set("running");
  await until(() => corgi.out.length === 1);
  expect(corgi.last()).toEqual(dot("hot"));
  recorder.set(null);
  await until(() => corgi.out.length === 2);
  expect(corgi.last()).toEqual(remove);
  session.setUnavailable(null);
  await until(() => corgi.out.length === 3);
  expect(corgi.last()).toEqual(note("accent", "toggle-1"));
  session.setUnavailable("server_down");
  await until(() => corgi.out.length === 4);
  expect(corgi.last()).toEqual(remove);
  await Bun.sleep(50);
  expect(corgi.sets()).toHaveLength(2);
});

test("a target or reason change writes nothing (FR-004)", async () => {
  const { path, session } = await serve(),
    { corgi } = run();
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  session.focus = "api · logs";
  session.changed();
  session.viewer = false;
  session.focus = null;
  session.reason = "Corgi unreachable";
  session.changed();
  await Bun.sleep(150);
  expect(corgi.out).toHaveLength(1);
});

test("corgi-voice quitting removes the item within a second; starting again brings it back (US1 scenarios 4 and 5)", async () => {
  const served = await serve(),
    { corgi } = run({ retryMs: 200 });
  corgi.ready({ socket: served.path });
  await until(() => corgi.out.length === 1);
  let started = performance.now();
  served.close();
  await until(() => corgi.out.length === 2, 1000);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(corgi.last()).toEqual(remove);
  expect(corgi.logs).toEqual(["corgi-voice trick: corgi-voice not reachable"]);
  await Bun.sleep(500);
  // Retrying quietly: no more lines, no more logs.
  expect(corgi.out).toHaveLength(2);
  expect(corgi.logs).toHaveLength(1);
  started = performance.now();
  const again = await serve({ path: served.path });
  again.session.setMuted(true);
  await until(() => corgi.out.length === 3, 3000);
  expect(performance.now() - started).toBeLessThan(3000);
  expect(corgi.last()).toEqual(note("faint", "toggle-2"));
  expect(corgi.logs).toEqual(["corgi-voice trick: corgi-voice not reachable", "corgi-voice trick: corgi-voice reachable again"]);
});

test("the end of input ends the trick with 0 within a second, connected or retrying (FR-007)", async () => {
  const { path } = await serve();
  for (const socket of [path, join(folder(), "none.sock")]) {
    const { corgi, done, code } = run({ retryMs: 60_000 });
    corgi.ready({ socket });
    await Bun.sleep(150);
    const started = performance.now();
    corgi.end();
    await done;
    expect(code()).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
  }
});

test("Corgi's error replies are logged once per kind, and garbage lines are ignored (Edge Cases)", async () => {
  const { path, session } = await serve(),
    { corgi } = run();
  for (const line of ["not json", "", "[1]", "null", '"ready"', '{"event":"other"}', '{"id":"x","ok":true}', '{"event":"ui.press"}'])
    corgi.send(line);
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  corgi.send({ id: null, error: "UnknownOp" });
  corgi.send({ id: null, error: "UnknownOp" });
  corgi.send({ id: 3, error: "TitleExists" });
  corgi.send({ id: null, error: { nested: true } });
  // Each later change still sends its one ui.set: no retry loop.
  session.setMuted(true);
  await until(() => corgi.out.length === 2);
  corgi.send({ id: null, error: "TitleExists" });
  session.setMuted(false);
  await until(() => corgi.out.length === 3);
  await Bun.sleep(50);
  expect(corgi.logs).toEqual(["corgi-voice trick: Corgi refused the item: UnknownOp", "corgi-voice trick: Corgi refused the item: TitleExists"]);
  expect(corgi.out).toHaveLength(3);
});

const listening = { pid: 1, muted: false, mode: "listening", unavailable: null, reason: null, recording: "none", target: null, updated_at: 1 };
/** A stand-in channel at a fresh path: `answer` runs on each connection's request. */
function stub(answer: (s: { write(t: string): void; end(): void }, n: number) => void) {
  const path = join(folder("cv-st-"), "c.sock");
  let opened = 0;
  const server = Bun.listen({
    unix: path,
    socket: {
      open: () => void opened++,
      data: s => answer(s, opened),
    },
  });
  later(() => server.stop(true));
  return { path, opened: () => opened };
}

test("a channel that answers garbage mid-watch removes the item and is tried again (FR-006)", async () => {
  const st = stub((s, n) => {
      s.write(JSON.stringify({ ok: true, state: listening }) + "\n");
      if (n === 1) setTimeout(() => s.write("garbage\n"), 50);
    }),
    { corgi } = run({ retryMs: 50 });
  corgi.ready({ socket: st.path });
  await until(() => corgi.out.length === 3);
  expect(corgi.out).toEqual([note("accent", "toggle-1"), remove, note("accent", "toggle-2")]);
  expect(st.opened()).toBe(2);
  expect(corgi.logs).toEqual(["corgi-voice trick: corgi-voice not reachable", "corgi-voice trick: corgi-voice reachable again"]);
});

test("a channel that never answers within a second draws nothing and is tried again (FR-006)", async () => {
  const st = stub(() => {}),
    { corgi } = run({ retryMs: 50 });
  corgi.ready({ socket: st.path });
  await until(() => st.opened() >= 2, 3000);
  expect(corgi.out).toEqual([]);
  expect(corgi.logs).toEqual(["corgi-voice trick: corgi-voice not reachable"]);
});

test("a channel that closes after its first answer removes the item at once", async () => {
  const st = stub((s, n) => {
      s.write(JSON.stringify({ ok: true, state: listening }) + "\n");
      if (n === 1) setTimeout(() => s.end(), 50);
    }),
    { corgi } = run({ retryMs: 100 });
  corgi.ready({ socket: st.path });
  await until(() => corgi.out.length === 3);
  expect(corgi.out).toEqual([note("accent", "toggle-1"), remove, note("accent", "toggle-2")]);
});

test("without corgi-voice for a while: one log line and no ui.set or ui.remove (SC-003)", async () => {
  const { corgi } = run({ retryMs: 20 });
  corgi.ready({ socket: join(folder(), "none.sock") });
  // 60 s at 2 s per try is 30 tries; this is more.
  await Bun.sleep(1000);
  expect(corgi.out).toEqual([]);
  expect(corgi.logs).toEqual(["corgi-voice trick: corgi-voice not reachable"]);
});

test("connected and idle: no output and no new connections (FR-010)", async () => {
  const st = stub(s => void s.write(JSON.stringify({ ok: true, state: listening }) + "\n")),
    { corgi } = run({ retryMs: 20 });
  corgi.ready({ socket: st.path });
  await until(() => corgi.out.length === 1);
  await Bun.sleep(1100);
  expect(corgi.out).toHaveLength(1);
  expect(st.opened()).toBe(1);
  expect(corgi.logs).toEqual([]);
});

test("without a usable config.socket the path comes from the trick's own environment (FR-008)", async () => {
  for (const config of [{}, { socket: "" }, { socket: 42 }, { socket: null }, { other: "x" }]) {
    const rt = folder("cv-rt-"),
      { path } = await serve({ path: join(rt, "corgi-voice.sock") }),
      { corgi } = run({ env: { HOME: folder(), XDG_RUNTIME_DIR: rt } });
    corgi.ready(config);
    await until(() => corgi.out.length === 1);
    expect([config, corgi.last()]).toEqual([config, note("accent", "toggle-1")]);
    expect(path.startsWith(rt)).toBe(true);
  }
  // A config that is no object at all.
  const rt = folder("cv-rt-");
  await serve({ path: join(rt, "corgi-voice.sock") });
  const { corgi } = run({ env: { HOME: folder(), XDG_RUNTIME_DIR: rt } });
  corgi.send({ event: "ready", version: 2, config: "x", kv: {} });
  await until(() => corgi.out.length === 1);
  // config.socket wins over the environment.
  const other = await serve(),
    second = run({ env: { HOME: folder(), XDG_RUNTIME_DIR: rt } });
  other.session.setMuted(true);
  second.corgi.ready({ socket: other.path });
  await until(() => second.corgi.out.length === 1);
  expect(second.corgi.last()).toEqual(note("faint", "toggle-1"));
});

test("a socket folder that is not safe: one log line, idle, 0 at the end of input (FR-008)", async () => {
  // Injected: the path function refuses.
  const injected = run({
    socketPath: () => {
      throw Object.assign(Error("SocketFolderUnsafe"), { detail: "/t/corgi-voice-1: others may write to it" });
    },
  });
  injected.corgi.ready();
  await Bun.sleep(100);
  injected.corgi.end();
  await injected.done;
  expect([injected.code(), injected.corgi.out, injected.corgi.logs]).toEqual([
    0,
    [],
    ["corgi-voice trick: /t/corgi-voice-1: others may write to it"],
  ]);
  // The real thing: a socket path too long for the usual place, and a $TMPDIR others may write to.
  const tmp = join(folder(), "open");
  mkdirSync(tmp);
  chmodSync(tmp, 0o777);
  const real = run({ env: { HOME: folder(), XDG_STATE_HOME: join(folder(), "s".repeat(120)), TMPDIR: tmp } });
  real.corgi.ready();
  await Bun.sleep(100);
  real.corgi.end();
  await real.done;
  expect(real.code()).toBe(0);
  expect(real.corgi.out).toEqual([]);
  expect(real.corgi.logs).toHaveLength(1);
  expect(real.corgi.logs[0]).toContain("writable by others and not sticky");
});

test("a second ready event changes nothing", async () => {
  const a = await serve(),
    b = await serve(),
    { corgi } = run();
  b.session.setMuted(true);
  corgi.ready({ socket: a.path });
  await until(() => corgi.out.length === 1);
  corgi.ready({ socket: b.path });
  await Bun.sleep(150);
  expect(corgi.out).toEqual([note("accent", "toggle-1")]);
});

/** Lines after the first `n`. */
const after = (out: any[], n: number) => out.slice(n);

test("a press on the listening note mutes, as m does, with one ui.set (US2 scenario 1, SC-002)", async () => {
  const { path, session } = await serve(),
    { corgi } = run();
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  corgi.press("toggle-1");
  await until(() => corgi.out.length === 2);
  await Bun.sleep(150);
  expect(after(corgi.out, 1)).toEqual([note("faint", "toggle-2")]);
  expect([session.muted, session.sets, session.events]).toEqual([true, [true], ["muted from outside"]]);
});

test("a press on the muted note unmutes, with one ui.set (US2 scenario 2)", async () => {
  const { path, session } = await serve(),
    { corgi } = run();
  session.muted = true;
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  expect(corgi.last()).toEqual(note("faint", "toggle-1"));
  corgi.press("toggle-1");
  await until(() => corgi.out.length === 2);
  await Bun.sleep(150);
  expect(after(corgi.out, 1)).toEqual([note("accent", "toggle-2")]);
  expect([session.muted, session.events]).toEqual([false, ["unmuted from outside"]]);
  // And back again on the fresh action.
  corgi.press("toggle-2");
  await until(() => corgi.out.length === 3);
  expect(corgi.last()).toEqual(note("faint", "toggle-3"));
});

test("a refused unmute changes nothing, removes the item once, and the trick goes on (US2 scenario 3)", async () => {
  const { path, session } = await serve(),
    { corgi, code } = run();
  session.muted = true;
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  // The microphone goes away just before the press is handled, unannounced.
  session.unavailable = "mic_missing";
  corgi.press("toggle-1");
  await until(() => corgi.out.length === 2);
  await Bun.sleep(150);
  expect(after(corgi.out, 1)).toEqual([remove]);
  expect([session.muted, session.events, code()]).toEqual([true, [], null]);
  // Voice can listen again: one armed note, which works.
  session.setUnavailable(null);
  await until(() => corgi.out.length === 3);
  expect(corgi.last()).toEqual(note("faint", "toggle-2"));
  corgi.press("toggle-2");
  await until(() => corgi.out.length === 4);
  expect([corgi.last(), session.muted]).toEqual([note("accent", "toggle-3"), false]);
});

test("stale actions are ignored, and a double press toggles once (US2 scenario 4)", async () => {
  const { path, session } = await serve(),
    { corgi } = run();
  // Before ready: nothing is armed.
  corgi.press("toggle-1");
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  for (const action of ["toggle-0", "toggle-2", "toggle-99", "", "voice"]) corgi.press(action);
  corgi.send({ event: "ui.press", action: 1 });
  corgi.send({ event: "ui.press" });
  await Bun.sleep(150);
  expect([session.sets, corgi.out.length]).toEqual([[], 1]);
  corgi.press("toggle-1");
  corgi.press("toggle-1");
  await until(() => corgi.out.length === 2);
  await Bun.sleep(150);
  expect([session.sets, corgi.out.length]).toEqual([[true], 2]);
  // The drawing before is gone: its action no longer toggles.
  corgi.press("toggle-1");
  await Bun.sleep(150);
  expect([session.sets, corgi.out.length]).toEqual([[true], 2]);
});

test("a recording item has no action, and a press for an older action does nothing (US2 scenario 5)", async () => {
  const { path, session, recorder } = await serve(),
    { corgi } = run();
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  recorder.set("running");
  await until(() => corgi.out.length === 2);
  expect(corgi.last().view.action).toBeUndefined();
  expect(corgi.last().view.slot).toBeUndefined();
  corgi.press("toggle-1");
  recorder.set("paused");
  await until(() => corgi.out.length === 3);
  corgi.press("toggle-1");
  await Bun.sleep(150);
  expect([session.sets, session.muted, corgi.last()]).toEqual([[], false, dot("warm")]);
});

test("a press while corgi-voice is not reachable is ignored", async () => {
  const served = await serve(),
    { corgi } = run({ retryMs: 60_000 });
  corgi.ready({ socket: served.path });
  await until(() => corgi.out.length === 1);
  served.close();
  await until(() => corgi.out.length === 2);
  // A corgi-voice back at the same path while the trick waits to retry: a
  // toggle sent anyway would reach it and show up in its session.
  const again = await serve({ path: served.path });
  corgi.press("toggle-1");
  await Bun.sleep(150);
  expect([again.session.sets, served.session.sets, corgi.out.length]).toEqual([[], [], 2]);
});

test("the retry schedule is 2 s (FR-006), so a restarted corgi-voice shows within 3 s (US1 scenario 5)", () => {
  expect(retry_ms).toBe(2000);
});

/** A stand-in channel that hands each request's op and socket to `on`. */
function channel(on: (op: string, s: { write(t: string): void; end(): void }) => void) {
  const path = join(folder("cv-ch-"), "c.sock"),
    server = Bun.listen({
      unix: path,
      socket: { data: (s, chunk) => on(JSON.parse(new TextDecoder().decode(chunk)).op, s) },
    });
  later(() => server.stop(true));
  return path;
}
const answer = (state: object) => JSON.stringify({ ok: true, state: { ...listening, ...state } }) + "\n";

test("corgi-voice quitting during a toggle leaves the item removed", async () => {
  let watcher: { end(): void } | null = null;
  const path = channel((op, s) => {
      if (op === "watch") return void ((watcher = s), s.write(answer({})));
      // It quits: the watch ends at once, the toggle gets no answer.
      watcher?.end();
      setTimeout(() => s.end(), 100);
    }),
    { corgi } = run({ retryMs: 60_000 });
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  corgi.press("toggle-1");
  await until(() => corgi.out.length === 2);
  await Bun.sleep(300);
  expect(corgi.out).toEqual([note("accent", "toggle-1"), remove]);
});

test("a recording that starts during a toggle shows at once and stays after it (data-model Transitions)", async () => {
  let watcher: { write(t: string): void } | null = null;
  const path = channel((op, s) => {
      if (op === "watch") return void ((watcher = s), s.write(answer({})));
      // The watch hears of the recording before the toggle's answer, which is older.
      setTimeout(() => watcher?.write(answer({ muted: true, mode: "muted", recording: "running", updated_at: 3 })), 20);
      setTimeout(() => s.write(answer({ muted: true, mode: "muted", updated_at: 2 })), 80);
    }),
    { corgi } = run();
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  corgi.press("toggle-1");
  await until(() => corgi.out.length === 2);
  await Bun.sleep(250);
  expect(corgi.out).toEqual([note("accent", "toggle-1"), dot("hot")]);
});

test("the toggle's answer arriving before the watch's push draws once, with a fresh action", async () => {
  let watcher: { write(t: string): void } | null = null;
  const path = channel((op, s) => {
      if (op === "watch") return void ((watcher = s), s.write(answer({})));
      s.write(answer({ muted: true, mode: "muted", updated_at: 2 }));
      setTimeout(() => watcher?.write(answer({ muted: true, mode: "muted", updated_at: 2 })), 60);
    }),
    { corgi } = run();
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  corgi.press("toggle-1");
  await until(() => corgi.out.length === 2);
  await Bun.sleep(200);
  expect(corgi.out).toEqual([note("accent", "toggle-1"), note("faint", "toggle-2")]);
});

test("a toggle that gets no answer re-arms the note from the watch", async () => {
  const path = channel((op, s) => {
      if (op === "watch") return void s.write(answer({}));
      setTimeout(() => s.end(), 30);
    }),
    { corgi } = run();
  corgi.ready({ socket: path });
  await until(() => corgi.out.length === 1);
  corgi.press("toggle-1");
  await until(() => corgi.out.length === 2);
  expect(corgi.last()).toEqual(note("accent", "toggle-2"));
});

test("two tricks on one corgi-voice each keep their own item, and one press toggles once (clarification Q3)", async () => {
  const { path, session } = await serve(),
    a = run(),
    b = run();
  a.corgi.ready({ socket: path });
  b.corgi.ready({ socket: path });
  await until(() => a.corgi.out.length === 1 && b.corgi.out.length === 1);
  a.corgi.press("toggle-1");
  await until(() => a.corgi.out.length === 2 && b.corgi.out.length === 2);
  await Bun.sleep(150);
  expect([a.corgi.out.length, b.corgi.out.length]).toEqual([2, 2]);
  expect([a.corgi.last(), b.corgi.last()]).toEqual([note("faint", "toggle-2"), note("faint", "toggle-2")]);
  expect([session.sets, session.events]).toEqual([[true], ["muted from outside"]]);
});
