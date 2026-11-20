import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate, sha256 } from "../../src/util/migrate";
import * as models from "../../src/voice/models";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A home with XDG folders of its own. */
function home() {
  const root = mkdtempSync(join(tmpdir(), "cv-migrate-"));
  dirs.push(root);
  const env = {
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
  return {
    env,
    oldSettings: join(root, "state", "corgi", "voice.json"),
    newSettings: join(root, "state", "corgi-voice", "voice.json"),
    oldCache: join(root, "cache", "corgi", "voice"),
    newCache: join(root, "cache", "corgi-voice"),
  };
}
/** A model file of the pinned size, so it counts as installed. */
function model(dir: string, entry: models.Entry): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, entry.file);
  // A sparse file of the pinned size: no real download needed.
  writeFileSync(file, "");
  Bun.spawnSync(["truncate", "-s", String(entry.bytes), file]);
  return file;
}
const entries = [models.catalog["tiny.en"], models.filter];
/** Says every file has its pinned hash: the sparse stand-ins hold no real model. */
const pinned = (file: string) => entries.find(e => file.endsWith(e.file))!.sha256;
/** Fails the test's expectation of no notices if anything is hashed. */
const unhashed = () => {
  throw Error("hashed needlessly");
};
/** A small model of its own: `content`, pinned by its real size and hash. */
function small(content: string | Uint8Array, file = "ggml-small-test.bin"): models.Entry {
  const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    name: "tiny.en",
    file,
    url: "http://127.0.0.1:1/unused",
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

test("settings are copied from the old file when the new one is missing, privately, with a notice", () => {
  const h = home();
  mkdirSync(join(h.env.XDG_STATE_HOME, "corgi"), { recursive: true });
  writeFileSync(h.oldSettings, '{"threshold": 60}\n');
  chmodSync(h.oldSettings, 0o644);
  const { notices } = migrate(h.env, { entries });
  expect(readFileSync(h.newSettings, "utf8")).toBe('{"threshold": 60}\n');
  expect(statSync(h.newSettings).mode & 0o777).toBe(0o600);
  expect(notices).toEqual([`Copied the settings of corgi voice from ${h.oldSettings}`]);
  // The old file is unchanged.
  expect(readFileSync(h.oldSettings, "utf8")).toBe('{"threshold": 60}\n');
  expect(statSync(h.oldSettings).mode & 0o777).toBe(0o644);
});

test("settings are not copied when the new file exists", () => {
  const h = home();
  mkdirSync(join(h.env.XDG_STATE_HOME, "corgi"), { recursive: true });
  mkdirSync(join(h.env.XDG_STATE_HOME, "corgi-voice"), { recursive: true });
  writeFileSync(h.oldSettings, '{"threshold": 60}');
  writeFileSync(h.newSettings, '{"threshold": 30}');
  expect(migrate(h.env, { entries }).notices).toEqual([]);
  expect(readFileSync(h.newSettings, "utf8")).toBe('{"threshold": 30}');
});

test("without old settings nothing is created", () => {
  const h = home();
  expect(migrate(h.env, { entries }).notices).toEqual([]);
  expect(existsSync(h.newSettings)).toBe(false);
});

test("each missing model file is taken from the old cache by a hard link", () => {
  const h = home();
  const old = model(h.oldCache, models.filter);
  const { notices } = migrate(h.env, { entries, hash: pinned });
  const taken = join(h.newCache, models.filter.file);
  expect(statSync(taken).size).toBe(models.filter.bytes);
  // A hard link: the same file, no second copy on disk.
  expect(statSync(taken).ino).toBe(statSync(old).ino);
  expect(notices).toEqual([`Took ${models.filter.file} from ${h.oldCache}`]);
  // Present now, it is not taken again, nor hashed again.
  expect(migrate(h.env, { entries, hash: unhashed }).notices).toEqual([]);
});

test("a model is copied when it cannot be linked (another file system)", () => {
  const h = home();
  const old = model(h.oldCache, models.filter);
  migrate(h.env, {
    entries,
    hash: pinned,
    link: () => {
      throw Object.assign(Error("cross-device link"), { code: "EXDEV" });
    },
  });
  const taken = join(h.newCache, models.filter.file);
  expect(statSync(taken).size).toBe(models.filter.bytes);
  expect(statSync(taken).ino).not.toBe(statSync(old).ino);
});

test("partial or present models are left alone, and old files are never changed", () => {
  const h = home();
  mkdirSync(h.oldCache, { recursive: true });
  // A partial download in the old cache does not count.
  writeFileSync(join(h.oldCache, models.catalog["tiny.en"].file), "short");
  const old = model(h.oldCache, models.filter);
  const before = statSync(old);
  model(h.newCache, models.filter);
  // Neither is hashed: a size that is off, or a file that is there, settles it.
  expect(migrate(h.env, { entries, hash: unhashed }).notices).toEqual([]);
  expect(existsSync(join(h.newCache, models.catalog["tiny.en"].file))).toBe(false);
  const after = statSync(old);
  expect([after.size, after.mtimeMs, after.mode]).toEqual([before.size, before.mtimeMs, before.mode]);
});

test("a file is taken only when its SHA-256 is the pinned one, hashed a chunk at a time", () => {
  const h = home(),
    // More than the megabyte read at a time, and no multiple of it.
    content = new Uint8Array(2_500_001).map((_, i) => (i * 31) % 251),
    entry = small(content);
  mkdirSync(h.oldCache, { recursive: true });
  writeFileSync(join(h.oldCache, entry.file), content);
  expect(sha256(join(h.oldCache, entry.file))).toBe(entry.sha256);
  expect(migrate(h.env, { entries: [entry] }).notices).toEqual([`Took ${entry.file} from ${h.oldCache}`]);
  expect(sha256(join(h.newCache, entry.file))).toBe(entry.sha256);
});

test("a file of the right size whose checksum does not match is not taken, and both sides stay as they are", () => {
  const h = home(),
    entry = small("the model that is pinned");
  mkdirSync(h.oldCache, { recursive: true });
  const old = join(h.oldCache, entry.file);
  // The same length, another content: only the hash can tell.
  writeFileSync(old, "the model that is pruned");
  expect(statSync(old).size).toBe(entry.bytes);
  const before = statSync(old);
  expect(migrate(h.env, { entries: [entry] }).notices).toEqual([
    `Did not take ${entry.file} from ${h.oldCache}: its checksum does not match`,
  ]);
  expect(existsSync(h.newCache)).toBe(false);
  const after = statSync(old);
  expect(readFileSync(old, "utf8")).toBe("the model that is pruned");
  expect([after.size, after.mtimeMs, after.mode, after.nlink]).toEqual([before.size, before.mtimeMs, before.mode, 1]);
  // Setup downloads it then; until it has, each start says so again.
  expect(migrate(h.env, { entries: [entry] }).notices).toHaveLength(1);
});

test("a partial file in the new cache is left alone: nothing is taken over on top of it", () => {
  const h = home(),
    entry = small("a whole model");
  mkdirSync(h.oldCache, { recursive: true });
  mkdirSync(h.newCache, { recursive: true });
  writeFileSync(join(h.oldCache, entry.file), "a whole model");
  const partial = join(h.newCache, entry.file);
  writeFileSync(partial, "a who");
  const before = statSync(partial);
  // The old file is whole and would match; it is not even hashed.
  expect(migrate(h.env, { entries: [entry], hash: unhashed }).notices).toEqual([]);
  expect(readFileSync(partial, "utf8")).toBe("a who");
  expect([statSync(partial).ino, statSync(partial).mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  expect(statSync(join(h.oldCache, entry.file)).nlink).toBe(1);
});

test("an old file that cannot be read is reported, not taken", () => {
  const h = home(),
    entry = small("unreadable");
  mkdirSync(h.oldCache, { recursive: true });
  writeFileSync(join(h.oldCache, entry.file), "unreadable");
  const { notices } = migrate(h.env, {
    entries: [entry],
    hash: () => {
      throw Error("EACCES: permission denied");
    },
  });
  expect(notices).toEqual([`Could not take ${entry.file} from ${h.oldCache}: EACCES: permission denied`]);
  expect(existsSync(join(h.newCache, entry.file))).toBe(false);
});
