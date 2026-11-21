import { test, expect, afterEach } from "bun:test";
import { Poller, machineNames, bound_ms, fallback_ms, interval_ms, machine_list_ms } from "../../src/corgi/poller";
import { fresh_ms } from "../../src/corgi/viewers";
import { fakeCorgi, listJson, listReply, machineList, type FakeCorgi, type Scenario } from "../fixtures/corgi";

const fakes: FakeCorgi[] = [],
  pollers: Poller[] = [];
afterEach(() => {
  for (const p of pollers.splice(0)) p.stop();
  for (const f of fakes.splice(0)) f.cleanup();
});
function make(scenario: Scenario, opts: Partial<ConstructorParameters<typeof Poller>[0]> = {}) {
  const fake = fakeCorgi(scenario),
    poller = new Poller({ cmd: fake.cmd, intervalMs: 150, ...opts });
  fakes.push(fake);
  pollers.push(poller);
  return { fake, poller };
}
async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(20);
  expect(check()).toBe(true);
}
const local = listReply([{ id: 1, pane: 10, active: 5 }], [{ id: 10, name: "here" }]),
  remote = listReply([{ id: 7, pane: 70, active: 900 }], [{ id: 70, name: "there" }]);
/** The machines' names the fake was asked about, in call order. */
const asked = (fake: FakeCorgi) =>
  fake
    .calls()
    .filter(c => c.argv.includes("list") && c.argv.includes("--json") && !c.argv.includes("--all-machines"))
    .map(c => (c.argv[0] === "--machine" ? c.argv[1] : "local"));

test("machine names come from machine list, past its notice line", async () => {
  const { fake, poller } = make({ machineList: machineList(["local", "marovo"]), machines: { local, marovo: remote } });
  await poller.start();
  await until(() => poller.machines.length === 2 && poller.machines.every(m => m.state === "ok"));
  expect(poller.machines.map(m => m.name)).toEqual(["local", "marovo"]);
  expect(asked(fake)).toContain("marovo");
  expect(fake.calls().some(c => c.argv.join(" ") === "--machine marovo list --json")).toBe(true);
  // local is never asked with --machine.
  expect(fake.calls().some(c => c.argv.join(" ") === "--machine local list --json")).toBe(false);
});

test("a remote machine that takes 10 s never delays the local target", async () => {
  const { fake, poller } = make({
    machineList: machineList(["local", "marovo"]),
    machines: { local, marovo: { ...remote, delayMs: 10_000 } },
  });
  const started = Date.now();
  await poller.start();
  // The local machine answered first; nothing waited for marovo.
  expect(Date.now() - started).toBeLessThan(1500);
  expect(poller.resolve().target).toMatchObject({ machine: "local", pane: 10 });
  const before = asked(fake).filter(n => n === "local").length;
  await Bun.sleep(1200);
  // Local kept its own pace meanwhile.
  expect(asked(fake).filter(n => n === "local").length - before).toBeGreaterThanOrEqual(3);
  expect(poller.resolve().target?.machine).toBe("local");
  // marovo's call was cut at its bound.
  await until(() => poller.machines.find(m => m.name === "marovo")?.error === "no answer in time", 3000);
}, 10_000);

test("a machine whose data is older than 2 s stops being a candidate", async () => {
  let offset = 0;
  const { fake, poller } = make(
    { machineList: machineList(["local", "marovo"]), machines: { local, marovo: remote } },
    { now: () => Date.now() + offset },
  );
  await poller.start();
  await until(() => poller.machines.length === 2 && poller.machines.every(m => m.state === "ok"));
  expect(poller.resolve().target?.machine).toBe("local");
  // local stops answering; marovo keeps answering.
  fake.set({ machineList: machineList(["local", "marovo"]), machines: { local: { ...local, delayMs: 10_000 }, marovo: remote } });
  await Bun.sleep(400);
  offset = 2500;
  await until(() => poller.resolve().target?.machine === "marovo", 3000);
});

test("the one watched viewer wins across machines", async () => {
  const { poller } = make({
    machineList: machineList(["local", "marovo"]),
    machines: {
      local,
      marovo: listReply([{ id: 7, pane: 70, active: 1, watched: true }], [{ id: 70, name: "there" }]),
    },
  });
  await poller.start();
  await until(() => poller.machines.length === 2 && poller.machines.every(m => m.state === "ok"));
  expect(poller.resolve().target).toMatchObject({ machine: "marovo", pane: 70, label: "there" });
});

test("without a watched viewer, the previous delivery's machine, then local", async () => {
  const { poller } = make({
    machineList: machineList(["marovo", "local"]),
    machines: { local, marovo: remote },
  });
  await poller.start();
  await until(() => poller.machines.length === 2 && poller.machines.every(m => m.state === "ok"));
  expect(poller.resolve().target?.machine).toBe("local");
  poller.delivered("marovo");
  expect(poller.resolve().target?.machine).toBe("marovo");
});

test("machines added or removed between refreshes gain or lose their loop", async () => {
  const { fake, poller } = make(
    { machineList: machineList(["local"]), machines: { local, b: remote } },
    { machineListMs: 300 },
  );
  await poller.start();
  expect(poller.machines.map(m => m.name)).toEqual(["local"]);
  fake.set({ machineList: machineList(["local", "b"]), machines: { local, b: remote } });
  await until(() => poller.machines.some(m => m.name === "b" && m.state === "ok"));
  fake.set({ machineList: machineList(["local"]), machines: { local, b: remote } });
  await until(() => !poller.machines.some(m => m.name === "b"));
  await Bun.sleep(300);
  const count = asked(fake).filter(n => n === "b").length;
  await Bun.sleep(500);
  expect(asked(fake).filter(n => n === "b").length).toBe(count);
});

test("without machine list, local is polled alone and --all-machines fills in the rest", async () => {
  const all = JSON.stringify({
    machines: [
      { machine: "local", ok: true, err: null, ...JSON.parse(listJson([{ id: 1, pane: 10, active: 5 }])) },
      {
        machine: "marovo",
        ok: true,
        err: null,
        ...JSON.parse(listJson([{ id: 7, pane: 70, active: 2, watched: true }], [{ id: 70, name: "there" }])),
      },
      { machine: "gone", ok: false, err: "RequestTimedOut" },
    ],
  });
  const { fake, poller } = make(
    {
      machineList: { stderr: "corgi: unknown command machine\n", code: 2 },
      machines: { local },
      // Exit code 1 because one machine failed; the JSON still counts.
      allMachines: { stdout: all, code: 1 },
    },
    { fallbackMs: 300 },
  );
  await poller.start();
  await until(() => poller.machines.find(m => m.name === "marovo")?.state === "ok");
  expect(poller.machines.find(m => m.name === "gone")).toMatchObject({ state: "unreachable", error: "RequestTimedOut" });
  expect(poller.resolve().target).toMatchObject({ machine: "marovo", pane: 70 });
  // Local has its own loop; remote machines get none.
  expect(asked(fake).every(n => n === "local")).toBe(true);
  expect(fake.calls().filter(c => c.argv.includes("--all-machines")).length).toBeGreaterThanOrEqual(1);
  // Asked as often as the machines' own loops would be, its data stays fresh.
  await Bun.sleep(2500);
  expect(poller.resolve().target).toMatchObject({ machine: "marovo", pane: 70 });
});

test("the fallback call is bounded like any viewer fetch", async () => {
  const { fake, poller } = make(
    {
      machineList: { code: 2, stderr: "corgi: unknown command machine\n" },
      machines: { local },
      allMachines: { stdout: "{}", delayMs: 10_000 },
    },
    // The bound holds for the local machine's own calls too: wide enough
    // for a fake corgi that starts slowly on a busy host.
    { fallbackMs: 300, boundMs: 1000 },
  );
  await poller.start();
  // Each call is cut at 1 s, so the next starts long before the 10 s the
  // first would have taken.
  const started = Date.now();
  await until(() => fake.calls().filter(c => c.argv.includes("--all-machines")).length >= 3, 6000);
  expect(Date.now() - started).toBeLessThan(6000);
  await until(() => poller.resolve().target?.machine === "local");
}, 15_000);

test("a corgi that disappears after startup shows as unreachable and polling goes on", async () => {
  const { fake, poller } = make({ machines: { local } });
  const seen: (string | null)[] = [];
  poller.on("change", r => seen.push(r.reason));
  await poller.start();
  fake.cleanup();
  await until(() => seen.at(-1) === `Corgi unreachable: corgi not found: ${fake.cmd}`, 4000);
});

test("an older corgi's refusal on standard error reads as its err, not as raw JSON", async () => {
  // The walkthrough's old release: `{"ok":false,...}` on standard error, exit 2.
  const { poller } = make({
    machines: { local: { stderr: '{"ok":false,"err":"JSON Parse error: Unexpected identifier \\"HTTP\\""}\n', code: 2 } },
  });
  const seen: (string | null)[] = [];
  poller.on("change", r => seen.push(r.reason));
  await poller.start();
  await until(() => seen.length > 0);
  expect(seen.at(-1)).toBe('Corgi unreachable: JSON Parse error: Unexpected identifier "HTTP"');
});

test("the same reason from another machine is news: the voice.json hint depends on it (FR-011)", async () => {
  const misread = { stdout: "not json\n" },
    { fake, poller } = make({ machineList: machineList(["local", "marovo"]), machines: { local: misread, marovo: misread } });
  const seen: { reason: string | null; source: string | null }[] = [];
  poller.on("change", r => seen.push({ reason: r.reason, source: r.source }));
  await poller.start();
  await until(() => seen.at(-1)?.source === "local");
  expect(seen.at(-1)).toEqual({ reason: "Corgi output not understood", source: "local" });
  // Local stops answering; only marovo's output is not understood now.
  fake.set({
    machineList: machineList(["local", "marovo"]),
    machines: { local: { stderr: "corgi: daemon not running\n", code: 1 }, marovo: misread },
  });
  await until(() => seen.at(-1)?.source === "marovo");
  expect(seen.at(-1)).toEqual({ reason: "Corgi output not understood", source: "marovo" });
});

test("machine names that would read as options or hold spaces are never passed to --machine", () => {
  expect(machineNames(JSON.stringify({ machines: [{ name: "marovo" }, { name: "--enter" }, { name: "a b" }, { name: "-x" }, { name: "dev.box-1" }] }))).toEqual([
    "marovo",
    "dev.box-1",
  ]);
});

test("the spec's defaults: each machine asked every second and bounded below the 2 s freshness, the list every 30 s", () => {
  expect(interval_ms).toBe(1000);
  expect(bound_ms).toBe(1500);
  expect(fresh_ms).toBe(2000);
  expect(bound_ms).toBeLessThan(fresh_ms);
  expect(machine_list_ms).toBe(30_000);
  // The fallback keeps the remote machines as fresh as their own loops would.
  expect(fallback_ms).toBe(interval_ms);
});

test("a machine that keeps failing is logged once per distinct failure, and once when it answers again", async () => {
  const lines: string[] = [],
    about = () => lines.filter(l => l.startsWith("corgi: local:")),
    polls = (fake: FakeCorgi) => asked(fake).length;
  const { fake, poller } = make(
    { machines: { local: { stderr: "corgi: daemon not running\n", code: 1 } } },
    { log: line => lines.push(line) },
  );
  await poller.start();
  // The same failure, poll after poll.
  let before = polls(fake);
  await until(() => polls(fake) >= before + 2, 10_000);
  expect(about()).toEqual(["corgi: local: daemon not running"]);
  fake.set({ machines: { local: { stderr: "ssh: connect to host box port 22: Connection refused\n", code: 255 } } });
  await until(() => about().length === 2, 10_000);
  before = polls(fake);
  await until(() => polls(fake) >= before + 2, 10_000);
  fake.set({ machines: { local } });
  await until(() => poller.machines[0]?.state === "ok", 10_000);
  before = polls(fake);
  await until(() => polls(fake) >= before + 2, 10_000);
  expect(about()).toEqual([
    "corgi: local: daemon not running",
    "corgi: local: ssh: connect to host box port 22: Connection refused",
    "corgi: local: answering",
  ]);
}, 30_000);

test("a machine list that fails is logged once per distinct failure, and once when it answers again", async () => {
  const lines: string[] = [],
    about = () => lines.filter(l => l.startsWith("corgi: machine list:")),
    listed = (fake: FakeCorgi) => fake.calls().filter(c => c.argv.join(" ") === "machine list").length;
  const { fake, poller } = make(
    { machineList: { stderr: "corgi: unknown command machine\n", code: 2 }, machines: { local } },
    { machineListMs: 400, log: line => lines.push(line) },
  );
  await poller.start();
  await until(() => listed(fake) >= 2, 10_000);
  expect(about()).toEqual(["corgi: machine list: unknown command machine"]);
  // Another failure: an answer that is no machine list.
  fake.set({ machineList: { stdout: "not json\n" }, machines: { local } });
  await until(() => about().length === 2, 10_000);
  let before = listed(fake);
  await until(() => listed(fake) >= before + 2, 10_000);
  fake.set({ machineList: machineList(["local"]), machines: { local } });
  await until(() => about().length === 3, 10_000);
  before = listed(fake);
  await until(() => listed(fake) >= before + 2, 10_000);
  expect(about()).toEqual([
    "corgi: machine list: unknown command machine",
    "corgi: machine list: Corgi output not understood",
    "corgi: machine list: answering",
  ]);
}, 30_000);

test("once machine list answers, the fallback stops and each machine gets a loop of its own", async () => {
  const all = JSON.stringify({
    machines: [
      {
        machine: "marovo",
        ok: true,
        err: null,
        ...JSON.parse(listJson([{ id: 7, pane: 70, active: 2, watched: true }], [{ id: 70, name: "there" }])),
      },
    ],
  });
  const watched = listReply([{ id: 7, pane: 70, active: 2, watched: true }], [{ id: 70, name: "there" }]),
    fallbacks = (fake: FakeCorgi) => fake.calls().filter(c => c.argv.includes("--all-machines")).length,
    own = (fake: FakeCorgi) => asked(fake).filter(n => n === "marovo").length;
  const { fake, poller } = make(
    {
      machineList: { stderr: "corgi: unknown command machine\n", code: 2 },
      machines: { local, marovo: watched },
      allMachines: { stdout: all },
    },
    { machineListMs: 500, fallbackMs: 150 },
  );
  await poller.start();
  // The fallback fills marovo in; it has no loop of its own.
  await until(() => poller.resolve().target?.machine === "marovo", 10_000);
  expect(own(fake)).toBe(0);
  expect(fallbacks(fake)).toBeGreaterThanOrEqual(1);
  // `machine list` starts answering: marovo first, as Corgi lists it.
  fake.set({
    machineList: machineList(["marovo", "local"]),
    machines: { local, marovo: watched },
    allMachines: { stdout: all },
  });
  await until(() => own(fake) >= 2, 10_000);
  expect(poller.machines.map(m => m.name)).toEqual(["marovo", "local"]);
  await until(() => poller.resolve().target?.machine === "marovo", 10_000);
  // The fallback is not asked any more, while marovo's own loop goes on;
  // one fallback call may have been on its way at the switch.
  await Bun.sleep(500);
  const count = fallbacks(fake),
    loops = own(fake);
  await until(() => own(fake) >= loops + 2, 10_000);
  expect(fallbacks(fake)).toBe(count);
  expect(poller.resolve().target).toMatchObject({ machine: "marovo", pane: 70 });
}, 30_000);
