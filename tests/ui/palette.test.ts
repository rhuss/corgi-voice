import { test, expect, afterEach } from "bun:test";
import {
  contrast,
  Style,
  fgRgb,
  bgRgb,
  keycap,
  mix,
  colors,
  derived,
  use,
  variants,
  pairs,
  note_fade,
  foregrounds,
  type Rgb,
  type Variant,
} from "../../src/ui/palette";

afterEach(() => use("dark"));

test("every foreground-on-background pair the window draws reaches 3:1 in both variants", () => {
  for (const variant of ["dark", "light"] as Variant[]) {
    const c = variants[variant];
    for (const [ink, ground] of pairs) {
      const ratio = contrast(c[ink], c[ground]);
      if (ratio < 3) throw Error(`${variant}: ${ink} on ${ground} is ${ratio.toFixed(2)}`);
      expect(ratio).toBeGreaterThanOrEqual(3);
    }
    // Every foreground token on every background it is used on.
    for (const ink of foregrounds) expect(contrast(c[ink], c.bg)).toBeGreaterThanOrEqual(3);
  }
});

test("the listening note, the accent faded toward bg, reaches 3:1 in both variants", () => {
  for (const variant of ["dark", "light"] as Variant[]) {
    const c = variants[variant];
    expect(contrast(mix(c.accent, c.bg, note_fade), c.bg)).toBeGreaterThanOrEqual(3);
  }
});

test("the dark variant keeps Corgi's own colors and backgrounds, with line lifted to 3:1", () => {
  const d = variants.dark;
  expect(d.bg).toEqual([24, 27, 32]);
  expect(d.selected).toEqual([51, 57, 65]);
  expect(d.text).toEqual([209, 214, 219]);
  expect(d.accent).toEqual([123, 241, 168]);
  // Corgi's line, [80, 90, 101], is 2.5:1 on bg; separators drawn in it must reach 3:1 (FR-027).
  expect(contrast(d.line, d.bg)).toBeGreaterThanOrEqual(3);
});

test("the light variant has light backgrounds and darker foregrounds", () => {
  const l = variants.light;
  expect(l.bg).toEqual([250, 250, 248]);
  expect(l.selected).toEqual([225, 228, 232]);
  const sum = (c: Rgb) => c[0] + c[1] + c[2];
  for (const token of ["accent", "warm", "hot", "text", "strong"] as const)
    expect(sum(l[token])).toBeLessThan(sum(variants.dark[token]));
});

test("styles write SGR from the tokens in use", () => {
  expect(new Style({ fg: "text", bg: "bg" }).sgr()).toBe("\x1b[0;38;2;209;214;219;48;2;24;27;32m");
  expect(new Style({ fg: "hot", bg: "bg", bold: true }).sgr()).toBe("\x1b[0;1;38;2;237;163;152;48;2;24;27;32m");
  expect(new Style().sgr()).toBe("\x1b[0m");
  expect(fgRgb([1, 2, 3])).toBe("\x1b[38;2;1;2;3m");
  expect(bgRgb([1, 2, 3])).toBe("\x1b[48;2;1;2;3m");
});

test("mix blends by percentage and clamps at 100", () => {
  expect(mix([0, 0, 0], [100, 200, 255], 50)).toEqual([50, 100, 128]);
  expect(mix([10, 10, 10], [20, 20, 20], 150)).toEqual([20, 20, 20]);
  expect(mix([10, 10, 10], [20, 20, 20], 0)).toEqual([10, 10, 10]);
});

test("switching the variant repaints held tokens and derived values", () => {
  const held = colors.bg;
  let seen = "";
  derived(() => (seen = fgRgb(colors.text)));
  const darkKeycap = keycap;
  use("light");
  expect(held).toEqual(variants.light.bg);
  expect(seen).toBe(fgRgb(variants.light.text));
  expect(keycap).not.toBe(darkKeycap);
  use("dark");
  expect(held).toEqual(variants.dark.bg);
  expect(keycap).toBe(darkKeycap);
});
