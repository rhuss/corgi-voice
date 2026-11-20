//! How the voice session reaches Corgi: the seam between the session and the
//! `corgi` CLI link (`src/corgi/link.ts`). Mute lives in corgi-voice alone,
//! so nothing here sends voice state anywhere.

/** Whether a viewer would take text, the label of the pane it would go to,
 * the machine that pane is on, and why there is none (when there is none). */
export type Seen = { viewer: boolean; focus: string | null; machine: string | null; reason: string | null };
/** Where a delivery went. */
export type Typed = { machine: string; pane: number; viewer: number };
export type LinkEvents = {
  viewer: (seen: Seen) => void;
  closed: (reason: string) => void;
};
/**
 * The session's link to Corgi. `type()` rejects with `Error("Timeout")` when
 * the delivery was abandoned at its bound, `Error("VoicePane")` when the
 * target is the pane corgi-voice runs in, `Error("NoViewer")` when there is
 * no target, or `Error(reason)` with a short reason from `reasonFor()`.
 */
export interface VoiceLink {
  watch(): Promise<Seen>;
  type(text: string): Promise<Typed>;
  on<K extends keyof LinkEvents>(event: K, fn: LinkEvents[K]): void;
  close(): void;
}
/** `viewer` and `closed` listeners. */
export class Events {
  private listeners: { [K in keyof LinkEvents]: LinkEvents[K][] } = { viewer: [], closed: [] };
  on<K extends keyof LinkEvents>(event: K, fn: LinkEvents[K]): void {
    this.listeners[event].push(fn);
  }
  emitViewer(state: Seen): void {
    for (const fn of this.listeners.viewer) fn(state);
  }
  emitClosed(reason: string): void {
    const listeners = this.listeners.closed.splice(0);
    for (const fn of listeners) fn(reason);
  }
}
/** The delivery bound CorgiLink holds every `pane send` to (FR-012). */
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
