import { test, expect, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { bunPath, install, manifest, tricksDir } from "../../src/trick/install";
import { socketPath } from "../../src/util/paths";
import { cleanup, folder, later } from "./helpers";

afterEach(cleanup);

type Manifest = { version: number; id: string; description: string; command: string[]; config: { socket: string } };
const read = (path: string) => Bun.TOML.parse(readFileSync(path, "utf8")) as Manifest;

test("the manifest: id, absolute command ending in --trick, and the channel path as config (US3 scenario 1, FR-011)", () => {
  const dir = folder(),
    env = { HOME: dir, CORGI_TRICKS_DIR: join(dir, "tricks"), XDG_RUNTIME_DIR: dir },
    { path } = install(env);
  expect(path).toBe(join(dir, "tricks", "corgi-voice", "trick.toml"));
  const m = read(path);
  expect(m.version).toBe(1);
  expect(m.id).toBe("corgi-voice");
  expect(m.description).toBe("Shows **corgi-voice** in the sidebar title row; click to mute.");
  expect(m.command).toHaveLength(3);
  expect(m.command[0]).toBe(process.execPath);
  expect(m.command[1]).toEndWith("/src/main.ts");
  expect(m.command[2]).toBe("--trick");
  expect(m.command.slice(0, 2).every(p => isAbsolute(p) && existsSync(p))).toBe(true);
  expect(m.config.socket).toBe(socketPath(env));
  expect(m.config.socket).toBe(join(dir, "corgi-voice.sock"));
});

test("the tricks folder: CORGI_TRICKS_DIR, else XDG_CONFIG_HOME, else ~/.config", () => {
  expect(tricksDir({ HOME: "/h", XDG_CONFIG_HOME: "/x", CORGI_TRICKS_DIR: "/t" })).toBe("/t");
  expect(tricksDir({ HOME: "/h", XDG_CONFIG_HOME: "/x" })).toBe("/x/corgi/tricks");
  expect(tricksDir({ HOME: "/h" })).toBe("/h/.config/corgi/tricks");
  expect(tricksDir({ HOME: "/h", XDG_CONFIG_HOME: "", CORGI_TRICKS_DIR: "" })).toBe("/h/.config/corgi/tricks");
  const dir = folder();
  expect(install({ HOME: dir, XDG_RUNTIME_DIR: dir }).path).toBe(join(dir, ".config", "corgi", "tricks", "corgi-voice", "trick.toml"));
  expect(install({ HOME: dir, XDG_CONFIG_HOME: join(dir, "cfg"), XDG_RUNTIME_DIR: dir }).path).toBe(
    join(dir, "cfg", "corgi", "tricks", "corgi-voice", "trick.toml"),
  );
});

test("a rerun replaces only corgi-voice/trick.toml, with the current paths (US3 scenario 2, FR-012)", () => {
  const dir = folder(),
    tricks = join(dir, "tricks"),
    other = join(tricks, "other");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "trick.toml"), "id = \"other\"\n");
  const env = { HOME: dir, CORGI_TRICKS_DIR: tricks, XDG_RUNTIME_DIR: dir },
    first = install(env, { bun: "/old/bun", main: "/old/main.ts" });
  writeFileSync(join(tricks, "corgi-voice", "notes.txt"), "mine");
  const second = install({ ...env, XDG_RUNTIME_DIR: join(dir, "rt") }, { bun: "/new/bun", main: "/new/main.ts" });
  expect(second.path).toBe(first.path);
  const m = read(second.path);
  expect(m.command).toEqual(["/new/bun", "/new/main.ts", "--trick"]);
  expect(m.config.socket).toBe(join(dir, "rt", "corgi-voice.sock"));
  expect(readFileSync(join(other, "trick.toml"), "utf8")).toBe("id = \"other\"\n");
  // No temporary file left, and nothing else in its folder touched.
  expect(readdirSync(join(tricks, "corgi-voice")).sort()).toEqual(["notes.txt", "trick.toml"]);
  expect(readdirSync(tricks).sort()).toEqual(["corgi-voice", "other"]);
});

test("a folder it cannot write is an error, leaving nothing behind", () => {
  const dir = folder(),
    locked = join(dir, "locked");
  mkdirSync(join(locked, "corgi-voice"), { recursive: true });
  chmodSync(join(locked, "corgi-voice"), 0o500);
  later(() => chmodSync(join(locked, "corgi-voice"), 0o700));
  expect(() => install({ HOME: dir, CORGI_TRICKS_DIR: locked, XDG_RUNTIME_DIR: dir })).toThrow(/EACCES/);
  expect(readdirSync(join(locked, "corgi-voice"))).toEqual([]);
  chmodSync(locked, 0o500);
  later(() => chmodSync(locked, 0o700));
  expect(() => install({ HOME: dir, CORGI_TRICKS_DIR: join(locked, "deeper"), XDG_RUNTIME_DIR: dir })).toThrow(/EACCES/);
});

test("a socket folder socketPath() refuses is an error, with its reason", () => {
  const dir = folder(),
    open = join(dir, "open");
  mkdirSync(open);
  chmodSync(open, 0o777);
  let caught: unknown;
  try {
    install({ HOME: dir, CORGI_TRICKS_DIR: join(dir, "tricks"), XDG_STATE_HOME: join(dir, "s".repeat(120)), TMPDIR: open });
  } catch (error) {
    caught = error;
  }
  expect((caught as Error).message).toBe("SocketFolderUnsafe");
  expect((caught as { detail: string }).detail).toContain("writable by others and not sticky");
  expect(existsSync(join(dir, "tricks"))).toBe(false);
});

test("paths with a space and a double quote round-trip through TOML", () => {
  const odd = '/Users/a "b" c/x\\y',
    text = manifest({ bun: `${odd}/bun`, main: `${odd}/main.ts`, socket: `${odd}/control.sock` }),
    m = Bun.TOML.parse(text) as Manifest;
  expect(m.command).toEqual([`${odd}/bun`, `${odd}/main.ts`, "--trick"]);
  expect(m.config.socket).toBe(`${odd}/control.sock`);
  // Through the file too.
  const dir = join(folder(), 'a "b" c'),
    { path } = install({ HOME: dir, CORGI_TRICKS_DIR: join(dir, "tricks"), XDG_RUNTIME_DIR: dir }, { bun: `${odd}/bun` });
  expect(read(path).command[0]).toBe(`${odd}/bun`);
  expect(read(path).config.socket).toBe(join(dir, "corgi-voice.sock"));
});

test("DEL is escaped and a lone surrogate refused, so the manifest is always valid TOML", () => {
  const m = Bun.TOML.parse(manifest({ bun: "/b/bun", main: "/m/main.ts", socket: "/s/a\x7fb.sock" })) as Manifest;
  expect(m.config.socket).toBe("/s/a\x7fb.sock");
  expect(() => manifest({ bun: "/b/bun", main: "/m/main.ts", socket: "/s/a\ud800b.sock" })).toThrow("NotUnicode");
});

test("bun: a stable link on PATH to the running bun, else the running bun itself", () => {
  const linked = folder(),
    other = folder(),
    running = process.execPath;
  symlinkSync(running, join(linked, "bun"));
  // A shim or another bun first on PATH is not the running binary.
  writeFileSync(join(other, "bun"), "#!/bin/sh\nexec bun \"$@\"\n", { mode: 0o755 });
  expect(bunPath({ PATH: linked }, running)).toBe(join(linked, "bun"));
  expect(bunPath({ PATH: `${other}:${linked}` }, running)).toBe(running);
  expect(bunPath({ PATH: "" }, running)).toBe(running);
  // A relative PATH entry would depend on the folder the install ran in.
  expect(bunPath({ PATH: relative(process.cwd(), linked) }, running)).toBe(running);
  expect(bunPath({}, running)).toBe(running);
  // The install writes it.
  const dir = folder(),
    { path } = install({ HOME: dir, CORGI_TRICKS_DIR: join(dir, "tricks"), XDG_RUNTIME_DIR: dir, PATH: linked });
  expect(read(path).command[0]).toBe(join(linked, "bun"));
});
