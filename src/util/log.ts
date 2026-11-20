//! The verbose log: `corgi-voice --verbose` appends JSON lines to its own
//! file (the screen is the window, so nothing goes to stderr). Without
//! `configure`, every logger is a no-op.
import { appendFileSync } from "node:fs";

export type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;
const levels: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
let minimum: Level | null = null,
  sink: (line: string) => void = () => {};

/** Logs to `file` (append only, mode 0600) when `verbose`; otherwise turns logging off. */
export function configure(opts: { file: string | null; verbose: boolean; level?: Level }): void {
  minimum = null;
  sink = () => {};
  if (!opts.verbose || !opts.file) return;
  const file = opts.file;
  minimum = opts.level ?? "info";
  sink = line => void appendFileSync(file, line, { mode: 0o600 });
}

function stringify(value: unknown): string {
  const ancestors: object[] = [],
    errors = new WeakMap<Error, object>();
  return JSON.stringify(value, function (_key, value: unknown) {
    if (typeof value === "bigint") return JSON.rawJSON(String(value));
    if (value instanceof Error) {
      let fields = errors.get(value);
      if (!fields) {
        fields = { ...value, name: value.name, message: value.message, stack: value.stack, cause: value.cause };
        errors.set(value, fields);
      }
      value = fields;
    }
    if (value !== null && typeof value === "object") {
      while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
      if (ancestors.includes(value)) return "[Circular]";
      ancestors.push(value);
    }
    return value;
  });
}

export type Logger = ReturnType<typeof getLogger>;

export function getLogger(scope: string) {
  const write = (level: Level, message: string, fields?: Fields) => {
    if (minimum === null || levels[level] < levels[minimum]) return;
    let line: string;
    try {
      line = stringify({ ...fields, at: Date.now(), message });
    } catch {
      line = stringify({ at: Date.now(), message, logging_error: "Could not serialize fields" });
    }
    try {
      sink(`${level}(${scope}): ${line}\n`);
    } catch {
      // Logging must not interrupt the operation it describes.
    }
  };
  return {
    debug: (message: string, fields?: Fields) => write("debug", message, fields),
    info: (message: string, fields?: Fields) => write("info", message, fields),
    warn: (message: string, fields?: Fields) => write("warn", message, fields),
    error: (message: string, fields?: Fields) => write("error", message, fields),
  };
}
