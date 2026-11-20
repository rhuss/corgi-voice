//! Where corgi-voice keeps its files (FR-022, FR-024), and where the
//! in-Corgi voice mode kept them, which is only ever read.
import { homedir } from "node:os";
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
