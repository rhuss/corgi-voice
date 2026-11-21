import { test, expect, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCorgi, checkCapabilities, checkReachable, reach_ms } from "../../src/corgi/command";
import { fakeCorgi, type FakeCorgi } from "../fixtures/corgi";

const dirs: string[] = [],
  fakes: FakeCorgi[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const f of fakes.splice(0)) f.cleanup();
});
/** A folder with executables named `names`, for a PATH of its own. */
function bin(...names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cv-bin-"));
  dirs.push(dir);
  for (const name of names) {
    writeFileSync(join(dir, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

test("--corgi beats the setting, which beats corgi on PATH", () => {
  const dir = bin("corgi", "corgi-flag", "corgi-setting"),
    env = { PATH: dir, HOME: "/home/me" };
  expect(resolveCorgi({ flag: "corgi-flag", setting: "corgi-setting" }, env)).toEqual({
    ok: true,
    cmd: join(dir, "corgi-flag"),
  });
  expect(resolveCorgi({ flag: undefined, setting: "corgi-setting" }, env)).toEqual({
    ok: true,
    cmd: join(dir, "corgi-setting"),
  });
  expect(resolveCorgi({ setting: null }, env)).toEqual({ ok: true, cmd: join(dir, "corgi") });
});

test("a path is used as given when it is an executable file", () => {
  const dir = bin("my-corgi");
  expect(resolveCorgi({ flag: join(dir, "my-corgi") }, { PATH: "" })).toEqual({
    ok: true,
    cmd: join(dir, "my-corgi"),
  });
  // ~/ is the home folder.
  expect(resolveCorgi({ flag: "~/my-corgi" }, { PATH: "", HOME: dir })).toEqual({
    ok: true,
    cmd: join(dir, "my-corgi"),
  });
});

test("a path that is not executable fails", () => {
  const dir = bin();
  writeFileSync(join(dir, "plain"), "not a program");
  chmodSync(join(dir, "plain"), 0o644);
  const result = resolveCorgi({ flag: join(dir, "plain") }, { PATH: "" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain(join(dir, "plain"));
  expect(resolveCorgi({ flag: dir }, { PATH: "" }).ok).toBe(false);
});

test("the not-found message names the value and says an alias needs the executable's path", () => {
  for (const given of [{ flag: "corgi-custom" }, { setting: "corgi-custom" }]) {
    const result = resolveCorgi(given, { PATH: bin() });
    expect(result.ok).toBe(false);
    if (result.ok) continue;
    expect(result.error).toContain("corgi-custom");
    expect(result.error).toContain("alias");
    expect(result.error).toContain("executable's path");
  }
  const missing = resolveCorgi({}, { PATH: bin() });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error).toContain('"corgi"');
});

test("help listing --stdin passes the capability check", async () => {
  const fake = fakeCorgi();
  fakes.push(fake);
  expect(await checkCapabilities(fake.cmd)).toEqual({ ok: true });
  expect(fake.calls().map(c => c.argv)).toEqual([["pane", "send", "--help"]]);
});

test("help without --stdin fails naming pane send --stdin", async () => {
  const fake = fakeCorgi({ help: { stdout: "Usage:\n  corgi pane send ID TEXT [--enter]\n", code: 0 } });
  fakes.push(fake);
  const result = await checkCapabilities(fake.cmd);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("pane send --stdin");
  // Help on stderr counts as well.
  fake.set({ help: { stderr: "corgi pane send ID|current TEXT|--stdin [--enter]\n", code: 2 } });
  expect(await checkCapabilities(fake.cmd)).toEqual({ ok: true });
});

test("a corgi that cannot run fails the check with not found", async () => {
  const result = await checkCapabilities("/nonexistent/corgi");
  expect(result).toEqual({ ok: false, error: expect.stringContaining("corgi not found: /nonexistent/corgi") });
});

test("the help call is bounded at 3000 ms", async () => {
  const fake = fakeCorgi({ help: { stdout: "--stdin", delayMs: 10_000 } });
  fakes.push(fake);
  const started = Date.now();
  const result = await checkCapabilities(fake.cmd);
  const took = Date.now() - started;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("did not answer");
  expect(took).toBeGreaterThanOrEqual(2900);
  expect(took).toBeLessThan(4000);
}, 8000);

test("a corgi whose list --json has viewers, none included, reaches Corgi", async () => {
  const fake = fakeCorgi({ machines: { local: { stdout: '{"viewers":[]}' } } });
  fakes.push(fake);
  expect(await checkReachable(fake.cmd)).toEqual({ kind: "ok" });
  // One call, list --json and nothing else: no pane is touched.
  expect(fake.calls().map(c => c.argv)).toEqual([["list", "--json"]]);
});

test("a stopped Corgi is not running, from the reply's err or from stderr", async () => {
  const fake = fakeCorgi({ machines: { local: { stdout: '{"ok":false,"err":"NoRuntime"}', code: 1 } } });
  fakes.push(fake);
  expect(await checkReachable(fake.cmd)).toEqual({ kind: "not_running", detail: "NoRuntime" });
  fake.set({ machines: { local: { stderr: "corgi: ConnectionRefused\n", code: 1 } } });
  expect(await checkReachable(fake.cmd)).toEqual({ kind: "not_running", detail: "ConnectionRefused" });
});

test("the walkthrough's old corgi against a newer Corgi is a mismatch with its error", async () => {
  const fake = fakeCorgi({
    machines: { local: { stdout: '{"ok":false,"err":"JSON Parse error: Unexpected identifier \\"HTTP\\""}', code: 1 } },
  });
  fakes.push(fake);
  expect(await checkReachable(fake.cmd)).toEqual({
    kind: "mismatch",
    detail: 'JSON Parse error: Unexpected identifier "HTTP"',
  });
  // An err with exit code 0 is read the same.
  fake.set({ machines: { local: { stdout: '{"ok":false,"err":"JSON Parse error: Unexpected EOF"}' } } });
  expect(await checkReachable(fake.cmd)).toEqual({ kind: "mismatch", detail: "JSON Parse error: Unexpected EOF" });
  // What the old release really does: the reply on standard error, exit 2.
  fake.set({
    machines: {
      local: { stderr: '{"ok":false,"err":"JSON Parse error: Unexpected identifier \\"HTTP\\""}\n', code: 2 },
    },
  });
  expect(await checkReachable(fake.cmd)).toEqual({
    kind: "mismatch",
    detail: 'JSON Parse error: Unexpected identifier "HTTP"',
  });
  fake.set({ machines: { local: { stderr: "corgi: unknown command list; see corgi --help\n", code: 2 } } });
  expect(await checkReachable(fake.cmd)).toEqual({
    kind: "mismatch",
    detail: "unknown command list; see corgi --help",
  });
  // Only the first line of the error is quoted (FR-009).
  fake.set({ machines: { local: { stderr: "corgi: unknown command list\nusage: corgi <command>\n", code: 2 } } });
  expect(await checkReachable(fake.cmd)).toEqual({ kind: "mismatch", detail: "unknown command list" });
  // An answer that is no JSON at all, with exit code 0.
  fake.set({ machines: { local: { stdout: "HTTP/1.1 400 Bad Request\n" } } });
  expect(await checkReachable(fake.cmd)).toEqual({ kind: "mismatch", detail: "Corgi output not understood" });
});

test("a reply without viewers is a mismatch: Corgi output not understood", async () => {
  const fake = fakeCorgi({ machines: { local: { stdout: '{"panes":[]}' } } });
  fakes.push(fake);
  expect(await checkReachable(fake.cmd)).toEqual({ kind: "mismatch", detail: "Corgi output not understood" });
});

test("a slow Corgi has no answer in time: past the bound, or RequestTimedOut", async () => {
  const fake = fakeCorgi({ machines: { local: { stdout: '{"viewers":[]}', delayMs: 2000 } } });
  fakes.push(fake);
  const started = Date.now();
  expect(await checkReachable(fake.cmd, 200)).toEqual({ kind: "no_answer", detail: "no answer in time" });
  expect(Date.now() - started).toBeLessThan(1500);
  fake.set({ machines: { local: { stderr: "corgi: RequestTimedOut\n", code: 1 } } });
  expect(await checkReachable(fake.cmd)).toEqual({ kind: "no_answer", detail: "RequestTimedOut" });
});

test("the probe is bounded at 3 s by default", () => {
  expect(reach_ms).toBe(3000);
});

test("a corgi that vanished before the probe is a mismatch saying it was not found", async () => {
  expect(await checkReachable("/nonexistent/corgi")).toEqual({
    kind: "mismatch",
    detail: "corgi not found: /nonexistent/corgi",
  });
});
