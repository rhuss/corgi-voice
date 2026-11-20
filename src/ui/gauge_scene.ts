//! The threshold gauge's animation, from Corgi's corgi_animation: the corgi
//! sniffs along the level meter for 10 s while music plays, a tick marking
//! the loudest it heard and `T:` counting down; then the threshold marker
//! glides to its new place, a cell every 50 ms, with `T:` counting along.

/** The marker's glide: one meter cell every 50 ms. */
export const gauge_glide_ms = 50,
  /** The cell of the sniffing corgi's nose. */
  gauge_nose = 3;
/** The sniffing corgi, a frame every 200 ms. */
export const sniff = [
  "~ʌ•ᴥ•ʌ",
  "~ʌ•ᴥ•ʌ",
  "~ʌ•ω•ʌ",
  "-ʌ•ᴥ•ʌ",
  "-ᐱ•ω•ᐱ",
  "-ᐱ•ˑ•ᐱ",
  "~ᐱ•ˑ•ᐱ",
  "~ᐱ•ᴥ•ᐱ",
  "~ᐱ•ᴥ•ᐱ",
  "^ʌ◡ᴥ◡ʌ",
  "^ʌ•ᴥ•ʌ",
  "^ʌ•ᴥ•ʌ",
];
/** The corgi `progress` of the way along a meter of `cells` cells, from the
 * first at 0 to the last at 1, and its sniffing sprite `ms` in. */
export function gaugeScene(cells: number, progress: number, ms: number): { x: number; sprite: string } {
  return {
    x: Math.round(Math.min(1, Math.max(0, progress)) * Math.max(0, cells - 1)),
    sprite: sniff[Math.floor(Math.max(0, ms) / 200) % sniff.length],
  };
}
