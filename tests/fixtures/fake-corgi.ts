//! A stand-in for the `corgi` command (FR-029). It reads the scenario JSON
//! named by `FAKE_CORGI_SCENARIO` on every call, so a test can change what
//! Corgi reports between polls, and appends each call as a JSON line
//! `{argv, stdin, at, pid}` to `FAKE_CORGI_LOG`. `stdin` is whatever the call
//! was given, read to its end for every call, so a test sees anything that
//! crossed to Corgi besides the arguments (FR-015).
import { appendFileSync, readFileSync } from "node:fs";

/** What one call answers: output, exit code and how long it takes first. */
export type Reply = { stdout?: string; stderr?: string; code?: number; delayMs?: number };
export type Scenario = {
  /** `pane send --help` output; the default lists `--stdin`. */
  help?: Reply;
  /** `machine list`; the default lists `local` only. */
  machineList?: Reply;
  /** `[--machine NAME] list --json` per machine; a machine not listed fails with `UnknownMachine`. */
  machines?: Record<string, Reply>;
  /** `list --all-machines --json`. */
  allMachines?: Reply;
  /** `pane send` per `machine:pane` key, else `default`; the default succeeds. */
  send?: Record<string, Reply>;
};

export const default_help =
  "Usage:\n  corgi pane send ID|current TEXT|--stdin [--enter]\n";

async function main(): Promise<number> {
  const argv = process.argv.slice(2),
    scenarioFile = process.env.FAKE_CORGI_SCENARIO,
    logFile = process.env.FAKE_CORGI_LOG;
  const scenario: Scenario = scenarioFile ? JSON.parse(readFileSync(scenarioFile, "utf8")) : {};
  let args = argv,
    machine = "local";
  if (args[0] === "--machine") {
    machine = args[1] ?? "";
    args = args.slice(2);
  }
  const sending = args[0] === "pane" && args[1] === "send" && args.includes("--stdin") && !args.includes("--help");
  const stdin = await Bun.stdin.text();
  if (logFile) appendFileSync(logFile, JSON.stringify({ argv, stdin, at: Date.now(), pid: process.pid }) + "\n");

  let reply: Reply;
  if (args[0] === "pane" && args[1] === "send" && args.includes("--help"))
    reply = scenario.help ?? { stdout: default_help };
  else if (args[0] === "machine" && args[1] === "list")
    reply = scenario.machineList ?? {
      stderr: "Remote machines are experimental; bug reports are appreciated (corgi bugreport).\n",
      stdout: JSON.stringify({ machines: [{ name: "local" }] }) + "\n",
    };
  else if (args[0] === "list" && args.includes("--all-machines"))
    reply = scenario.allMachines ?? { stderr: "corgi: unsupported\n", code: 1 };
  else if (args[0] === "list" && args.includes("--json"))
    reply = scenario.machines?.[machine] ?? { stderr: "corgi: UnknownMachine\n", code: 1 };
  else if (sending) {
    const pane = args[2];
    reply = scenario.send?.[`${machine}:${pane}`] ?? scenario.send?.default ?? {};
  } else reply = { stderr: `corgi: unknown command ${args.join(" ")}\n`, code: 2 };

  if (reply.delayMs) await Bun.sleep(reply.delayMs);
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  return reply.code ?? 0;
}

process.exitCode = await main();
