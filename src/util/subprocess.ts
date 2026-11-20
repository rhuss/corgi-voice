//! Short-lived helper processes on `Bun.spawn`, each bounded: a call that
//! runs past its bound (or is aborted) gets SIGTERM, then SIGKILL 200 ms
//! later, and `run` settles only after the process has exited.

export type Result = {
  /** Exit code, or null when a signal ended the process. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The bound ran out (or `signal` aborted) and the process was killed. */
  timedOut: boolean;
};
export type Options = {
  /** Written to the process's stdin, which is then closed. Without it stdin is closed at once. */
  stdin?: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Aborting kills the process as a timeout does. */
  signal?: AbortSignal;
};

const kill_grace_ms = 200;

/** A spawn failure by name, such as `FileNotFound` for a missing program. */
export function spawnError(error: any): Error {
  const name = (
    {
      ENOENT: "FileNotFound",
      ENOTDIR: "NotDir",
      EACCES: "AccessDenied",
      EPERM: "AccessDenied",
      ENOEXEC: "InvalidExe",
      E2BIG: "SystemResources",
      EMFILE: "ProcessFdQuotaExceeded",
      ENFILE: "SystemFdQuotaExceeded",
    } as Record<string, string>
  )[error?.code];
  return name ? Error(name) : error;
}

/** Reads `stream` as it comes, so what arrived is there even when the read is cut short. */
function collect(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder(),
    reader = stream.getReader();
  let text = "";
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {}
  })();
  return {
    done,
    text: () => text,
    cancel: () => void reader.cancel().catch(() => {}),
  };
}

/** Runs `argv` to completion within `timeoutMs`. Throws `spawnError(...)`
 * when the program cannot start (`FileNotFound` for a missing one). */
export async function run(argv: string[], opts: Options): Promise<Result> {
  if (opts.signal?.aborted) return { code: null, stdout: "", stderr: "", timedOut: true };
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  try {
    child = Bun.spawn(argv, {
      env: (opts.env ?? process.env) as Record<string, string>,
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw spawnError(error);
  }
  let timedOut = false,
    exited = false,
    grace: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    // A process that already exited finished in time, whatever its pipes do.
    if (timedOut || exited) return;
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {}
    grace = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, kill_grace_ms);
  };
  // The bound and the abort hold from the spawn on, so a child that never
  // reads its input (or an abort while it is written) cannot outlive them.
  const timer = setTimeout(stop, opts.timeoutMs);
  opts.signal?.addEventListener("abort", stop, { once: true });
  if (opts.signal?.aborted) stop();
  const stdout = collect(child.stdout),
    stderr = collect(child.stderr);
  try {
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    await Promise.race([child.stdin.end(), child.exited]);
  } catch {
    // The process may have exited before reading its input.
  }
  try {
    const code = await child.exited;
    exited = true;
    clearTimeout(timer);
    // A grandchild can keep the pipes open after the process itself is
    // gone; its output is not waited for past a short drain.
    const drain = timedOut ? 50 : 300;
    await Promise.race([Promise.all([stdout.done, stderr.done]), Bun.sleep(drain)]);
    stdout.cancel();
    stderr.cancel();
    return { code: child.signalCode ? null : code, stdout: stdout.text(), stderr: stderr.text(), timedOut };
  } finally {
    clearTimeout(timer);
    clearTimeout(grace);
    opts.signal?.removeEventListener("abort", stop);
  }
}
