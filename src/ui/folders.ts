//! The path field's folder pop-down (FR-004 to FR-007): which part of the
//! path the caret is in, the folder that part lives in, that folder's
//! sub-folders (symbolic links to folders included) filtered as the user
//! types, and the path as the field shows it. Listing only reads: nothing is
//! created or changed, and a folder that cannot be read lists nothing, with
//! a note instead of an error.
import { readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { spaced } from "../util/text";

/** What a folder listing says about one name: `Dirent` has these. */
export type Entry = { name: string; isDirectory(): boolean; isSymbolicLink(): boolean };
/** The entries of a folder; may throw. */
export type Lister = (dir: string) => Entry[];
/** A folder's sub-folders in code point order, hidden ones included, and why
 * there are none when it could not be read. A missing folder (one a
 * recording would create) simply has none. */
export type Listing = { names: string[]; unreadable: boolean };
/** The part of the path the caret is in, in code points: `from` to `to`
 * (the part's own `/` not included). `file` is the file name, the text after
 * the last `/`; a folder part has its `/` at `to`. `folder` is the text in
 * front of the part, the folder it lives in. */
export type Part = { file: boolean; from: number; to: number; folder: string };

export function subfolders(dir: string, list: Lister = defaultList): Listing {
  let entries: Entry[];
  try {
    entries = list(dir);
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { names: [], unreadable: code !== "ENOENT" && code !== "ENOTDIR" };
  }
  // Names with control characters are listed too; the prompt shows those
  // characters as spaces, as everywhere on screen.
  return {
    names: entries
      .filter(e => isFolder(dir, e))
      .map(e => e.name)
      .sort(byCodePoint),
    unreadable: false,
  };
}

/** The names `filter` keeps, best first: those starting with it, then those
 * containing it, each in code point order; case-insensitive, and composed
 * and decomposed letters alike (macOS may hand out either). Names starting
 * with `.` only when the filter does. `names` come in code point order. */
export function filtered(names: string[], filter: string): string[] {
  const hidden = filter.startsWith("."),
    shown = names.filter(n => hidden || !n.startsWith("."));
  if (!filter) return shown;
  const q = fold(filter),
    starts = shown.filter(n => fold(n).startsWith(q)),
    contains = shown.filter(n => !fold(n).startsWith(q) && fold(n).includes(q));
  return [...starts, ...contains];
}

/** `dir` as the field shows it, ending in `/`: the home folder and below as
 * `~/`, anything else absolute. Control characters stay; the prompt shows
 * them as spaces. */
export function shown(dir: string, home: string): string {
  const d = trimmed(normalize(dir)),
    h = trimmed(normalize(home));
  if (h !== sep && d === h) return "~/";
  if (h !== sep && d.startsWith(h + sep)) return "~/" + d.slice(h.length + 1) + "/";
  return d === sep ? sep : d + "/";
}

/** The folder the field's text `folder` (a path in front of a part, empty
 * or ending in `/`) names: `~/` is the home folder, absolute paths are used
 * as given, and relative ones resolve against `base`, the transcript folder;
 * `..` parts are resolved. Leading spaces never name a folder. */
export function located(folder: string, base: string, home: string): string {
  const text = folder.trimStart();
  if (text === "~" || text.startsWith("~/")) return join(home, text.slice(1));
  return isAbsolute(text) ? normalize(text) : join(base, text);
}

/** The part of `chars` the caret is in: the file name when the caret is
 * after the last `/`, else the folder part around it. */
export function partAt(chars: string[], caret: number): Part {
  const last = chars.lastIndexOf("/");
  if (caret > last) return { file: true, from: last + 1, to: chars.length, folder: chars.slice(0, last + 1).join("") };
  const from = caret > 0 ? chars.lastIndexOf("/", caret - 1) + 1 : 0,
    to = chars.indexOf("/", caret);
  return { file: false, from, to, folder: chars.slice(0, from).join("") };
}

/** The folder text one level above `folder` (empty or ending in `/`), as
 * Backspace at the file name's start makes it: the last folder part goes.
 * Nothing goes past `/`. Where the last part is `~`, `.` or `..`, the folder
 * is resolved first, so the path really goes up and shows as the field
 * shows paths. */
export function above(folder: string, base: string, home: string): string {
  if (!folder.endsWith("/")) return folder;
  // At the root, `lastIndexOf` finds the root's own `/` and nothing goes.
  const from = folder.lastIndexOf("/", Math.max(0, folder.length - 2)) + 1,
    part = folder.slice(from, -1);
  if (part.trim() !== "~" && part !== "." && part !== "..") return folder.slice(0, from);
  return shown(dirname(located(folder, base, home)), home);
}

function trimmed(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/** The form names are compared in when filtering. */
function fold(name: string): string {
  return spaced(name).normalize("NFC").toLowerCase();
}

function isFolder(dir: string, e: Entry): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, e.name)).isDirectory();
  } catch {
    // A dangling link.
    return false;
  }
}

function defaultList(dir: string): Entry[] {
  return readdirSync(dir, { withFileTypes: true });
}

/** Orders by code point; `<` on strings compares UTF-16 units, which puts
 * characters above the surrogates (such as U+FF21) after astral ones. */
function byCodePoint(a: string, b: string): number {
  const x = [...a],
    y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0)! - y[i].codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}
