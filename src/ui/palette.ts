//! The voice window's colors: the subset of Corgi's palette tokens it uses,
//! in a dark variant (Corgi's own `corgi` theme) and a light one. Every
//! foreground token reaches 3:1 against each background it is drawn on
//! (FR-027). Corgi's theme files are never read.

export type Rgb = [number, number, number];
export type Variant = "dark" | "light";

const dark_base = {
  bg: [24, 27, 32],
  selected: [51, 57, 65],
  line: [80, 90, 101],
  faint: [131, 144, 158],
  muted: [165, 174, 184],
  text: [209, 214, 219],
  strong: [238, 241, 244],
  accent: [123, 241, 168],
  warm: [229, 195, 139],
  hot: [237, 163, 152],
} satisfies Record<string, Rgb>;
export type Token = keyof typeof dark_base;

/** Tokens drawn as text, and the backgrounds each is drawn on. */
export const foregrounds: Token[] = ["strong", "text", "muted", "faint", "accent", "warm", "hot", "line"];
export const backgrounds: Token[] = ["bg", "selected"];
/** The pairs the window draws, beyond every foreground on `bg`: menu and
 * picker choices and the prompt field on `selected`, keycaps on `line`. */
export const pairs: [Token, Token][] = [
  ...foregrounds.map(f => [f, "bg"] as [Token, Token]),
  ["strong", "selected"],
  ["text", "selected"],
  ["strong", "line"],
];

export function luminance(rgb: Rgb): number {
  return rgb.reduce((sum, channel, index) => {
    const value = channel / 255;
    return (
      sum + [0.2126, 0.7152, 0.0722][index] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
}
/** The WCAG contrast ratio of two colors. */
export function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function mix(a: Rgb, b: Rgb, percentage: number): Rgb {
  return a.map((v, i) =>
    Math.floor((v * (100 - Math.min(100, percentage)) + b[i] * Math.min(100, percentage) + 50) / 100),
  ) as Rgb;
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255,
    G = g / 255,
    B = b / 255,
    max = Math.max(R, G, B),
    min = Math.min(R, G, B),
    l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min,
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min),
    h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}
function fromHsl([h, s, l]: [number, number, number]): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s,
    p = 2 * l - q,
    hue = (t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map(v => Math.round(v * 255)) as Rgb;
}
/** `rgb` with its HSL lightness moved by `step` (negative darkens) until it
 * reaches `ratio` against every color in `grounds`. */
export function readable(rgb: Rgb, grounds: Rgb[], ratio: number, step: number): Rgb {
  const [h, s, l0] = toHsl(rgb);
  let out = rgb;
  for (let l = l0; l >= 0 && l <= 1; l += step) {
    out = fromHsl([h, s, l]);
    if (grounds.every(g => contrast(out, g) >= ratio)) return out;
  }
  return out;
}

/** How far the window's listening note fades the accent toward `bg`, in percent. */
export const note_fade = 35;
/** A small margin above 3:1, so rounding never lands a pair just under it. */
const target = 3.1;

function darkVariant(): Record<Token, Rgb> {
  const out = structuredClone(dark_base) as Record<Token, Rgb>;
  // Corgi's `line` is a separator grey at 2.5:1; it is lifted to 3:1 here,
  // since the window draws its separators and box edges in it.
  out.line = readable(out.line, [out.bg], target, 0.01);
  return out;
}
function lightVariant(): Record<Token, Rgb> {
  const bg: Rgb = [250, 250, 248],
    selected: Rgb = [225, 228, 232],
    out: Record<Token, Rgb> = {
      bg,
      selected,
      line: [118, 126, 136],
      faint: [104, 112, 122],
      muted: [82, 89, 98],
      text: [44, 49, 56],
      strong: [16, 18, 22],
      accent: dark_base.accent,
      warm: dark_base.warm,
      hot: dark_base.hot,
    };
  for (const token of ["accent", "warm", "hot", "faint", "muted"] as Token[])
    out[token] = readable(out[token], [bg, selected], target, -0.01);
  // The listening note is the accent faded toward `bg`; it must read too.
  const [h, sat, l0] = toHsl(out.accent);
  for (let l = l0; l >= 0 && contrast(mix(out.accent, bg, note_fade), bg) < target; l -= 0.01)
    out.accent = fromHsl([h, sat, l]);
  return out;
}
export const variants: Record<Variant, Record<Token, Rgb>> = { dark: darkVariant(), light: lightVariant() };

/** The colors in use. `use` repaints them in place, so a held token stays current. */
export const colors = Object.fromEntries(
  Object.entries(variants.dark).map(([token, rgb]) => [token, [...rgb] as Rgb]),
) as Record<Token, Rgb>;
let current: Variant = "dark";
const refreshers: (() => void)[] = [];
/** Runs `refresh` now and after every variant change, for strings and colors
 * a module computes from tokens once. */
export function derived(refresh: () => void) {
  refresh();
  refreshers.push(refresh);
}
/** Switches to `variant`. */
export function use(variant: Variant): void {
  if (variant === current) return;
  current = variant;
  for (const token of Object.keys(colors) as Token[]) colors[token].splice(0, 3, ...variants[variant][token]);
  for (const refresh of refreshers) refresh();
}
export function variant(): Variant {
  return current;
}
export function fgRgb(c: Rgb) {
  return `\x1b[38;2;${c.join(";")}m`;
}
export function bgRgb(c: Rgb) {
  return `\x1b[48;2;${c.join(";")}m`;
}
export function fg(t: Token) {
  return fgRgb(colors[t]);
}
export function bg(t: Token) {
  return bgRgb(colors[t]);
}
export class Style {
  constructor(
    public value: {
      fg?: Token;
      bg?: Token;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      strike?: boolean;
    } = {},
  ) {}
  sgr() {
    const fields = ["0"];
    if (this.value.bold) fields.push("1");
    if (this.value.italic) fields.push("3");
    if (this.value.underline) fields.push("4");
    if (this.value.strike) fields.push("9");
    if (this.value.fg) fields.push("38", "2", ...colors[this.value.fg].map(String));
    if (this.value.bg) fields.push("48", "2", ...colors[this.value.bg].map(String));
    return `\x1b[${fields.join(";")}m`;
  }
}
/** A key in the footer: bold `strong` on `line`. */
export let keycap: string;
derived(() => {
  keycap = new Style({ fg: "strong", bg: "line", bold: true }).sgr();
});
