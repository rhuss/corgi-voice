//! Text measurement and clipping in terminal cells, on `Bun.stringWidth`
//! instead of Corgi's native width table.

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
/** Fits a path in `room` columns: its first two components, then the last,
 * then as many between as fit, nearest the last first, with one "…" for the
 * rest. The second component goes before the last is cut. An absolute path's
 * top directory is one component, as `~` is. */
export function shortPath(path: string, room: number): string {
  if (displayWidth(path) <= room) return path;
  const split = path.split("/"),
    parts = path.startsWith("/") ? ["/" + split[1], ...split.slice(2)] : split,
    last = parts[parts.length - 1],
    fits = (s: string) => displayWidth(s) <= room;
  if (parts.length > 3) {
    const join = (kept: string[]) => [parts[0], parts[1], "…", ...kept, last].join("/");
    if (fits(join([]))) {
      let kept: string[] = [];
      for (let i = parts.length - 2; i >= 3 && fits(join([parts[i], ...kept])); i--) kept = [parts[i], ...kept];
      return join(kept);
    }
  }
  const prefix = parts[0] + "/…/";
  if (parts.length > 2 && fits(prefix + last)) return prefix + last;
  if (parts.length > 2 && room - displayWidth(prefix) >= 6) return prefix + ellipsis(last, room - displayWidth(prefix));
  return ellipsis(path, room);
}
