//! How the voice session reaches Corgi: the seam between the session and the
//! `corgi` CLI link (`src/corgi/link.ts`). Mute lives in corgi-voice alone,
//! so nothing here sends voice state anywhere.
import type { Why } from "../corgi/viewers";

/** Whether a viewer would take text, the label of the pane it would go to,
 * the machine that pane is on, and why there is none (when there is none):
 * `reason` in words for the window, `why` for the code to tell the cases
 * apart. Both are null while there is a target. */
export type Seen = {
  viewer: boolean;
  focus: string | null;
  machine: string | null;
  reason: string | null;
  why: Why | null;
};
/** Where a delivery went. */
export type Typed = { machine: string; pane: number; viewer: number };
export type LinkEvents = {
  viewer: (seen: Seen) => void;
};
/**
 * The session's link to Corgi. `watch()` starts it and resolves with the
 * first view of the target; every later change comes as a `viewer` event.
 * `type()` rejects with `Error("Timeout")` when the delivery was abandoned at
 * its bound, `Error("VoicePane")` when the target is the pane corgi-voice
 * runs in, `Error("NoViewer")` when there is no target, or `Error(reason)`
 * with a short reason from `reasonFor()`.
 */
export interface VoiceLink {
  watch(): Promise<Seen>;
  type(text: string): Promise<Typed>;
  on<K extends keyof LinkEvents>(event: K, fn: LinkEvents[K]): void;
  close(): void;
}
/** `viewer` listeners. */
export class Events {
  private listeners: LinkEvents["viewer"][] = [];
  on<K extends keyof LinkEvents>(_event: K, fn: LinkEvents[K]): void {
    this.listeners.push(fn);
  }
  emitViewer(state: Seen): void {
    for (const fn of this.listeners) fn(state);
  }
}
/** The delivery bound (FR-012), and the one that decides: at it CorgiLink
 * rejects the delivery as abandoned and kills its `pane send`. Nothing else
 * ends a delivery earlier; the session's `safety_ms` is only a net under it. */
export const deadline_ms = 2000;

/** Rejects with `Timeout` when `promise` takes longer than `ms`. */
export function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error("Timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
