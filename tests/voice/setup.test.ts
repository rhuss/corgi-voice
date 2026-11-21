import { test, expect, afterEach, beforeEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as setup from "../../src/voice/setup";
import * as models from "../../src/voice/models";
import { fakeCorgi, type FakeCorgi } from "../fixtures/corgi";

const fixtures = resolve(import.meta.dir, "../fixtures/voice"),
  saved = process.env.XDG_CACHE_HOME,
  bun = dirname(process.execPath);
const reachable = { machines: { local: { stdout: '{"viewers":[]}' } } };
let fake: FakeCorgi;
let dir = "",
  served: Record<string, Uint8Array<ArrayBuffer>> = {},
  requests: string[] = [],
  /** Called halfway through a file's download, the first half sent, when set. */
  midway: (() => Promise<void>) | null = null,
  server: ReturnType<typeof Bun.serve>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "corgi-setup-"));
  // The process's own cache is somewhere else than the one setup is given:
  // whatever read or wrote there would not have taken the injected env.
  process.env.XDG_CACHE_HOME = join(dir, "not-the-given-cache");
  // A running Corgi this corgi can talk to: list --json answers with viewers.
  fake = fakeCorgi(reachable);
  requests = [];
  midway = null;
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const name = new URL(request.url).pathname.slice(1),
        data = served[name],
        pause = midway;
      requests.push(name);
      if (!data) return new Response("missing", { status: 404 });
      if (!pause) return new Response(data);
      const half = Math.floor(data.length / 2);
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(data.subarray(0, half));
            await pause();
            controller.enqueue(data.subarray(half));
            controller.close();
          },
        }),
      );
    },
  });
});
afterEach(() => {
  fake.cleanup();
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = saved;
});
function entry(name: "base.en" | "filter", content: string, sha256?: string): models.Entry {
  const data = new TextEncoder().encode(content) as Uint8Array<ArrayBuffer>;
  served[name] = data;
  return {
    name,
    file: `ggml-${name}.bin`,
    url: `http://127.0.0.1:${server.port}/${name}`,
    bytes: data.length,
    sha256: sha256 ?? createHash("sha256").update(data).digest("hex"),
  };
}
/** Old and new files under the test's folder only. */
const env = (): NodeJS.ProcessEnv => ({
  HOME: dir,
  XDG_STATE_HOME: join(dir, "state"),
  XDG_CACHE_HOME: join(dir, "cache"),
});
async function report(
  entries: { model: models.Entry; filter: models.Entry },
  path = `${fixtures}:${bun}`,
  corgi: string | null = fake.cmd,
) {
  let out = "";
  const code = await setup.run({ model: "base.en", corgi }, { write: text => (out += text), entries, path, env: env() });
  return { code, out };
}

test("missing files are downloaded, verified and renamed into place", async () => {
  const entries = { model: entry("base.en", "model bytes"), filter: entry("filter", "filter bytes") };
  const { code, out } = await report(entries);
  expect(code).toBe(0);
  expect(out).toContain(`[ok] whisper-server ${fixtures}/whisper-server`);
  expect(out).toContain(`[ok] ffmpeg ${fixtures}/ffmpeg`);
  expect(out).toContain("downloading model base.en");
  expect(out).toContain("100%");
  expect(out).toContain("Voice is ready");
  const file = models.fileOf(entries.model, env());
  expect(file).toBe(join(dir, "cache", "corgi-voice", entries.model.file));
  expect(out).toContain(`[ok] model base.en ${file}`);
  expect(readFileSync(file, "utf8")).toBe("model bytes");
  expect(existsSync(file + ".part")).toBe(false);
  expect(requests).toEqual(["base.en", "filter"]);
  // A second run has nothing to fetch.
  const again = await report(entries);
  expect(again.code).toBe(0);
  expect(again.out).not.toContain("downloading");
  expect(requests).toHaveLength(2);
});

test("setup reads and writes the one cache its env names, never the process's own", async () => {
  const entries = { model: entry("base.en", "model bytes"), filter: entry("filter", "filter bytes") },
    own = process.env.XDG_CACHE_HOME!;
  expect(models.cacheDir()).toBe(join(own, "corgi-voice"));
  expect(models.cacheDir(env())).toBe(join(dir, "cache", "corgi-voice"));
  expect((await report(entries)).code).toBe(0);
  // Downloaded into the given cache, and found there by the next run.
  expect(models.installed(entries.model, env())).toBe(true);
  expect(models.installed(entries.filter, env())).toBe(true);
  expect(models.installed(entries.model)).toBe(false);
  expect(existsSync(own)).toBe(false);
  expect((await report(entries)).out).not.toContain("downloading");
  // A model in the process's own cache counts for nothing here.
  mkdirSync(join(own, "corgi-voice"), { recursive: true });
  writeFileSync(join(own, "corgi-voice", "ggml-base.en.bin"), "model bytes");
  rmSync(join(dir, "cache"), { recursive: true });
  const fresh = await report(entries);
  expect(fresh.out).toContain("downloading model base.en");
  expect(requests).toHaveLength(4);
});

test("a download that does not match its checksum is deleted", async () => {
  const entries = { model: entry("base.en", "model bytes", "0".repeat(64)), filter: entry("filter", "filter") };
  const { code, out } = await report(entries);
  expect(code).toBe(1);
  expect(out).toContain("[failed] model base.en: the download did not match its checksum");
  expect(existsSync(models.fileOf(entries.model, env()))).toBe(false);
  expect(existsSync(models.fileOf(entries.model, env()) + ".part")).toBe(false);
  expect(out).toContain("[ok] speech filter");
});

test("a download that cannot be written fails instead of hanging", async () => {
  const entries = { model: entry("base.en", "model bytes"), filter: entry("filter", "filter") },
    cache = dirname(models.fileOf(entries.model, env()));
  mkdirSync(cache, { recursive: true });
  chmodSync(cache, 0o500);
  try {
    const { code, out } = await report(entries);
    expect(code).toBe(1);
    expect(out).toContain("[failed] model base.en: the download failed");
  } finally {
    chmodSync(cache, 0o755);
  }
  expect(existsSync(models.fileOf(entries.model, env()) + ".part")).toBe(false);
});

test("missing tools are reported with how to install them", async () => {
  const entries = { model: entry("base.en", "m"), filter: entry("filter", "f") };
  const { code, out } = await report(entries, join(dir, "empty"));
  expect(code).toBe(1);
  expect(out).toContain(`[missing] whisper-server: install with ${setup.hint("whisper-server")}`);
  expect(out).toContain(`[missing] ffmpeg: install with ${setup.hint("ffmpeg")}`);
  expect(out).toContain("Voice is not ready");
});

test("a whisper-server without --vad is too old", async () => {
  const bin = join(dir, "bin"),
    old = join(bin, "whisper-server");
  mkdirSync(bin);
  writeFileSync(old, "#!/bin/sh\necho 'usage: whisper-server [options]'\n");
  chmodSync(old, 0o755);
  const entries = { model: entry("base.en", "m"), filter: entry("filter", "f") };
  const { code, out } = await report(entries, `${bin}:${fixtures}`);
  expect(code).toBe(1);
  expect(out).toContain(`[too old] whisper-server at ${old} has no --vad`);
});

test("install hints follow the platform", () => {
  expect(setup.hint("whisper-server", "macos")).toBe("brew install whisper-cpp");
  expect(setup.hint("ffmpeg", "macos")).toBe("brew install ffmpeg");
  expect(setup.hint("whisper-server", "arch")).toBe("sudo pacman -S whisper-cpp");
  expect(setup.hint("whisper-server", "debian")).toBe("sudo apt install whisper.cpp-tools");
  expect(setup.hint("whisper-server", "linux")).toContain("build whisper.cpp from source");
});

test("the corgi command is checked: found with pane send --stdin, missing, or too old", async () => {
  const entries = { model: entry("base.en", "m"), filter: entry("filter", "f") };
  let { code, out } = await report(entries);
  expect(code).toBe(0);
  expect(out).toContain(`[ok] corgi ${fake.cmd}`);
  ({ code, out } = await report(entries, `${fixtures}:${bun}`, "corgi-custom"));
  expect(code).toBe(1);
  expect(out).toContain('[missing] corgi: the corgi command "corgi-custom" was not found');
  expect(out).toContain("executable's path");
  fake.set({ help: { stdout: "corgi pane send ID TEXT [--enter]\n" } });
  ({ code, out } = await report(entries));
  expect(code).toBe(1);
  expect(out).toContain('[too old] corgi: this corgi');
  expect(out).toContain("pane send --stdin");
});

/** The lines setup printed about the corgi command. */
const corgiLines = (out: string) => out.split("\n").filter(l => /^\[[a-z ]+\] corgi\b/.test(l));
/** The calls of `list --json`, setup's reachability probe. */
const probes = () => fake.calls().filter(c => c.argv.join(" ") === "list --json");

test("a corgi that talks to the running Corgi is ok, probed once with list --json", async () => {
  const entries = { model: entry("base.en", "m"), filter: entry("filter", "f") },
    { code, out } = await report(entries);
  expect(code).toBe(0);
  expect(corgiLines(out)).toEqual([`[ok] corgi ${fake.cmd}`]);
  expect(probes()).toHaveLength(1);
  // The probe never touches a pane: the only other call is the capability check.
  expect(fake.calls().map(c => c.argv.join(" "))).toEqual(["pane send --help", "list --json"]);
});

test("a corgi that cannot talk to the running Corgi is a mismatch, with the fix, and setup fails", async () => {
  const entries = { model: entry("base.en", "m"), filter: entry("filter", "f") };
  fake.set({
    machines: { local: { stdout: '{"ok":false,"err":"JSON Parse error: Unexpected identifier \\"HTTP\\""}', code: 1 } },
  });
  let { code, out } = await report(entries);
  expect(code).toBe(1);
  expect(corgiLines(out)).toEqual([
    `[mismatch] corgi ${fake.cmd} cannot talk to the running Corgi: JSON Parse error: Unexpected identifier "HTTP"`,
  ]);
  expect(out).toContain(
    `[mismatch] corgi ${fake.cmd} cannot talk to the running Corgi: JSON Parse error: Unexpected identifier "HTTP"\n` +
      `         set "corgi" in voice.json, or pass --corgi, to the corgi your Corgi runs\n`,
  );
  expect(out).toContain("Voice is not ready");
  // A reply without viewers, and an error no table knows, count the same.
  fake.set({ machines: { local: { stdout: '{"panes":[]}' } } });
  ({ code, out } = await report(entries));
  expect(code).toBe(1);
  expect(corgiLines(out)).toEqual([
    `[mismatch] corgi ${fake.cmd} cannot talk to the running Corgi: Corgi output not understood`,
  ]);
  fake.set({ machines: { local: { stderr: "corgi: something new went wrong\n", code: 1 } } });
  ({ code, out } = await report(entries));
  expect(code).toBe(1);
  expect(corgiLines(out)[0]).toEndWith("cannot talk to the running Corgi: something new went wrong");
});

test("a Corgi that is not running is a note, and voice is still ready", async () => {
  const entries = { model: entry("base.en", "m"), filter: entry("filter", "f") };
  fake.set({ machines: { local: { stdout: '{"ok":false,"err":"NoRuntime"}', code: 1 } } });
  let { code, out } = await report(entries);
  expect(code).toBe(0);
  expect(corgiLines(out)).toEqual([
    `[note] corgi: Corgi is not running; could not check that ${fake.cmd} talks to it`,
  ]);
  expect(out).toContain("Voice is ready");
  fake.set({ machines: { local: { stderr: "corgi: ConnectionRefused\n", code: 1 } } });
  ({ code, out } = await report(entries));
  expect(code).toBe(0);
  expect(corgiLines(out)[0]).toStartWith("[note] corgi: Corgi is not running");
});

test("a slow Corgi is a note, past the probe's bound or RequestTimedOut, and voice is still ready", async () => {
  const entries = { model: entry("base.en", "m"), filter: entry("filter", "f") };
  fake.set({ machines: { local: { stdout: '{"viewers":[]}', delayMs: 2000 } } });
  let out = "";
  const code = await setup.run(
    { model: "base.en", corgi: fake.cmd },
    { write: text => (out += text), entries, path: `${fixtures}:${bun}`, env: env(), reachMs: 200 },
  );
  expect(code).toBe(0);
  expect(corgiLines(out)).toEqual(["[note] corgi: no answer in time"]);
  fake.set({ machines: { local: { stderr: "corgi: RequestTimedOut\n", code: 1 } } });
  const again = await report(entries);
  expect(again.code).toBe(0);
  expect(corgiLines(again.out)).toEqual(["[note] corgi: no answer in time"]);
});

test("no probe runs when the corgi command is missing or too old", async () => {
  const entries = { model: entry("base.en", "m"), filter: entry("filter", "f") };
  let { out } = await report(entries, `${fixtures}:${bun}`, "corgi-custom");
  expect(corgiLines(out)).toHaveLength(1);
  fake.set({ ...reachable, help: { stdout: "corgi pane send ID TEXT [--enter]\n" } });
  ({ out } = await report(entries));
  expect(corgiLines(out)).toHaveLength(1);
  expect(corgiLines(out)[0]).toStartWith("[too old] corgi: ");
  expect(probes()).toEqual([]);
});

test("models of the in-Corgi voice mode are taken before anything is downloaded", async () => {
  const entries = { model: entry("base.en", "model bytes"), filter: entry("filter", "filter bytes") },
    old = join(dir, "cache", "corgi", "voice");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, entries.model.file), "model bytes");
  mkdirSync(join(dir, "state", "corgi"), { recursive: true });
  writeFileSync(join(dir, "state", "corgi", "voice.json"), "{}");
  const { code, out } = await report(entries);
  expect(code).toBe(0);
  expect(out).toContain(`[taken] Took ${entries.model.file} from ${old}`);
  expect(out).toContain("[taken] Copied the settings of corgi voice");
  // Only the filter was missing from both caches.
  expect(requests).toEqual(["filter"]);
  expect(existsSync(join(dir, "state", "corgi-voice", "voice.json"))).toBe(true);
});

test("a model of the old cache whose checksum does not match is not taken: it is downloaded", async () => {
  const entries = { model: entry("base.en", "model bytes"), filter: entry("filter", "filter bytes") },
    old = join(dir, "cache", "corgi", "voice");
  mkdirSync(old, { recursive: true });
  // The pinned size, another content.
  writeFileSync(join(old, entries.model.file), "MODEL BYTES");
  const { code, out } = await report(entries);
  expect(code).toBe(0);
  expect(out).toContain(`[taken] Did not take ${entries.model.file} from ${old}: its checksum does not match`);
  expect(out).not.toContain(`Took ${entries.model.file}`);
  expect(requests).toEqual(["base.en", "filter"]);
  expect(readFileSync(models.fileOf(entries.model, env()), "utf8")).toBe("model bytes");
  expect(readFileSync(join(old, entries.model.file), "utf8")).toBe("MODEL BYTES");
});

test("a partial model in the new cache is not taken over; setup downloads it through .part and replaces it", async () => {
  const entries = { model: entry("base.en", "the whole model, every byte"), filter: entry("filter", "filter bytes") },
    old = join(dir, "cache", "corgi", "voice"),
    file = models.fileOf(entries.model, env()),
    part = file + ".part";
  // The old cache has the whole model; the new one a file that is too short.
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, entries.model.file), "the whole model, every byte");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "the whole mo");
  // Halfway through the model's download: what is on disk then.
  let during = null as { part: boolean; file: string } | null;
  midway = async () => {
    if (during) return;
    for (let i = 0; i < 200 && !existsSync(part); i++) await Bun.sleep(10);
    during = { part: existsSync(part), file: readFileSync(file, "utf8") };
  };
  const { code, out } = await report(entries);
  expect(code).toBe(0);
  // Migration left the partial file as it was, and linked nothing over it.
  expect(out).not.toContain("[taken]");
  expect(requests).toEqual(["base.en", "filter"]);
  // The download went beside it, and took its place only when whole and checked.
  expect(during).toEqual({ part: true, file: "the whole mo" });
  expect(readFileSync(file, "utf8")).toBe("the whole model, every byte");
  expect(existsSync(part)).toBe(false);
  expect(out).toContain(`[ok] model base.en ${file}`);
});
