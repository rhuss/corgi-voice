import { test, expect } from "bun:test";
import { run, spawnError } from "../../src/util/subprocess";

test("run captures exit code, stdout and stderr", async () => {
  const out = await run(["sh", "-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 2000 });
  expect(out).toEqual({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
});

test("stdin carries exactly the given text and is closed", async () => {
  const out = await run(["sh", "-c", "cat | od -c | head -1"], { stdin: "hi", timeoutMs: 2000 });
  expect(out.stdout).toContain("h   i");
  expect(out.stdout).not.toContain("\\n");
  const empty = await run(["cat"], { timeoutMs: 2000 });
  expect(empty.stdout).toBe("");
  expect(empty.timedOut).toBe(false);
});

test("a call past its bound is killed and marked timed out", async () => {
  const started = Date.now();
  const out = await run(["sleep", "5"], { timeoutMs: 100 });
  expect(out.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(1500);
});

test("the bound holds while a process never reads a large stdin", async () => {
  const started = Date.now();
  const out = await run(["sleep", "5"], { stdin: "x".repeat(1 << 20), timeoutMs: 200 });
  expect(out.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(1500);
});

test("an abort while stdin is written still kills the process", async () => {
  const abort = new AbortController(),
    started = Date.now();
  const pending = run(["sleep", "5"], { stdin: "x".repeat(1 << 20), timeoutMs: 10_000, signal: abort.signal });
  abort.abort();
  const out = await pending;
  expect(out.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(1500);
});

test("a process that ignores SIGTERM is killed 200 ms later", async () => {
  const started = Date.now();
  const out = await run(["sh", "-c", "trap '' TERM; sleep 5"], { timeoutMs: 100 });
  expect(out.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(1500);
});

test("aborting kills the process", async () => {
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 50);
  const out = await run(["sleep", "5"], { timeoutMs: 5000, signal: abort.signal });
  expect(out.timedOut).toBe(true);
});

test("env reaches the process", async () => {
  const out = await run(["sh", "-c", "echo $CV_TEST"], { timeoutMs: 2000, env: { ...process.env, CV_TEST: "yes" } });
  expect(out.stdout).toBe("yes\n");
});

test("a missing program fails with FileNotFound", async () => {
  await expect(run(["/nonexistent/corgi-voice-test"], { timeoutMs: 1000 })).rejects.toThrow("FileNotFound");
});

test("spawnError names spawn failures", () => {
  expect(spawnError(Object.assign(Error("x"), { code: "ENOENT" })).message).toBe("FileNotFound");
  expect(spawnError(Object.assign(Error("x"), { code: "EACCES" })).message).toBe("AccessDenied");
  const other = Error("other");
  expect(spawnError(other)).toBe(other);
});

test("a process that exits in time is not marked timed out while a grandchild holds its pipes", async () => {
  const out = await run(["sh", "-c", "sleep 3 >&2 & echo done; exit 0"], { timeoutMs: 250 });
  expect(out).toMatchObject({ code: 0, stdout: "done\n", timedOut: false });
});
