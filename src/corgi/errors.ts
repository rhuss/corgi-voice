//! What a failed `corgi` call means for the history (FR-013). The patterns
//! are best effort; this table is the one place they live, and anything it
//! does not know shows as the first line of corgi's output.
import { ellipsis } from "../util/text";

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
function lines(output: string): string[] {
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
  return ellipsis(said[0].replace(/^corgi:\s*/, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " "), max_columns);
}
