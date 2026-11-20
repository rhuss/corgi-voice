//! The session against the real CorgiLink and a fake corgi: speech in,
//! `pane send --stdin` out, without a microphone, Whisper or Corgi.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorgiLink } from "../../src/corgi/link";
import { VoiceSession } from "../../src/voice/session";
import { Segmenter } from "../../src/voice/segmenter";
import { Recorder } from "../../src/voice/recorder";
import type { Tuning } from "../../src/voice/tuning";
import { shapes } from "../fixtures/voice/make_pcm";
import { fakeCorgi, listReply, type FakeCorgi, type Scenario } from "../fixtures/corgi";

const fakes: FakeCorgi[] = [],
  sessions: VoiceSession[] = [],
  dirs: string[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.close();
  for (const f of fakes.splice(0)) f.cleanup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const one: Scenario = {
  machines: { local: listReply([{ id: 1, pane: 5, active: 10 }], [{ id: 5, name: "shell" }]) },
};
function make(scenario: Scenario, script: string[], recorder?: Recorder) {
  const fake = fakeCorgi(scenario);
  const s = new VoiceSession({
    link: async () => new CorgiLink({ cmd: fake.cmd, intervalMs: 100, boundMs: 4000 }),
    transcriber: { transcribe: async () => ({ text: script.shift() ?? "" }), on: () => {} },
    segmenter: new Segmenter({ threshold: 44, timing: { silence: 0.5 }, now: () => performance.now() }),
    now: () => performance.now(),
    recorder,
  });
  fakes.push(fake);
  sessions.push(s);
  return { fake, s };
}
function speak(s: VoiceSession) {
  const pcm = shapes.speech();
  for (let at = 0; at < pcm.length; at += 320) s.frame(pcm.subarray(at, at + 320));
}
async function until(check: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(10);
  expect(check()).toBe(true);
}

test("speech is typed into the focused pane with pane send --stdin, joined by one space", async () => {
  const { fake, s } = make(one, ["refactor the parser module", "and add tests"]);
  await s.connect();
  expect([s.viewer, s.focus, s.machine, s.link_state]).toEqual([true, "shell", "local", "connected"]);
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 2);
  expect(fake.sends().map(c => [c.argv, c.stdin])).toEqual([
    [["pane", "send", "5", "--stdin"], "refactor the parser module"],
    [["pane", "send", "5", "--stdin"], " and add tests"],
  ]);
});

test("with no viewer attached nothing is transcribed for dictation; a viewer attaching resumes it", async () => {
  let asked = 0;
  const { fake, s } = make({ machines: { local: listReply([]) } }, ["after"]);
  const whisper = (s as unknown as { deps: { transcriber: { transcribe: () => Promise<{ text: string }> } } }).deps.transcriber;
  const transcribe = whisper.transcribe;
  whisper.transcribe = () => (asked++, transcribe());
  await s.connect();
  expect([s.viewer, s.reason]).toEqual([false, "no viewer attached"]);
  speak(s);
  await Bun.sleep(50);
  expect([asked, s.history.length, fake.sends().length]).toEqual([0, 0, 0]);
  fake.set(one);
  await until(() => s.viewer, 2000);
  speak(s);
  await until(() => s.history.at(-1)?.status === "delivered");
  expect(fake.sends().map(c => c.stdin)).toEqual(["after"]);
});

test("a recording goes on while no viewer is attached: passages are written, marked not typed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cv-int-"));
  dirs.push(dir);
  const tuning = { pause_break: 2, begin: () => {}, end: () => {} } as unknown as Tuning,
    recorder = new Recorder({ tuning, now: () => performance.now() }),
    path = join(dir, "t.txt");
  const { fake, s } = make({ machines: { local: listReply([]) } }, ["kept for the notes"], recorder);
  await s.connect();
  recorder.start(path);
  speak(s);
  await until(() => s.history[0]?.status === "recorded");
  expect(s.history[0].reason).toBe("no viewer attached");
  expect(existsSync(path) && readFileSync(path, "utf8")).toBe("kept for the notes\n");
  expect(fake.sends()).toEqual([]);
  recorder.finish();
});

test("Corgi not answering holds dictation off and says why; the session retries on every poll", async () => {
  const { fake, s } = make({ machines: { local: { stderr: "corgi: daemon not running\n", code: 1 } } }, ["back"]);
  await s.connect();
  expect([s.viewer, s.link_state, s.reason]).toEqual([false, "lost", "Corgi unreachable: daemon not running"]);
  fake.set(one);
  await until(() => s.link_state === "connected" && s.viewer, 2000);
  speak(s);
  await until(() => s.history.at(-1)?.status === "delivered");
});

test("mute lives in corgi-voice: m sends nothing to Corgi and drops speech in flight", async () => {
  const { fake, s } = make(one, ["muted words", "after unmute"]);
  await s.connect();
  // Mid-sentence, then muted: the sentence leaves no row and is never typed.
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  expect(s.history[0]?.status).toBe("recording");
  const before = fake.calls().length;
  s.setMuted(true);
  expect(s.history.filter(u => u.status !== "muted")).toEqual([]);
  speak(s);
  await Bun.sleep(300);
  expect(fake.sends()).toEqual([]);
  s.setMuted(false);
  speak(s);
  await until(() => s.history.at(-1)?.status === "delivered");
  expect(fake.sends().map(c => c.stdin)).toEqual(["muted words"]);
  // Only polling and the delivery reached corgi: nothing about the mute.
  const kinds = new Set(
    fake.calls().map(c => {
      const a = c.argv[0] === "--machine" ? c.argv.slice(2) : c.argv;
      if (a[0] === "list") return "list";
      if (a[0] === "machine" && a[1] === "list") return "machine list";
      if (a[0] === "pane" && a[1] === "send") return a.includes("--help") ? "help" : "pane send";
      return a.join(" ");
    }),
  );
  for (const kind of kinds) expect(["list", "machine list", "pane send", "help"]).toContain(kind);
  expect(fake.calls().length).toBeGreaterThan(before);
});

test("MUTED while the tool cannot listen, and unmuting waits for the microphone", async () => {
  const { s } = make(one, []);
  await s.connect();
  s.setAvailable(false, "mic_missing");
  expect(s.available).toBe(false);
  s.setMuted(false);
  expect(s.available).toBe(false);
  // The microphone comes back with its next frame.
  s.frame(new Int16Array(320));
  expect(s.available).toBe(true);
});
