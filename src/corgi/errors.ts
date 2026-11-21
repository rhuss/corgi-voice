//! What a failed `corgi` call means for the history (FR-013). The patterns
//! are best effort; this table is the one place they live, and anything it
//! does not know shows as the first line of corgi's output.
import { ellipsis, spaced } from "../util/text";

/** corgi's error names (after the `corgi: ` prefix) and what each means. */
export const mapping: Record<string, "pane gone" | "unreachable"> = {
  NoPane: "pane gone",
  PaneExited: "pane gone",
  NoSuchPane: "pane gone",
  UnknownMachine: "unreachable",
  RequestTimedOut: "unreachable",
  ConnectionRefused: "unreachable",
  NoRuntime: "unreachable",
};
/** Lines from ssh, which corgi uses to reach a remote machine: the machine is unreachable. */
export const ssh_patterns: RegExp[] = [
  /^ssh:/,
  /Permission denied \(/,
  /Could not resolve hostname/,
  /Connection (refused|timed out|closed by)/,
  /Host key verification failed/,
  /sign_and_send_pubkey/,
];
/** What a failed `list --json` says about the `corgi` command (FR-008, FR-010):
 * Corgi is not running, did not answer in time, or this build of `corgi`
 * cannot talk to the Corgi that runs. */
export type Reach = "not_running" | "no_answer" | "mismatch";
/** The patterns of each class. Setup counts anything none of them matches as
 * a mismatch; the window hints only on the explicit `mismatch` ones, so a
 * passing error never sends the user to voice.json. */
export const reach_patterns: Record<Reach, RegExp[]> = {
  not_running: [/\bNoRuntime\b/, /\bConnectionRefused\b/, /\bECONNREFUSED\b/],
  no_answer: [/\bRequestTimedOut\b/],
  mismatch: [/JSON Parse error/, /\bunknown command\b/, /\bUnexpected\b/],
};
/** The class of the error `text` of a `list --json` call; unmatched text is
 * a mismatch. A call our own bound ended is no answer, decided by the caller. */
export function classify(text: string): Reach {
  for (const kind of ["not_running", "no_answer"] as const)
    if (reach_patterns[kind].some(p => p.test(text))) return kind;
  return "mismatch";
}
/** Whether `reason` names one of the explicit mismatch patterns. */
export function isMismatch(reason: string): boolean {
  return reach_patterns.mismatch.some(p => p.test(reason));
}
/** The JSON object in `text` from its first `{`, past any notice before it, or null. */
export function jsonFrom(text: string): unknown {
  const at = text.indexOf("{");
  if (at < 0) return null;
  try {
    return JSON.parse(text.slice(at));
  } catch {
    return null;
  }
}
/** The `err` of a reply with `ok: false`, if that is what `reply` is. */
export function refused(reply: unknown): string | null {
  const r = reply && typeof reply === "object" ? (reply as Record<string, unknown>) : null;
  return r && r.ok === false && typeof r.err === "string" ? r.err : null;
}
/** The `err` of an `{"ok":false}` reply a failed call printed, on standard
 * output or, as older corgi releases do, on standard error; null when neither
 * holds one. */
export function refusal(stdout: string, stderr: string): string | null {
  return refused(jsonFrom(stdout)) ?? refused(jsonFrom(stderr));
}
/** A delivery abandoned at its bound: the text may have arrived. */
export const no_answer = "no answer in time; may have been typed";
/** The longest reason taken from corgi's own output, in columns. */
const max_columns = 60;
/** The notice corgi prints before anything about remote machines. */
const notice = /^Remote machines are experimental/;

/** The corgi command could not be started. */
export function notFound(cmd: string): string {
  return `corgi not found: ${cmd}`;
}
/** The lines corgi printed, without its experimental notice and blank lines. */
export function lines(output: string): string[] {
  return output
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !notice.test(l));
}
/** The short reason for a failed call on `machine` from its error output and exit code. */
export function reasonFor(stderr: string, machine: string, code: number | null = 1): string {
  const said = lines(stderr);
  for (const line of said) {
    if (ssh_patterns.some(p => p.test(line))) return `${machine} unreachable`;
    const name = line.replace(/^corgi:\s*/, "").split(/[\s:;,.]/)[0];
    const meaning = Object.hasOwn(mapping, name) ? mapping[name] : undefined;
    if (meaning === "pane gone") return "pane gone";
    if (meaning === "unreachable") return `${machine} unreachable`;
  }
  return firstLine(stderr, code);
}
/** The first line of a failed `list` or `machine list` call, for the window's "Corgi unreachable: …". */
export function firstLine(stderr: string, code: number | null): string {
  const said = lines(stderr);
  if (!said.length) return code === null ? "corgi exited with a signal" : `corgi exited with code ${code}`;
  return ellipsis(spaced(said[0].replace(/^corgi:\s*/, "")), max_columns);
}
