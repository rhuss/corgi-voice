import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { acquire, reap } from "../../src/util/lock";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function lockFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "cv-lock-"));
  dirs.push(dir);
  return join(dir, "sub", "corgi-voice.lock");
}
/** A PID that was alive a moment ago and is not any more. */
function deadPid(): number {
  const child = Bun.spawnSync(["sh", "-c", "echo $$"]);
  return Number(child.stdout.toString().trim());
}

test("the first instance takes the lock with its PID", () => {
  const file = lockFile(),
    lock = acquire(file);
  expect(lock.ok).toBe(true);
  expect(readFileSync(file, "utf8").trim()).toBe(String(process.pid));
  if (lock.ok) lock.release();
});

test("a second instance is refused with a message naming the running PID", () => {
  const file = lockFile(),
    first = acquire(file);
  expect(first.ok).toBe(true);
  const second = acquire(file, 424242);
  expect(second.ok).toBe(false);
  if (!second.ok) {
    expect(second.pid).toBe(process.pid);
    expect(second.message).toContain(`PID ${process.pid}`);
    expect(second.message).toContain("already running");
  }
  if (first.ok) first.release();
});

test("a stale lock of a process that is gone is replaced", () => {
  const file = lockFile();
  acquire(file).ok && rmSync(file);
  writeFileSync(file, `${deadPid()}\n`);
  const lock = acquire(file);
  expect(lock.ok).toBe(true);
  expect(readFileSync(file, "utf8").trim()).toBe(String(process.pid));
  if (lock.ok) lock.release();
  // A lock file that names no PID is stale too, once it has sat a while.
  writeFileSync(file, "garbage");
  const again = acquire(file, process.pid, () => Date.now() + 5000);
  expect(again.ok).toBe(true);
  if (again.ok) again.release();
});

test("a lock without a PID that is still fresh is not reaped", () => {
  const file = lockFile();
  acquire(file).ok && rmSync(file);
  writeFileSync(file, "");
  const lock = acquire(file);
  expect(lock.ok).toBe(false);
  if (!lock.ok) expect(lock.message).toContain("being taken");
  expect(readFileSync(file, "utf8")).toBe("");
});

test("a lock that cannot be read is kept, and the start refused", () => {
  if (process.getuid?.() === 0) return; // root reads anything
  const file = lockFile();
  acquire(file).ok && rmSync(file);
  writeFileSync(file, `${process.ppid}\n`, { mode: 0o000 });
  const lock = acquire(file, 424242);
  expect(lock.ok).toBe(false);
  if (!lock.ok) expect(lock.message).toContain("could not read the lock");
  expect(existsSync(file)).toBe(true);
});

test("the lock appears whole: no temporary files are left behind", () => {
  const file = lockFile(),
    lock = acquire(file);
  expect(lock.ok).toBe(true);
  expect(readdirSync(dirname(file))).toEqual(["corgi-voice.lock"]);
  if (lock.ok) lock.release();
  expect(readdirSync(dirname(file))).toEqual([]);
});

test("release removes the lock, and only our own", () => {
  const file = lockFile(),
    lock = acquire(file);
  if (!lock.ok) throw Error("not taken");
  lock.release();
  expect(existsSync(file)).toBe(false);
  const next = acquire(file);
  if (!next.ok) throw Error("not taken");
  // Someone else's lock in its place is left alone.
  writeFileSync(file, "1\n");
  next.release();
  expect(existsSync(file)).toBe(true);
});

/** Starts `n` processes that each take the lock
 * and hold it until every one has said whether it got it. */
async function contenders(file: string, n: number): Promise<string[]> {
  const taker = join(import.meta.dir, "..", "fixtures", "take-lock.ts");
  const runs = Array.from({ length: n }, () => Bun.spawn(["bun", taker, file], { stdin: "pipe", stdout: "pipe" }));
  const said = await Promise.all(
    runs.map(async p => {
      const reader = p.stdout.getReader();
      let text = "";
      while (!text.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      return text.trim();
    }),
  );
  // Everyone has answered: the holders may let go.
  for (const p of runs) p.stdin.end();
  await Promise.all(runs.map(p => p.exited));
  return said;
}

test("smoke: many instances started at once over a stale lock file, exactly one gets it", async () => {
  const file = lockFile();
  acquire(file).ok && rmSync(file);
  writeFileSync(file, `${deadPid()}\n`);
  const said = await contenders(file, 8);
  expect(said.filter(s => s === "ok")).toHaveLength(1);
}, 30_000);

test("a live reaper's turn is kept however old; one without a PID is cleared once old", () => {
  const file = lockFile();
  acquire(file).ok && rmSync(file);
  writeFileSync(file, `${deadPid()}\n`);
  // A fresh turn of a live reaper (the parent stands in): nothing is removed yet.
  writeFileSync(`${file}.reap`, `${process.ppid}\n`);
  expect(acquire(file).ok).toBe(false);
  expect(existsSync(file)).toBe(true);
  // A live reaper's turn is not taken from it within a minute.
  expect(acquire(file, process.pid, () => Date.now() + 10_000).ok).toBe(false);
  // A turn naming no PID is cleared once old, and the stale lock replaced.
  writeFileSync(`${file}.reap`, "");
  const lock = acquire(file, process.pid, () => Date.now() + 10_000);
  expect(lock.ok).toBe(true);
  if (lock.ok) lock.release();
});

test("a reaper never removes a lock another instance took after the stale one was seen", () => {
  const file = lockFile();
  acquire(file).ok && rmSync(file);
  const dead = deadPid();
  // The stale lock was seen naming `dead`; meanwhile a live instance took the name.
  writeFileSync(file, `${process.pid}\n`);
  reap(file, { pid: dead }, 424242);
  expect(readFileSync(file, "utf8").trim()).toBe(String(process.pid));
  expect(existsSync(`${file}.reap`)).toBe(false);
  // The lock it judged stale is the one it removes.
  writeFileSync(file, `${dead}\n`);
  reap(file, { pid: dead }, 424242);
  expect(existsSync(file)).toBe(false);
});

test("a reaper's turn whose reaper is gone is cleared at once", () => {
  const file = lockFile();
  acquire(file).ok && rmSync(file);
  writeFileSync(file, `${deadPid()}\n`);
  writeFileSync(`${file}.reap`, `${deadPid()}\n`);
  const lock = acquire(file);
  expect(lock.ok).toBe(true);
  if (lock.ok) lock.release();
});


test("a reaper's turn held a minute is left over whoever it names, and the refusal says what to remove", () => {
  const file = lockFile();
  acquire(file).ok && rmSync(file);
  writeFileSync(file, `${deadPid()}\n`);
  writeFileSync(`${file}.reap`, `${process.ppid}\n`);
  const refused = acquire(file);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.message).toContain(`${file}.reap`);
  const lock = acquire(file, process.pid, () => Date.now() + 61_000);
  expect(lock.ok).toBe(true);
  if (lock.ok) lock.release();
});
