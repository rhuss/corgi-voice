//! Taking over from the in-Corgi voice mode (FR-024): its settings are
//! copied when corgi-voice has none, and each model missing from
//! corgi-voice's cache is taken from the old one (hard link, else copy)
//! instead of downloaded, once its SHA-256 matches the pinned one. The old
//! files are only ever read.
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import * as paths from "./paths";
import * as models from "../voice/models";

export type MigrateDeps = {
  /** The model files to look for; every Whisper model and the speech filter by default. */
  entries?: models.Entry[];
  /** Makes a hard link; a stand-in lets tests fail it. */
  link?: (from: string, to: string) => void;
  /** A file's SHA-256 in hex; a stand-in spares tests a real model's content. */
  hash?: (file: string) => string;
};

/** The SHA-256 of `file` in hex, read a megabyte at a time: a model is up to
 * 1.6 GB, and is never held in memory whole. */
export function sha256(file: string): string {
  const hash = createHash("sha256"),
    chunk = Buffer.allocUnsafe(1 << 20),
    fd = openSync(file, "r");
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

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
    link = deps.link ?? linkSync,
    hash = deps.hash ?? sha256;
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
    // Only a whole file counts, on either side. A file of another size in
    // the new cache (a broken download, say) is left for setup to replace.
    if (size(to) === entry.bytes || size(from) !== entry.bytes || existsSync(to)) continue;
    try {
      // The size alone proves nothing about the content: the old file is
      // taken only when it is the pinned one. A file that matches is hashed
      // once, as it is in the new cache from then on; one that does not is
      // hashed on each start until setup has downloaded it.
      if (hash(from) !== entry.sha256) {
        notices.push(`Did not take ${entry.file} from ${oldCache}: its checksum does not match`);
        continue;
      }
      mkdirSync(cache, { recursive: true });
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
