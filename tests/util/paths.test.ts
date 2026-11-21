import { test, expect, describe, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
      paths.socketPath,
    ])
      expect(fn(env)).not.toContain("cc-deck");
});

test("the control socket sits next to the lock", () => {
  expect(paths.socketPath(xdg)).toBe("/run/user/1/corgi-voice.sock");
  expect(paths.socketPath({ HOME: "/home/u", XDG_STATE_HOME: "/x/state" })).toBe("/x/state/corgi-voice/control.sock");
  expect(paths.socketPath(plain)).toBe("/home/u/.local/state/corgi-voice/control.sock");
  expect(paths.socketMoved(paths.socketPath(xdg), xdg)).toBe(false);
  expect(paths.socketMoved(paths.socketPath(plain), plain)).toBe(false);
});

describe("a socket path too long for the system", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const temp = () => {
    const d = mkdtempSync(join(tmpdir(), "cv-paths-"));
    made.push(d);
    return d;
  };
  const uid = process.getuid!();

  test("moves to a folder of the user's own under $TMPDIR, created 0700", () => {
    const tmp = temp(),
      env = { HOME: "/home/u", XDG_STATE_HOME: join("/x", "s".repeat(100)), TMPDIR: tmp };
    // The usual place would be too long; the fallback is computed, never bound to find out.
    expect(Buffer.byteLength(join(env.XDG_STATE_HOME, "corgi-voice", "control.sock"))).toBeGreaterThan(paths.max_socket_path);
    const path = paths.socketPath(env);
    expect(path).toBe(join(tmp, `corgi-voice-${uid}`, "control.sock"));
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(paths.socketMoved(path, env)).toBe(true);
    // A long $XDG_RUNTIME_DIR moves the same way.
    expect(paths.socketPath({ HOME: "/h", XDG_RUNTIME_DIR: join("/r", "r".repeat(110)), TMPDIR: tmp })).toBe(path);
    // Asked again, the existing folder is used.
    expect(paths.socketPath(env)).toBe(path);
  });

  test("refuses a folder others may write to, or that is not a folder", () => {
    const tmp = temp(),
      env = { HOME: "/home/u", XDG_STATE_HOME: join("/x", "s".repeat(100)), TMPDIR: tmp },
      folder = join(tmp, `corgi-voice-${uid}`);
    mkdirSync(folder, { mode: 0o700 });
    chmodSync(folder, 0o777);
    expect(() => paths.socketPath(env)).toThrow("SocketFolderUnsafe");
    rmSync(folder, { recursive: true });
    writeFileSync(folder, "");
    expect(() => paths.socketPath(env)).toThrow("SocketFolderUnsafe");
    // Writable by the group alone is refused too; readable by others is fine.
    rmSync(folder);
    mkdirSync(folder, { mode: 0o700 });
    chmodSync(folder, 0o720);
    expect(() => paths.socketPath(env)).toThrow("SocketFolderUnsafe");
    chmodSync(folder, 0o755);
    expect(paths.socketPath(env)).toBe(join(folder, "control.sock"));
  });

  test("takes a private or sticky $TMPDIR, refuses one others may write to, and a fallback still too long", () => {
    const tmp = temp(),
      env = { HOME: "/home/u", XDG_STATE_HOME: join("/x", "s".repeat(100)), TMPDIR: tmp };
    // Writable by others without the sticky bit: they could swap the folder.
    chmodSync(tmp, 0o777);
    expect(() => paths.socketPath(env)).toThrow("SocketFolderUnsafe");
    chmodSync(tmp, 0o700);
    expect(paths.socketPath(env)).toBe(join(tmp, `corgi-voice-${uid}`, "control.sock"));
    chmodSync(tmp, 0o1777);
    expect(paths.socketPath(env)).toBe(join(tmp, `corgi-voice-${uid}`, "control.sock"));
    chmodSync(tmp, 0o700);
    const long = { ...env, TMPDIR: join(tmp, "t".repeat(90)) };
    expect(() => paths.socketPath(long)).toThrow("SocketFolderUnsafe");
    try {
      paths.socketPath(long);
    } catch (error) {
      expect((error as { detail: string }).detail).toContain("too long");
    }
  });
});
