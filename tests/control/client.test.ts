import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, watch, timeout_ms } from "../../src/control/client";
import { startServer } from "../../src/control/server";

const dirs: string[] = [],
  cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function socket(): string {
  const dir = mkdtempSync(join(tmpdir(), "cv-cli-"));
  dirs.push(dir);
  return join(dir, "control.sock");
}
/** A session and recorder that hold still. */
function still() {
  const listeners: (() => void)[] = [];
  const session = {
    muted: false,
    available: true,
    unavailable: null,
    viewer: true,
    focus: "bat · corgi-voice",
    machine: "local",
    reason: null,
    link_state: "connected" as const,
    setMuted(m: boolean) {
      session.muted = m;
      for (const fn of listeners) fn();
    },
    note: () => {},
    on: (_e: "change", fn: () => void) => void listeners.push(fn),
  };
  return { session, recorder: { current: null, on: () => {} } };
}

test("the default timeout is one second", () => {
  expect(timeout_ms).toBe(1000);
});

test("request returns the server's answer", async () => {
  const path = socket(),
    { session, recorder } = still(),
    server = await startServer({ path, session, recorder, pid: 9 });
  cleanups.push(() => server.close());
  const out = await request(path, "toggle", { timeoutMs: 1000 });
  expect(out).toMatchObject({ ok: true, answer: { ok: true, state: { pid: 9, mode: "muted" } } });
  expect(session.muted).toBe(true);
});

test("no socket file is not running", async () => {
  const path = socket();
  expect(await request(path, "status", { timeoutMs: 100 })).toEqual({ ok: false, why: "not_running" });
  expect(await watch(path, () => {}, { timeoutMs: 100 })).toBe("not_running");
});

test("a socket file nobody listens on, left by a killed corgi-voice, is not running", async () => {
  const path = socket(),
    child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `Bun.listen({ unix: ${JSON.stringify(path)}, socket: { data() {} } }); console.log("up"); setInterval(() => {}, 1000);`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
  cleanups.push(() => child.kill("SIGKILL"));
  const reader = child.stdout.getReader();
  await reader.read();
  child.kill("SIGKILL");
  await child.exited;
  expect(existsSync(path)).toBe(true);
  expect(await request(path, "status", { timeoutMs: 100 })).toEqual({ ok: false, why: "not_running" });
  // A plain file there is no corgi-voice either.
  rmSync(path);
  writeFileSync(path, "");
  expect(await request(path, "status", { timeoutMs: 100 })).toEqual({ ok: false, why: "not_running" });
});

test("a server that accepts and never answers is no answer, within the timeout", async () => {
  const path = socket(),
    server = Bun.listen({ unix: path, socket: { data() {} } });
  cleanups.push(() => server.stop(true));
  const started = performance.now();
  expect(await request(path, "status", { timeoutMs: 100 })).toEqual({ ok: false, why: "no_answer" });
  const took = performance.now() - started;
  expect(took).toBeGreaterThanOrEqual(90);
  expect(took).toBeLessThan(600);
  expect(await watch(path, () => {}, { timeoutMs: 100 })).toBe("no_answer");
});

test("a server that closes without an answer, or answers garbage, is no answer", async () => {
  const path = socket(),
    server = Bun.listen({
      unix: path,
      socket: {
        data(s, chunk) {
          if (new TextDecoder().decode(chunk).includes("status")) s.end();
          else s.end("garbage\n");
        },
      },
    });
  cleanups.push(() => server.stop(true));
  expect(await request(path, "status", { timeoutMs: 500 })).toEqual({ ok: false, why: "no_answer" });
  expect(await request(path, "mute", { timeoutMs: 500 })).toEqual({ ok: false, why: "no_answer" });
});

test("a watch that runs past the timeout keeps going, and ends closed when the server does", async () => {
  const path = socket(),
    { session, recorder } = still(),
    server = await startServer({ path, session, recorder, pid: 9 });
  cleanups.push(() => server.close());
  const seen: boolean[] = [];
  const watching = watch(path, a => void seen.push(a.state.muted), { timeoutMs: 300 });
  await Bun.sleep(500);
  session.setMuted(true);
  await Bun.sleep(50);
  server.close();
  expect(await watching).toBe("closed");
  expect(seen).toEqual([false, true]);
});

test("a line that is not an answer ends a watch as no answer, not as a quit", async () => {
  const state = { pid: 1, muted: false, mode: "listening", unavailable: null, reason: null, recording: "none", target: null, updated_at: 1 };
  for (const after of ["garbage\n", '{"ok":true}\n', "null\n"]) {
    const path = socket(),
      server = Bun.listen({
        unix: path,
        socket: {
          data(s) {
            s.write(JSON.stringify({ ok: true, state }) + "\n");
            setTimeout(() => s.end(after), 20);
          },
        },
      });
    cleanups.push(() => server.stop(true));
    const seen: number[] = [];
    expect([after, await watch(path, a => void seen.push(a.state.pid), { timeoutMs: 1000 })]).toEqual([after, "no_answer"]);
    expect(seen).toEqual([1]);
  }
});
