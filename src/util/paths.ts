//! Where corgi-voice keeps its files (FR-022, FR-024), and where the
//! in-Corgi voice mode kept them, which is only ever read.
import { lstatSync, mkdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

type Env = NodeJS.ProcessEnv;

/** The home folder `~/` stands for: `$HOME`, else the account's. */
export function home(env: Env = process.env): string {
  return env.HOME || homedir();
}
/** `$XDG_STATE_HOME/corgi-voice`, else `~/.local/state/corgi-voice`. */
export function stateDir(env: Env = process.env): string {
  return env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "corgi-voice") : join(home(env), ".local", "state", "corgi-voice");
}
/** The settings file. */
export function settingsFile(env: Env = process.env): string {
  return join(stateDir(env), "voice.json");
}
/** The model cache: Whisper models and the speech filter. */
export function cacheDir(env: Env = process.env): string {
  return env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, "corgi-voice") : join(home(env), ".cache", "corgi-voice");
}
/** The in-Corgi voice mode's settings file (read only). */
export function oldSettingsFile(env: Env = process.env): string {
  return env.XDG_STATE_HOME
    ? join(env.XDG_STATE_HOME, "corgi", "voice.json")
    : join(home(env), ".local", "state", "corgi", "voice.json");
}
/** The in-Corgi voice mode's model cache (read only). */
export function oldCacheDir(env: Env = process.env): string {
  return env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, "corgi", "voice") : join(home(env), ".cache", "corgi", "voice");
}
/** The default transcript folder, unchanged from the in-Corgi voice mode. */
export function transcriptsDefault(env: Env = process.env): string {
  return env.XDG_DATA_HOME
    ? join(env.XDG_DATA_HOME, "corgi", "transcripts")
    : join(home(env), ".local", "share", "corgi", "transcripts");
}
/** The verbose log. */
export function logFile(env: Env = process.env): string {
  return join(stateDir(env), "voice.log");
}
/** The single-instance lock: `$XDG_RUNTIME_DIR/corgi-voice.lock`, else in the state folder. */
export function lockFile(env: Env = process.env): string {
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "corgi-voice.lock") : join(stateDir(env), "lock");
}
/** The longest socket path the system takes: macOS's `sun_path` holds 104
 * bytes, the closing NUL included (Linux's 108). */
export const max_socket_path = 103;
/** The control channel's socket, next to the lock (`usualSocketPath`). A
 * path too long for a socket becomes one in a folder of the user's own under
 * `$TMPDIR`, created 0700 when missing and refused (`SocketFolderUnsafe`,
 * with the reason as `detail`) when someone else owns it, others may write
 * to it, others may replace it (a `$TMPDIR` owned by someone other than the
 * user or root, or writable by others without the sticky bit), or it is
 * still too long. corgi-voice and its commands both
 * ask here, so they always meet. */
export function socketPath(env: Env = process.env): string {
  const wanted = usualSocketPath(env);
  if (Buffer.byteLength(wanted) <= max_socket_path) return wanted;
  const uid = process.getuid?.() ?? 0,
    parent = env.TMPDIR || tmpdir(),
    folder = join(parent, `corgi-voice-${uid}`),
    path = join(folder, "control.sock"),
    unsafe = (why: string) => Object.assign(Error("SocketFolderUnsafe"), { detail: `${folder}: ${why}` });
  if (Buffer.byteLength(path) > max_socket_path) throw unsafe("too long for a socket too");
  try {
    // Followed: macOS's /tmp and $TMPDIR sit behind symbolic links.
    // Who may rename what is in it: its owner, and without the sticky bit
    // anyone who may write to it. Only the user and root are trusted.
    const above = statSync(parent);
    if (above.uid !== uid && above.uid !== 0) throw unsafe(`others may replace it (${parent} belongs to someone else)`);
    if (above.mode & 0o022 && !(above.mode & 0o1000))
      throw unsafe(`others may replace it (${parent} is writable by others and not sticky)`);
    mkdirSync(folder, { mode: 0o700 });
  } catch (error) {
    if ((error as Error).message === "SocketFolderUnsafe") throw error;
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unsafe((error as Error).message);
  }
  const st = lstatSync(folder);
  if (!st.isDirectory()) throw unsafe("not a folder");
  if (st.uid !== uid) throw unsafe("owned by someone else");
  if (st.mode & 0o022) throw unsafe("others may write to it");
  return path;
}
/** Where the socket goes when that path is short enough: next to the lock,
 * `$XDG_RUNTIME_DIR/corgi-voice.sock`, else `control.sock` in the state
 * folder. It stays right after `socketPath`, the only place naming it. */
function usualSocketPath(env: Env): string {
  return env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "corgi-voice.sock") : join(stateDir(env), "control.sock");
}
/** Whether `path`, from `socketPath`, had to leave the usual place for a shorter one. */
export function socketMoved(path: string, env: Env = process.env): boolean {
  return path !== usualSocketPath(env);
}
