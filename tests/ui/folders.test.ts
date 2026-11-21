import { test, expect, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { above, filtered, located, partAt, shown, subfolders } from "../../src/ui/folders";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    // An unreadable folder must be readable again to be removed.
    try {
      chmodSync(join(d, "folder", "locked"), 0o700);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});
/** A transcript folder with `meetings/`, `meetups/`, `notes/2026/`,
 * `.hidden/`, a file `old.txt`, a link `link -> notes`, a link to the file
 * and an unreadable `locked/`. */
function tree() {
  const root = mkdtempSync(join(tmpdir(), "cv-folders-"));
  dirs.push(root);
  const folder = join(root, "folder");
  for (const d of ["meetings", "meetups", "notes/2026", ".hidden", "locked"]) mkdirSync(join(folder, d), { recursive: true });
  writeFileSync(join(folder, "old.txt"), "Earlier.\n");
  symlinkSync(join(folder, "notes"), join(folder, "link"));
  symlinkSync(join(folder, "old.txt"), join(folder, "old-link"));
  symlinkSync(join(folder, "gone"), join(folder, "dangling"));
  chmodSync(join(folder, "locked"), 0o000);
  return { root, folder };
}
const entry = (name: string, dir: boolean) => ({ name, isDirectory: () => dir, isSymbolicLink: () => false });

test("a folder lists its sub-folders in code point order, links to folders included, files and hidden ones kept for the filter", () => {
  const { folder } = tree();
  expect(subfolders(folder)).toEqual({
    names: [".hidden", "link", "locked", "meetings", "meetups", "notes"],
    unreadable: false,
  });
});

test("an unreadable folder lists nothing and says so; a missing one simply has none; nothing throws", () => {
  const { folder } = tree();
  if (process.getuid?.() !== 0) expect(subfolders(join(folder, "locked"))).toEqual({ names: [], unreadable: true });
  expect(subfolders(join(folder, "missing"))).toEqual({ names: [], unreadable: false });
  // A file in place of a folder has no sub-folders either.
  expect(subfolders(join(folder, "old.txt"))).toEqual({ names: [], unreadable: false });
  const failing = () => {
    throw new Error("EACCES");
  };
  expect(subfolders("/t", failing)).toEqual({ names: [], unreadable: true });
});

test("listing goes through the injected reader, and reads only", () => {
  const seen: string[] = [];
  const list = (dir: string) => {
    seen.push(dir);
    return [entry("beta", true), entry("alpha", true), entry("alps.txt", false)];
  };
  expect(subfolders("/t", list)).toEqual({ names: ["alpha", "beta"], unreadable: false });
  expect(seen).toEqual(["/t"]);
});

test("an empty filter keeps every visible folder, hidden ones only for a filter starting with a dot", () => {
  const names = [".hidden", ".config", "link", "notes"];
  expect(filtered(names, "")).toEqual(["link", "notes"]);
  expect(filtered(names, ".")).toEqual([".hidden", ".config"]);
  expect(filtered(names, ".c")).toEqual([".config"]);
  // Not when the dot is further in.
  expect(filtered(names, "id")).toEqual([]);
});

test("the filter puts names starting with it first, then names containing it, each in code point order", () => {
  const names = ["2025", "2026", "Archive-2026", "meetings", "meetups", "notes", "planning-2026"];
  expect(filtered(names, "20")).toEqual(["2025", "2026", "Archive-2026", "planning-2026"]);
  expect(filtered(names, "me")).toEqual(["meetings", "meetups"]);
  expect(filtered(names, "n")).toEqual(["notes", "meetings", "planning-2026"]);
  expect(filtered(names, "zz")).toEqual([]);
});

test("the filter ignores case, and composed and decomposed letters alike", () => {
  const names = ["Meetings", "notes", "Überblick"];
  expect(filtered(names, "MEE")).toEqual(["Meetings"]);
  expect(filtered(names, "NoT")).toEqual(["notes"]);
  // macOS hands out decomposed names; a typed composed letter still matches.
  expect(filtered(names, "üb")).toEqual(["Überblick"]);
});

test("names with control characters are listed as they are; a space in the filter matches them", () => {
  const { folder } = tree();
  mkdirSync(join(folder, "bad\x1bname"));
  mkdirSync(join(folder, "bad\nline"));
  const { names } = subfolders(folder);
  expect(names).toContain("bad\x1bname");
  expect(filtered(names, "bad n")).toEqual(["bad\x1bname"]);
});

test("order is by code point, not by UTF-16 unit", () => {
  const { folder } = tree();
  for (const d of ["\u{1F600}a", "\u{FF21}x"]) mkdirSync(join(folder, d));
  expect(subfolders(folder).names.slice(-2)).toEqual(["\u{FF21}x", "\u{1F600}a"]);
});

test("the field shows the home folder and below as ~/, anything else absolute, ending in /", () => {
  expect(shown("/home/me", "/home/me")).toBe("~/");
  expect(shown("/home/me/", "/home/me")).toBe("~/");
  expect(shown("/home/me/.local/share/corgi/transcripts", "/home/me")).toBe("~/.local/share/corgi/transcripts/");
  expect(shown("/home/me/notes", "/home/me/")).toBe("~/notes/");
  expect(shown("/home", "/home/me")).toBe("/home/");
  expect(shown("/home/meier", "/home/me")).toBe("/home/meier/");
  expect(shown("/tmp/x", "/home/me")).toBe("/tmp/x/");
  expect(shown("/", "/home/me")).toBe("/");
});

test("the part at the caret: the file name after the last /, else the folder part around the caret", () => {
  const chars = [..."~/a/bc/file.txt"];
  expect(partAt(chars, 15)).toEqual({ file: true, from: 7, to: 15, folder: "~/a/bc/" });
  expect(partAt(chars, 7)).toEqual({ file: true, from: 7, to: 15, folder: "~/a/bc/" });
  // Right before a `/`, and right after one, the caret is in that folder part.
  expect(partAt(chars, 6)).toEqual({ file: false, from: 4, to: 6, folder: "~/a/" });
  expect(partAt(chars, 5)).toEqual({ file: false, from: 4, to: 6, folder: "~/a/" });
  expect(partAt(chars, 4)).toEqual({ file: false, from: 4, to: 6, folder: "~/a/" });
  expect(partAt(chars, 0)).toEqual({ file: false, from: 0, to: 1, folder: "" });
  // A name without a folder is all file name; code points, not UTF-16 units.
  expect(partAt([..."日本.txt"], 2)).toEqual({ file: true, from: 0, to: 6, folder: "" });
  expect(partAt([..."日/x"], 0)).toEqual({ file: false, from: 0, to: 1, folder: "" });
});

test("a folder in the field is located against home, as given, or in the transcript folder; .. parts are resolved", () => {
  expect(located("~/", "/data", "/home/me")).toBe("/home/me/");
  expect(located("~/notes/", "/data", "/home/me")).toBe("/home/me/notes/");
  expect(located("/tmp/a/../b/", "/data", "/home/me")).toBe("/tmp/b/");
  expect(located("", "/data", "/home/me")).toBe("/data");
  expect(located("  calls/", "/data", "/home/me")).toBe("/data/calls/");
  expect(located("../", "/data/t", "/home/me")).toBe("/data/");
});

test("going up takes away the last folder part, resolves ~, . and .. first, and never goes past /", () => {
  const up = (folder: string) => above(folder, "/data/t", "/home/me");
  expect(up("~/notes/2026/")).toBe("~/notes/");
  expect(up("~/notes/")).toBe("~/");
  expect(up("~/")).toBe("/home/");
  expect(up("/home/")).toBe("/");
  expect(up("/")).toBe("/");
  expect(up("calls/")).toBe("");
  expect(up("~/a/b/../")).toBe("~/");
  expect(up("~/a/./")).toBe("~/");
  expect(up("../")).toBe("/");
  expect(up("")).toBe("");
});
