//! Text measurement and clipping in terminal cells, on `Bun.stringWidth`,
//! and the one definition of the control characters kept off the screen
//! and out of what is typed.

/** The control characters (C0, DEL and C1) as the inside of a character
 * class, for a pattern that names more than these. */
export const controls = "\\x00-\\x1f\\x7f-\\x9f";
const control = new RegExp(`[${controls}]`, "g");

/** `text` with a space for each control character, so nothing in it moves
 * the cursor, starts an escape sequence or breaks a line. */
export function spaced(text: string): string {
  return text.replace(control, " ");
}
/** Cells the code point `cp` takes. */
export function codepointWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  return Bun.stringWidth(String.fromCodePoint(cp));
}
/** Cells `text` takes; escape sequences take none. */
export function displayWidth(text: string): number {
  return Bun.stringWidth(text);
}
/** The longest prefix of `text` that fits `room` cells. */
export function clipped(text: string, room: number): string {
  let used = 0;
  let end = 0;
  for (const ch of text) {
    used += codepointWidth(ch.codePointAt(0)!);
    if (used > room) break;
    end += ch.length;
  }
  return text.slice(0, end);
}
/** `text` cut to `room` cells with "…" at the end when it does not fit. */
export function ellipsis(text: string, room: number): string {
  if (displayWidth(text) <= room) return text;
  if (room <= 0) return "";
  return clipped(text, room - 1) + "…";
}
