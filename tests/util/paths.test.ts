import { test, expect } from "bun:test";
import * as paths from "../../src/util/paths";

const xdg = {
  HOME: "/home/u",
  XDG_STATE_HOME: "/x/state",
  XDG_CACHE_HOME: "/x/cache",
  XDG_DATA_HOME: "/x/data",
  XDG_RUNTIME_DIR: "/run/user/1",
};
const plain = { HOME: "/home/u" };

test("XDG locations win when set", () => {
  expect(paths.settingsFile(xdg)).toBe("/x/state/corgi-voice/voice.json");
  expect(paths.cacheDir(xdg)).toBe("/x/cache/corgi-voice");
  expect(paths.oldSettingsFile(xdg)).toBe("/x/state/corgi/voice.json");
  expect(paths.oldCacheDir(xdg)).toBe("/x/cache/corgi/voice");
  expect(paths.transcriptsDefault(xdg)).toBe("/x/data/corgi/transcripts");
  expect(paths.logFile(xdg)).toBe("/x/state/corgi-voice/voice.log");
  expect(paths.lockFile(xdg)).toBe("/run/user/1/corgi-voice.lock");
});

test("home folder fallbacks without XDG variables", () => {
  expect(paths.settingsFile(plain)).toBe("/home/u/.local/state/corgi-voice/voice.json");
  expect(paths.cacheDir(plain)).toBe("/home/u/.cache/corgi-voice");
  expect(paths.oldSettingsFile(plain)).toBe("/home/u/.local/state/corgi/voice.json");
  expect(paths.oldCacheDir(plain)).toBe("/home/u/.cache/corgi/voice");
  expect(paths.transcriptsDefault(plain)).toBe("/home/u/.local/share/corgi/transcripts");
  expect(paths.logFile(plain)).toBe("/home/u/.local/state/corgi-voice/voice.log");
  expect(paths.lockFile(plain)).toBe("/home/u/.local/state/corgi-voice/lock");
});

test("no path names cc-deck", () => {
  for (const env of [xdg, plain])
    for (const fn of [
      paths.settingsFile,
      paths.cacheDir,
      paths.oldSettingsFile,
      paths.oldCacheDir,
      paths.transcriptsDefault,
      paths.logFile,
      paths.lockFile,
    ])
      expect(fn(env)).not.toContain("cc-deck");
});
