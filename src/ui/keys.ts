//! Keys, clicks and wheel notches from a terminal in raw mode with SGR mouse
//! reports, for the voice window.
//! Operating system commands (`ESC ]` up to `BEL` or `ESC \`) are dropped
//! whole for the entire session, so a terminal's late answer to the OSC 11
//! background query is never read as keys (its `rgb:` would press `r`).

export type Key =
  | {
      kind:
        | "up"
        | "down"
        | "left"
        | "right"
        | "tab"
        | "backtab"
        | "enter"
        | "esc"
        | "backspace"
        | "cancel"
        | "pageup"
        | "pagedown"
        | "home"
        | "end";
    }
  | { kind: "text"; text: string }
  /** Ctrl and a letter, as `d` for Ctrl+D. */
  | { kind: "ctrl"; key: string }
  | { kind: "click"; x: number; y: number }
  /** The pointer moved with the left button held, where the terminal reports motion (mode 1002). */
  | { kind: "drag"; x: number; y: number }
  /** The left button let go. */
  | { kind: "release"; x: number; y: number }
  | { kind: "wheel"; dir: 1 | -1; x: number; y: number };

const named: [string, Key["kind"]][] = [
  ["\x1b[A", "up"],
  ["\x1bOA", "up"],
  ["\x1b[B", "down"],
  ["\x1bOB", "down"],
  ["\x1b[C", "right"],
  ["\x1bOC", "right"],
  ["\x1b[D", "left"],
  ["\x1bOD", "left"],
  ["\x1b[Z", "backtab"],
  ["\x1b[5~", "pageup"],
  ["\x1b[6~", "pagedown"],
  ["\x1b[H", "home"],
  ["\x1bOH", "home"],
  ["\x1b[1~", "home"],
  ["\x1b[7~", "home"],
  ["\x1b[F", "end"],
  ["\x1bOF", "end"],
  ["\x1b[4~", "end"],
  ["\x1b[8~", "end"],
];
/** Where `data` ends inside an escape sequence or a paste, or `data.length`:
 * a read can stop between the bytes of one key, and the rest comes next. */
export function incomplete(data: string): number {
  const osc = data.lastIndexOf("\x1b]");
  if (osc >= 0 && oscEnd(data, osc) < 0) return osc;
  const paste = data.lastIndexOf("\x1b[200~");
  if (paste >= 0 && data.indexOf("\x1b[201~", paste) < 0) return paste;
  const esc = data.lastIndexOf("\x1b");
  return esc >= 0 && /^\x1b(?:\[[0-9;?<]*|O)?$/.test(data.slice(esc)) ? esc : data.length;
}
/** Where the operating system command starting at `at` ends (just past its
 * terminator), or -1 while it is unterminated. */
function oscEnd(data: string, at: number): number {
  for (let i = at + 2; i < data.length; i++) {
    if (data[i] === "\x07") return i + 1;
    if (data[i] === "\x1b" && data[i + 1] === "\\") return i + 2;
  }
  return -1;
}
/** The keys, clicks and wheel notches in `data`. Coordinates are 0-based. */
export function keys(data: string): Key[] {
  const out: Key[] = [];
  for (let i = 0; i < data.length;) {
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(i));
    if (mouse) {
      const button = Number(mouse[1]),
        x = Number(mouse[2]) - 1,
        y = Number(mouse[3]) - 1;
      if (mouse[4] === "M" && button === 0) out.push({ kind: "click", x, y });
      else if (mouse[4] === "M" && button === 32) out.push({ kind: "drag", x, y });
      else if (mouse[4] === "m" && button === 0) out.push({ kind: "release", x, y });
      else if (mouse[4] === "M" && (button === 64 || button === 65))
        out.push({ kind: "wheel", dir: button === 64 ? 1 : -1, x, y });
      i += mouse[0].length;
      continue;
    }
    if (data.startsWith("\x1b]", i)) {
      const end = oscEnd(data, i);
      i = end < 0 ? data.length : end;
      continue;
    }
    if (data.startsWith("\x1b[200~", i)) {
      const end = data.indexOf("\x1b[201~", i);
      out.push({ kind: "text", text: data.slice(i + 6, end < 0 ? data.length : end) });
      i = end < 0 ? data.length : end + 6;
      continue;
    }
    const seq = named.find(([s]) => data.startsWith(s, i));
    if (seq) {
      out.push({ kind: seq[1] } as Key);
      i += seq[0].length;
      continue;
    }
    const ch = data[i++];
    if (ch === "\x1b") {
      // Another escape sequence: skip it whole.
      const rest = /^(?:\[[0-9;?]*[ -\/]*[@-~]|O.)/.exec(data.slice(i));
      if (rest) i += rest[0].length;
      else out.push({ kind: "esc" });
    } else if (ch === "\r" || ch === "\n") out.push({ kind: "enter" });
    else if (ch === "\t") out.push({ kind: "tab" });
    else if (ch === "\x7f" || ch === "\b") out.push({ kind: "backspace" });
    else if (ch === "\x03" || ch === "\x11") out.push({ kind: "cancel" });
    else if (ch >= " ") out.push({ kind: "text", text: ch });
    else if (ch >= "\x01" && ch <= "\x1a") out.push({ kind: "ctrl", key: String.fromCharCode(ch.charCodeAt(0) + 96) });
  }
  return out;
}

/** How long a read that ends in an escape waits for the rest of the key, and
 * how long an unfinished operating system command is held for its end. */
export const esc_ms = 50,
  osc_hold_ms = 1000;
/** The tail of a background answer whose start was already dropped. */
const osc_tail = /^(?:\]?1[01];)?rgba?:[0-9a-fA-F/]*(?:\x07|\x1b\\)/,
  /** The rest of an answer after a dropped start: its hex digits, then its end. */
  osc_rest = /^[0-9a-fA-F/:;]*(?:\x07|\x1b\\)/;

/** Reads from the terminal put back together into whole keys: a read can
 * stop inside a key, a paste or an OSC answer, and the rest comes next. */
export class KeyFeed {
  private partial = "";
  private held_since = 0;
  /** An unfinished answer was dropped; its rest may still come. */
  private dropped = false;
  /** Takes one read; returns the text that is complete now. */
  push(data: string, now = Date.now()): string {
    let text = this.partial + data;
    // The end of an answer that came apart too late to be held is no key.
    if (!this.partial) text = text.replace(this.dropped ? osc_rest : osc_tail, "").replace(osc_tail, "");
    this.dropped = false;
    const cut = incomplete(text);
    const was = this.partial;
    this.partial = text.slice(cut);
    if (this.oscPending && !was.startsWith("\x1b]")) this.held_since = now;
    return text.slice(0, cut);
  }
  /** Whether part of a key waits for more. */
  get waiting(): boolean {
    return this.partial !== "";
  }
  private get oscPending(): boolean {
    return this.partial.startsWith("\x1b]");
  }
  /** How long to wait for the rest before `flush`. */
  delay(): number {
    return this.oscPending ? osc_hold_ms : esc_ms;
  }
  /** Nothing more came: a lone Escape (or a cut key) is handed out as it is;
   * an unfinished OSC answer is held up to a second, then dropped, never read as keys. */
  flush(now = Date.now()): string {
    if (this.oscPending) {
      if (now - this.held_since < osc_hold_ms) return "";
      this.partial = "";
      this.dropped = true;
      return "";
    }
    const held = this.partial;
    this.partial = "";
    return held;
  }
}
