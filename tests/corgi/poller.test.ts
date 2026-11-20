import { test, expect, afterEach } from "bun:test";
import { Poller, machineNames } from "../../src/corgi/poller";
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
  poller.previous = "marovo";
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
    { fallbackMs: 300, boundMs: 500 },
  );
  await poller.start();
  await Bun.sleep(1800);
  // Each call was cut at 500 ms, so several started within 1.8 s.
  expect(fake.calls().filter(c => c.argv.includes("--all-machines")).length).toBeGreaterThanOrEqual(2);
  expect(poller.resolve().target?.machine).toBe("local");
}, 10_000);

test("a corgi that disappears after startup shows as unreachable and polling goes on", async () => {
  const { fake, poller } = make({ machines: { local } });
  const seen: (string | null)[] = [];
  poller.on("change", r => seen.push(r.reason));
  await poller.start();
  fake.cleanup();
  await until(() => seen.at(-1) === `Corgi unreachable: corgi not found: ${fake.cmd}`, 4000);
});

test("machine names that would read as options or hold spaces are never passed to --machine", () => {
  expect(machineNames(JSON.stringify({ machines: [{ name: "marovo" }, { name: "--enter" }, { name: "a b" }, { name: "-x" }, { name: "dev.box-1" }] }))).toEqual([
    "marovo",
    "dev.box-1",
  ]);
});
