//! One corgi-voice per user and machine (FR-005): a lock file holding the
//! owner's PID. The file appears whole, PID included, by hard-linking a
//! finished temporary file into place, so no one ever reads it half
//! written. A lock whose PID is gone is stale: reapers take turns to remove
//! it, checking it again under their turn, so a lock another instance just
//! took in its place is never deleted by mistake. Release removes our own.
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as paths from "./paths";

export type Lock = { ok: true; release: () => void } | { ok: false; pid: number; message: string };
/** What a lock file says: its PID, that it is gone, that it names no PID, or that it cannot be read. */
type Owner = { pid: number } | "missing" | "garbage" | "unreadable";

/** A lock file without a PID is left this long (ms) before it counts as stale. */
export const garbage_grace_ms = 2000;
/** A reaper's turn this old (ms) was left by one that died. */
const reap_stale_ms = 5000;
/** A reaper's turn this old (ms) is left over, whoever it names. */
const turn_abandoned_ms = 60_000;
const attempts = 5;

/** Whether `pid` runs: `kill(pid, 0)` fails with ESRCH only when it is gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function owner(file: string): Owner {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? { pid } : "garbage";
}
/** A name next to `file` no other call uses. */
function aside(file: string, tag: string, pid: number): string {
  return `${file}.${tag}.${pid}.${Math.random().toString(36).slice(2)}`;
}
/** Puts `pid`'s lock in place whole; false when a lock is there already. */
function claim(file: string, pid: number): boolean {
  const temp = aside(file, "new", pid);
  writeFileSync(temp, `${pid}\n`, { mode: 0o600 });
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    rmSync(temp, { force: true });
  }
}
/** Removes the stale lock that said `seen`. Reapers take turns through a
 * second lock, `<file>.reap`, and only a reaper removes the main one (its
 * owner is gone), so the file cannot change between the check and the
 * removal: no lock another instance just took is ever deleted. Without the
 * turn, nothing is removed and the caller tries again. */
export function reap(file: string, seen: Owner, pid: number, now: () => number = Date.now): void {
  const turn = `${file}.reap`;
  if (!claim(turn, pid)) {
    // Another reaper is at it, or one died holding the turn. A turn whose
    // reaper is gone is stale; age counts only for one naming no PID, never
    // against a live reaper. (Two starters clearing one dead reaper's turn at
    // the same instant remains a narrow window.)
    try {
      const holder = owner(turn);
      // A reap takes microseconds: a turn held for a minute, by whatever PID
      // (one reused after its reaper died), is left over.
      const age = now() - statSync(turn).mtimeMs,
        stale =
          age > turn_abandoned_ms ||
          (typeof holder === "object" ? !alive(holder.pid) : holder === "garbage" && age > reap_stale_ms);
      if (stale) rmSync(turn, { force: true });
    } catch {}
    return;
  }
  try {
    const held = owner(file),
      same = typeof held === "object" && typeof seen === "object" ? held.pid === seen.pid : held === seen;
    if (same) rmSync(file, { force: true });
  } finally {
    rmSync(turn, { force: true });
  }
}
/** The lock `pid` holds, with its release. */
function taken(file: string, pid: number): Lock {
  return {
    ok: true,
    release: () => {
      // Only our own lock: another instance may have replaced a stale one.
      const held = owner(file);
      if (typeof held === "object" && held.pid === pid) rmSync(file, { force: true });
    },
  };
}
function refused(pid: number, message: string): Lock {
  return { ok: false, pid, message };
}
/** Takes the lock for `pid`, or says which running corgi-voice holds it. */
export function acquire(file: string = paths.lockFile(), pid: number = process.pid, now: () => number = Date.now): Lock {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (claim(file, pid)) return taken(file, pid);
    const held = owner(file);
    if (held === "missing") continue;
    if (held === "unreadable")
      return refused(0, `could not read the lock ${file}; remove it if no corgi-voice is running`);
    if (held === "garbage") {
      // Not one of ours, or written by hand: stale once it has sat a while.
      let age = Infinity;
      try {
        age = now() - statSync(file).mtimeMs;
      } catch {}
      if (age < garbage_grace_ms) return refused(0, `the lock ${file} is being taken; try again in a moment`);
    } else if (held.pid !== pid && alive(held.pid))
      return refused(
        held.pid,
        `corgi-voice is already running (PID ${held.pid}); only one may run at a time, so speech is never typed twice`,
      );
    reap(file, held, pid, now);
    // Another reaper may hold the turn: give it a moment.
    if (attempt > 0) Bun.sleepSync(10);
  }
  // The last reap may have freed it.
  if (claim(file, pid)) return taken(file, pid);
  return refused(
    0,
    `could not take the lock ${file}; try again in a moment, and if no corgi-voice runs, remove ${file}.reap`,
  );
}
