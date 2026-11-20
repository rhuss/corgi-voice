//! The terminal under the voice window: the alternate screen with mouse
//! reports, and redraws that write only the rows that changed, inside
//! synchronized output. It stands in for Corgi's native frame differ.
//!
//! The window draws a frame as positioned text (cursor moves, SGR colors,
//! characters); `rows` lays such a frame onto a grid and gives back one
//! string per row, which `render` compares with the last frame's.

const esc = "\x1b[";
/** Alternate screen, hidden cursor, bracketed paste, mouse clicks, drags and
 * wheel in SGR form, and a clear screen. */
export const enter = `${esc}?1049h${esc}?25l${esc}?2004h${esc}?1000h${esc}?1002h${esc}?1006h${esc}2J`;
/** Everything `enter` turned on, off again, and the cursor back. */
export const leave = `${esc}?1002l${esc}?1000l${esc}?1006l${esc}?2004l${esc}0m${esc}?25h${esc}?1049l`;
const sync_on = `${esc}?2026h`,
  sync_off = `${esc}?2026l`,
  hide = `${esc}?25l`,
  reset = `${esc}0m`;

export type Output = { write(text: string): unknown };
type Cell = { ch: string; sgr: string };

/** The rows a frame leaves on a `cols` × `height` screen, each with the
 * colors its cells were drawn in. */
export function rows(frame: string, cols: number, height: number): string[] {
  const grid: Cell[][] = Array.from({ length: height }, () =>
    Array.from({ length: cols }, () => ({ ch: " ", sgr: "" })),
  );
  let x = 0,
    y = 0,
    sgr = "";
  for (let i = 0; i < frame.length; ) {
    if (frame[i] === "\x1b") {
      const csi = /^\x1b\[([0-9;:?<>=]*)([ -\/]*)([@-~])/.exec(frame.slice(i, i + 64));
      if (csi) {
        if (csi[3] === "H" && !csi[2]) {
          const [row, col] = csi[1].split(";").map(v => Number(v || 1));
          y = row - 1;
          x = (col ?? 1) - 1;
        } else if (csi[3] === "m" && !csi[2]) {
          // A sequence that starts with a reset replaces what came before.
          sgr = csi[1] === "" || csi[1] === "0" || csi[1].startsWith("0;") ? csi[0] : sgr + csi[0];
        }
        i += csi[0].length;
        continue;
      }
      i++;
      continue;
    }
    const cp = frame.codePointAt(i)!,
      ch = String.fromCodePoint(cp);
    i += ch.length;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    const width = Bun.stringWidth(ch);
    if (width === 0) {
      // A combining mark joins the cell before it.
      const prev = grid[y]?.[x - 1];
      if (prev) prev.ch += ch;
      continue;
    }
    if (y >= 0 && y < height && x >= 0 && x < cols) {
      grid[y][x] = { ch, sgr };
      // The cell a wide character covers is part of it.
      if (width === 2 && x + 1 < cols) grid[y][x + 1] = { ch: "", sgr };
    }
    x += width;
  }
  return grid.map(line => {
    let out = "",
      last: string | null = null;
    for (const cell of line) {
      if (cell.sgr !== last) {
        out += reset + cell.sgr;
        last = cell.sgr;
      }
      out += cell.ch;
    }
    return out + reset;
  });
}

export class Screen {
  private shown: string[] = [];
  private entered = false;
  constructor(private out: Output) {}
  /** Takes the terminal: alternate screen, hidden cursor, mouse reports. */
  enter(): void {
    this.entered = true;
    this.shown = [];
    this.out.write(enter);
  }
  /** Writes the rows that differ from the last frame, in one synchronized update. */
  render(next: string[]): void {
    let changed = "";
    for (let y = 0; y < next.length; y++)
      if (next[y] !== this.shown[y]) changed += `${esc}${y + 1};1H${next[y]}${esc}K`;
    // Rows the screen lost when it got shorter are gone with the resize.
    this.shown = next.slice();
    // A host terminal that lost the mode would show the cursor after the footer.
    if (changed) this.out.write(sync_on + changed + reset + hide + sync_off);
  }
  /** The terminal changed size: the next frame is drawn whole. */
  resize(): void {
    this.shown = [];
    this.out.write(`${esc}2J`);
  }
  /** Gives the terminal back as it was. Safe to call more than once. */
  restore(): void {
    if (!this.entered) return;
    this.entered = false;
    this.out.write(leave);
  }
}
