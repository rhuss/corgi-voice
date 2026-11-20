//! Taking over from the in-Corgi voice mode (FR-024): its settings are
//! copied when corgi-voice has none, and each model missing from
//! corgi-voice's cache is taken from the old one (hard link, else copy)
//! instead of downloaded. The old files are only ever read.
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import * as paths from "./paths";
import * as models from "../voice/models";

export type MigrateDeps = {
  /** The model files to look for; every Whisper model and the speech filter by default. */
  entries?: models.Entry[];
  /** Makes a hard link; a stand-in lets tests fail it. */
  link?: (from: string, to: string) => void;
};

function size(file: string): number | null {
  try {
    const s = statSync(file);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}
/** Copies the old settings and takes the old models; returns what it did, as notices. */
export function migrate(env: NodeJS.ProcessEnv = process.env, deps: MigrateDeps = {}): { notices: string[] } {
  const notices: string[] = [],
    link = deps.link ?? linkSync;
  const settings = paths.settingsFile(env),
    old = paths.oldSettingsFile(env);
  if (!existsSync(settings) && size(old) !== null) {
    try {
      mkdirSync(dirname(settings), { recursive: true, mode: 0o700 });
      copyFileSync(old, settings);
      chmodSync(settings, 0o600);
      notices.push(`Copied the settings of corgi voice from ${old}`);
    } catch (error) {
      notices.push(`Could not copy the settings of corgi voice from ${old}: ${(error as Error).message}`);
    }
  }
  const cache = paths.cacheDir(env),
    oldCache = paths.oldCacheDir(env);
  for (const entry of deps.entries ?? [...Object.values(models.catalog), models.filter]) {
    const to = join(cache, entry.file),
      from = join(oldCache, entry.file);
    // Only a whole file counts, on either side.
    if (size(to) === entry.bytes || size(from) !== entry.bytes) continue;
    try {
      mkdirSync(cache, { recursive: true });
      if (existsSync(to)) continue;
      try {
        link(from, to);
      } catch {
        // Another file system, or links not allowed: a copy then.
        copyFileSync(from, to);
      }
      notices.push(`Took ${entry.file} from ${oldCache}`);
    } catch (error) {
      notices.push(`Could not take ${entry.file} from ${oldCache}: ${(error as Error).message}`);
    }
  }
  return { notices };
}
