//! `corgi-voice --trick` (FR-001 to FR-010): a Corgi raw JSONL trick that
//! keeps one sidebar title item in step with the voice state, and toggles
//! mute once per press of the note. It reads Corgi's events on its input,
//! writes one command per line, watches the control channel through
//! `src/control/client.ts` and reconnects every 2 s while corgi-voice is gone. It never exits because of corgi-voice; only
//! the end of its input ends it.
import { request, watch, type Outcome } from "../control/client";
import type { Answer } from "../control/server";
import type { VoiceState } from "../control/state";
import * as paths from "../util/paths";
import { item, sameItem, type Item } from "./item";

type Env = NodeJS.ProcessEnv;
/** The one key the trick draws under, and the pressable item's keyboard slot. */
export const key = "voice",
  slot = "voice";
/** How long the trick waits before connecting again. */
export const retry_ms = 2000;

export type TrickIo = {
  /** Corgi's lines, without their newlines; the trick ends with them. */
  input: AsyncIterable<string>;
  /** One command for Corgi, without its newline. */
  write(line: string): void;
  /** One diagnostic line (standard error). */
  log(line: string): void;
  /** The environment the channel path is computed from without `config.socket`. */
  env: Env;
  retryMs?: number;
  /** `paths.socketPath`, for tests. */
  socketPath?: (env: Env) => string;
};

/** Runs the trick until its input ends; returns the exit status, always 0. */
export async function runTrick(io: TrickIo): Promise<number> {
  const stop = new AbortController(),
    retryMs = io.retryMs ?? retry_ms,
    socketPath = io.socketPath ?? paths.socketPath,
    say = (message: string) => io.log(`corgi-voice trick: ${message}`),
    /** The error kinds Corgi answered with, each logged once. */
    refusals = new Set<string>();
  let started = false,
    /** The channel path, once `ready` named or computed one. */
    channel: string | null = null,
    /** The item drawn now, or none. */
    shown: Item | null = null,
    /** The action a press may use now, or none. */
    armed: string | null = null,
    seq = 0,
    /** A `toggle` is on its way to corgi-voice. */
    inflight = false,
    /** The newest watch state while a watch is connected. */
    latest: VoiceState | null = null,
    /** Last known reachability, for logging transitions only; null before the first try. */
    reachable: boolean | null = null,
    watching: Promise<void> | null = null;

  const send = (command: object) => {
    if (!stop.signal.aborted) io.write(JSON.stringify(command));
  };
  /** Draws `next`, or removes the item for none, unless that is what shows;
   * `rearm` draws a pressable item again when no press may use it. */
  const show = (next: Item | null, rearm = false) => {
    if (!next) {
      armed = null;
      if (shown) {
        shown = null;
        send({ op: "ui.remove", key });
      }
      return;
    }
    if (sameItem(shown, next) && !(rearm && next.pressable && armed === null)) return;
    const view: Record<string, unknown> = { kind: "title", spans: [{ text: next.glyph }], color: next.color };
    // A fresh action per drawing, so a press for an older one is told apart.
    armed = next.pressable ? `toggle-${++seq}` : null;
    if (armed) Object.assign(view, { action: armed, slot });
    shown = next;
    send({ op: "ui.set", key, view });
  };
  const answered = (answer: Answer) => {
    latest = answer.state;
    if (reachable === false) say("corgi-voice reachable again");
    reachable = true;
    const next = item(latest);
    // While a toggle is out, its end draws the note; a recording or no
    // item at all shows at once.
    if (!inflight || !next?.pressable) show(next);
  };
  /** A press: the first with the armed action sends one `toggle`; any other is ignored. */
  const press = (action: unknown) => {
    if (!channel || inflight || !latest || armed === null || action !== armed) return;
    armed = null;
    inflight = true;
    request(channel, "toggle").then(toggled, () => toggled(null));
  };
  /** The toggle ended, answered or not: draw the newer of its answer and
   * the watch (the watch on a tie, its stream is ordered), armed afresh.
   * Without a watch nothing is drawn; its next answer will. */
  const toggled = (outcome: Outcome | null) => {
    inflight = false;
    if (stop.signal.aborted || !latest) return;
    const answer = outcome?.ok ? outcome.answer.state : null;
    show(item(answer && answer.updated_at > latest.updated_at ? answer : latest), true);
  };
  /** Watches `path` until the input ends, again `retryMs` after each end. */
  const connect = async (path: string) => {
    while (!stop.signal.aborted) {
      await watch(path, answered, { signal: stop.signal });
      latest = null;
      if (stop.signal.aborted) return;
      show(null);
      if (reachable !== false) say("corgi-voice not reachable");
      reachable = false;
      await pause(retryMs, stop.signal);
    }
  };
  /** The channel path: `config.socket` when given, else this environment's. */
  const ready = (event: Record<string, unknown>) => {
    if (started) return;
    started = true;
    const config = event.config,
      given = typeof config === "object" && config !== null ? (config as { socket?: unknown }).socket : undefined;
    let path: string;
    if (typeof given === "string" && given) path = given;
    else
      try {
        path = socketPath(io.env);
      } catch (error) {
        // No safe folder for the socket: no corgi-voice listens anywhere to find. Idle.
        say((error as { detail?: string }).detail ?? (error instanceof Error ? error.message : String(error)));
        return;
      }
    channel = path;
    watching = connect(path);
  };

  try {
    for await (const line of io.input) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const event = parsed as Record<string, unknown>;
      if (event.event === "ready") ready(event);
      else if (event.event === "ui.press") press(event.action);
      // A command Corgi did not take (a Corgi without title items, or a
      // contract change): said once per kind, never retried.
      else if (event.event === undefined && typeof event.error === "string" && !refusals.has(event.error)) {
        refusals.add(event.error);
        say(`Corgi refused the item: ${event.error}`);
      }
    }
  } finally {
    // Corgi closed the input (reload, disable, daemon exit): stop at once.
    stop.abort();
    await watching;
  }
  return 0;
}
/** The lines of `stream` (standard input), without their newlines. */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  buf += decoder.decode();
  if (buf) yield buf;
}
/** Waits `ms`, or less when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
