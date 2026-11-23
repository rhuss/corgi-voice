//! `corgi-voice --install-trick` (FR-011, FR-012): writes the trick's
//! manifest into Corgi's tricks folder, with absolute paths and the channel
//! path, since Corgi starts tricks with a reduced environment. Touches only
//! `corgi-voice/trick.toml` there, written whole and renamed into place.
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as paths from "../util/paths";

type Env = NodeJS.ProcessEnv;
/** The trick's id, and its folder under the tricks folder. */
export const id = "corgi-voice";

/** Corgi's tricks folder: `$CORGI_TRICKS_DIR`, else `${XDG_CONFIG_HOME:-~/.config}/corgi/tricks`. */
export function tricksDir(env: Env = process.env): string {
  if (env.CORGI_TRICKS_DIR) return env.CORGI_TRICKS_DIR;
  return join(env.XDG_CONFIG_HOME || join(paths.home(env), ".config"), "corgi", "tricks");
}
/** A TOML basic string: JSON's escapes are TOML's, except that TOML also
 * wants DEL escaped and takes no lone surrogate. */
const str = (s: string) => {
  if (!s.isWellFormed()) throw Object.assign(Error("NotUnicode"), { detail: `not valid Unicode: ${JSON.stringify(s)}` });
  return JSON.stringify(s).replace(/\x7f/g, "\\u007F");
};
/** The `bun` to write: the running one, through a stable link when PATH
 * finds one that is this very binary (Homebrew's `/opt/homebrew/bin/bun`
 * instead of its Cellar path, which `brew upgrade bun` removes). Another
 * bun on PATH, or a version manager's shim, is not this binary and is
 * never written. */
export function bunPath(env: Env = process.env, running: string = process.execPath): string {
  // Only absolute PATH entries: a relative one would tie the manifest to
  // the folder the install ran in (Bun.which resolves it against the cwd).
  const PATH = (env.PATH ?? "").split(delimiter).filter(isAbsolute).join(delimiter),
    found = PATH ? Bun.which("bun", { PATH }) : null;
  if (!found) return running;
  try {
    return realpathSync(found) === realpathSync(running) ? found : running;
  } catch {
    return running;
  }
}
/** The manifest: `bun main --trick`, and the channel path as config. */
export function manifest(o: { bun: string; main: string; socket: string }): string {
  return [
    "version = 1",
    `id = ${str(id)}`,
    `description = ${str("Shows **corgi-voice** in the sidebar title row; click to mute.")}`,
    `command = [${[o.bun, o.main, "--trick"].map(str).join(", ")}]`,
    "",
    "[config]",
    `socket = ${str(o.socket)}`,
    "",
  ].join("\n");
}
/** Writes the manifest for this environment and returns where. Throws on
 * failure (an unwritable folder, `SocketFolderUnsafe` with its `detail`). */
export function install(env: Env = process.env, opts: { bun?: string; main?: string } = {}): { path: string } {
  const bun = opts.bun ?? bunPath(env),
    main = opts.main ?? realpathSync(fileURLToPath(new URL("../main.ts", import.meta.url))),
    socket = paths.socketPath(env),
    dir = join(tricksDir(env), id),
    path = join(dir, "trick.toml"),
    tmp = `${path}.tmp-${process.pid}`;
  mkdirSync(dir, { recursive: true });
  // Corgi reloads on a changed manifest: it only ever sees a whole one.
  try {
    writeFileSync(tmp, manifest({ bun, main, socket }));
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return { path };
}
