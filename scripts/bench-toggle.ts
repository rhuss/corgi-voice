//! The hand-run benchmark for `corgi-voice --toggle-mute` (FR-009): a
//! control server with a stand-in session on a temporary socket, and the
//! command spawned 20 times against it, from spawn to exit. Prints p50 and
//! p95 and whether p95 stays under 200 ms. Not part of `bun test`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../src/control/server";

const runs = 20,
  budget_ms = 200,
  main = resolve(import.meta.dir, "..", "src", "main.ts"),
  dir = mkdtempSync(join(tmpdir(), "cv-bench-")),
  listeners: (() => void)[] = [];
const session = {
  muted: false,
  available: true,
  unavailable: null,
  viewer: true,
  focus: "bench",
  machine: "local",
  reason: null,
  link_state: "connected" as const,
  setMuted(muted: boolean) {
    session.muted = muted;
    for (const fn of listeners) fn();
  },
  note: () => {},
  on: (_event: "change", fn: () => void) => void listeners.push(fn),
};
const server = await startServer({
  path: join(dir, "corgi-voice.sock"),
  session,
  recorder: { current: null, on: () => {} },
  pid: process.pid,
});
const times: number[] = [];
try {
  for (let i = 0; i < runs; i++) {
    const started = performance.now(),
      child = Bun.spawn([process.execPath, main, "--toggle-mute"], {
        env: { ...process.env, XDG_RUNTIME_DIR: dir },
        stdout: "ignore",
        stderr: "inherit",
      }),
      code = await child.exited;
    times.push(performance.now() - started);
    if (code !== 0) throw Error(`run ${i + 1} exited ${code}`);
  }
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
const sorted = [...times].sort((a, b) => a - b),
  at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)],
  ms = (n: number) => `${Math.round(n)} ms`;
console.log(`runs ${runs}  p50 ${ms(at(50))}  p95 ${ms(at(95))}  max ${ms(sorted.at(-1)!)}`);
console.log(at(95) < budget_ms ? `p95 under ${budget_ms} ms: ok` : `p95 over ${budget_ms} ms: too slow`);
process.exit(at(95) < budget_ms ? 0 : 1);
