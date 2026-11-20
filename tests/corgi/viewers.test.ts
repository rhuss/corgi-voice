import { test, expect } from "bun:test";
import { parseReply, paneLabel, resolve, type Machine } from "../../src/corgi/viewers";
import { jsonFrom } from "../../src/corgi/poller";

/** A `list --json` reply read as the poller reads it. */
const readList = (text: string) => parseReply(jsonFrom(text));

const observed =
  '{"ok":true,"result":{"panes":[{"id":207,"name":"","agent":"claude","command":"claude","cwd":"/path/cc-rosa-rhoai","dormant":false,"exited":false}]},' +
  '"viewers":[{"id":4,"pid":0,"active":10720,"workspace":20,"pane":207,"watched":false}]}';

test("parses the observed list --json reply", () => {
  const parsed = readList(observed);
  if (!parsed.ok) throw Error("not parsed");
  expect(parsed.viewers).toEqual([{ id: 4, pane: 207, workspace: 20, active: 10720, watched: false }]);
  expect(parsed.panes.get(207)).toEqual({ id: 207, label: "claude · cc-rosa-rhoai", exited: false, dormant: false });
});

test("invalid, truncated or non-object JSON is not understood", () => {
  for (const text of ["", "{", observed.slice(0, 60), "[]", "null", "42", '"x"'])
    expect(readList(text)).toEqual({ ok: false, reason: "not-understood" });
});

test("a reply without a viewers array is not understood", () => {
  expect(readList('{"ok":true,"result":{"panes":[]}}')).toEqual({ ok: false, reason: "not-understood" });
  expect(readList('{"ok":true,"viewers":{}}')).toEqual({ ok: false, reason: "not-understood" });
  // An empty list is fine.
  const empty = readList('{"ok":true,"result":{"panes":[]},"viewers":[]}');
  expect(empty.ok && empty.viewers).toEqual([]);
});

test("unknown fields are ignored", () => {
  const parsed = readList(
    JSON.stringify({
      ok: true,
      future: { x: 1 },
      result: { panes: [{ id: 1, name: "n", extra: [1, 2] }], more: true },
      viewers: [{ id: 1, active: 3, pane: 1, watched: true, workspace: 2, color: "red" }],
    }),
  );
  if (!parsed.ok) throw Error("not parsed");
  expect(parsed.viewers).toEqual([{ id: 1, pane: 1, workspace: 2, active: 3, watched: true }]);
  expect(parsed.panes.get(1)?.label).toBe("n");
});

test("a viewer missing a required field makes the reply not understood, rather than dropped", () => {
  const good = { id: 5, active: 9, pane: 1 };
  for (const bad of [{ active: 3, pane: 1 }, { id: 2, pane: 1 }, { id: 3, active: "9", pane: 1 }, { id: "4", active: 9, pane: 1 }, { id: -1, active: 9, pane: 1 }, { id: 1.5, active: 9, pane: 1 }, null, 7])
    expect(readList(JSON.stringify({ viewers: [good, bad] }))).toEqual({ ok: false, reason: "not-understood" });
  const parsed = readList(JSON.stringify({ viewers: [good] }));
  if (!parsed.ok) throw Error("not parsed");
  expect(parsed.viewers.map(v => v.id)).toEqual([5]);
  // A pane that is no id reads as none.
  const odd = readList(JSON.stringify({ viewers: [{ id: 1, active: 1, pane: -3 }] }));
  if (!odd.ok) throw Error("not parsed");
  expect(odd.viewers[0].pane).toBeNull();
});

test("a viewer's pane, workspace and watched default when missing or mistyped", () => {
  const parsed = readList(JSON.stringify({ viewers: [{ id: 1, active: 1, pane: "x", workspace: null }] }));
  if (!parsed.ok) throw Error("not parsed");
  expect(parsed.viewers[0]).toEqual({ id: 1, pane: null, workspace: null, active: 1, watched: false });
});

test("pane label: name, else agent or command with the cwd's last segment, else pane id", () => {
  expect(paneLabel({ id: 1, name: "api", agent: "claude", cwd: "/a/b" })).toBe("api");
  expect(paneLabel({ id: 1, name: "", agent: "claude", command: "node", cwd: "/a/proj" })).toBe("claude · proj");
  expect(paneLabel({ id: 1, name: "", agent: null, command: "zsh", cwd: "/a/proj/" })).toBe("zsh · proj");
  expect(paneLabel({ id: 1, command: "cat" })).toBe("cat");
  // Current Corgi reports the agent as an object; its provider names it.
  expect(paneLabel({ id: 1, name: "", agent: { provider: "claude", name: "a title" }, command: "claude", cwd: "/w/api" })).toBe(
    "claude · api",
  );
  expect(paneLabel({ id: 9, name: "" })).toBe("pane 9");
  expect(paneLabel({ id: 9, cwd: "/x" })).toBe("pane 9");
  // Controls never reach the screen.
  expect(paneLabel({ id: 1, name: "a\x1b[2Jb" })).toBe("a [2Jb");
});

const now = 100_000;
function machine(name: string, viewers: Machine["viewers"], extra: Partial<Machine> = {}): Machine {
  return {
    name,
    state: "ok",
    error: null,
    fetchedAt: now - 100,
    viewers,
    panes: new Map(),
    ...extra,
  };
}
const v = (id: number, pane: number | null, active: number, watched = false) => ({
  id,
  pane,
  workspace: 1,
  active,
  watched,
});

test("step 1: per machine, the viewer with a focused pane and the highest active", () => {
  const r = resolve([machine("local", [v(1, 10, 50), v(2, 20, 90), v(3, null, 999)])], null, now);
  expect(r.target).toMatchObject({ machine: "local", viewer: 2, pane: 20, active: 90 });
  // Ties go to the lower id.
  const tie = resolve([machine("local", [v(7, 70, 5), v(3, 30, 5)])], null, now);
  expect(tie.target).toMatchObject({ viewer: 3, pane: 30 });
});

test("the target carries the pane's label, else its id", () => {
  const m = machine("local", [v(1, 10, 1)]);
  expect(resolve([m], null, now).target?.label).toBe("pane 10");
  m.panes.set(10, { id: 10, label: "claude · api", exited: false, dormant: false });
  expect(resolve([m], null, now).target?.label).toBe("claude · api");
});

test("the target says when its pane has exited or is hibernated, and takes no text", () => {
  const m = machine("local", [v(1, 10, 1)]);
  // A pane the listing does not know is not known to be gone.
  expect(resolve([m], null, now).target?.gone).toBe(false);
  m.panes.set(10, { id: 10, label: "shell", exited: false, dormant: false });
  expect(resolve([m], null, now).target?.gone).toBe(false);
  m.panes.set(10, { id: 10, label: "shell", exited: true, dormant: false });
  expect(resolve([m], null, now).target?.gone).toBe(true);
  m.panes.set(10, { id: 10, label: "shell", exited: false, dormant: true });
  expect(resolve([m], null, now).target?.gone).toBe(true);
});

test("step 2: no candidate says why, in words and as a cause", () => {
  expect(resolve([machine("local", [v(1, null, 5)])], null, now)).toEqual({
    target: null,
    reason: "no viewer attached",
    why: "no_viewer",
  });
  expect(resolve([machine("local", [])], null, now).reason).toBe("no viewer attached");
  expect(
    resolve([machine("local", [], { state: "unreachable", error: "daemon not running", fetchedAt: 0 })], null, now),
  ).toEqual({ target: null, reason: "Corgi unreachable: daemon not running", why: "unreachable" });
  expect(
    resolve([machine("local", [], { state: "not-understood", error: "Corgi output not understood" })], null, now),
  ).toEqual({ target: null, reason: "Corgi output not understood", why: "not_understood" });
  // A remote machine alone that is not understood, with no local answer.
  expect(
    resolve([machine("marovo", [], { state: "not-understood", error: "Corgi output not understood" })], null, now).why,
  ).toBe("not_understood");
  expect(resolve([], null, now).reason).toStartWith("Corgi unreachable");
  expect(resolve([], null, now).why).toBe("unreachable");
  // With a target there is neither.
  expect(resolve([machine("local", [v(1, 10, 5)])], null, now)).toMatchObject({ reason: null, why: null });
});

test("step 3 and 4: one candidate, else the only watched one", () => {
  const local = machine("local", [v(1, 10, 1000)]),
    remote = machine("marovo", [v(4, 40, 2, true)]);
  expect(resolve([local], null, now).target?.machine).toBe("local");
  expect(resolve([local, remote], null, now).target).toMatchObject({ machine: "marovo", pane: 40 });
});

test("watched is judged on each machine's candidate only", () => {
  // marovo's watched viewer has no pane; its candidate (viewer 5) is not watched.
  const local = machine("local", [v(1, 10, 1)]),
    remote = machine("marovo", [v(4, null, 900, true), v(5, 50, 2)]);
  expect(resolve([local, remote], null, now).target?.machine).toBe("local");
});

test("step 5: all or none watched, then previous, then local, then listing order", () => {
  const local = machine("local", [v(1, 10, 1)]),
    a = machine("a", [v(2, 20, 1)]),
    b = machine("b", [v(3, 30, 1)]);
  expect(resolve([local, a, b], "b", now).target?.machine).toBe("b");
  expect(resolve([local, a, b], null, now).target?.machine).toBe("local");
  expect(resolve([a, b], null, now).target?.machine).toBe("a");
  expect(resolve([b, a], "gone", now).target?.machine).toBe("b");
  const watchedA = machine("a", [v(2, 20, 1, true)]),
    watchedB = machine("b", [v(3, 30, 1, true)]);
  expect(resolve([local, watchedA, watchedB], null, now).target?.machine).toBe("a");
  expect(resolve([local, watchedA, watchedB], "b", now).target?.machine).toBe("b");
});

test("active values from different machines are never compared", () => {
  // marovo's huge counter does not beat local's small one.
  const local = machine("local", [v(1, 10, 3)]),
    remote = machine("marovo", [v(2, 20, 1_000_000)]);
  expect(resolve([local, remote], null, now).target?.machine).toBe("local");
  expect(resolve([remote, local], null, now).target?.machine).toBe("local");
  expect(resolve([remote, machine("other", [v(2, 20, 1)])], null, now).target?.machine).toBe("marovo");
});

test("a machine whose data is older than 2000 ms is not a candidate", () => {
  const local = machine("local", [v(1, 10, 1)], { fetchedAt: now - 2001 }),
    remote = machine("marovo", [v(2, 20, 1)], { fetchedAt: now - 2000 });
  expect(resolve([local, remote], "local", now).target?.machine).toBe("marovo");
  expect(resolve([local], null, now).target).toBeNull();
  expect(resolve([local], null, now).reason).toStartWith("Corgi unreachable");
});

test("a machine that is not ok is not a candidate even with recent data", () => {
  const local = machine("local", [v(1, 10, 1)], { state: "unreachable", error: "x" }),
    remote = machine("marovo", [v(2, 20, 1)]);
  expect(resolve([local, remote], null, now).target?.machine).toBe("marovo");
});

test("a viewer showing a machine that stopped answering names that machine", () => {
  // The local daemon reports the viewer without a pane: it shows another machine.
  const local = machine("local", [v(1, null, 5)]),
    marovo = machine("marovo", [v(4, 40, 2)], { state: "unreachable", error: "RequestTimedOut", fetchedAt: now - 5000 });
  expect(resolve([local, marovo], null, now)).toEqual({
    target: null,
    reason: "marovo unreachable: RequestTimedOut",
    why: "unreachable",
  });
  // With no viewer at all, nobody is looking at marovo.
  expect(resolve([machine("local", []), marovo], null, now)).toMatchObject({
    reason: "no viewer attached",
    why: "no_viewer",
  });
  // With every machine answering, a viewer without a pane is just not attached to any.
  expect(resolve([local, machine("marovo", [v(4, null, 2)])], null, now).reason).toBe("no viewer attached");
});
