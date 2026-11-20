//! Test helpers around the fake `corgi`: a private scenario and log per
//! test, a command path that carries them, and builders for `list --json`.
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Reply, Scenario } from "./fake-corgi";

export type { Reply, Scenario };
export type Call = { argv: string[]; stdin: string | null; at: number; pid: number };
export type FakeViewer = { id: number; pane: number | null; active: number; watched?: boolean; workspace?: number };
export type FakePane = {
  id: number;
  name?: string;
  agent?: string;
  command?: string;
  cwd?: string;
  dormant?: boolean;
  exited?: boolean;
};

const shim = resolve(import.meta.dir, "fake-corgi");

/** A fake corgi for one test: `cmd` runs it with this test's scenario and log. */
export function fakeCorgi(scenario: Scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cv-fake-corgi-")),
    scenarioFile = join(dir, "scenario.json"),
    logFile = join(dir, "calls.jsonl"),
    cmd = join(dir, "corgi");
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  // A wrapper per test, so the scenario travels with the command itself.
  writeFileSync(
    cmd,
    `#!/bin/sh\nFAKE_CORGI_SCENARIO='${scenarioFile}' FAKE_CORGI_LOG='${logFile}' exec '${shim}' "$@"\n`,
  );
  chmodSync(cmd, 0o755);
  return {
    dir,
    cmd,
    /** Replaces the scenario; the next call reads it. Written aside and
     * renamed, so a fake started by a poller mid-write never reads a
     * truncated file. */
    set(next: Scenario): void {
      const tmp = `${scenarioFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(next));
      renameSync(tmp, scenarioFile);
    },
    calls(): Call[] {
      if (!existsSync(logFile)) return [];
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line) as Call);
    },
    /** The `pane send` calls. */
    sends(): Call[] {
      return this.calls().filter(c => c.argv.includes("send"));
    },
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type FakeCorgi = ReturnType<typeof fakeCorgi>;

/** The `list --json` reply of a machine with `viewers` and `panes`. */
export function listJson(viewers: FakeViewer[], panes: FakePane[] = []): string {
  return (
    JSON.stringify({
      ok: true,
      result: {
        panes: panes.map(p => ({
          id: p.id,
          name: p.name ?? "",
          agent: p.agent ?? null,
          command: p.command ?? "zsh",
          cwd: p.cwd ?? "/tmp",
          dormant: p.dormant ?? false,
          exited: p.exited ?? false,
        })),
      },
      viewers: viewers.map(v => ({
        id: v.id,
        pid: 0,
        active: v.active,
        workspace: v.workspace ?? 1,
        pane: v.pane,
        watched: v.watched ?? false,
      })),
    }) + "\n"
  );
}
/** A `list --json` reply as a scenario entry. */
export function listReply(viewers: FakeViewer[], panes: FakePane[] = [], delayMs = 0): Reply {
  return { stdout: listJson(viewers, panes), delayMs };
}
/** The `machine list` reply naming `names`, behind the experimental notice. */
export function machineList(names: string[]): Reply {
  return {
    stdout:
      "Remote machines are experimental; bug reports are appreciated (corgi bugreport).\n" +
      JSON.stringify({ machines: names.map(name => ({ name })) }) +
      "\n",
  };
}
