import { test, expect } from "bun:test";
import { Screen, rows, enter, leave } from "../../src/ui/screen";

function fake() {
  const writes: string[] = [];
  return { writes, out: { write: (t: string) => void writes.push(t) } };
}
/** The text of a row, without its colors. */
const plain = (row: string) => row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

test("a frame of positioned text becomes one string per row", () => {
  const r = rows("\x1b[1;1H\x1b[0mhello\x1b[2;3Hab\x1b[3;1H日本", 8, 3);
  expect(r.map(plain)).toEqual(["hello   ", "  ab    ", "日本    "]);
});

test("colors stay with the cells they were drawn in", () => {
  const red = "\x1b[0;38;2;255;0;0m",
    r = rows(`\x1b[1;1H${red}ab\x1b[0mcd`, 4, 1)[0];
  expect(r).toBe(`\x1b[0m${red}ab\x1b[0m\x1b[0mcd\x1b[0m`);
  // A sequence without a reset adds to the one before.
  const bold = rows("\x1b[1;1H\x1b[0;38;2;1;2;3m\x1b[1mX", 1, 1)[0];
  expect(bold).toContain("\x1b[0;38;2;1;2;3m\x1b[1mX");
});

test("text past the edges is dropped, controls are not drawn", () => {
  expect(rows("\x1b[1;3Habcdef\x1b[5;1Hzz", 4, 2).map(plain)).toEqual(["  ab", "    "]);
  expect(rows("\x1b[1;1Ha\nb", 3, 1).map(plain)).toEqual(["ab "]);
});

test("the first render writes every row, the next only those that changed", () => {
  const { writes, out } = fake(),
    screen = new Screen(out);
  screen.enter();
  expect(writes[0]).toBe(enter);
  screen.render(["one", "two", "three"]);
  const first = writes[1];
  expect(first.startsWith("\x1b[?2026h")).toBe(true);
  expect(first.endsWith("\x1b[?2026l")).toBe(true);
  for (const [y, text] of [
    [1, "one"],
    [2, "two"],
    [3, "three"],
  ])
    expect(first).toContain(`\x1b[${y};1H${text}\x1b[K`);
  screen.render(["one", "two", "three"]);
  expect(writes).toHaveLength(2);
  screen.render(["one", "TWO", "three"]);
  expect(writes).toHaveLength(3);
  expect(writes[2]).toContain("\x1b[2;1HTWO\x1b[K");
  expect(writes[2]).not.toContain("one");
  expect(writes[2]).not.toContain("three");
  // The cursor stays hidden after each change.
  expect(writes[2]).toContain("\x1b[?25l");
});

test("a resize clears and draws the next frame whole", () => {
  const { writes, out } = fake(),
    screen = new Screen(out);
  screen.enter();
  screen.render(["a", "b"]);
  screen.resize();
  expect(writes.at(-1)).toBe("\x1b[2J");
  screen.render(["a", "b"]);
  expect(writes.at(-1)).toContain("\x1b[1;1Ha");
  expect(writes.at(-1)).toContain("\x1b[2;1Hb");
});

test("restore gives the terminal back once", () => {
  const { writes, out } = fake(),
    screen = new Screen(out);
  screen.restore();
  expect(writes).toEqual([]);
  screen.enter();
  screen.restore();
  screen.restore();
  expect(writes.filter(w => w === leave)).toHaveLength(1);
  // Mouse modes, bracketed paste and the alternate screen are all switched off.
  for (const mode of ["1000", "1002", "1006", "2004", "1049"]) expect(leave).toContain(`\x1b[?${mode}l`);
  expect(leave).toContain("\x1b[?25h");
  for (const mode of ["1000", "1006", "1049", "25"])
    expect(enter).toContain(`\x1b[?${mode}${mode === "25" ? "l" : "h"}`);
});
