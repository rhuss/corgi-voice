//! What voice is doing, in one description shared by the window and the
//! control channel (FR-004): the mute setting and the mode the window shows,
//! why voice cannot listen, where text would go or why it would go nowhere,
//! and the recording. Pure: built from the session and the recorder as they
//! are, so the window and `corgi-voice --status` never disagree.
import type { LinkState, Unavailable } from "../voice/session";
import type { RecordingState } from "../voice/recorder";

export type Mode = "listening" | "muted";
export type VoiceState = {
  pid: number;
  /** The mute setting, which decides the mode whenever voice can listen. */
  muted: boolean;
  /** The mode the window shows: muted while muted or while voice cannot listen. */
  mode: Mode;
  unavailable: Unavailable | null;
  /** Why there is no target, in the window's words; null with a target. */
  reason: string | null;
  /** A stopping recording counts as none: the window hides REC at once. */
  recording: "none" | "running" | "paused";
  /** The machine text would go to, and the window's Target text. */
  target: { machine: string; label: string } | null;
  /** When another field last changed (ms since the epoch). */
  updated_at: number;
};
/** What the state is read from: the session's fields the window shows. */
export type StateSource = {
  muted: boolean;
  available: boolean;
  unavailable: Unavailable | null;
  viewer: boolean;
  focus: string | null;
  machine: string | null;
  reason: string | null;
  link_state: LinkState;
};
/** The recording the recorder has, if any. */
export type RecordingSource = { current: { state: RecordingState } | null };

/** Why voice cannot listen, as the short line says it. */
export const cannot_listen: Record<Unavailable, string> = {
  mic_missing: "microphone missing",
  mic_denied: "microphone access denied",
  mic_busy: "microphone busy",
  server_down: "transcription server down",
};

/** Why nothing would be typed, in full: the session's reason, else what the
 * window falls back to. */
function noTarget(s: StateSource): string {
  return s.reason ?? (s.link_state === "lost" ? "Corgi unreachable" : "no viewer attached");
}
/** A reason's head, as the window's Target cell shows it: "Corgi
 * unreachable", "marovo unreachable", "no viewer attached". */
const head = (reason: string) => reason.split(":")[0];
/** Where the next text goes: the pane's label, after its machine when that is
 * not the local one; or why nothing would be typed. The window's Target cell. */
export function target(s: StateSource): string {
  if (!s.viewer) return head(noTarget(s));
  const machine = s.machine ?? "local";
  if (!s.focus) return machine;
  return machine !== "local" ? `${machine} → ${s.focus}` : s.focus;
}
/** Whether the window shows MUTED: muted, or unable to listen (the window's
 * `mode()` and the channel's refusals both follow this). */
export function shownMuted(s: { muted: boolean; available: boolean }): boolean {
  return s.muted || !s.available;
}
/** The state now. `updated_at` stays `previous`'s unless another field changed. */
export function stateOf(o: {
  session: StateSource;
  recorder: RecordingSource;
  pid: number;
  now: () => number;
  previous?: VoiceState | null;
}): VoiceState {
  const s = o.session,
    running = o.recorder.current?.state,
    next: VoiceState = {
      pid: o.pid,
      muted: s.muted,
      mode: shownMuted(s) ? "muted" : "listening",
      unavailable: s.unavailable,
      reason: s.viewer ? null : noTarget(s),
      recording: running === "running" || running === "paused" ? running : "none",
      target: s.viewer ? { machine: s.machine ?? "local", label: target(s) } : null,
      updated_at: 0,
    };
  next.updated_at = o.previous && equal(o.previous, next) ? o.previous.updated_at : o.now();
  return next;
}
/** Whether two states say the same, `updated_at` aside. */
export function equal(a: VoiceState, b: VoiceState): boolean {
  return (
    a.pid === b.pid &&
    a.muted === b.muted &&
    a.mode === b.mode &&
    a.unavailable === b.unavailable &&
    a.reason === b.reason &&
    a.recording === b.recording &&
    a.target?.machine === b.target?.machine &&
    a.target?.label === b.target?.label
  );
}
/** The one line for scripts and status bars (FR-007): the mode, then where
 * text goes, why it goes nowhere, or why voice cannot listen, which wins;
 * then the recording, if one runs. */
export function shortLine(state: VoiceState): string {
  const where = state.unavailable
      ? `cannot listen: ${cannot_listen[state.unavailable]}`
      : (state.target?.label ?? head(state.reason ?? "no viewer attached")),
    rec = state.recording === "running" ? " · REC" : state.recording === "paused" ? " · REC paused" : "";
  return `${state.mode} · ${where}${rec}`;
}
