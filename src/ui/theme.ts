//! Light or dark (FR-027): the `theme` setting, or the terminal's background
//! from an OSC 11 query answered within 200 ms; no answer means dark.
//! Corgi's theme files are never read.
import { luminance, type Rgb, type Variant } from "./palette";

export type ThemeSetting = "auto" | "light" | "dark";
/** How long the terminal has to answer the background query. */
export const answer_ms = 200;
const query = "\x1b]11;?\x07";

/** The color in an OSC 11 answer (`ESC ] 11 ; rgb:RRRR/GGGG/BBBB` ended by
 * BEL or ST, with 1 to 4 hex digits per channel), or null. */
export function parseReply(data: string): Rgb | null {
  const m = /\x1b\]11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/.exec(data);
  if (!m) return null;
  return [m[1], m[2], m[3]].map(hex => Math.round((parseInt(hex, 16) / (16 ** hex.length - 1)) * 255)) as Rgb;
}
/** A background with relative luminance under 0.5 is dark. */
export function variantOf(background: Rgb): Variant {
  return luminance(background) < 0.5 ? "dark" : "light";
}
type Input = {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  isRaw?: boolean;
  on(event: "data", fn: (data: Buffer) => void): unknown;
  off(event: "data", fn: (data: Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
};
type Output = { isTTY?: boolean; write(text: string): unknown };

/** The variant to draw in: the setting's, else the terminal's background's,
 * else dark. */
export async function detect(
  setting: ThemeSetting,
  io: { input: Input; output: Output } = { input: process.stdin, output: process.stdout },
  timeoutMs = answer_ms,
): Promise<Variant> {
  if (setting === "light" || setting === "dark") return setting;
  const { input, output } = io;
  if (!input.isTTY || !output.isTTY) return "dark";
  const raw = input.isRaw ?? false;
  let heard = "",
    onData!: (data: Buffer) => void;
  const answered = new Promise<Rgb | null>(resolve => {
    onData = data => {
      heard += data.toString("latin1");
      const rgb = parseReply(heard);
      if (rgb) resolve(rgb);
    };
  });
  try {
    input.setRawMode?.(true);
    input.on("data", onData);
    input.resume();
    output.write(query);
    const rgb = await Promise.race([answered, Bun.sleep(timeoutMs).then(() => null)]);
    return rgb ? variantOf(rgb) : "dark";
  } finally {
    input.off("data", onData);
    input.pause();
    try {
      input.setRawMode?.(raw);
    } catch {}
  }
}
