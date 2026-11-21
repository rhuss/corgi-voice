//! The other end of the control channel, for `corgi-voice --mute`,
//! `--status`, `--watch` and the rest: one request, its answer, or a stream
//! of states for a watch. No answer within the timeout (connect and first
//! answer together) is no answer; a watch then runs as long as corgi-voice.
import { max_line, type Answer, type Op } from "./server";

/** How long a command waits for corgi-voice to connect and answer. */
export const timeout_ms = 1000;

export type Outcome = { ok: true; answer: Answer } | { ok: false; why: "not_running" | "no_answer" };
type End = "done" | "closed" | "not_running" | "no_answer";
/** The longest answer line taken: a state is a few hundred bytes. */
const max_answer = 16 * max_line;
/** Whether `value` looks like an answer: `ok` and a `state` object. */
function isAnswer(value: unknown): value is Answer {
  if (typeof value !== "object" || value === null) return false;
  const a = value as { ok?: unknown; state?: unknown };
  return typeof a.ok === "boolean" && typeof a.state === "object" && a.state !== null;
}

/** Sends `op` to the corgi-voice listening at `path` and returns its answer. */
export async function request(path: string, op: Op, opts: { timeoutMs?: number } = {}): Promise<Outcome> {
  let answer = null as Answer | null;
  const end = await converse(path, op, opts.timeoutMs ?? timeout_ms, a => {
    answer = a;
    return false;
  });
  if (answer) return { ok: true, answer };
  return { ok: false, why: end === "not_running" ? "not_running" : "no_answer" };
}
/** Watches the corgi-voice at `path`: `onAnswer` gets the state now, then
 * every change. "closed" once corgi-voice ends the watch (it quit). */
export async function watch(
  path: string,
  onAnswer: (answer: Answer) => void,
  opts: { timeoutMs?: number } = {},
): Promise<"closed" | "not_running" | "no_answer"> {
  // `onAnswer` never ends the watch, so it ends only when corgi-voice does.
  const end = await converse(path, "watch", opts.timeoutMs ?? timeout_ms, a => {
    onAnswer(a);
    return true;
  });
  return end as Exclude<End, "done">;
}
/** One connection: sends `op`, hands each answer line to `onAnswer` while it
 * returns true, and says how it ended. Only the first answer is timed. */
function converse(path: string, op: Op, timeoutMs: number, onAnswer: (a: Answer) => boolean): Promise<End> {
  return new Promise<End>(resolve => {
    const decoder = new TextDecoder();
    let settled = false,
      answered = false,
      buf = "",
      sock: Bun.Socket<undefined> | null = null;
    const finish = (end: End) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.end();
      } catch {}
      resolve(end);
    };
    const timer = setTimeout(() => finish("no_answer"), timeoutMs);
    // Whatever the server closes with: an answer came, or none did.
    const gone = () => finish(answered ? "closed" : "no_answer");
    Bun.connect({
      unix: path,
      socket: {
        open(s) {
          sock = s;
          if (settled) return void s.end();
          s.write(JSON.stringify({ op }) + "\n");
        },
        data(_s, chunk) {
          buf += decoder.decode(chunk, { stream: true });
          for (let i = buf.indexOf("\n"); i >= 0 && !settled; i = buf.indexOf("\n")) {
            const text = buf.slice(0, i);
            buf = buf.slice(i + 1);
            let answer: unknown;
            try {
              answer = JSON.parse(text);
            } catch {}
            // Not corgi-voice's answer: no answer, also in the middle of a
            // watch, which then fails instead of looking like a quit.
            if (!isAnswer(answer)) return finish("no_answer");
            if (!answered) {
              answered = true;
              clearTimeout(timer);
            }
            if (!onAnswer(answer)) return finish("done");
          }
          if (buf.length > max_answer) finish("no_answer");
        },
        close: gone,
        error: gone,
        // Nothing at the path, or a socket nobody listens on: a dead corgi-voice's.
        connectError: () => finish("not_running"),
      },
    }).catch(() => finish("not_running"));
  });
}
