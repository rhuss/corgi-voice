//! What the sidebar voice icon shows for a voice state (FR-003): the
//! recording first, then nothing while voice cannot listen, else `♫` in the
//! mode's color. Pure; the target and its reason never change the item.
import type { VoiceState } from "../control/state";

/** Corgi palette names (`docs/tricks.md`, "Palette and branding"). */
export type Color = "accent" | "faint" | "hot" | "warm";
export type Item = { glyph: "♫" | "●"; color: Color; pressable: boolean };

/** The item for `state`, or none: none without a state (corgi-voice unreachable). */
export function item(state: Pick<VoiceState, "mode" | "unavailable" | "recording"> | null): Item | null {
  if (!state) return null;
  // A recording is not pressable: a click must not unmute dictation under it.
  if (state.recording === "running") return { glyph: "●", color: "hot", pressable: false };
  if (state.recording === "paused") return { glyph: "●", color: "warm", pressable: false };
  if (state.unavailable !== null) return null;
  return state.mode === "listening"
    ? { glyph: "♫", color: "accent", pressable: true }
    : { glyph: "♫", color: "faint", pressable: true };
}
/** Whether two items (or none) look and press the same. */
export function sameItem(a: Item | null, b: Item | null): boolean {
  if (!a || !b) return a === b;
  return a.glyph === b.glyph && a.color === b.color && a.pressable === b.pressable;
}
