import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../../src/util/migrate";
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
  const { notices } = migrate(h.env, { entries });
  const taken = join(h.newCache, models.filter.file);
  expect(statSync(taken).size).toBe(models.filter.bytes);
  // A hard link: the same file, no second copy on disk.
  expect(statSync(taken).ino).toBe(statSync(old).ino);
  expect(notices).toEqual([`Took ${models.filter.file} from ${h.oldCache}`]);
  // Present now, it is not taken again.
  expect(migrate(h.env, { entries }).notices).toEqual([]);
});

test("a model is copied when it cannot be linked (another file system)", () => {
  const h = home();
  const old = model(h.oldCache, models.filter);
  migrate(h.env, {
    entries,
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
  expect(migrate(h.env, { entries }).notices).toEqual([]);
  expect(existsSync(join(h.newCache, models.catalog["tiny.en"].file))).toBe(false);
  const after = statSync(old);
  expect([after.size, after.mtimeMs, after.mode]).toEqual([before.size, before.mtimeMs, before.mode]);
});
