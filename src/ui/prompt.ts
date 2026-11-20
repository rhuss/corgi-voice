//! The recording's file prompt (FR-021): one file name field, suggested as
//! `YYYY-MM-DD-.txt` with the caret before `.txt`, showing the folder the
//! file goes to and whether it will be appended to. Relative names resolve
//! against the transcript folder; Enter accepts, Esc cancels.
import { dirname } from "node:path";
import * as palette from "./palette";
import { Style } from "./palette";
import type { Key } from "./keys";
import { displayWidth, ellipsis, shortPath, spaced } from "../util/text";
import * as transcript from "../voice/transcript";

export type Result = "none" | "accept" | "cancel" | "quit";
export type Resolved = { path: string } | { error: string };
export type Options = {
  /** The transcript folder relative names resolve against. */
  folder: string;
  /** The file a typed name stands for, or why it is refused. */
  resolve: (name: string) => Resolved;
  now?: Date;
  /** Whether a file is there already; the file system by default. */
  exists?: (path: string) => boolean;
};

const reset = "\x1b[0m",
  title = "Record a transcript",
  keys_line = "enter record  esc cancel",
  max_width = 72;
let line = "",
  strong = "",
  muted = "",
  quiet = "",
  warm = "",
  plain = "",
  field = "";
palette.derived(() => {
  plain = new Style({ bg: "bg" }).sgr();
  line = new Style({ fg: "line", bg: "bg" }).sgr();
  strong = new Style({ fg: "strong", bg: "bg", bold: true }).sgr();
  muted = new Style({ fg: "muted", bg: "bg" }).sgr();
  quiet = new Style({ fg: "faint", bg: "bg" }).sgr();
  warm = new Style({ fg: "warm", bg: "bg" }).sgr();
  field = new Style({ fg: "text", bg: "selected" }).sgr();
});

export class FilePrompt {
  /** The name, one code point per entry, so the caret never splits a character. */
  private chars: string[];
  /** The caret, in code points from the start. */
  caret: number;
  /** UTF-8 bytes of a character whose rest has not come yet. */
  private decoder = new TextDecoder("utf-8");
  constructor(private opts: Options) {
    const { name, caret } = transcript.defaultName(opts.now ?? new Date());
    this.chars = [...name];
    this.caret = caret;
  }
  get text(): string {
    return this.chars.join("");
  }
  /** The file the name stands for, or why it is refused. */
  resolve(): Resolved {
    return this.opts.resolve(this.text);
  }
  /** The line under the field: the file, that it will be appended to, or why it is refused. */
  note(): { text: string; warn: boolean } {
    const where = this.resolve();
    if ("error" in where) return { text: where.error, warn: true };
    if ((this.opts.exists ?? transcript.exists)(where.path))
      return { text: `appends to the existing file: ${where.path}`, warn: true };
    return { text: where.path, warn: false };
  }
  /** One key; says whether the prompt is done. */
  key(key: Key): Result {
    switch (key.kind) {
      case "enter":
        return "error" in this.resolve() ? "none" : "accept";
      case "esc":
        return "cancel";
      case "cancel":
        return "quit";
      case "backspace":
        if (this.caret > 0) this.chars.splice(--this.caret, 1);
        return "none";
      case "left":
        this.caret = Math.max(0, this.caret - 1);
        return "none";
      case "right":
        this.caret = Math.min(this.chars.length, this.caret + 1);
        return "none";
      case "home":
        this.caret = 0;
        return "none";
      case "end":
        this.caret = this.chars.length;
        return "none";
      case "ctrl":
        this.ctrl(key.key);
        return "none";
      case "text":
        this.insert(key.text);
        return "none";
      default:
        return "none";
    }
  }
  /** Ctrl+A and Ctrl+E move to the start and end, Ctrl+U deletes to the
   * start, Ctrl+W the word before the caret, Ctrl+K to the end. */
  private ctrl(k: string): void {
    switch (k) {
      case "a":
        this.caret = 0;
        break;
      case "e":
        this.caret = this.chars.length;
        break;
      case "u":
        this.chars.splice(0, this.caret);
        this.caret = 0;
        break;
      case "k":
        this.chars.splice(this.caret);
        break;
      case "w": {
        let from = this.caret;
        while (from > 0 && this.chars[from - 1] === " ") from--;
        while (from > 0 && this.chars[from - 1] !== " ") from--;
        this.chars.splice(from, this.caret - from);
        this.caret = from;
        break;
      }
    }
  }
  /** Typed or pasted text: keys arrive as latin1 bytes, put back together as
   * UTF-8 here; line breaks and other controls become spaces. */
  private insert(latin1: string): void {
    const text = spaced(this.decoder.decode(Buffer.from(latin1, "latin1"), { stream: true }));
    const added = [...text];
    this.chars.splice(this.caret, 0, ...added);
    this.caret += added.length;
  }
  /** The prompt as a box over a `cols` × `rows` window; `at` positions the cursor. */
  draw(cols: number, rows: number, at: (y: number, x: number) => string): string {
    const where = this.resolve(),
      folder = "error" in where ? this.opts.folder : dirname(where.path),
      note = this.note(),
      // Wide enough for the folder and the note when the window allows.
      wanted = Math.max(max_width, displayWidth(folder) + 12, displayWidth(note.text) + 4),
      width = Math.max(20, Math.min(cols - 2, wanted)),
      inner = width - 4,
      height = 7,
      left = Math.floor((cols - width) / 2),
      top = Math.max(0, Math.floor((rows - height) / 2)),
      put = (y: number, style: string, text: string) =>
        at(top + y, left) + line + "│" + plain + " " + style + pad(ellipsis(text, inner), inner) + plain + " " + line + "│";
    let out =
      at(top, left) +
      line +
      "╭─ " +
      strong +
      ellipsis(title, width - 6) +
      line +
      " " +
      "─".repeat(Math.max(0, width - 5 - displayWidth(ellipsis(title, width - 6)))) +
      "╮";
    out += put(1, muted, "File name");
    out += at(top + 2, left) + line + "│" + plain + " " + this.field(inner) + plain + " " + line + "│";
    out += put(3, muted, `Folder  ${shortPath(folder, inner - 8)}`);
    out += put(4, note.warn ? warm : quiet, note.text);
    out += put(5, quiet, keys_line);
    out += at(top + 6, left) + line + "╰" + "─".repeat(width - 2) + "╯" + reset;
    return out;
  }
  /** The field `width` cells wide, scrolled to keep the caret in view, with
   * the caret in reverse video: the window hides the terminal's cursor. */
  private field(width: number): string {
    const w = (c: string) => displayWidth(c) || 1;
    // The first character shown: the caret and the character under it fit.
    let start = this.caret,
      used = w(this.chars[this.caret] ?? " ");
    while (start > 0 && used + w(this.chars[start - 1]) <= width) used += w(this.chars[--start]);
    let out = field,
      cells = 0;
    for (let i = start; i <= this.chars.length; i++) {
      const c = this.chars[i] ?? " ",
        cw = w(c);
      if (cells + cw > width) break;
      out += i === this.caret ? `\x1b[7m${c}\x1b[27m` : c;
      cells += cw;
      if (i === this.chars.length) break;
    }
    return out + " ".repeat(Math.max(0, width - cells)) + reset;
  }
}
/** `text` padded with spaces to `width` cells. */
function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}
