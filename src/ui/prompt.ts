//! The recording's file prompt (FR-004 to FR-007a): one field holding the
//! transcript file's full path, prefilled with the start folder and the
//! suggested `YYYY-MM-DD-.txt`, the caret before `.txt`. A muted line under
//! it says only that the file will be appended to, or why the path is
//! refused. Tab opens a folder pop-down at the caret: typing filters it, the
//! arrows pick, Enter or Tab takes a folder into the path, Esc closes it.
//! Backspace at the start of the file name takes away the folder in front
//! of it, so going up is one key per level.
import * as palette from "./palette";
import { Style } from "./palette";
import type { Key } from "./keys";
import { above, filtered, located, partAt, shown, subfolders, type Lister, type Listing, type Part } from "./folders";
import { displayWidth, ellipsis, spaced } from "../util/text";
import * as paths from "../util/paths";
import * as transcript from "../voice/transcript";

export type Result = "none" | "accept" | "cancel" | "quit";
export type Resolved = { path: string } | { error: string };
export type Options = {
  /** The transcript folder: relative paths resolve against it. */
  folder: string;
  /** The folder the field starts in: the one the last recording of this
   * run went to (FR-007a), else `folder`. */
  start?: string;
  /** The file a typed path stands for, relative ones inside `dir`, or why it is refused. */
  resolve: (name: string, dir: string) => Resolved;
  now?: Date;
  /** What is at a path; the file system by default. */
  kind?: (path: string) => transcript.Kind;
  /** The folder shown as `~/`; `$HOME` by default. */
  home?: string;
  /** A folder's entries for the pop-down; the file system by default. */
  list?: Lister;
};
/** The open pop-down: the part of the path it completes, that part's
 * folder's listing, the filter, the folders it keeps, the highlighted one,
 * the first one shown, and the note that stands in for an empty or
 * unreadable folder (the next key closes it). */
type Popdown = {
  part: Part;
  listing: Listing;
  query: string[];
  entries: string[];
  choice: number;
  scroll: number;
  note: "no folders" | "cannot read" | null;
};

const reset = "\x1b[0m",
  title = "Record a transcript",
  /** The key hints, closed and open, longest first: the first that fits is shown. */
  hints = {
    closed: ["tab folders  enter record  esc cancel", "⇥ folders  ↵ record  esc cancel", "⇥ folders  ↵ record"],
    open: ["↑↓ pick  enter take  esc close", "↑↓ pick  ↵ take  esc close", "↑↓  ↵ take"],
  },
  max_width = 96,
  /** The most folders the pop-down shows at once. */
  max_rows = 8,
  /** Rows besides the pop-down's folders while it is open: the box's edges,
   * the field and its frame, the pop-down's frame, a blank row and the key hints. */
  fixed_rows = 9;
let line = "",
  strong = "",
  muted = "",
  quiet = "",
  text = "",
  warm = "",
  plain = "",
  focused = "";
palette.derived(() => {
  plain = new Style({ bg: "bg" }).sgr();
  line = new Style({ fg: "line", bg: "bg" }).sgr();
  strong = new Style({ fg: "strong", bg: "bg", bold: true }).sgr();
  muted = new Style({ fg: "muted", bg: "bg" }).sgr();
  quiet = new Style({ fg: "faint", bg: "bg" }).sgr();
  text = new Style({ fg: "text", bg: "bg" }).sgr();
  warm = new Style({ fg: "warm", bg: "bg" }).sgr();
  focused = new Style({ fg: "strong", bg: "selected", bold: true }).sgr();
});

export class FilePrompt {
  /** The path, one code point per entry, so the caret never splits a character. */
  private chars: string[];
  /** The caret, in code points from the start. */
  caret: number;
  /** The first code point the field shows; it scrolls to keep the caret in
   * view. It starts past the end, so a long path first shows its end. */
  private offset = Infinity;
  private pop: Popdown | null = null;
  /** UTF-8 bytes of a character whose rest has not come yet. */
  private decoder = new TextDecoder("utf-8");
  constructor(private opts: Options) {
    const { name, caret } = transcript.defaultName(opts.now ?? new Date()),
      folder = [...shown(opts.start ?? opts.folder, this.home)];
    this.chars = [...folder, ...name];
    this.caret = folder.length + caret;
  }
  get text(): string {
    return this.chars.join("");
  }
  private get home(): string {
    return this.opts.home ?? paths.home();
  }
  /** Whether the pop-down is open. */
  get open(): boolean {
    return this.pop !== null;
  }
  /** The pop-down's filter. */
  get filter(): string {
    return this.pop?.query.join("") ?? "";
  }
  /** The folders the pop-down offers, best match first. */
  get choices(): string[] {
    return [...(this.pop?.entries ?? [])];
  }
  /** The highlighted folder, or null when there is none. */
  get highlighted(): string | null {
    return this.pop?.entries[this.pop.choice] ?? null;
  }
  /** The file the path stands for, or why it is refused: the path's own
   * shape, then what is on disk (a folder, or a file on the way). */
  resolve(): Resolved {
    const where = this.opts.resolve(this.text, this.opts.folder);
    if ("error" in where) return where;
    const why = transcript.refusal(where.path, this.opts.kind);
    return why === null ? where : { error: why };
  }
  /** The line under the field, if any: that the file will be appended to, or why the path is refused. */
  note(): { text: string; warn: boolean } | null {
    const where = this.resolve();
    if ("error" in where) return { text: where.error, warn: true };
    if ((this.opts.kind ?? transcript.kind)(where.path) === "file") return { text: "appends to the existing file", warn: false };
    return null;
  }
  /** One key; says whether the prompt is done. */
  key(key: Key): Result {
    if (key.kind === "cancel") return "quit";
    if (this.pop) {
      this.popKey(this.pop, key);
      return "none";
    }
    switch (key.kind) {
      case "enter":
        return "error" in this.resolve() ? "none" : "accept";
      case "esc":
        return "cancel";
      case "tab":
        this.openPop();
        return "none";
      case "backspace":
        if (this.caret > 0 && this.caret === this.chars.lastIndexOf("/") + 1) this.goUp();
        else if (this.caret > 0) this.chars.splice(--this.caret, 1);
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
      case "text": {
        const added = [...this.decode(key.text)];
        this.chars.splice(this.caret, 0, ...added);
        this.caret += added.length;
        return "none";
      }
      default:
        return "none";
    }
  }
  /** A key while the pop-down is open: the field takes none. */
  private popKey(pop: Popdown, key: Key): void {
    // A note for an empty or unreadable folder closes on any key.
    if (pop.note) {
      this.pop = null;
      return;
    }
    switch (key.kind) {
      case "up":
        if (pop.choice > 0) pop.choice--;
        return;
      case "down":
        if (pop.choice < pop.entries.length - 1) pop.choice++;
        return;
      case "enter":
      case "tab":
        this.take(pop);
        return;
      case "esc":
        this.pop = null;
        return;
      case "backspace":
        if (pop.query.length) {
          pop.query.pop();
          this.refresh(pop);
        }
        return;
      case "text":
        pop.query.push(...this.decode(key.text));
        this.refresh(pop);
        return;
    }
  }
  /** Tab: the folders that fit the part the caret is in. In the file name,
   * the sub-folders of the file's folder; in a folder part, the folders of
   * its parent, filtered by the part's text before the caret. */
  private openPop(): void {
    const part = partAt(this.chars, this.caret),
      listing = subfolders(located(part.folder, this.opts.folder, this.home), this.opts.list),
      query = part.file ? [] : this.chars.slice(part.from, this.caret),
      pop: Popdown = { part, listing, query, entries: [], choice: 0, scroll: 0, note: null };
    this.refresh(pop);
    if (listing.unreadable) pop.note = "cannot read";
    else if (!listing.names.length || (!query.length && !pop.entries.length)) pop.note = "no folders";
    this.pop = pop;
  }
  /** The folders the filter keeps, the best match highlighted. */
  private refresh(pop: Popdown): void {
    pop.entries = filtered(pop.listing.names, pop.query.join(""));
    pop.choice = 0;
    pop.scroll = 0;
  }
  /** Takes the highlighted folder: in front of the file name, the caret
   * keeping its place in the name, or in place of the whole folder part,
   * the caret after its `/`. */
  private take(pop: Popdown): void {
    const chosen = pop.entries[pop.choice];
    if (chosen === undefined) return;
    const name = [...chosen, "/"];
    if (pop.part.file) {
      this.chars.splice(pop.part.from, 0, ...name);
      this.caret += name.length;
    } else {
      this.chars.splice(pop.part.from, pop.part.to + 1 - pop.part.from, ...name);
      this.caret = pop.part.from + name.length;
    }
    this.pop = null;
  }
  /** Backspace at the file name's start: the folder part in front of it goes. */
  private goUp(): void {
    const { from, folder } = partAt(this.chars, this.caret),
      up = [...above(folder, this.opts.folder, this.home)];
    this.chars.splice(0, from, ...up);
    this.caret = up.length;
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
  private decode(latin1: string): string {
    return spaced(this.decoder.decode(Buffer.from(latin1, "latin1"), { stream: true }));
  }
  /** The prompt as a box over a `cols` × `rows` window; `at` positions the
   * cursor. The box's top stays put while the pop-down opens and closes. */
  draw(cols: number, rows: number, at: (y: number, x: number) => string): string {
    const width = Math.max(20, Math.min(cols - 2, max_width)),
      inner = width - 4,
      room = Math.max(1, Math.min(max_rows, rows - fixed_rows)),
      top = Math.max(0, Math.floor((rows - fixed_rows - room) / 2)),
      left = Math.floor((cols - width) / 2),
      field = this.field(inner - 4),
      cut = ellipsis(title, width - 6);
    let y = top,
      out = at(y++, left) + line + "╭─ " + strong + cut + line + " " + "─".repeat(Math.max(0, width - 5 - displayWidth(cut))) + "╮";
    /** One row inside the box, from styled pieces `inner` cells wide in all. */
    const row = (body: string) => {
      if (y < rows) out += at(y, left) + line + "│" + plain + " " + body + plain + " " + line + "│";
      y++;
    };
    row(line + "┌" + "─".repeat(inner - 2) + "┐");
    row(line + "│" + plain + " " + field.body + plain + " " + line + "│");
    row(line + "└" + "─".repeat(inner - 2) + "┘");
    if (this.pop) {
      // The field's own frame and padding come before its text.
      for (const body of this.drawPop(this.pop, inner, room, 2 + field.anchor)) row(body);
      row(cell("", inner));
    } else {
      const note = this.note();
      row(note ? (note.warn ? warm : muted) + cell(spaced(note.text), inner) : cell("", inner));
    }
    const options = this.pop ? hints.open : hints.closed,
      hint = options.find(h => displayWidth(h) <= inner) ?? options.at(-1)!;
    row(quiet + cell(hint, inner));
    if (y < rows) out += at(y, left) + line + "╰" + "─".repeat(width - 2) + "╯";
    return out + reset;
  }
  /** The pop-down's rows, each `inner` cells wide: its frame starts under the
   * cell before `anchor` (the column where a taken folder goes), moved left
   * or narrowed to fit, and shows up to `room` folders. */
  private drawPop(pop: Popdown, inner: number, room: number, anchor: number): string[] {
    const filter = spaced(pop.query.join("")),
      lines = pop.note ? [pop.note] : pop.entries.length ? pop.entries.map(e => spaced(e) + "/") : ["no match"],
      shown_rows = Math.min(room, lines.length),
      hidden = lines.length - shown_rows,
      more = hidden > 0 ? ` +${hidden} more ` : "",
      wanted = Math.max(
        ...lines.map(l => displayWidth(l) + 5),
        filter ? displayWidth(filter) + 6 : 0,
        displayWidth(more) + 4,
        14,
      ),
      w = Math.min(inner, wanted),
      x = Math.max(0, Math.min(anchor - 1, inner - w)),
      pad = (body: string) => plain + " ".repeat(x) + body + plain + " ".repeat(inner - x - w);
    // The highlight stays in view.
    pop.scroll = Math.max(0, Math.min(pop.scroll, pop.choice, lines.length - shown_rows));
    if (pop.choice >= pop.scroll + shown_rows) pop.scroll = pop.choice - shown_rows + 1;
    const head = filter ? " " + ellipsis(filter, w - 6) + " " : "",
      out = [pad(line + "┌" + strong + head + line + "─".repeat(w - 2 - displayWidth(head)) + "┐")];
    lines.slice(pop.scroll, pop.scroll + shown_rows).forEach((entry, i) => {
      const chosen = !pop.note && pop.entries.length > 0 && pop.scroll + i === pop.choice,
        body = pop.note || !pop.entries.length
          ? muted + cell("  " + entry, w - 2)
          : chosen
            ? focused + cell("❯ " + entry, w - 2)
            : text + cell("  " + entry, w - 2);
      out.push(pad(line + "│" + body + line + "│"));
    });
    const tail = ellipsis(more, w - 3);
    out.push(pad(line + "└" + (tail ? "─" + muted + tail + line : "") + "─".repeat(w - 2 - (tail ? 1 + displayWidth(tail) : 0)) + "┘"));
    return out;
  }
  /** The field's text `width` cells wide, scrolled to keep the caret in view,
   * with `…` where it is cut, and the caret in reverse video: the window
   * hides the terminal's cursor. `anchor` is the column, from the field's
   * start, of the part the pop-down completes. */
  private field(width: number): { body: string; anchor: number } {
    const w = (i: number) => (i < this.chars.length ? displayWidth(spaced(this.chars[i])) || 1 : 1),
      n = this.chars.length,
      /** Cells from `from` up to `to`, the caret's cell at the end counted. */
      span = (from: number, to: number) => {
        let cells = 0;
        for (let i = from; i < to; i++) cells += w(i);
        return cells;
      },
      // Everything from `start` on, the caret's cell at the end included, fits.
      tail = (start: number) => span(start, n + 1) <= width - (start > 0 ? 1 : 0),
      // The caret is in view from `start`, with room for the marks at both cut ends.
      visible = (start: number) => span(start, this.caret + 1) <= width - (start > 0 ? 1 : 0) - (tail(start) ? 0 : 1);
    let start = Math.min(this.offset, this.caret);
    while (start > 0 && tail(start - 1)) start--;
    // Scrolling right: the end of the path in full when the caret is in it,
    // else just enough to bring the caret in.
    if (!visible(start) && tail(this.caret)) {
      start = this.caret;
      while (start > 0 && tail(start - 1)) start--;
    }
    while (start < this.caret && !visible(start)) start++;
    this.offset = start;
    const lead = start > 0 ? 1 : 0,
      room = width - lead - (tail(start) ? 0 : 1);
    let out = lead ? muted + "…" + text : text,
      cells = lead;
    for (let i = start; i <= n; i++) {
      const cw = w(i);
      if (cells - lead + cw > room) break;
      // A pasted path may hold control characters.
      const c = i < n ? spaced(this.chars[i]) : " ";
      out += i === this.caret ? `\x1b[7m${c}\x1b[27m` : c;
      cells += cw;
    }
    if (!tail(start)) {
      out += " ".repeat(Math.max(0, width - 1 - cells)) + muted + "…";
      cells = width;
    }
    const part = this.pop?.part.from ?? this.caret,
      anchor = part < start ? 0 : Math.min(width, lead + span(start, part));
    return { body: out + " ".repeat(Math.max(0, width - cells)), anchor };
  }
}
/** `text` cut and padded with spaces to exactly `width` cells. */
function cell(text: string, width: number): string {
  const cut = ellipsis(text, width);
  return cut + " ".repeat(Math.max(0, width - displayWidth(cut)));
}
