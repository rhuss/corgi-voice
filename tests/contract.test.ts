//! The repository's own boundaries (FR-002, FR-031, SC-004, SC-007): no
//! import outside the repository, only src/corgi/ runs corgi, never
//! `--enter`, nothing about cc-deck, no native code.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

test("nothing reads Corgi's state, sockets or protocol", () => {
  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    for (const off of ["control.sock", "websocket", "/protocol", "/rpc", "Bun.connect({ unix"])
      expect([relative(src, file), off, text.includes(off)]).toEqual([relative(src, file), off, false]);
  }
});
