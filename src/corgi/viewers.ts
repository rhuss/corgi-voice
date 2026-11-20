//! Viewer data from `corgi list --json` and the choice of target (FR-006):
//! pure functions, so the rules can be tested without Corgi.
import { spaced } from "../util/text";

export type MachineState = "ok" | "unreachable" | "not-understood";
export type Viewer = {
  id: number;
  /** The focused pane; null while the viewer does not show this machine. */
  pane: number | null;
  workspace: number | null;
  /** Grows with the viewer's input; per machine, never compared across machines. */
  active: number;
  /** The viewer's terminal window has OS focus. */
  watched: boolean;
};
export type PaneInfo = { id: number; label: string; exited: boolean; dormant: boolean };
export type Machine = {
  name: string;
  state: MachineState;
  /** Why the latest poll failed, when it did. */
  error: string | null;
  /** When the latest successful poll finished (ms); 0 before the first. */
  fetchedAt: number;
  viewers: Viewer[];
  panes: Map<number, PaneInfo>;
};
export type Target = {
  machine: string;
  viewer: number;
  pane: number;
  /** The viewer's `active` in the poll that chose it. */
  active: number;
  label: string;
  /** The pane has exited or is hibernated: it takes no text. */
  gone: boolean;
};
/** Why there is no target, as the code tells the cases apart; `reason` is
 * the same in words, for the window and the history. "unreachable" covers
 * Corgi as a whole and the one machine a viewer shows. */
export type Why = "no_viewer" | "unreachable" | "not_understood";
export type Resolution = { target: Target; reason: null; why: null } | { target: null; reason: string; why: Why };
export type Parsed = { ok: true; viewers: Viewer[]; panes: Map<number, PaneInfo> } | { ok: false; reason: "not-understood" };

/** How old a machine's data may be and still choose a target. */
export const fresh_ms = 2000;
export const not_understood = "Corgi output not understood";
export const no_viewer = "no viewer attached";

const object = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const number = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** An id as Corgi gives them: a whole number, not negative. */
const id = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);

/** The viewers and panes in a parsed `list --json` reply, or in one
 * machine's entry of `list --all-machines --json`. Unknown fields are
 * ignored; a reply without a `viewers` array, or with a viewer lacking a
 * whole-number `id` or a numeric `active`, is not understood: dictation holds
 * off rather than guess which viewer the user works in. */
export function parseReply(data: unknown): Parsed {
  const reply = object(data);
  const viewers = reply && Array.isArray(reply.viewers) ? viewersOf(reply.viewers) : null;
  if (!reply || !viewers) return { ok: false, reason: "not-understood" };
  return { ok: true, viewers, panes: panesOf(object(reply.result)?.panes) };
}
/** The viewers of one machine's entry, as `parseReply` reads them, or null
 * when one lacks a required field. A pane that is not an id reads as none. */
export function viewersOf(list: unknown[]): Viewer[] | null {
  const viewers: Viewer[] = [];
  for (const item of list) {
    const v = object(item);
    const vid = id(v?.id),
      active = number(v?.active);
    if (!v || vid === null || active === null) return null;
    viewers.push({ id: vid, pane: id(v.pane), workspace: number(v.workspace), active, watched: v.watched === true });
  }
  return viewers;
}
/** The panes of `result.panes`, by id. */
export function panesOf(list: unknown): Map<number, PaneInfo> {
  const panes = new Map<number, PaneInfo>();
  if (!Array.isArray(list)) return panes;
  for (const item of list) {
    const p = object(item),
      pid = id(p?.id);
    if (!p || pid === null) continue;
    panes.set(pid, { id: pid, label: paneLabel(p), exited: p.exited === true, dormant: p.dormant === true });
  }
  return panes;
}
/** A pane's label: its `name`, else its agent (or command) and the last
 * segment of its `cwd`, else `pane <id>`. */
export function paneLabel(pane: Record<string, unknown>): string {
  if (typeof pane.name === "string" && pane.name.trim()) return spaced(pane.name.trim());
  // `agent` is an object in current Corgi (its `provider` names it), a name in older ones.
  const agent = object(pane.agent),
    who =
      (typeof pane.agent === "string" && pane.agent) ||
      (typeof agent?.provider === "string" && agent.provider) ||
      (typeof pane.command === "string" && pane.command) ||
      "";
  if (who) {
    const where = typeof pane.cwd === "string" ? (pane.cwd.split("/").filter(Boolean).at(-1) ?? "") : "";
    return spaced(where ? `${who} · ${where}` : who);
  }
  return `pane ${number(pane.id) ?? "?"}`;
}
/** Whether `m` may choose a target at `now`. */
export function isFresh(m: Machine, now: number): boolean {
  return m.state === "ok" && m.fetchedAt > 0 && now - m.fetchedAt <= fresh_ms;
}
/** Each fresh machine's candidate: its viewer with a focused pane and the
 * highest `active` (ties: lower id). */
function candidate(m: Machine): Viewer | null {
  let best: Viewer | null = null;
  for (const v of m.viewers)
    if (v.pane !== null && (!best || v.active > best.active || (v.active === best.active && v.id < best.id))) best = v;
  return best;
}
/**
 * The target among `machines` (in Corgi's listing order) at `now` (FR-006):
 * one candidate per fresh machine; then the only watched one; then the
 * machine of the `previous` successful delivery, then `local`, then the first
 * listed. `active` values of different machines are never compared.
 */
export function resolve(machines: Machine[], previous: string | null, now: number): Resolution {
  const found: { m: Machine; v: Viewer }[] = [];
  for (const m of machines) {
    if (!isFresh(m, now)) continue;
    const v = candidate(m);
    if (v) found.push({ m, v });
  }
  if (!found.length) return { target: null, ...whyNone(machines, now) };
  let pool = found;
  // Watched candidates win over the others; among several, or none, the tie-break goes on.
  if (pool.length > 1) {
    const watched = pool.filter(c => c.v.watched);
    if (watched.length) pool = watched;
  }
  const chosen =
    pool.length === 1
      ? pool[0]
      : (pool.find(c => c.m.name === previous) ?? pool.find(c => c.m.name === "local") ?? pool[0]);
  const { m, v } = chosen,
    pane = v.pane!,
    info = m.panes.get(pane);
  return {
    target: {
      machine: m.name,
      viewer: v.id,
      pane,
      active: v.active,
      label: info?.label ?? `pane ${pane}`,
      gone: !!info && (info.exited || info.dormant),
    },
    reason: null,
    why: null,
  };
}
/** Why there is no target: Corgi's output not understood; a machine that
 * stopped answering while a viewer seems to show it; no viewer; or Corgi
 * unreachable. */
function whyNone(machines: Machine[], now: number): { reason: string; why: Why } {
  const misread = { reason: not_understood, why: "not_understood" } as const,
    local = machines.find(m => m.name === "local");
  if (local?.state === "not-understood") return misread;
  const fresh = machines.filter(m => isFresh(m, now));
  if (fresh.length) {
    // A viewer without a focused pane on any machine that answers shows
    // another machine: one that stopped answering, when there is one.
    const elsewhere = fresh.some(m => m.viewers.some(v => v.pane === null)),
      down = machines.filter(m => !isFresh(m, now) && m.state !== "not-understood"),
      // The one whose last answer had a focused viewer is the likeliest.
      likely = down.find(m => m.viewers.some(v => v.pane !== null)) ?? down[0];
    if (elsewhere && likely)
      return { reason: `${likely.name} unreachable: ${likely.error ?? "no answer in time"}`, why: "unreachable" };
    return { reason: no_viewer, why: "no_viewer" };
  }
  if (machines.some(m => m.state === "not-understood")) return misread;
  const failed = (local?.state === "unreachable" ? local : null) ?? machines.find(m => m.error);
  return { reason: `Corgi unreachable: ${failed?.error ?? "no answer in time"}`, why: "unreachable" };
}
