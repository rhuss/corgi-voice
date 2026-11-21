//! The repository's own boundaries (FR-002, FR-031, SC-004, SC-007): no
//! import outside the repository, only src/corgi/ runs corgi, never
//! `--enter`, nothing about cc-deck, no native code.
import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname } from "node:path";

const root = resolve(import.meta.dir, ".."),
  src = join(root, "src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
const sources = files(src).filter(f => f.endsWith(".ts"));
const imports = (text: string) => [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(m => m[1]);

test("no file under src/ imports from outside the repository", () => {
  for (const file of sources)
    for (const spec of imports(readFileSync(file, "utf8"))) {
      if (spec.startsWith("node:")) continue;
      // No npm runtime dependencies: only relative imports.
      expect([relative(root, file), spec.startsWith(".")]).toEqual([relative(root, file), true]);
      const target = resolve(dirname(file), spec);
      expect(target.startsWith(root + "/")).toBe(true);
    }
});

test("package.json has no runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.dependencies ?? {}).toEqual({});
  expect(pkg.bin).toEqual({ "corgi-voice": "src/main.ts" });
});

test("only src/corgi/ spawns the corgi command", () => {
  for (const file of sources) {
    const rel = relative(src, file);
    if (rel.startsWith("corgi/") || rel === "util/subprocess.ts") continue;
    const text = readFileSync(file, "utf8");
    // Every corgi call is built from the resolved command in src/corgi/.
    expect([rel, /(?:run|spawn)\s*\(\s*\[\s*(?:cmd|this\.cmd|"corgi")/.test(text)]).toEqual([rel, false]);
    expect([rel, /"pane",\s*"send"/.test(text)]).toEqual([rel, false]);
  }
});

test("--enter appears nowhere in src/", () => {
  for (const file of sources) expect([relative(src, file), readFileSync(file, "utf8").includes("--enter")]).toEqual([relative(src, file), false]);
});

test("cc-deck appears nowhere in src/", () => {
  for (const file of sources)
    expect([relative(src, file), /cc-deck/i.test(readFileSync(file, "utf8"))]).toEqual([relative(src, file), false]);
});

test("no native code and no Corgi UI modules", () => {
  const all = files(root).filter(f => !f.includes("/node_modules/") && !f.includes("/.git/"));
  for (const file of all) expect([relative(root, file), /\.(zig|c|cc|cpp|h|so|dylib|node)$/.test(file)]).toEqual([relative(root, file), false]);
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const module of ["frame_diff", "name_dialog", "new_workspace", "native_bridge", "viewer_native", "bun:ffi"])
      expect([relative(src, file), text.includes(module)]).toEqual([relative(src, file), false]);
  }
});

/** The text of `socketPath()` in src/util/paths.ts, up to the next declaration. */
function socketPathBody(text: string): string {
  const from = text.indexOf("export function socketPath(");
  if (from < 0) return "";
  const next = text.indexOf("\nexport ", from + 1);
  return text.slice(from, next < 0 ? undefined : next);
}

test("nothing reads Corgi's state, sockets or protocol", () => {
  for (const file of sources) {
    const rel = relative(src, file);
    let text = readFileSync(file, "utf8");
    // corgi-voice's own control channel: its socket's name lives only in
    // socketPath(), and only src/control/ connects to it.
    if (rel === "util/paths.ts") text = text.replace(socketPathBody(text), "");
    const own = rel.startsWith("control/");
    for (const off of ["control.sock", "websocket", "/protocol", "/rpc", "Bun.connect({ unix"]) {
      if (own && off === "Bun.connect({ unix") continue;
      expect([rel, off, text.includes(off)]).toEqual([rel, off, false]);
    }
    // Corgi's own socket and state folder stay out of reach everywhere,
    // src/control/ and socketPath() included.
    const whole = readFileSync(file, "utf8");
    for (const off of [/["/]corgi\/control\.sock/, /"corgi",\s*"control\.sock"/, /corgi\.sock/])
      expect([rel, String(off), off.test(whole)]).toEqual([rel, String(off), false]);
  }
});

test("socketPath() only ever names corgi-voice's own folders", async () => {
  const paths = await import("../src/util/paths");
  const uid = process.getuid?.() ?? 0,
    tmp = mkdtempSync(join(tmpdir(), "cv-contract-")),
    own = /(?:\/corgi-voice\.sock|\/corgi-voice\/control\.sock|\/corgi-voice-\d+\/control\.sock)$/;
  try {
    for (const env of [
      { HOME: "/home/u", XDG_RUNTIME_DIR: "/run/user/1" },
      { HOME: "/home/u", XDG_STATE_HOME: "/x/state" },
      { HOME: "/home/u" },
      { HOME: "/home/u", XDG_STATE_HOME: join("/x", "s".repeat(120)), TMPDIR: tmp },
      { HOME: "/home/u", XDG_RUNTIME_DIR: join("/r", "r".repeat(120)), TMPDIR: tmp },
    ]) {
      const path = paths.socketPath(env);
      expect([path, own.test(path)]).toEqual([path, true]);
      expect(path).not.toMatch(/\/corgi\//);
    }
    expect(paths.socketPath({ HOME: "/h", XDG_STATE_HOME: join("/x", "s".repeat(120)), TMPDIR: tmp })).toBe(
      join(tmp, `corgi-voice-${uid}`, "control.sock"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("src/control/ never runs corgi and never sends text to a pane (FR-006)", () => {
  const control = sources.filter(f => relative(src, f).startsWith("control/"));
  expect(control.map(f => relative(src, f)).sort()).toEqual(["control/client.ts", "control/server.ts", "control/state.ts"]);
  for (const file of control) {
    const rel = relative(src, file),
      text = readFileSync(file, "utf8");
    // No process at all: the channel only answers and mutes.
    for (const off of [/\bspawn(?:Sync)?\s*\(/, /\bexec(?:File|Sync)?\s*\(/, /node:child_process/, /\.\.\/corgi\//, /\.\.\/util\/subprocess/])
      expect([rel, String(off), off.test(text)]).toEqual([rel, String(off), false]);
    for (const off of ["pane send", '"pane", "send"', '"send"', ".type("])
      expect([rel, off, text.includes(off)]).toEqual([rel, off, false]);
  }
});

test("the README shows the hotkey recipes, the state line, the JSON fields and the exit codes (US3, FR-011)", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8"),
    start = readme.indexOf("## Mute from anywhere"),
    section = readme.slice(start, readme.indexOf("\n## ", start + 1));
  expect(start).toBeGreaterThan(0);
  for (const flag of ["--mute", "--unmute", "--toggle-mute", "--status", "--status --json", "--watch", "--watch --json"])
    expect([flag, section.includes(`corgi-voice ${flag}`)]).toEqual([flag, true]);
  // One recipe each, with the absolute path found by `command -v`.
  expect(section).toContain("command -v corgi-voice");
  expect(section).toContain("macOS Shortcuts");
  expect(section).toMatch(/skhd[\s\S]*corgi-voice --toggle-mute/);
  expect(section).toMatch(/hs\.hotkey\.bind[\s\S]*corgi-voice --toggle-mute/);
  for (const field of ["pid", "muted", "mode", "unavailable", "reason", "recording", "target", "updated_at"])
    expect([field, section.includes(`| \`${field}\` |`)]).toEqual([field, true]);
  for (const code of ["0", "1", "2", "3"]) expect([code, section.includes(`| \`${code}\` |`)]).toEqual([code, true]);
  expect(section).toContain("`listening · bat · corgi-voice`");
  expect(section).toContain("`muted · cannot listen: microphone missing`");
});
