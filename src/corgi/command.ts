//! Which `corgi` to run (FR-003) and whether it has what corgi-voice needs (FR-004).
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import * as subprocess from "../util/subprocess";
import * as paths from "../util/paths";
import { notFound } from "./errors";

export type Found = { ok: true; cmd: string } | { ok: false; error: string };
export type Checked = { ok: true } | { ok: false; error: string };
/** How long `pane send --help` may take. */
export const help_ms = 3000;

function executable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
/**
 * The `corgi` command: `--corgi` (`flag`), else the `corgi` setting, else
 * `corgi` on PATH. A value with a `/` (or `~/`) is a path to an executable;
 * anything else is a name looked up on PATH. A shell alias is neither, so the
 * message for a value that is not found says to give the executable's path.
 */
export function resolveCorgi(
  given: { flag?: string | null; setting?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): Found {
  const value = given.flag || given.setting || "corgi";
  let found: string | null = null;
  if (value.startsWith("~/")) found = join(paths.home(env), value.slice(2));
  else if (value.includes("/")) found = isAbsolute(value) ? value : resolve(value);
  if (found !== null) {
    if (executable(found)) return { ok: true, cmd: found };
  } else {
    const onPath = Bun.which(value, { PATH: env.PATH ?? "" });
    if (onPath) return { ok: true, cmd: onPath };
  }
  return {
    ok: false,
    error:
      `the corgi command "${value}" was not found or is not executable. ` +
      `If "${value}" is a shell alias, other programs cannot run it: ` +
      `pass --corgi or set "corgi" in voice.json to the executable's path`,
  };
}
/** Whether `cmd pane send --help` lists `--stdin`, within 3 s. */
export async function checkCapabilities(cmd: string, timeoutMs = help_ms): Promise<Checked> {
  let out: subprocess.Result;
  try {
    out = await subprocess.run([cmd, "pane", "send", "--help"], { timeoutMs });
  } catch {
    return { ok: false, error: `${notFound(cmd)}; give the executable's path with --corgi` };
  }
  if (out.timedOut) return { ok: false, error: `${cmd} pane send --help did not answer within ${timeoutMs / 1000} s` };
  if (/--stdin\b/.test(out.stdout + out.stderr)) return { ok: true };
  return {
    ok: false,
    error: `this corgi (${cmd}) has no "pane send --stdin"; update Corgi to a release that has it`,
  };
}
