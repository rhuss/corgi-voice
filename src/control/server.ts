//! The control channel (FR-001 to FR-006): a Unix socket next to the lock
//! that answers what voice is doing and takes mute and unmute from outside,
//! one JSON request per connection, and streams the state to watchers. It
//! never types text, never controls a recording and never changes a stored
//! setting (voice.json); the mute it sets lives in the running window only.
//! Nothing a client does can hold up the window: input is bounded, a silent
//! client is closed, and a watcher that stops reading is dropped.
import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { stateOf, equal, shownMuted, type StateSource, type RecordingSource, type VoiceState } from "./state";

/** What the channel uses of the session: the state's fields, `m`'s path,
 * the history row, and its changes. */
export type SessionLike = StateSource & {
  setMuted(muted: boolean, restore?: boolean): void;
  note(text: string): void;
  on(event: "change", fn: () => void): void;
};
/** What the channel uses of the recorder: whether one runs, and its changes. */
export type RecorderLike = RecordingSource & { on(event: "change", fn: () => void): void };

export type Op = "status" | "mute" | "unmute" | "toggle" | "watch";
export const ops: readonly Op[] = ["status", "mute", "unmute", "toggle", "watch"];
export type Err = "bad_json" | "too_long" | "unknown_op" | "cannot_listen";
export type Answer = { ok: true; state: VoiceState } | { ok: false; state: VoiceState; err: Err };

/** The longest request line, its newline aside. */
export const max_line = 4096;
/** How long a client may take to send its request. */
export const idle_ms = 2000;
/** How much may wait unsent for a watcher before it is dropped. */
export const max_unsent = 64 * 1024;

type Conn = {
  /** The request so far, until its newline. */
  input: Uint8Array;
  /** Set once the request is in: what follows is ignored. */
  done: boolean;
  /** Bytes Bun did not take yet, in order, and their count. */
  queue: Uint8Array[];
  queued: number;
  /** End the connection once the queue is empty. */
  ending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};
const encoder = new TextEncoder(),
  decoder = new TextDecoder();

/** Listens at `path` until `close()`, which also removes the socket file.
 * The caller holds the instance lock, so a socket file already there is a
 * dead corgi-voice's and is removed first. */
export async function startServer(opts: {
  path: string;
  session: SessionLike;
  recorder: RecorderLike;
  pid: number;
  /** How long a client may stay silent before its request; 2 s by default. */
  idleMs?: number;
  /** A watcher's unsent bytes past which it is dropped; 64 KiB by default. */
  maxUnsent?: number;
  now?: () => number;
  log?: (line: string) => void;
}): Promise<{ close(): void }> {
  const { path, session, recorder, pid } = opts,
    idle = opts.idleMs ?? idle_ms,
    limit = opts.maxUnsent ?? max_unsent,
    now = opts.now ?? Date.now,
    conns = new Set<Bun.Socket<Conn>>(),
    watchers = new Set<Bun.Socket<Conn>>();
  let last: VoiceState | null = null,
    closed = false;
  /** The state now; a change since the last look goes to every watcher. */
  const current = (): VoiceState => {
    const next = stateOf({ session, recorder, pid, now, previous: last });
    if (last && equal(last, next)) return last;
    const changed = last !== null;
    last = next;
    if (changed) for (const w of watchers) send(w, line({ ok: true, state: next }));
    return next;
  };
  const line = (answer: Answer) => encoder.encode(JSON.stringify(answer) + "\n");
  /** Gone at once: nothing more is sent or read. */
  const drop = (s: Bun.Socket<Conn>, why: string) => {
    if (!conns.has(s)) return;
    opts.log?.(`control: dropped a ${watchers.has(s) ? "watcher" : "client"}: ${why}`);
    forget(s);
    s.terminate();
  };
  const forget = (s: Bun.Socket<Conn>) => {
    conns.delete(s);
    watchers.delete(s);
    if (s.data?.timer) clearTimeout(s.data.timer);
  };
  /** Writes what Bun takes now and queues the rest, for `drain`; a watcher
   * that lets too much pile up is dropped. */
  const send = (s: Bun.Socket<Conn>, bytes: Uint8Array) => {
    const c = s.data;
    if (!c.queue.length) {
      const n = s.write(bytes);
      if (n < 0) return drop(s, "gone");
      if (n >= bytes.length) return;
      bytes = bytes.subarray(n);
    }
    c.queue.push(bytes);
    c.queued += bytes.length;
    if (c.queued > limit) drop(s, `more than ${limit} bytes unsent`);
  };
  const flush = (s: Bun.Socket<Conn>) => {
    const c = s.data;
    while (c.queue.length) {
      const head = c.queue[0],
        n = s.write(head);
      if (n < 0) return drop(s, "gone");
      c.queued -= Math.max(0, n);
      if (n < head.length) {
        c.queue[0] = head.subarray(n);
        return;
      }
      c.queue.shift();
    }
    if (c.ending) s.end();
  };
  /** One answer, then the connection ends once it is out. */
  const answer = (s: Bun.Socket<Conn>, a: Answer) => {
    s.data.ending = true;
    send(s, line(a));
    if (conns.has(s) && !s.data.queue.length) s.end();
  };
  const refuse = (s: Bun.Socket<Conn>, err: Err) => {
    opts.log?.(`control: refused: ${err}`);
    answer(s, { ok: false, state: current(), err });
  };
  /** Mute or unmute as `m` does; a change of the setting gets its history row. */
  const mute = (s: Bun.Socket<Conn>, muted: boolean) => {
    const before = session.muted;
    // The session decides, as for `m`: an unmute it does not take (voice
    // cannot listen) leaves the window MUTED, and is refused here.
    session.setMuted(muted);
    if (!muted && shownMuted(session)) return refuse(s, "cannot_listen");
    if (session.muted !== before) {
      const row = muted ? "muted from outside" : "unmuted from outside";
      opts.log?.(`control: ${row}`);
      session.note(row);
    }
    answer(s, { ok: true, state: current() });
  };
  const request = (s: Bun.Socket<Conn>, text: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return refuse(s, "bad_json");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return refuse(s, "bad_json");
    const op = (parsed as { op?: unknown }).op;
    switch (typeof op === "string" && (ops as readonly string[]).includes(op) ? (op as Op) : null) {
      case "status":
        return answer(s, { ok: true, state: current() });
      case "mute":
        return mute(s, true);
      case "unmute":
        return mute(s, false);
      case "toggle":
        // What the window shows decides: MUTED, also while voice cannot listen, means unmute.
        return mute(s, current().mode !== "muted");
      case "watch": {
        // The state first: a change it finds goes to the other watchers,
        // and this one gets it once, as its first line.
        const state = current();
        watchers.add(s);
        return send(s, line({ ok: true, state }));
      }
      default:
        return refuse(s, "unknown_op");
    }
  };
  const received = (s: Bun.Socket<Conn>, chunk: Uint8Array) => {
    const c = s.data;
    if (c.done) return;
    const input = new Uint8Array(c.input.length + chunk.length);
    input.set(c.input);
    input.set(chunk, c.input.length);
    const end = input.indexOf(10);
    if (end < 0 ? input.length > max_line : end > max_line) {
      finished(c);
      return refuse(s, "too_long");
    }
    if (end < 0) {
      c.input = input;
      return;
    }
    finished(c);
    request(s, decoder.decode(input.subarray(0, end)));
  };
  const finished = (c: Conn) => {
    c.done = true;
    c.input = new Uint8Array(0);
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
  };

  const handlers: Bun.SocketHandler<Conn> = {
    open(s) {
      s.data = {
        input: new Uint8Array(0),
        done: false,
        queue: [],
        queued: 0,
        ending: false,
        timer: null,
      };
      if (closed) return void s.terminate();
      conns.add(s);
      s.data.timer = setTimeout(() => {
        if (!s.data.done) drop(s, `no request within ${idle} ms`);
      }, idle);
    },
    data(s, chunk) {
      try {
        received(s, chunk);
      } catch (error) {
        // Whatever a client sends, the window goes on.
        drop(s, `request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    drain(s) {
      flush(s);
    },
    close(s) {
      forget(s);
    },
    error(s) {
      forget(s);
    },
  };

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  removeSocket(path);
  // Created 0600 from the start: a socket is checked at connect time only,
  // so one made looser and tightened after would let others in meanwhile.
  const umask = process.umask(0o177);
  let server: Bun.TCPSocketListener<Conn> | Bun.UnixSocketListener<Conn>;
  try {
    server = Bun.listen<Conn>({ unix: path, socket: handlers });
  } finally {
    process.umask(umask);
  }
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    // Not left listening where nothing would close it.
    try {
      server.stop(true);
    } catch {}
    removeSocket(path);
    throw error;
  }
  // Every change the window can show reaches the watchers, once each, and
  // `updated_at` says when it happened, watched or not. Whatever goes wrong
  // with a watcher stays out of the session's own work.
  const changed = () => {
    if (closed) return;
    try {
      current();
    } catch (error) {
      opts.log?.(`control: update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  session.on("change", changed);
  recorder.on("change", changed);
  opts.log?.(`control: listening on ${path}`);
  return {
    close() {
      if (closed) return;
      closed = true;
      // Watchers see the end and stop; one-shot clients lose nothing they waited for.
      for (const s of conns) {
        forget(s);
        try {
          s.end();
        } catch {}
      }
      try {
        server.stop(true);
      } catch {}
      removeSocket(path);
    },
  };
}
/** Removes the socket file; one already gone is fine. */
function removeSocket(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
