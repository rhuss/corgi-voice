import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { FilePrompt } from "../../src/ui/prompt";
import { keys } from "../../src/ui/keys";
import * as transcript from "../../src/voice/transcript";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** The text a frame leaves on a `cols` × `rows` screen. */
function screen(frame: string, cols: number, rows: number): string[] {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let x = 0,
    y = 0;
  for (let i = 0; i < frame.length; ) {
    const csi = /^\x1b\[([0-9;?]*)([@-~])/.exec(frame.slice(i));
    if (csi) {
      if (csi[2] === "H") [y, x] = csi[1].split(";").map(v => Number(v || 1) - 1);
      i += csi[0].length;
      continue;
    }
    const ch = String.fromCodePoint(frame.codePointAt(i)!);
    if (y < rows && x < cols) grid[y][x] = ch;
    x++;
    i += ch.length;
  }
  return grid.map(r => r.join(""));
}
const at = (y: number, x: number) => `\x1b[${y + 1};${x + 1}H`;
const down = "\x1b[B",
  up = "\x1b[A",
  left = "\x1b[D",
  home_key = "\x1b[H",
  end_key = "\x1b[F",
  esc = "\x1b",
  tab = "\t",
  backspace = "\x7f",
  /** Ctrl+A and Ctrl+K: empties the field. */
  clear = "\x01\x0b";

/** A prompt over a transcript folder `<home>/.local/share/corgi/transcripts`
 * with the sub-folders `names` and a file `old.txt`, in a home folder of its own. */
function make(names: string[] = [], opts: { list?: (dir: string) => never; start?: string; outside?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "cv-prompt-home-")),
    folder = opts.outside ? mkdtempSync(join(tmpdir(), "cv-prompt-")) : join(home, ".local", "share", "corgi", "transcripts");
  dirs.push(home, folder);
  mkdirSync(folder, { recursive: true });
  for (const name of names) mkdirSync(join(folder, name), { recursive: true });
  writeFileSync(join(folder, "old.txt"), "Earlier.\n");
  const prompt = new FilePrompt({
      folder,
      home,
      now: new Date(2026, 10, 20, 9, 30),
      resolve: (name, dir) => transcript.resolve(name, dir, home),
      list: opts.list,
      start: opts.start,
    }),
    /** Feeds terminal input; returns the last result. */
    type = (data: string) => {
      let result: ReturnType<FilePrompt["key"]> = "none";
      for (const k of keys(data)) result = prompt.key(k);
      return result;
    },
    rows = (cols = 120, height = 30) => screen(prompt.draw(cols, height, at), cols, height);
  return { prompt, folder, home, type, rows, text: (cols = 120, height = 30) => rows(cols, height).join("\n") };
}
/** The field's text with `|` at the caret. */
const field = (p: FilePrompt) => {
  const chars = [...p.text];
  return [...chars.slice(0, p.caret), "|", ...chars.slice(p.caret)].join("");
};
/** The box's rows on screen from its top edge on. */
const box = (rows: string[]) => rows.slice(rows.findIndex(r => r.includes("╭─ Record a transcript")));
/** The field as the screen shows it, inside its frame. */
const shownField = (rows: string[]) => box(rows)[2].split("│")[2].slice(1, -1);
/** The open pop-down: its frame's title and its rows, trimmed. */
function popdown(rows: string[]): { title: string; rows: string[]; bottom: string } {
  const b = box(rows),
    end = b.findIndex((r, i) => i > 4 && r.includes("└"));
  return {
    title: b[4].split("┌")[1].split("┐")[0].replace(/─/g, "").trim(),
    rows: b.slice(5, end).map(r => r.split("│")[2].trim()),
    bottom: b[end].split("└")[1].split("┘")[0].replace(/─/g, "").trim(),
  };
}
const story = ["meetings", "meetups", "notes", "walkthrough-test/2026"];
const start = "~/.local/share/corgi/transcripts/";

test("scenario 1: one field with the full path in ~/ form, the caret before .txt, and the key hints; nothing else", () => {
  const { prompt, text, rows } = make(story);
  expect(field(prompt)).toBe(`${start}2026-11-20-|.txt`);
  expect(prompt.open).toBe(false);
  expect(prompt.note()).toBeNull();
  const shown = text();
  expect(shown).toContain("Record a transcript");
  expect(shown).toContain("tab folders  enter record  esc cancel");
  // The path is on screen exactly once; no Folder line, no path note, no `..`.
  expect(shown.split(`${start}2026-11-20-.txt`)).toHaveLength(2);
  expect(shown).not.toContain("Folder");
  expect(shown).not.toContain("..");
  expect(shownField(rows()).trim()).toBe(`${start}2026-11-20-.txt`);
});

test("scenario 1: outside the home folder the path is absolute", () => {
  const { prompt, folder } = make([], { outside: true });
  expect(prompt.text).toBe(`${folder}/2026-11-20-.txt`);
  expect(prompt.resolve()).toEqual({ path: join(folder, "2026-11-20-.txt") });
});

test("scenario 2: Tab in the file name lists the file's folder's sub-folders; taking one puts it in front of the name", () => {
  const { prompt, folder, type, rows, text } = make(story);
  type(tab);
  expect(prompt.open).toBe(true);
  expect(prompt.choices).toEqual(["meetings", "meetups", "notes", "walkthrough-test"]);
  expect(prompt.highlighted).toBe("meetings");
  const shown = rows();
  expect(popdown(shown).rows).toEqual(["❯ meetings/", "meetups/", "notes/", "walkthrough-test/"]);
  expect(text()).toContain("↑↓ pick  enter take  esc close");
  expect(text()).not.toContain("enter record");
  // Files are not listed.
  expect(text()).not.toContain("old.txt");
  // The pop-down hangs at the caret: its frame starts under the `/` in front of the file name.
  const b = box(shown),
    slash = b[2].indexOf("2026-11-20-") - 1;
  expect(b[4].indexOf("┌")).toBe(slash);
  type(down.repeat(3) + "\r");
  expect(prompt.open).toBe(false);
  expect(field(prompt)).toBe(`${start}walkthrough-test/2026-11-20-|.txt`);
  expect(prompt.resolve()).toEqual({ path: join(folder, "walkthrough-test", "2026-11-20-.txt") });
  // Tab takes too, and the caret keeps its place in the name.
  type(left + left + tab + "20" + tab);
  expect(field(prompt)).toBe(`${start}walkthrough-test/2026/2026-11-2|0-.txt`);
});

test("scenario 3: typing filters, prefix matches first, then substring, ignoring case; Backspace edits the filter; Esc changes nothing", () => {
  const { prompt, type, rows } = make([...story, "Away", "WALL"]);
  const before = field(prompt);
  type(tab + "wa");
  expect(prompt.filter).toBe("wa");
  expect(prompt.choices).toEqual(["WALL", "walkthrough-test", "Away"]);
  expect(prompt.highlighted).toBe("WALL");
  expect(popdown(rows()).title).toBe("wa");
  // The field takes no keys meanwhile.
  expect(field(prompt)).toBe(before);
  type(home_key + left);
  expect(field(prompt)).toBe(before);
  type(backspace);
  expect(prompt.filter).toBe("w");
  expect(prompt.choices).toEqual(["WALL", "walkthrough-test", "Away"]);
  type(backspace + backspace + backspace);
  expect(prompt.filter).toBe("");
  expect(prompt.open).toBe(true);
  expect(prompt.choices).toEqual(["Away", "WALL", "meetings", "meetups", "notes", "walkthrough-test"]);
  // The arrows pick and stop at the ends.
  type(up + down.repeat(10));
  expect(prompt.highlighted).toBe("walkthrough-test");
  type(esc);
  expect(prompt.open).toBe(false);
  expect(field(prompt)).toBe(before);
});

test("scenario 4: Tab inside a folder part lists that part's parent's folders matching the text before the caret, and replaces the part", () => {
  const { prompt, home, type, rows } = make(story);
  mkdirSync(join(home, ".local", "share", "corgi", "translations"));
  mkdirSync(join(home, ".local", "share", "corgi", "other"));
  // The caret after `trans` in `…/corgi/trans|cripts/…`.
  type(home_key + "\x1b[C".repeat(`${start}`.indexOf("trans") + 5));
  expect(field(prompt)).toBe("~/.local/share/corgi/trans|cripts/2026-11-20-.txt");
  type(tab);
  expect(prompt.filter).toBe("trans");
  expect(prompt.choices).toEqual(["transcripts", "translations"]);
  expect(popdown(rows()).title).toBe("trans");
  // The frame starts under the `/` in front of the part.
  const b = box(rows());
  expect(b[4].indexOf("┌")).toBe(b[2].indexOf("transcripts/") - 1);
  type(down + "\r");
  expect(field(prompt)).toBe("~/.local/share/corgi/translations/|2026-11-20-.txt");
  // A part near the start: the rest of the path after it stays.
  type(home_key + "\x1b[C".repeat(4) + tab);
  expect(prompt.filter).toBe(".l");
  expect(prompt.choices).toEqual([".local"]);
  type("\r");
  expect(field(prompt)).toBe("~/.local/|share/corgi/translations/2026-11-20-.txt");
});

test("scenario 4: a part after the caret's text is replaced whole, keeping the path after it", () => {
  const { prompt, folder, type } = make(story);
  type(tab + "wa\r");
  type(home_key + "\x1b[C".repeat(`${start}`.length + 2) + tab);
  expect(prompt.filter).toBe("wa");
  expect(prompt.choices).toEqual(["walkthrough-test"]);
  type(backspace + backspace + "no" + tab);
  expect(field(prompt)).toBe(`${start}notes/|2026-11-20-.txt`);
  expect(prompt.resolve()).toEqual({ path: join(folder, "notes", "2026-11-20-.txt") });
});

test("scenario 5: Backspace at the start of the file name removes the folder in front of it, and walks up to / and stops there", () => {
  const { prompt, home, type } = make(story);
  type(tab + "wa\r" + left.repeat("2026-11-20-".length));
  expect(field(prompt)).toBe(`${start}walkthrough-test/|2026-11-20-.txt`);
  type(backspace);
  expect(field(prompt)).toBe(`${start}|2026-11-20-.txt`);
  type(backspace);
  expect(field(prompt)).toBe("~/.local/share/corgi/|2026-11-20-.txt");
  type(backspace.repeat(3));
  expect(field(prompt)).toBe("~/|2026-11-20-.txt");
  // Above the home folder the path is absolute.
  type(backspace);
  expect(field(prompt)).toBe(`${dirname(home)}/|2026-11-20-.txt`);
  type(backspace.repeat(40));
  expect(field(prompt)).toBe("/|2026-11-20-.txt");
  // Everywhere else Backspace takes one character.
  type(end_key + left.repeat(4) + backspace);
  expect(field(prompt)).toBe("/2026-11-20|.txt");
});

test("Backspace at the file name's start resolves a .. in front of it and goes up from there", () => {
  const { prompt, home, type } = make(story);
  type(clear + "~/a/b/../x.txt" + home_key + "\x1b[C".repeat("~/a/b/../".length));
  type(backspace);
  expect(field(prompt)).toBe("~/|x.txt");
  void home;
});

test("scenario 6: an empty folder or one that cannot be read shows a muted note that closes on the next key", () => {
  const empty = make([]);
  const before = empty.prompt.text;
  empty.type(tab);
  expect(popdown(empty.rows()).rows).toEqual(["no folders"]);
  expect(empty.type("x")).toBe("none");
  expect(empty.prompt.open).toBe(false);
  expect(empty.prompt.text).toBe(before);
  const failing = make([], {
    list: () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
  });
  failing.type(tab);
  expect(popdown(failing.rows()).rows).toEqual(["cannot read"]);
  expect(failing.text()).not.toContain("EACCES");
  failing.type("\r");
  expect(failing.prompt.open).toBe(false);
  // Enter records once the note is gone: a missing folder is made when recording starts.
  expect(failing.type("\r")).toBe("accept");
});

test("scenario 6: only hidden folders count as none; a filter without matches says so and takes nothing", () => {
  const { prompt, type, rows } = make([".hidden", "notes"]);
  type(tab + "zz");
  expect(prompt.choices).toEqual([]);
  expect(popdown(rows()).rows).toEqual(["no match"]);
  const before = prompt.text;
  type("\r");
  expect(prompt.open).toBe(true);
  expect(prompt.text).toBe(before);
  const hidden = make([".hidden"]);
  hidden.type(tab);
  expect(popdown(hidden.rows()).rows).toEqual(["no folders"]);
});

test("scenario 7: an existing file is appended to, and the line under the field says so", () => {
  const { prompt, type, text } = make(story);
  type(end_key + backspace.repeat("2026-11-20-.txt".length) + "old.txt");
  expect(prompt.note()).toEqual({ text: "appends to the existing file", warn: false });
  expect(text()).toContain("appends to the existing file");
  expect(type("\r")).toBe("accept");
});

test("scenario 7: a refused path says why on the line under the field, and Enter does nothing", () => {
  const { prompt, type, text } = make(story);
  const cases: [string, string][] = [
    ["", "name is empty"],
    [`${start}notes/`, "no file name after the last /"],
    [`${start}notes`, "this is a folder, not a file"],
    [`${start}old.txt/x.txt`, "old.txt is a file, not a folder"],
  ];
  for (const [path, why] of cases) {
    type(clear + path);
    expect(prompt.note()).toEqual({ text: why, warn: true });
    expect(text()).toContain(why);
    expect(type("\r")).toBe("none");
  }
});

test("SC-003: two levels down take Tab, two letters and Enter per level, then Enter records; the path shows once", () => {
  const { prompt, folder, type, text } = make(story);
  const once = () => expect(text().split(prompt.text)).toHaveLength(2);
  for (const key of [tab, "w", "a", "\r", tab, "2", "0", "\r"]) {
    type(key);
    once();
  }
  expect(type("\r")).toBe("accept");
  expect(prompt.resolve()).toEqual({ path: join(folder, "walkthrough-test", "2026", "2026-11-20-.txt") });
});

test("a typed path with .. parts resolves them and is accepted, relative ones against the transcript folder", () => {
  const { prompt, folder, home, type } = make(story);
  type(clear + "../x.txt");
  expect(prompt.resolve()).toEqual({ path: join(dirname(folder), "x.txt") });
  expect(prompt.note()).toBeNull();
  expect(type("\r")).toBe("accept");
  type(clear + "~/a/../../y.txt");
  expect(prompt.resolve()).toEqual({ path: join(dirname(home), "y.txt") });
  type(clear + "/tmp/a/../z.txt");
  expect(prompt.resolve()).toEqual({ path: "/tmp/z.txt" });
  type(clear + "notes/../w.txt");
  expect(prompt.resolve()).toEqual({ path: join(folder, "w.txt") });
});

test("the field starts in the start folder when one is given (FR-007a)", () => {
  const home = mkdtempSync(join(tmpdir(), "cv-prompt-home-"));
  dirs.push(home);
  const prompt = new FilePrompt({
    folder: join(home, "transcripts"),
    start: join(home, "transcripts", "notes"),
    home,
    now: new Date(2026, 10, 20),
    resolve: (name, dir) => transcript.resolve(name, dir, home),
  });
  expect(field(prompt)).toBe("~/transcripts/notes/2026-11-20-|.txt");
});

test("a long path scrolls in the field to keep the caret in view, with … at a cut end", () => {
  const { prompt, type, rows } = make(story);
  type(clear + "~/" + "deep/".repeat(12) + "file.txt" + left.repeat(4));
  const caretInView = () => {
    const frame = prompt.draw(37, 14, at),
      shown = shownField(screen(frame, 37, 14));
    expect(frame).toContain("\x1b[7m");
    return shown;
  };
  let shown = caretInView();
  expect(shown.startsWith("…")).toBe(true);
  expect(shown.trimEnd().endsWith("/file.txt")).toBe(true);
  // The caret is drawn in reverse video on the character after it.
  expect(prompt.draw(37, 14, at)).toContain("\x1b[7m.\x1b[27m");
  type(home_key);
  shown = caretInView();
  expect(shown.startsWith("~/deep/")).toBe(true);
  expect(shown.endsWith("…")).toBe(true);
  expect(prompt.draw(37, 14, at)).toContain("\x1b[7m~\x1b[27m");
  // Moving right a little does not scroll; the view follows once the caret leaves it.
  type("\x1b[C".repeat(10));
  expect(shownField(rows(37, 14)).startsWith("~/deep/")).toBe(true);
  type("\x1b[C".repeat(40));
  expect(shownField(rows(37, 14)).startsWith("…")).toBe(true);
  for (const r of rows(37, 14)) expect(Bun.stringWidth(r)).toBe(37);
});

test("the pop-down scrolls up to 8 rows with the highlight and counts the hidden ones", () => {
  const names = Array.from({ length: 12 }, (_, i) => `folder-with-a-long-name-${String(i).padStart(2, "0")}`),
    { prompt, type, rows } = make(names);
  type(tab);
  let pop = popdown(rows());
  expect(pop.rows).toHaveLength(8);
  expect(pop.rows[0]).toBe("❯ folder-with-a-long-name-00/");
  expect(pop.bottom).toBe("+4 more");
  type(down.repeat(9));
  expect(prompt.highlighted).toBe("folder-with-a-long-name-09");
  pop = popdown(rows());
  expect(pop.rows.at(-1)).toBe("❯ folder-with-a-long-name-09/");
  expect(pop.rows[0]).toBe("folder-with-a-long-name-02/");
  // Back up past the top of the view, which follows.
  type(up.repeat(9));
  expect(popdown(rows()).rows[0]).toBe("❯ folder-with-a-long-name-00/");
});

test("the pop-down hangs at the caret, moved left to fit the window", () => {
  const { type, rows } = make(story);
  type(tab);
  const b = box(rows(37, 14)),
    slash = b[2].lastIndexOf("/");
  // Where it would hang under the `/`, it would stick out of the box; it moves left instead.
  expect(b[4].indexOf("┌")).toBeLessThan(slash);
  expect(b[4].lastIndexOf("┐")).toBeLessThanOrEqual(b[0].lastIndexOf("╮") - 2);
  expect(popdown(rows(37, 14)).rows).toContain("walkthrough-test/");
});

test("the pop-down narrows to fit the window, cutting long names with …", () => {
  const names = Array.from({ length: 3 }, (_, i) => `a-folder-with-a-rather-long-name-${i}`),
    { type, rows } = make(names);
  type(tab);
  const shown = rows(37, 14);
  for (const r of shown) expect(Bun.stringWidth(r)).toBe(37);
  const b = box(shown);
  expect(b[4].indexOf("┌")).toBe(b[2].indexOf("│", 3));
  expect(popdown(shown).rows[0]).toBe("❯ a-folder-with-a-rather-lon…");
});

test("the prompt fits the smallest voice window, closed and open, with the short key hints", () => {
  const names = Array.from({ length: 12 }, (_, i) => `folder-with-a-long-name-${i}`),
    { type, rows } = make(names);
  let shown = rows(37, 14);
  for (const r of shown) expect(Bun.stringWidth(r)).toBe(37);
  expect(shown.join("\n")).toContain("⇥ folders  ↵ record  esc cancel");
  expect(shown.join("\n")).toContain("╰");
  type(tab + "folder");
  shown = rows(37, 14);
  for (const r of shown) expect(Bun.stringWidth(r)).toBe(37);
  const text = shown.join("\n");
  expect(text).toContain("╭─ Record a transcript");
  expect(text).toContain("╰");
  expect(text).toContain("┌ folder ");
  expect(text).toContain("↑↓ pick  enter take  esc close");
  expect(text).toContain("more");
  // Smaller still, nothing overflows.
  for (const [cols, height] of [[30, 10], [24, 6]]) for (const r of rows(cols, height)) expect(Bun.stringWidth(r)).toBe(cols);
});

test("hidden folders are listed only for a filter starting with a dot", () => {
  const { prompt, type } = make([".hidden", "notes"]);
  type(tab);
  expect(prompt.choices).toEqual(["notes"]);
  type(".");
  expect(prompt.choices).toEqual([".hidden"]);
  type("\r");
  expect(prompt.text).toBe(`${start}.hidden/2026-11-20-.txt`);
});

test("control characters in folder names are shown as spaces in the pop-down and the field", () => {
  const { prompt, type, rows } = make(["bad\x1bname"]);
  type(tab);
  expect(popdown(rows()).rows).toEqual(["❯ bad name/"]);
  type("\r");
  expect(prompt.text).toBe(`${start}bad\x1bname/2026-11-20-.txt`);
  expect(shownField(rows())).toContain("transcripts/bad name/");
  expect(prompt.draw(120, 30, at)).not.toContain("\x1bname");
});

test("Enter accepts, Esc cancels, Ctrl+C quits, also with the pop-down open", () => {
  expect(make().type("\r")).toBe("accept");
  expect(make().type("\x1b")).toBe("cancel");
  expect(make().type("\x03")).toBe("quit");
  expect(make(["notes"]).type(tab + "\x03")).toBe("quit");
});

test("editing keys: Backspace, Left/Right, Home/End, Ctrl+A/E/U/K/W", () => {
  const { prompt, type } = make();
  type("\x05\x15hello world.txt");
  expect(prompt.caret).toBe(prompt.text.length);
  type(backspace);
  expect(prompt.text).toBe("hello world.tx");
  // Two to the left, the caret is before "tx": Backspace takes the dot.
  type(left + left + backspace);
  expect(prompt.text).toBe("hello worldtx");
  type("\x1b[C");
  expect(prompt.caret).toBe("hello worldt".length);
  type(home_key);
  expect(prompt.caret).toBe(0);
  type(end_key);
  expect(prompt.caret).toBe(prompt.text.length);
  type("\x01");
  expect(prompt.caret).toBe(0);
  type("X");
  expect(prompt.text).toBe("Xhello worldtx");
  type("\x05");
  expect(prompt.caret).toBe(prompt.text.length);
  // Ctrl+W deletes the word before the caret, with the spaces before it.
  type("\x17");
  expect(prompt.text).toBe("Xhello ");
  type("\x17");
  expect(prompt.text).toBe("");
  type("a b c" + left + left + "\x15");
  expect([prompt.text, prompt.caret]).toEqual([" c", 0]);
  type("\x0b");
  expect(prompt.text).toBe("");
  // Left at the start and Backspace at the start change nothing.
  type("c" + home_key + left + backspace);
  expect([prompt.text, prompt.caret]).toEqual(["c", 0]);
});

test("a path arrives as UTF-8 in latin1 bytes, split across reads", () => {
  const { prompt, folder, type } = make();
  const bytes = Buffer.from("café-日本.txt", "utf8").toString("latin1");
  type(clear);
  type(bytes.slice(0, 4));
  type(bytes.slice(4));
  expect(prompt.text).toBe("café-日本.txt");
  expect(prompt.resolve()).toEqual({ path: join(folder, "café-日本.txt") });
  // The caret moves by characters, not bytes.
  type(backspace.repeat(5));
  expect(prompt.text).toBe("café-日");
});

test("a paste goes in whole, without line breaks", () => {
  const { prompt, type } = make();
  type(clear + "\x1b[200~call\nnotes.txt\x1b[201~");
  expect(prompt.text).toBe("call notes.txt");
});
