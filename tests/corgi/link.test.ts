import { test, expect, afterEach } from "bun:test";
import { chmodSync, rmSync } from "node:fs";
import { CorgiLink, type CorgiLinkOptions } from "../../src/corgi/link";
import type { Poller } from "../../src/corgi/poller";
import { deadline_ms, type Seen } from "../../src/voice/link";
import { fakeCorgi, listReply, machineList, type FakeCorgi, type Scenario } from "../fixtures/corgi";

const fakes: FakeCorgi[] = [],
  links: CorgiLink[] = [];
afterEach(() => {
  for (const l of links.splice(0)) l.close();
  for (const f of fakes.splice(0)) f.cleanup();
});
/** One local viewer focused on pane 5, `active` 10, with pane 5 a plain shell. */
const one: Scenario = {
  machines: { local: listReply([{ id: 1, pane: 5, active: 10 }], [{ id: 5, name: "shell" }]) },
};
function make(scenario: Scenario = one, opts: Partial<CorgiLinkOptions> = {}) {
  const fake = fakeCorgi(scenario),
    link = new CorgiLink({ cmd: fake.cmd, intervalMs: 100, boundMs: 4000, ...opts });
  fakes.push(fake);
  links.push(link);
  return { fake, link };
}
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  expect(check()).toBe(true);
}
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    return (error as Error).message;
  }
  throw Error("expected a rejection");
}

test("watch resolves with the first view of the target", async () => {
  const { link } = make();
  expect(await link.watch()).toEqual({ viewer: true, focus: "shell", machine: "local", reason: null, why: null, source: null });
});

test("the delivery bound is 2000 ms unless a test shortens it (FR-012)", () => {
  expect(deadline_ms).toBe(2000);
});

test("a delivery types the text with pane send --stdin, no trailing newline, never --enter", async () => {
  const { link, fake } = make();
  await link.watch();
  expect(await link.type("hello world")).toEqual({ machine: "local", pane: 5, viewer: 1 });
  const [send] = fake.sends();
  expect(send.argv).toEqual(["pane", "send", "5", "--stdin"]);
  expect(send.stdin).toBe("hello world");
});

test("50 deliveries never pass --enter and never end stdin in a newline", async () => {
  const { link, fake } = make();
  await link.watch();
  for (let i = 0; i < 50; i++) await link.type(`utterance ${i}`);
  const sends = fake.sends();
  expect(sends).toHaveLength(50);
  for (const s of sends) {
    expect(s.argv).not.toContain("--enter");
    expect(s.argv.slice(-1)).toEqual(["--stdin"]);
    expect(s.stdin.endsWith("\n")).toBe(false);
  }
  expect(fake.calls().some(c => c.argv.includes("--enter"))).toBe(false);
}, 30_000);

test("a leading space joins deliveries to the same pane while the viewer's active is unchanged", async () => {
  const { link, fake } = make();
  await link.watch();
  await link.type("first");
  await link.type("second");
  expect(fake.sends().map(s => s.stdin)).toEqual(["first", " second"]);
  // The user typed in the viewer: active moved, so no space.
  fake.set({ machines: { local: listReply([{ id: 1, pane: 5, active: 11 }], [{ id: 5, name: "shell" }]) } });
  await Bun.sleep(400);
  await link.type("third");
  await link.type("fourth");
  expect(fake.sends().map(s => s.stdin)).toEqual(["first", " second", "third", " fourth"]);
  // Another pane: no space.
  fake.set({ machines: { local: listReply([{ id: 1, pane: 6, active: 11 }], [{ id: 6, name: "other" }]) } });
  await Bun.sleep(400);
  await link.type("fifth");
  expect(fake.sends().at(-1)!.stdin).toBe("fifth");
});

test("failed and abandoned deliveries do not count for the leading space", async () => {
  const { link, fake } = make({ ...one, send: { "local:5": { code: 1, stderr: "corgi: Weird\n" } } });
  await link.watch();
  expect(await rejection(link.type("lost"))).toBe("Weird");
  fake.set(one);
  // A failed delivery is no previous delivery: no space.
  await link.type("kept");
  expect(fake.sends().at(-1)!.stdin).toBe("kept");
  fake.set({ ...one, send: { "local:5": { delayMs: 5000 } } });
  expect(await rejection(link.type("slow"))).toBe("Timeout");
  fake.set({ ...one, send: { "local:5": { code: 1, stderr: "corgi: Weird\n" } } });
  expect(await rejection(link.type("odd"))).toBe("Weird");
  fake.set(one);
  await link.type("after");
  // The last successful delivery, "kept", went to this pane with active
  // unchanged; the abandoned and failed ones after it do not count, so each
  // later delivery still joins "kept" with a space.
  expect(fake.sends().map(s => s.stdin)).toEqual(["lost", "kept", " slow", " odd", " after"]);
}, 15_000);

test("a delivery with no answer is abandoned at 2 s, killed, and the next waits for it", async () => {
  const { link, fake } = make({ ...one, send: { "local:5": { delayMs: 5000 } } });
  await link.watch();
  const started = Date.now();
  const first = rejection(link.type("stuck"));
  const second = link.type("next").catch(error => error);
  expect(await first).toBe("Timeout");
  const rejectedAt = Date.now();
  const abandoned = Date.now() - started;
  expect(abandoned).toBeGreaterThanOrEqual(1950);
  expect(abandoned).toBeLessThan(2400);
  fake.set(one);
  await second;
  const sends = fake.sends();
  expect(sends.map(s => s.stdin)).toEqual(["stuck", "next"]);
  // The second started only after the first was abandoned, and long before the
  // stuck one would have answered.
  expect(sends[1].at).toBeGreaterThanOrEqual(rejectedAt - 50);
  expect(sends[1].at - sends[0].at).toBeLessThan(3500);
  // The stuck process is gone, not just no longer waited for (FR-012).
  expect(() => process.kill(sends[0].pid, 0)).toThrow();
}, 15_000);

test("deliveries run strictly one at a time in order", async () => {
  const { link, fake } = make({ ...one, send: { "local:5": { delayMs: 150 } } });
  await link.watch();
  await Promise.all(["a", "b", "c", "d"].map(t => link.type(t)));
  const sends = fake.sends();
  expect(sends.map(s => s.stdin)).toEqual(["a", " b", " c", " d"]);
  for (let i = 1; i < sends.length; i++) expect(sends[i].at - sends[i - 1].at).toBeGreaterThanOrEqual(150);
});

test("only stale viewer data at delivery: no pane send, NoViewer", async () => {
  let offset = 0;
  const { link, fake } = make(one, { now: () => Date.now() + offset });
  await link.watch();
  // Corgi stops answering; what was fetched ages past 2 s.
  fake.set({ machines: { local: { ...one.machines!.local, delayMs: 10_000 } } });
  await Bun.sleep(400);
  offset = 3000;
  expect(await rejection(link.type("too late"))).toBe("NoViewer");
  expect(fake.sends()).toEqual([]);
});

test("no viewer at delivery: no pane send, NoViewer", async () => {
  const { link, fake } = make({ machines: { local: listReply([{ id: 1, pane: null, active: 1 }]) } });
  expect((await link.watch()).viewer).toBe(false);
  expect(await rejection(link.type("nobody"))).toBe("NoViewer");
  expect(fake.sends()).toEqual([]);
});

test("the voice's own pane is never typed into", async () => {
  const { link, fake } = make(one, { ownPane: 5 });
  await link.watch();
  expect(await rejection(link.type("echo"))).toBe("VoicePane");
  expect(fake.sends()).toEqual([]);
  // Another pane is fine.
  const other = make(one, { ownPane: 6 });
  await other.link.watch();
  await other.link.type("fine");
  expect(other.fake.sends()).toHaveLength(1);
});

test("an exited or dormant (hibernated) pane is gone, without calling pane send", async () => {
  const { link, fake } = make({
    machines: { local: listReply([{ id: 1, pane: 5, active: 1 }], [{ id: 5, exited: true }]) },
  });
  await link.watch();
  expect(await rejection(link.type("x"))).toBe("pane gone");
  fake.set({ machines: { local: listReply([{ id: 1, pane: 5, active: 1 }], [{ id: 5, dormant: true }]) } });
  await Bun.sleep(400);
  expect(await rejection(link.type("y"))).toBe("pane gone");
  expect(fake.sends()).toEqual([]);
});

test("pane send errors become short reasons", async () => {
  const { link, fake } = make({ ...one, send: { "local:5": { code: 2, stderr: "corgi: NoPane\n" } } });
  await link.watch();
  expect(await rejection(link.type("x"))).toBe("pane gone");
  fake.set({ ...one, send: { "local:5": { code: 4 } } });
  expect(await rejection(link.type("y"))).toBe("corgi exited with code 4");
});

test("a corgi that vanished after startup gives a readable reason", async () => {
  const { link, fake } = make();
  await link.watch();
  rmSync(fake.cmd);
  expect(await rejection(link.type("gone"))).toBe(`corgi not found: ${fake.cmd}`);
});

test("viewer events follow the target and its label", async () => {
  const { link, fake } = make();
  const seen: Seen[] = [];
  link.on("viewer", s => seen.push(s));
  await link.watch();
  fake.set({ machines: { local: listReply([{ id: 1, pane: 6, active: 10 }], [{ id: 6, name: "build" }]) } });
  await until(() => seen.at(-1)?.focus === "build");
  expect(seen.at(-1)).toEqual({ viewer: true, focus: "build", machine: "local", reason: null, why: null, source: null });
  fake.set({ machines: { local: listReply([{ id: 1, pane: null, active: 10 }]) } });
  await until(() => seen.at(-1)?.focus === null);
  expect(seen.at(-1)).toEqual({
    viewer: false,
    focus: null,
    machine: null,
    reason: "no viewer attached",
    why: "no_viewer",
    source: null,
  });
  // Each change is announced once.
  const count = seen.length;
  await Bun.sleep(300);
  expect(seen.length).toBe(count);
});

test("close stops polling", async () => {
  const { link, fake } = make();
  await link.watch();
  link.close();
  await Bun.sleep(150);
  const count = fake.calls().length;
  await Bun.sleep(300);
  expect(fake.calls().length).toBe(count);
});

/** A viewer on remote machine marovo, watched, focused on pane 70. */
const remote: Scenario = {
  machineList: machineList(["local", "marovo"]),
  machines: {
    local: listReply([{ id: 1, pane: 5, active: 10 }], [{ id: 5, name: "shell" }]),
    marovo: listReply([{ id: 3, pane: 70, active: 4, watched: true }], [{ id: 70, name: "agent" }]),
  },
};
async function onMarovo(link: CorgiLink) {
  await link.watch();
  await until(() => link.poller.resolve().target?.machine === "marovo");
}

test("a remote target is typed with --machine, and the window names the machine", async () => {
  const { link, fake } = make(remote);
  const seen: Seen[] = [];
  link.on("viewer", s => seen.push(s));
  await onMarovo(link);
  expect(seen.at(-1)).toEqual({ viewer: true, focus: "agent", machine: "marovo", reason: null, why: null, source: null });
  expect(await link.type("remote words")).toEqual({ machine: "marovo", pane: 70, viewer: 3 });
  const [send] = fake.sends();
  expect(send.argv).toEqual(["--machine", "marovo", "pane", "send", "70", "--stdin"]);
  expect(send.stdin).toBe("remote words");
  // Only the text crossed: no other call was given anything on stdin.
  expect(fake.calls().map(c => c.stdin).join("")).toBe("remote words");
});

test("the machine of the last delivery breaks a later tie between machines", async () => {
  const { link, fake } = make(remote);
  await onMarovo(link);
  await link.type("remote words");
  // marovo's viewer is no longer watched: two candidates, neither watched.
  fake.set({
    ...remote,
    machines: {
      ...remote.machines,
      marovo: listReply([{ id: 3, pane: 70, active: 4 }], [{ id: 70, name: "agent" }]),
    },
  });
  const marovo = () => link.poller.machines.find(m => m.name === "marovo");
  await until(() => marovo()?.viewers[0]?.watched === false);
  // Without a delivery there, the local machine would win.
  expect(link.poller.resolve().target?.machine).toBe("marovo");
});

test("an unreachable remote machine fails the row naming it, and the next one is tried normally", async () => {
  const { link, fake } = make({
    ...remote,
    send: { "marovo:70": { code: 1, stderr: "Remote machines are experimental; bug reports are appreciated.\ncorgi: RequestTimedOut\n" } },
  });
  await onMarovo(link);
  expect(await rejection(link.type("lost"))).toBe("marovo unreachable");
  fake.set({ ...remote, send: { "marovo:70": { code: 255, stderr: "ssh: connect to host marovo port 22: Connection refused\n" } } });
  expect(await rejection(link.type("again"))).toBe("marovo unreachable");
  fake.set(remote);
  await link.type("works");
  expect(fake.sends().map(s => s.stdin)).toEqual(["lost", "again", "works"]);
});

test("the voice's own pane is a local pane: the same id on a remote machine is typed into", async () => {
  const { link, fake } = make(remote, { ownPane: 70 });
  await onMarovo(link);
  await link.type("fine");
  expect(fake.sends()).toHaveLength(1);
});

test("hold-off reasons: no viewer, Corgi not answering, output not understood; polling goes on", async () => {
  const { link, fake } = make({ machines: { local: listReply([]) } });
  const seen: Seen[] = [];
  link.on("viewer", s => seen.push(s));
  expect(await link.watch()).toEqual({
    viewer: false,
    focus: null,
    machine: null,
    reason: "no viewer attached",
    why: "no_viewer",
    source: null,
  });
  // Corgi stops answering.
  fake.set({ machines: { local: { stderr: "corgi: daemon not running\n", code: 1 } } });
  await until(() => seen.at(-1)?.reason === "Corgi unreachable: daemon not running");
  expect(seen.at(-1)).toMatchObject({ why: "unreachable", source: "local" });
  // A viewer attaches: dictation resumes within a poll.
  fake.set(one);
  await until(() => seen.at(-1)?.viewer === true);
  expect(seen.at(-1)).toEqual({ viewer: true, focus: "shell", machine: "local", reason: null, why: null, source: null });
});

test("a first answer without viewers is not understood; the window opens and holds off", async () => {
  const { link, fake } = make({ machines: { local: { stdout: JSON.stringify({ ok: true, result: { panes: [] } }) } } });
  expect(await link.watch()).toEqual({
    viewer: false,
    focus: null,
    machine: null,
    reason: "Corgi output not understood",
    why: "not_understood",
    source: "local",
  });
  expect(await rejection(link.type("held"))).toBe("NoViewer");
  expect(fake.sends()).toEqual([]);
  // A Corgi that learns the field later is taken at the next poll.
  const seen: Seen[] = [];
  link.on("viewer", s => seen.push(s));
  fake.set(one);
  await until(() => seen.at(-1)?.viewer === true);
});

test("a corgi that vanished after startup: Corgi unreachable, corgi not found, and polling goes on", async () => {
  const { link, fake } = make();
  const seen: Seen[] = [];
  link.on("viewer", s => seen.push(s));
  await link.watch();
  const saved = Bun.file(fake.cmd);
  const script = await saved.text();
  rmSync(fake.cmd);
  await until(() => seen.at(-1)?.reason === `Corgi unreachable: corgi not found: ${fake.cmd}`);
  expect(seen.at(-1)?.viewer).toBe(false);
  // Put back, it is found again on the next poll.
  await Bun.write(fake.cmd, script);
  chmodSync(fake.cmd, 0o755);
  await until(() => seen.at(-1)?.viewer === true);
});

test("the delivery goes to the newly focused pane, by its id in the arguments", async () => {
  const { link, fake } = make();
  await link.watch();
  await link.type("to the shell");
  // The viewer focuses pane 6.
  fake.set({ machines: { local: listReply([{ id: 1, pane: 6, active: 10 }], [{ id: 6, name: "build" }]) } });
  await until(() => link.poller.resolve().target?.pane === 6);
  expect(await link.type("to the build")).toEqual({ machine: "local", pane: 6, viewer: 1 });
  expect(fake.sends().map(s => s.argv)).toEqual([
    ["pane", "send", "5", "--stdin"],
    ["pane", "send", "6", "--stdin"],
  ]);
});

test("the same pane id on another machine is another pane: no leading space", async () => {
  // The same viewer id, pane id and `active` on both machines: only the machine differs.
  const here = listReply([{ id: 1, pane: 5, active: 10 }], [{ id: 5, name: "shell" }]),
    there = listReply([{ id: 1, pane: 5, active: 10 }], [{ id: 5, name: "shell" }]),
    away = listReply([{ id: 1, pane: null, active: 10 }]),
    list = machineList(["local", "marovo"]);
  const { link, fake } = make({ machineList: list, machines: { local: here, marovo: away } });
  await link.watch();
  await until(() => link.poller.machines.length === 2 && link.poller.machines.every(m => m.state === "ok"));
  await link.type("first");
  await link.type("second");
  fake.set({ machineList: list, machines: { local: away, marovo: there } });
  await until(() => link.poller.resolve().target?.machine === "marovo");
  await link.type("third");
  await link.type("fourth");
  expect(fake.sends().map(s => [s.argv.join(" "), s.stdin])).toEqual([
    ["pane send 5 --stdin", "first"],
    ["pane send 5 --stdin", " second"],
    ["--machine marovo pane send 5 --stdin", "third"],
    ["--machine marovo pane send 5 --stdin", " fourth"],
  ]);
});

test("another viewer on the same pane gets no leading space", async () => {
  const { link, fake } = make();
  await link.watch();
  await link.type("first");
  await link.type("second");
  // Viewer 1 is gone; viewer 2 shows the same pane, with the same `active`.
  fake.set({ machines: { local: listReply([{ id: 2, pane: 5, active: 10 }], [{ id: 5, name: "shell" }]) } });
  await until(() => link.poller.resolve().target?.viewer === 2);
  expect(await link.type("third")).toEqual({ machine: "local", pane: 5, viewer: 2 });
  expect(fake.sends().map(s => s.stdin)).toEqual(["first", " second", "third"]);
});

test("a delivery that throws where nothing should is rejected alone, and the queue goes on", async () => {
  const lines: string[] = [],
    fake = fakeCorgi(one);
  fakes.push(fake);
  // A poller whose answer throws once, before the delivery's own catch.
  let faults = 1;
  const poller = {
    on: () => {},
    start: async () => {},
    stop: () => {},
    delivered: () => {},
    resolve: () => {
      if (faults-- > 0) throw Error("resolver broke");
      return {
        target: { machine: "local", viewer: 1, pane: 5, active: 10, label: "shell", gone: false },
        reason: null,
        why: null,
      };
    },
  } as unknown as Poller;
  const link = new CorgiLink({ cmd: fake.cmd, poller, log: line => lines.push(line) });
  links.push(link);
  const first = rejection(link.type("lost to the fault")),
    second = link.type("still typed"),
    third = link.type("and this");
  expect(await first).toBe("resolver broke");
  expect(await second).toEqual({ machine: "local", pane: 5, viewer: 1 });
  await third;
  expect(fake.sends().map(s => s.stdin)).toEqual(["still typed", " and this"]);
  expect(lines).toContain("delivery: failed unexpectedly: resolver broke");
});

test("each delivery leaves one log line: outcome, machine, pane, time, exit code, what corgi said; never the text", async () => {
  const lines: string[] = [],
    deliveries = () => lines.filter(l => l.startsWith("delivery:")),
    said = "Remote machines are experimental; bug reports are appreciated.\ncorgi: NoPane: pane 5 is gone\n";
  const { link, fake } = make(
    { ...one, send: { "local:5": { code: 1, stderr: said } } },
    { log: line => lines.push(line) },
  );
  await link.watch();
  expect(await rejection(link.type("dictated words one"))).toBe("pane gone");
  fake.set(one);
  await link.type("dictated words two");
  fake.set({ ...one, send: { "local:5": { delayMs: 5000 } } });
  expect(await rejection(link.type("dictated words three"))).toBe("Timeout");
  // Its line comes once its process is gone.
  await until(() => deliveries().length === 3);
  // No target: nothing ran, and the line says why.
  fake.set({ machines: { local: listReply([]) } });
  await until(() => link.poller.resolve().target === null);
  expect(await rejection(link.type("dictated words four"))).toBe("NoViewer");
  expect(deliveries()).toEqual([
    expect.stringMatching(/^delivery: failed machine=local pane=5 ms=\d+ code=1 stderr=corgi: NoPane: pane 5 is gone$/),
    expect.stringMatching(/^delivery: delivered machine=local pane=5 ms=\d+ code=0$/),
    expect.stringMatching(/^delivery: abandoned machine=local pane=5 ms=\d+ code=signal$/),
    expect.stringMatching(/^delivery: failed ms=\d+ error=NoViewer$/),
  ]);
  expect(lines.join("\n")).not.toContain("dictated");
}, 15_000);

test("a pane that takes no text, and the voice's own pane, are logged without a pane send", async () => {
  const lines: string[] = [];
  const { link, fake } = make(
    { machines: { local: listReply([{ id: 1, pane: 5, active: 1 }], [{ id: 5, exited: true }]) } },
    { log: line => lines.push(line) },
  );
  await link.watch();
  expect(await rejection(link.type("x"))).toBe("pane gone");
  const own = make(one, { ownPane: 5, log: line => lines.push(line) });
  await own.link.watch();
  expect(await rejection(own.link.type("y"))).toBe("VoicePane");
  expect(lines.filter(l => l.startsWith("delivery:"))).toEqual([
    expect.stringMatching(/^delivery: failed machine=local pane=5 ms=\d+ error=pane gone$/),
    expect.stringMatching(/^delivery: failed machine=local pane=5 ms=\d+ error=VoicePane$/),
  ]);
  expect([...fake.sends(), ...own.fake.sends()]).toEqual([]);
});
