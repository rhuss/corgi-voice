import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoiceSession, max_queued, safety_ms } from "../../src/voice/session";
import { Segmenter } from "../../src/voice/segmenter";
import { Recorder } from "../../src/voice/recorder";
import { Events, deadline_ms, type Seen, type VoiceLink } from "../../src/voice/link";
import type { Tuning } from "../../src/voice/tuning";
import { shapes, concat, music, silence, tone } from "../fixtures/voice/make_pcm";
import * as level from "../../src/voice/level";

/** What the link reports: a viewer on `focus`, or none attached. */
const seen = (viewer: boolean, focus: string | null): Seen => ({
  viewer,
  focus,
  machine: viewer ? "local" : null,
  reason: viewer ? null : "no viewer attached",
  why: viewer ? null : "no_viewer",
});
/** No target, because Corgi or the machine a viewer shows does not answer. */
const unreachable = (reason: string): Seen => ({ viewer: false, focus: null, machine: null, reason, why: "unreachable" });
/** A link whose replies the test hands out. */
class FakeLink implements VoiceLink {
  events = new Events();
  calls: { op: string; value?: unknown; at: number }[] = [];
  watches = 0;
  closed = false;
  /** Whether a viewer would take text, as the watch reply says. */
  viewer = true;
  /** What the first view waits for, or fails with. */
  watching: () => Promise<void> = async () => {};
  reply: (op: string, value?: unknown) => Promise<any> = async () => ({ machine: "local", pane: 1, viewer: 1 });
  async watch(): Promise<Seen> {
    this.watches++;
    await this.watching();
    return {
      viewer: this.viewer,
      focus: "dictation",
      machine: "local",
      reason: this.viewer ? null : "no viewer attached",
      why: this.viewer ? null : "no_viewer",
    };
  }
  type(text: string) {
    this.calls.push({ op: "type", value: text, at: performance.now() });
    return this.reply("type", text);
  }
  on(_event: "viewer", fn: (seen: Seen) => void) {
    this.events.on("viewer", fn);
  }
  close() {
    this.closed = true;
  }
}
class FakeWhisper {
  heard: string[] = [];
  requests = 0;
  /** The filter padding each request asked for, in seconds. */
  pads: number[] = [];
  speech_end?: number;
  crash: (code: number | null) => void = () => {};
  /** Holds every transcription until it resolves, for a Whisper that is behind. */
  gate: Promise<void> = Promise.resolve();
  constructor(private script: string[]) {}
  async transcribe(_wav: Uint8Array, opts: { pad: number }): Promise<{ text: string; speech_end?: number }> {
    this.requests++;
    this.pads.push(opts.pad);
    await this.gate;
    return { text: this.script.shift() ?? "", speech_end: this.speech_end };
  }
  on(_event: "crashed", fn: (code: number | null) => void) {
    this.crash = fn;
  }
}
function session(
  script: string[],
  opts: {
    link?: FakeLink;
    timeout?: number;
    recorder?: Recorder;
    log?: (line: string) => void;
    now?: () => number;
  } = {},
) {
  const link = opts.link ?? new FakeLink(),
    whisper = new FakeWhisper(script),
    now = opts.now ?? (() => performance.now()),
    // The recorder's clock: a resume breaks by when speech began.
    segmenter = new Segmenter({ threshold: 44, timing: { silence: 0.5 }, now }),
    s = new VoiceSession({
      link,
      transcriber: whisper,
      segmenter,
      now,
      deliverTimeoutMs: opts.timeout ?? 2000,
      recorder: opts.recorder,
      log: opts.log,
    });
  return { s, link, whisper, segmenter };
}
const folders: string[] = [];
afterEach(() => {
  for (const d of folders.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A recorder with timing that never changes, and a transcript path in a fresh folder. */
function recorder() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-session-")),
    tuning = { pause_break: 2, begin: () => {}, end: () => {} } as unknown as Tuning;
  folders.push(dir);
  return { recorder: new Recorder({ tuning, now: () => performance.now() }), path: join(dir, "t.txt") };
}
const transcript = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");
/** One utterance: 1.5 s of tone, then enough silence to end it. */
function speak(s: VoiceSession) {
  const pcm = shapes.speech();
  for (let at = 0; at < pcm.length; at += 320) s.frame(pcm.subarray(at, at + 320));
}
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(5);
  expect(check()).toBe(true);
}
const statuses = (s: VoiceSession) => s.history.filter(u => u.status !== "dropped").map(u => [u.status, u.reason]);

test("utterances are typed one delivery at a time", async () => {
  const link = new FakeLink();
  let open = 0,
    most = 0;
  link.reply = async () => {
    most = Math.max(most, ++open);
    await Bun.sleep(30);
    open--;
    return { machine: "local", pane: 1, viewer: 1 };
  };
  const { s } = session(["refactor the parser", "um, add tests"], { link });
  await s.start();
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 2);
  expect(link.calls.map(c => c.value)).toEqual(["refactor the parser", "add tests"]);
  expect(most).toBe(1);
  // The UI names where the text goes.
  expect(s.focus).toBe("dictation");
});

test("a delivery that never returns fails at the bound without holding up the next", async () => {
  const link = new FakeLink();
  let first = true;
  link.reply = () => {
    if (first) {
      first = false;
      return new Promise(() => {});
    }
    return Promise.resolve({ machine: "local", pane: 1, viewer: 1 });
  };
  const { s, whisper } = session(["stuck", "next one please"], { link, timeout: 300 });
  await s.start();
  speak(s);
  await until(() => s.history[0]?.status === "delivering");
  const hung = performance.now();
  // Said while the first delivery hangs: heard and transcribed at once.
  speak(s);
  await until(() => whisper.requests === 2 && s.history[1]?.text === "next one please");
  expect(performance.now() - hung).toBeLessThan(300);
  expect(s.history[0].status).toBe("delivering");
  // Delivered as soon as the bound gives up on the first.
  await until(() => s.history[1].status === "delivered");
  expect(s.history[0]).toMatchObject({ status: "failed", reason: "no answer in time; may have been typed" });
  expect(performance.now() - hung).toBeLessThan(300 + 150);
});

test("what Corgi cannot take while it is unreachable is dropped with the reason, and never sent later", async () => {
  const link = new FakeLink(),
    why = "Corgi unreachable: daemon not running";
  let release!: () => void,
    first = true;
  link.reply = () => {
    if (!first) return Promise.resolve({ machine: "local", pane: 1, viewer: 1 });
    first = false;
    return new Promise(resolve => (release = () => resolve({ machine: "local", pane: 1, viewer: 1 })));
  };
  const { s, whisper } = session(["on its way", "transcribed already", "after"], { link });
  await s.start();
  speak(s);
  await until(() => s.history[0]?.status === "delivering");
  // Transcribed, and waiting behind the delivery in flight.
  speak(s);
  await until(() => s.history[1]?.text === "transcribed already");
  // And a sentence still being spoken.
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  expect(s.history[2].status).toBe("recording");
  link.events.emitViewer(unreachable(why));
  expect([s.link_state, s.viewer, s.reason]).toEqual(["lost", false, why]);
  // Both are dropped at once, naming Corgi; neither waits for it to come back.
  expect(statuses(s).slice(1)).toEqual([
    ["discarded", why],
    ["discarded", why],
  ]);
  // What is said meanwhile is not even transcribed.
  speak(s);
  await Bun.sleep(30);
  expect([s.history.length, whisper.requests]).toEqual([3, 2]);
  // The delivery in flight ends as Corgi answers it.
  release();
  await until(() => s.history[0].status === "delivered");
  // Corgi is back: nothing was kept to send now.
  link.events.emitViewer(seen(true, "dictation"));
  expect(s.link_state).toBe("connected");
  await Bun.sleep(50);
  expect(link.calls.map(c => c.value)).toEqual(["on its way"]);
  speak(s);
  await until(() => s.history.at(-1)?.status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["on its way", "after"]);
});

test("muting discards what is being said or transcribed", async () => {
  const { s, link, whisper } = session(["first", "second"]);
  await s.start();
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  expect(s.history[0].status).toBe("recording");
  s.setMuted(true);
  expect(statuses(s)).toEqual([["muted", null]]);
  speak(s);
  await Bun.sleep(30);
  expect(whisper.requests).toBe(0);
  expect(link.calls).toEqual([]);
  // Unmuted mid-transcription, then muted again before delivery.
  s.setMuted(false);
  let release!: (heard: { text: string }) => void;
  whisper.transcribe = () => new Promise(resolve => (release = resolve));
  speak(s);
  await until(() => s.history.at(-1)?.status === "transcribing");
  s.setMuted(true);
  release({ text: "too late" });
  await Bun.sleep(30);
  expect(s.history.at(-1)?.status).toBe("muted");
  expect(link.calls).toEqual([]);
});

test("a Whisper that falls behind is not handed more than four recordings", async () => {
  const { s, whisper, link } = session(["one", "two", "three", "four"]);
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.start();
  for (let i = 0; i < 6; i++) speak(s);
  expect(statuses(s).map(([status]) => status)).toEqual([...Array(4).fill("transcribing"), "failed", "failed"]);
  expect(s.history[5].reason).toBe("backlog");
  open();
  await until(() => statuses(s).filter(([status]) => status === "delivered").length === 4);
  expect(link.calls.map(c => c.value)).toEqual(["one", "two", "three", "four"]);
  // With the backlog cleared, speech goes through again.
  speak(s);
  await until(() => s.history.at(-1)?.status === "dropped" || s.history.at(-1)?.status === "delivered");
  expect(s.history.at(-1)?.reason).not.toBe("backlog");
});

test("a Corgi that is slow to take text is not handed more than four utterances", async () => {
  const link = new FakeLink();
  link.reply = () => new Promise(() => {});
  const { s } = session(["a", "b", "c", "d", "e", "f"], { link, timeout: 200 });
  await s.start();
  for (let i = 0; i < 6; i++) speak(s);
  await until(() => s.history[0]?.status === "delivering");
  expect(statuses(s).map(([status]) => status)).toEqual([
    "delivering",
    ...Array(3).fill("transcribing"),
    "failed",
    "failed",
  ]);
  expect(s.history[4].reason).toBe("backlog");
  await until(
    () => statuses(s).filter(([, why]) => why === "no answer in time; may have been typed").length === 4,
    3000,
  );
});

test("words that sound like commands are typed as text", async () => {
  const { s, link } = session(["Send.", "next"]);
  await s.start();
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 2);
  expect(link.calls.map(c => [c.op, c.value])).toEqual([
    ["type", "Send."],
    ["type", "next"],
  ]);
});

test("non-speech and phantom text are dropped, not typed", async () => {
  const { s, link } = session(["[BLANK_AUDIO]", "Thank you.", "um"]);
  await s.start();
  speak(s);
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "dropped").length === 3);
  expect(link.calls).toEqual([]);
});

test("a crash spares text Whisper already gave back", async () => {
  const link = new FakeLink();
  let release!: () => void,
    first = true;
  link.reply = () => {
    if (!first) return Promise.resolve({ machine: "local", pane: 1, viewer: 1 });
    first = false;
    return new Promise(resolve => (release = () => resolve({ machine: "local", pane: 1, viewer: 1 })));
  };
  const { s, whisper } = session(["held", "waiting"], { link });
  await s.start();
  speak(s);
  await until(() => s.history[0]?.status === "delivering");
  // Transcribed, and queued behind the delivery that hangs.
  speak(s);
  await until(() => s.history[1]?.text === "waiting");
  whisper.crash(3);
  expect(s.history[1].status).toBe("transcribing");
  release();
  await until(() => s.history[1].status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["held", "waiting"]);
});

test("speech during a filter switch fails as such, not as a crash", async () => {
  const { s, whisper } = session([]);
  await s.start();
  whisper.transcribe = () => Promise.reject(Error("ServerRestarting"));
  speak(s);
  await until(() => s.history[0]?.status === "failed");
  expect(s.history[0].reason).toBe("filter switching");
  expect(s.available).toBe(true);
});

test("a fresh server after a crash makes voice listen again", async () => {
  const { s, link, whisper } = session(["back again"]);
  await s.start();
  whisper.crash(3);
  expect(s.available).toBe(false);
  s.serverReady();
  expect([s.available, s.unavailable, s.server]).toEqual([true, null, "ready"]);
  // Availability stays in corgi-voice; nothing goes to Corgi.
  expect(link.calls).toEqual([]);
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["back again"]);
});

test("a server crash fails the utterance and stops listening", async () => {
  const { s, link, whisper } = session([]);
  await s.start();
  whisper.transcribe = () => new Promise(() => {});
  speak(s);
  await until(() => s.history[0]?.status === "transcribing");
  whisper.crash(3);
  expect(statuses(s)).toEqual([["failed", "server crashed"]]);
  expect([s.available, s.unavailable, s.server]).toEqual([false, "server_down", "crashed"]);
  expect(link.calls).toEqual([]);
  speak(s);
  expect(s.history).toHaveLength(1);
  s.setMuted(false);
  expect(s.available).toBe(false);
});

test("a microphone that comes back does not revive a crashed server", async () => {
  const { s, link, whisper } = session([]);
  await s.start();
  whisper.crash(3);
  s.setAvailable(false, "mic_missing");
  s.frame(new Int16Array(320));
  expect([s.available, s.unavailable]).toEqual([false, "server_down"]);
  expect(link.calls).toEqual([]);
  s.setMuted(false);
  expect(s.available).toBe(false);
});

test("a microphone that comes back makes voice available again", async () => {
  const { s, link } = session([]);
  await s.start();
  s.setAvailable(false, "mic_denied");
  expect(s.unavailable).toBe("mic_denied");
  s.frame(new Int16Array(320));
  expect([s.available, s.unavailable]).toEqual([true, null]);
  expect(link.calls).toEqual([]);
});

test("a link that cannot start makes start() reject, and nothing retries behind the caller's back", async () => {
  const link = new FakeLink();
  link.watching = async () => {
    throw Error("FileNotFound");
  };
  const { s } = session([], { link });
  await expect(s.start()).rejects.toThrow("FileNotFound");
  await Bun.sleep(60);
  expect(link.watches).toBe(1);
  expect(s.link_state).toBe("connecting");
});

test("quitting before the link's first view takes nothing from it, then or later", async () => {
  const link = new FakeLink();
  let release!: () => void;
  link.watching = () => new Promise(resolve => (release = resolve));
  const { s } = session([], { link });
  const starting = s.start();
  expect(s.link_state).toBe("connecting");
  s.close();
  release();
  await starting;
  expect(link.closed).toBe(true);
  expect([s.link_state, s.focus]).toEqual(["closed", null]);
  link.events.emitViewer(seen(true, "build"));
  expect([s.link_state, s.focus]).toEqual(["closed", null]);
});

test("without a viewer, voice holds off and drops what is in progress", async () => {
  const link = new FakeLink();
  link.viewer = false;
  const { s, whisper } = session(["lost"], { link });
  await s.start();
  expect([s.viewer, s.focus]).toEqual([false, "dictation"]);
  speak(s);
  await Bun.sleep(30);
  expect(whisper.requests).toBe(0);
  expect(s.history).toEqual([]);
  // A viewer attaches: speech counts again.
  link.events.emitViewer(seen(true, "build"));
  expect(s.focus).toBe("build");
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  expect(s.recording).toBe(true);
  // It goes away mid-sentence: the sentence is dropped, never typed later.
  link.events.emitViewer(seen(false, null));
  expect(statuses(s)).toEqual([["discarded", "no viewer"]]);
  expect(link.calls).toEqual([]);
});

test("a transcription that times out says so, not that it may have been typed", async () => {
  const { s, whisper, link } = session([]);
  await s.start();
  whisper.transcribe = () => Promise.reject(Error("Timeout"));
  speak(s);
  await until(() => s.history[0]?.status === "failed");
  expect(s.history[0].reason).toBe("timed out");
  expect(link.calls).toEqual([]);
});

test("a recording while unmuted writes each passage and types it too", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["refactor the parser", "um, add tests"], { recorder: r });
  await s.start();
  r.start(path);
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 2);
  expect(link.calls.map(c => c.value)).toEqual(["refactor the parser", "add tests"]);
  expect(transcript(path)).toBe("refactor the parser\nadd tests\n");
  expect(s.history.every(u => u.record !== null && u.speech_end > u.speech_start)).toBe(true);
});

test("a passage that began before the recording and ended after it is written", async () => {
  const { recorder: r, path } = recorder(),
    { s } = session(["straddles the start"], { recorder: r });
  await s.start();
  const pcm = shapes.speech();
  let at = 0;
  for (; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  r.start(path);
  for (; at < pcm.length; at += 320) s.frame(pcm.subarray(at, at + 320));
  await until(() => s.history[0]?.status === "delivered");
  expect(transcript(path)).toBe("straddles the start\n");
});

test("a passage that ends before the recording starts is not written", async () => {
  const { recorder: r, path } = recorder(),
    { s, whisper } = session(["before"], { recorder: r });
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.start();
  speak(s);
  r.start(path);
  open();
  await until(() => s.history[0]?.status === "delivered");
  expect(s.history[0].record).toBeNull();
  expect(transcript(path)).toBe("");
});

test("a claimed passage that comes to nothing does not hold up a stop", async () => {
  const { recorder: r, path } = recorder(),
    { s, whisper } = session(["um", ""], { recorder: r });
  await s.start();
  r.start(path);
  speak(s);
  await until(() => s.history[0]?.status === "dropped");
  let fail!: (error: Error) => void;
  whisper.transcribe = () => new Promise((_, reject) => (fail = reject));
  speak(s);
  await until(() => s.history[1]?.status === "transcribing" && fail !== undefined);
  const stopping = r.stop(5000);
  fail(Error("Timeout"));
  const started = performance.now();
  expect(await stopping).toMatchObject({ late: 0 });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(s.history[1].status).toBe("failed");
  expect(transcript(path)).toBe("");
});

/** The first second of an utterance: speech is still in progress. */
function begin(s: VoiceSession, pcm: Int16Array) {
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
}
function end(s: VoiceSession, pcm: Int16Array) {
  for (let at = 16000; at < pcm.length; at += 320) s.frame(pcm.subarray(at, at + 320));
}

test("muted while recording, speech is written but never typed", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["a call", "goes on"], { recorder: r });
  await s.start();
  s.setMuted(true);
  r.start(path);
  speak(s);
  speak(s);
  await until(() => s.history.filter(u => u.status === "recorded").length === 2);
  expect(statuses(s)).toEqual([
    ["recorded", "muted"],
    ["recorded", "muted"],
  ]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("a call\ngoes on\n");
});

test("muted with the recording paused, audio is dropped as before", async () => {
  const { recorder: r, path } = recorder(),
    { s, whisper, link } = session(["private"], { recorder: r });
  await s.start();
  r.start(path);
  r.pause();
  s.setMuted(true);
  speak(s);
  await Bun.sleep(30);
  expect(whisper.requests).toBe(0);
  expect(s.history).toEqual([]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("");
});

test("a mute in the middle of a passage still writes it, untyped", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["half muted"], { recorder: r });
  await s.start();
  r.start(path);
  const pcm = shapes.speech();
  begin(s, pcm);
  s.setMuted(true);
  expect(s.recording).toBe(true);
  end(s, pcm);
  await until(() => s.history[0]?.status === "recorded");
  expect(statuses(s)).toEqual([["recorded", "muted"]]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("half muted\n");
});

test("speech that began muted stays untyped after an unmute", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["private aside"], { recorder: r });
  await s.start();
  r.start(path);
  s.setMuted(true);
  const pcm = shapes.speech();
  begin(s, pcm);
  s.setMuted(false);
  end(s, pcm);
  await until(() => s.history[0]?.status === "recorded");
  expect(statuses(s)).toEqual([["recorded", "muted"]]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("private aside\n");
});

test("speech that began without a viewer stays untyped when one attaches", async () => {
  const { recorder: r, path } = recorder(),
    link = new FakeLink(),
    { s } = session(["before the window"], { link, recorder: r });
  await s.start();
  r.start(path);
  link.events.emitViewer(seen(false, null));
  const pcm = shapes.speech();
  begin(s, pcm);
  link.events.emitViewer(seen(true, "dictation"));
  end(s, pcm);
  await until(() => s.history[0]?.status === "recorded");
  expect(statuses(s)).toEqual([["recorded", "no viewer attached"]]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("before the window\n");
});

test("a passage recorded while a machine is unreachable says so, not 'no viewer'", async () => {
  const { recorder: r, path } = recorder(),
    link = new FakeLink(),
    { s } = session(["while marovo is away"], { link, recorder: r });
  await s.start();
  r.start(path);
  link.events.emitViewer(unreachable("marovo unreachable: no answer in time"));
  const pcm = shapes.speech();
  begin(s, pcm);
  end(s, pcm);
  await until(() => s.history[0]?.status === "recorded");
  expect(statuses(s)).toEqual([["recorded", "marovo unreachable: no answer in time"]]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("while marovo is away\n");
});

test("speech dropped when its machine stops answering names the machine", async () => {
  const link = new FakeLink(),
    { s } = session(["never typed"], { link });
  await s.start();
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  expect(s.recording).toBe(true);
  link.events.emitViewer(unreachable("marovo unreachable: no answer in time"));
  expect(statuses(s)).toEqual([["discarded", "marovo unreachable: no answer in time"]]);
  expect(link.calls).toEqual([]);
});

test("a recorded passage whose typing gets no answer may have been typed", async () => {
  const { recorder: r, path } = recorder(),
    link = new FakeLink(),
    { s } = session(["slow to answer"], { link, recorder: r, timeout: 30 });
  link.reply = () => new Promise(() => {});
  await s.start();
  r.start(path);
  speak(s);
  await until(() => s.history[0]?.status === "recorded");
  expect(s.history[0]).toMatchObject({
    status: "recorded",
    reason: "no answer in time; may have been typed",
    maybe_typed: true,
  });
  expect(link.calls.map(c => c.value)).toEqual(["slow to answer"]);
  expect(transcript(path)).toBe("slow to answer\n");
});

test("muted, a passage cut off by a pause or a stop is dropped, unheard and unwritten", async () => {
  for (const end_recording of ["pause", "stop"] as const) {
    const { recorder: r, path } = recorder(),
      { s, whisper, link } = session(["private"], { recorder: r });
    await s.start();
    r.start(path);
    s.setMuted(true);
    const pcm = shapes.speech();
    begin(s, pcm);
    expect(s.recording).toBe(true);
    if (end_recording === "pause") r.pause();
    else void r.stop();
    end(s, pcm);
    await Bun.sleep(30);
    expect(statuses(s)).toEqual([["muted", null]]);
    expect(s.recording).toBe(false);
    expect(whisper.requests).toBe(0);
    expect(link.calls).toEqual([]);
    expect(transcript(path)).toBe("");
  }
});

test("a recording asks nothing more of the link: only the passage that is typed reaches it", async () => {
  const { recorder: r, path } = recorder(),
    link = new FakeLink(),
    { s } = session(["typed and kept", "kept only"], { link, recorder: r });
  await s.start();
  r.start(path);
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  s.setMuted(true);
  speak(s);
  await until(() => s.history[1]?.status === "recorded");
  r.pause();
  r.resume();
  await r.stop();
  // The mute, the pause and the stop are no calls; what the corgi command
  // itself is given is checked in corgi/integration.test.ts (FR-015).
  expect(link.calls.map(c => [c.op, c.value])).toEqual([["type", "typed and kept"]]);
  expect(transcript(path)).toBe("typed and kept\nkept only\n");
});

test("a viewer that leaves mid-passage leaves it written and untyped", async () => {
  const { recorder: r, path } = recorder(),
    link = new FakeLink(),
    { s } = session(["nobody watching", "still nobody"], { link, recorder: r });
  await s.start();
  r.start(path);
  const pcm = shapes.speech();
  begin(s, pcm);
  link.events.emitViewer(seen(false, null));
  end(s, pcm);
  // And speech while no viewer is attached is heard too.
  speak(s);
  await until(() => s.history.filter(u => u.status === "recorded").length === 2);
  expect(statuses(s)).toEqual([
    ["recorded", "no viewer attached"],
    ["recorded", "no viewer attached"],
  ]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("nobody watching\nstill nobody\n");
});

test("while Corgi is unreachable, a recorded passage is written and says why it was not typed", async () => {
  const { recorder: r, path } = recorder(),
    link = new FakeLink(),
    { s } = session(["offline"], { link, recorder: r });
  await s.start();
  link.events.emitViewer(unreachable("Corgi unreachable: daemon not running"));
  expect(s.link_state).toBe("lost");
  r.start(path);
  speak(s);
  await until(() => s.history[0]?.status === "recorded");
  expect(statuses(s)).toEqual([["recorded", "Corgi unreachable: daemon not running"]]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("offline\n");
  s.close();
});

test("a typing backlog never drops a recorded passage from the transcript", async () => {
  const { recorder: r, path } = recorder(),
    { s, whisper } = session(["one", "two", "three", "four", "five", "six"], { recorder: r });
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.start();
  r.start(path);
  for (let i = 0; i < 6; i++) speak(s);
  expect(statuses(s).map(([status]) => status)).toEqual(Array(6).fill("transcribing"));
  open();
  await until(() => s.history.every(u => u.status === "delivered" || u.status === "recorded"));
  expect(statuses(s)).toEqual([
    ...Array(4).fill(["delivered", null]),
    ["recorded", "backlog"],
    ["recorded", "backlog"],
  ]);
  expect(transcript(path)).toBe("one\ntwo\nthree\nfour\nfive\nsix\n");
});

test("past max_queued passages waiting for Whisper, a recorded one is left out and the recording says so", async () => {
  const { recorder: r, path } = recorder(),
    script = Array.from({ length: max_queued + 2 }, (_, i) => `p${i}`),
    { s, whisper } = session(script, { recorder: r });
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.start();
  r.start(path);
  for (let i = 0; i <= max_queued; i++) speak(s);
  const last = s.history.at(-1)!;
  expect([last.status, last.reason, last.record]).toEqual(["failed", "backlog", null]);
  expect(r.notices.at(-1)?.text).toContain("left out of the transcript");
  open();
  await until(() => s.history.slice(0, -1).every(u => u.status === "delivered" || u.status === "recorded"));
  expect(transcript(path).trim().split("\n")).toHaveLength(max_queued);
  // Once Whisper caught up, a passage is queued, written and typed again.
  speak(s);
  await until(() => s.history.at(-1)?.status === "delivered");
  expect(transcript(path).trim().split("\n")).toHaveLength(max_queued + 1);
}, 20_000);

test("a passage while paused is typed but not written; the next one after resume starts a contribution", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["before", "aside", "after"], { recorder: r });
  await s.start();
  r.start(path);
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  r.pause();
  speak(s);
  await until(() => s.history[1]?.status === "delivered");
  expect(s.history[1].record).toBeNull();
  r.resume();
  speak(s);
  await until(() => s.history[2]?.status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["before", "aside", "after"]);
  expect(transcript(path)).toBe("before\n\nafter\n");
});

test("a passage muted and unmuted while it is said is written but not typed", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["on and off"], { recorder: r });
  await s.start();
  r.start(path);
  const pcm = shapes.speech();
  begin(s, pcm);
  s.setMuted(true);
  s.setMuted(false);
  end(s, pcm);
  await until(() => s.history[0]?.status === "recorded");
  expect(statuses(s)).toEqual([["recorded", "muted"]]);
  expect(link.calls).toEqual([]);
  expect(transcript(path)).toBe("on and off\n");
});

test("a change in the machine or the reason alone reaches the window", async () => {
  const link = new FakeLink(),
    { s } = session([], { link });
  await s.start();
  let changes = 0;
  s.on("change", () => changes++);
  link.events.emitViewer({ viewer: true, focus: "dictation", machine: "marovo", reason: null, why: null });
  expect([s.machine, changes]).toEqual(["marovo", 1]);
  link.events.emitViewer(seen(false, null));
  expect([s.viewer, s.reason, s.why, changes]).toEqual([false, "no viewer attached", "no_viewer", 2]);
  const misread: Seen = {
    viewer: false,
    focus: null,
    machine: null,
    reason: "Corgi output not understood",
    why: "not_understood",
  };
  link.events.emitViewer(misread);
  expect([s.reason, s.why, changes]).toEqual(["Corgi output not understood", "not_understood", 3]);
  // Output that is not understood is no lost link: Corgi answers.
  expect(s.link_state).toBe("connected");
  // The same view again is no change.
  link.events.emitViewer({ ...misread });
  expect(changes).toBe(3);
});

test("while Corgi does not answer the link is lost, and back once it does", async () => {
  const link = new FakeLink(),
    lines: string[] = [],
    { s } = session(["later"], { link, log: line => lines.push(line) });
  expect(s.link_state).toBe("connecting");
  await s.start();
  expect(s.link_state).toBe("connected");
  link.events.emitViewer(unreachable("Corgi unreachable: corgi not found: /x/corgi"));
  expect([s.link_state, s.viewer, s.reason]).toEqual(["lost", false, "Corgi unreachable: corgi not found: /x/corgi"]);
  // Nothing is transcribed for dictation meanwhile.
  speak(s);
  await Bun.sleep(30);
  expect(s.history).toEqual([]);
  link.events.emitViewer(seen(true, "dictation"));
  expect(s.link_state).toBe("connected");
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["later"]);
  // Each change of the link's state is one line in the log.
  expect(lines.filter(l => l.startsWith("link:"))).toEqual([
    "link: connected",
    "link: lost (Corgi unreachable: corgi not found: /x/corgi)",
    "link: connected",
  ]);
});

test("the link's state follows the typed cause, never the words of the reason", async () => {
  const link = new FakeLink(),
    { s } = session([], { link });
  await s.start();
  // A machine that stopped answering under a viewer: lost, whatever it is called.
  link.events.emitViewer({ viewer: false, focus: null, machine: null, reason: "gone quiet", why: "unreachable" });
  expect(s.link_state).toBe("lost");
  // No viewer, in words that happen to say "unreachable": Corgi answers, so the link is there.
  link.events.emitViewer({ viewer: false, focus: null, machine: null, reason: "unreachable", why: "no_viewer" });
  expect(s.link_state).toBe("connected");
});

test("a missing viewer with those words as its reason is still a plain 'no viewer'", async () => {
  // The row's text comes from the cause, not from comparing the reason with a known sentence.
  const link = new FakeLink(),
    { s } = session(["dropped"], { link });
  await s.start();
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  link.events.emitViewer({ viewer: false, focus: null, machine: null, reason: "nobody is here", why: "no_viewer" });
  expect(statuses(s)).toEqual([["discarded", "no viewer"]]);
});

test("reasons from the link show in the history as they are", async () => {
  const link = new FakeLink();
  const reasons = ["pane gone", "marovo unreachable", "corgi exited with code 3"];
  let i = 0;
  link.reply = async () => {
    throw Error(reasons[i++]);
  };
  const { s } = session(["first words", "second words", "third words", "fourth words", "fifth words"], { link });
  await s.start();
  for (let n = 0; n < 3; n++) speak(s);
  await until(() => s.history.filter(u => u.status === "failed").length === 3);
  expect(statuses(s)).toEqual(reasons.map(r => ["failed", r]));
  link.reply = async () => {
    throw Error("VoicePane");
  };
  speak(s);
  await until(() => s.history[3]?.status === "failed");
  expect(s.history[3].reason).toBe("focused pane is the voice pane");
  link.reply = async () => {
    throw Error("NoViewer");
  };
  speak(s);
  await until(() => s.history[4]?.status === "failed");
  expect(s.history[4].reason).toBe("no viewer attached");
});

test("the session's safety net lies above the link's delivery bound, which decides", () => {
  expect(deadline_ms).toBe(2000);
  expect(safety_ms).toBe(2500);
  expect(safety_ms).toBeGreaterThan(deadline_ms);
});

test("something thrown where nothing should be fails that utterance alone, is logged, and the next goes on", async () => {
  const lines: string[] = [],
    { s, whisper, link } = session(["first", "second", "third"], { log: line => lines.push(line) });
  await s.start();
  // Whisper answers with no text at all: cleaning it throws, past every catch of the pipeline.
  const transcribe = whisper.transcribe.bind(whisper);
  whisper.transcribe = async () => ({ text: undefined as unknown as string });
  speak(s);
  await until(() => s.history[0]?.status === "failed");
  whisper.transcribe = transcribe;
  speak(s);
  await until(() => s.history[1]?.status === "delivered");
  // A listener that throws as a delivery starts, before the delivery's own catch.
  let thrown = false;
  s.on("change", () => {
    if (!thrown && s.history.at(-1)?.status === "delivering") {
      thrown = true;
      throw Error("listener broke");
    }
  });
  speak(s);
  await until(() => s.history[2]?.status === "failed");
  expect(s.history[2].reason).toBe("listener broke");
  speak(s);
  await until(() => s.history[3]?.status === "delivered");
  // Neither chain is wedged: what came after each failure was typed.
  expect(link.calls.map(c => c.value)).toEqual(["first", "third"]);
  expect(lines.filter(l => l.includes("unexpected error"))).toEqual([
    expect.stringMatching(/^utterance 1: unexpected error: /),
    expect.stringMatching(/^utterance 3: unexpected error: Error: listener broke/),
  ]);
});

test("the session's own delivery bound is a 2.5 s safety net", async () => {
  const link = new FakeLink();
  link.reply = () => new Promise(() => {});
  const s = new VoiceSession({
    link,
    transcriber: new FakeWhisper(["slow"]),
    segmenter: new Segmenter({ threshold: 44, timing: { silence: 0.5 }, now: () => performance.now() }),
    now: () => performance.now(),
  });
  await s.start();
  speak(s);
  await until(() => s.history[0]?.status === "delivering");
  const started = performance.now();
  await until(() => s.history[0]?.status === "failed", 4000);
  expect(performance.now() - started).toBeGreaterThanOrEqual(2400);
  expect(s.history[0].reason).toBe("no answer in time; may have been typed");
  s.close();
});

test("a passage that is only a sound marker is neither written, shown nor typed", async () => {
  const { recorder: r, path } = recorder(),
    { s, link } = session(["*clap*", "(music)", "[laughter]", "real words"], { recorder: r });
  await s.start();
  r.start(path);
  for (let i = 0; i < 4; i++) speak(s);
  await until(() => s.history.some(u => u.status === "delivered"));
  await until(() => s.history.filter(u => u.status === "dropped").length >= 3);
  expect(s.history.filter(u => u.status === "dropped").map(u => u.reason)).toEqual(["not speech", "not speech", "not speech"]);
  expect(link.calls.map(c => c.value)).toEqual(["real words"]);
  expect(transcript(path)).toBe("real words\n");
});

/** Feeds 20 ms frames of `pcm`, moving `clock` along with them when given. */
function play(s: VoiceSession, pcm: Int16Array, clock?: { t: number }) {
  for (let at = 0; at < pcm.length; at += 320) {
    if (clock) clock.t += 20;
    s.frame(pcm.subarray(at, at + 320));
  }
}
/** Feeds `seconds` of a tone at threshold-scale level `pct`, a frame at a time. */
function hum(s: VoiceSession, pct: number, seconds = 10, clock?: { t: number }) {
  play(s, tone(seconds, level.percentToRms(pct)), clock);
}
/** The level a tone at `pct` measures, frame by frame. */
const measured = (pct: number) => level.rmsToPercent(level.rms(tone(0.02, level.percentToRms(pct))));

test("a gauge listens 10 s, then sets the threshold just above the background", async () => {
  const lines: string[] = [],
    clock = { t: 0 },
    { s, segmenter, link } = session(["after the gauge"], { log: line => lines.push(line), now: () => clock.t });
  await s.start();
  expect(s.startGauge()).toBeNull();
  expect(s.gauge).toEqual({ frames: [], loudest: 0, progress: 0 });
  hum(s, 55.5, 5, clock);
  expect(s.gauge?.progress).toBe(0.5);
  expect(s.gauge?.loudest).toBeCloseTo(measured(55.5), 5);
  hum(s, 55.5, 5, clock);
  expect(s.gauge).toBeNull();
  expect(segmenter.percent).toBe(58);
  expect(s.gauges).toHaveLength(1);
  expect(s.gauges[0]).toMatchObject({ old: 44, threshold: 58, outcome: "no_speech_to_compare" });
  expect(s.gauges[0].took_ms).toBe(10000);
  expect(lines.filter(l => l.startsWith("gauge:"))).toEqual([
    expect.stringMatching(/^gauge: threshold 44 → 58 loudest=55\.\d outcome=no_speech_to_compare took_ms=10000$/),
  ]);
  // The same hum now starts nothing, and speech above the threshold is typed as before.
  hum(s, 55.5, 3, clock);
  expect(s.history).toEqual([]);
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["after the gauge"]);
  expect(s.muted).toBe(false);
});

test("a gauge sets the threshold through the tuning when one is wired", async () => {
  const set: number[] = [],
    link = new FakeLink(),
    segmenter = new Segmenter({ threshold: 44, now: () => 0 }),
    s = new VoiceSession({
      link,
      transcriber: new FakeWhisper([]),
      segmenter,
      now: () => 0,
      setThreshold: pct => set.push(pct),
    });
  await s.start();
  s.startGauge();
  hum(s, 55.5);
  expect(set).toEqual([58]);
});

test("a gauge replays with the timings in effect, not the defaults", async () => {
  const { s, segmenter } = session([]);
  await s.start();
  const usual = (() => {
    const t = session([]);
    void t.s.start();
    t.s.startGauge();
    play(t.s, music(10, 7));
    return t.segmenter.percent;
  })();
  segmenter.setTiming("min_speech", 1);
  s.startGauge();
  play(s, music(10, 7));
  // Clicks are too short to make a second of speech: only the notes count.
  expect(segmenter.percent).toBeLessThan(usual);
});

test("quitting during a gauge ends it, with no row and the threshold as it was", async () => {
  const lines: string[] = [],
    { s, segmenter } = session([], { log: line => lines.push(line) });
  await s.start();
  s.startGauge();
  hum(s, 60, 4);
  s.close();
  expect(s.gauge).toBeNull();
  hum(s, 60, 6);
  expect([s.gauge, s.gauges, segmenter.percent]).toEqual([null, [], 44]);
  expect(lines.filter(l => l.startsWith("gauge:"))).toEqual([]);
});

test("without a microphone, or during a recording, a gauge does not start", async () => {
  const { s } = session([]);
  await s.start();
  s.setAvailable(false, "mic_busy");
  expect(s.startGauge()).toBe("mic_busy");
  expect(s.gauge).toBeNull();
  // A crashed server is no reason: the gauge needs only the microphone.
  const crashed = session([]);
  await crashed.s.start();
  crashed.whisper.crash(3);
  expect(crashed.s.startGauge()).toBeNull();
  // A recording has a threshold of its own.
  const { recorder: r, path } = recorder(),
    rec = session([], { recorder: r });
  await rec.s.start();
  r.start(path);
  expect(rec.s.startGauge()).toBe("recording");
  expect(rec.s.gauge).toBeNull();
});

test("a gauge drops what is being said, but what Whisper has goes on to be typed", async () => {
  const { s, whisper, link } = session(["first words", "lost"]);
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.start();
  speak(s);
  expect(s.history[0].status).toBe("transcribing");
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.frame(pcm.subarray(at, at + 320));
  expect(s.history[1].status).toBe("recording");
  s.startGauge();
  expect(s.history.map(u => u.status)).toEqual(["transcribing", "dropped"]);
  speak(s);
  expect(s.history).toHaveLength(2);
  expect(s.pause).toBe(0);
  open();
  await until(() => s.history[0].status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["first words"]);
  expect(whisper.requests).toBe(1);
  expect(s.gauge).not.toBeNull();
});

test("mute, a missing viewer or a crashed server do not stop a gauge", async () => {
  const cases: [string, (t: ReturnType<typeof session>) => void][] = [
    ["muted", t => t.s.setMuted(true)],
    ["no viewer", t => t.link.events.emitViewer(seen(false, null))],
    ["server crashed", t => t.whisper.crash(3)],
  ];
  for (const [name, upset] of cases) {
    const t = session([]);
    await t.s.start();
    upset(t);
    expect(t.s.startGauge()).toBeNull();
    hum(t.s, 60);
    expect([name, t.s.gauges.map(g => g.threshold)]).toEqual([name, [Math.floor(measured(60)) + 3]]);
    t.s.close();
  }
});

test("a cancelled gauge leaves no row and the threshold as it was", async () => {
  const lines: string[] = [],
    { s, segmenter, link } = session(["after"], { log: line => lines.push(line) });
  await s.start();
  s.startGauge();
  hum(s, 70, 4);
  s.cancelGauge();
  expect([s.gauge, s.gauges, segmenter.percent]).toEqual([null, [], 44]);
  expect(lines.filter(l => l.startsWith("gauge:"))).toEqual([]);
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  expect(link.calls.map(c => c.value)).toEqual(["after"]);
});

test("a microphone that fails mid-gauge ends it with a row, and the threshold stays", async () => {
  const lines: string[] = [],
    { s, segmenter } = session([], { log: line => lines.push(line) });
  await s.start();
  s.startGauge();
  hum(s, 70, 4);
  s.setAvailable(false, "mic_denied");
  expect(s.gauge).toBeNull();
  expect(s.gauges).toEqual([expect.objectContaining({ old: 44, threshold: 44, outcome: "mic_failed" })]);
  expect(segmenter.percent).toBe(44);
  expect(lines).toContainEqual(
    expect.stringMatching(/^gauge: threshold 44 → 44 loudest=70(\.\d)? outcome=mic_failed took_ms=[\d.]+$/),
  );
  hum(s, 0, 0.02);
  expect(s.available).toBe(true);
});

test("music too loud to gauge leaves the threshold, and says so", async () => {
  const { s, segmenter } = session([]);
  await s.start();
  s.startGauge();
  play(s, tone(10, 0.6));
  expect(s.gauges).toEqual([expect.objectContaining({ old: 44, threshold: 44, loudest: 100, outcome: "too_loud" })]);
  expect(segmenter.percent).toBe(44);
});

test("delivered utterances keep their peak, and a gauge above most of them warns", async () => {
  const { s, segmenter } = session(["one", "two", "three"]);
  await s.start();
  for (let i = 0; i < 3; i++) speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 3);
  // shapes.speech() is a tone at RMS 0.1.
  const peak = level.rmsToPercent(level.rms(tone(0.02, 0.1)));
  for (const u of s.history) expect(u.peak).toBeCloseTo(peak, 5);
  s.startGauge();
  hum(s, peak);
  expect(s.gauges.at(-1)).toMatchObject({ outcome: "applied_quiet_speech", threshold: Math.floor(peak) + 3 });
  expect(segmenter.percent).toBe(Math.floor(peak) + 3);
  s.startGauge();
  hum(s, 50.5);
  expect(s.gauges.at(-1)).toMatchObject({ outcome: "applied", threshold: 53 });
});

test("only delivered utterances count against a gauge's result", async () => {
  const { s } = session(["loud words", "", ""]);
  await s.start();
  speak(s);
  for (let i = 0; i < 2; i++) play(s, concat(tone(1.5, level.percentToRms(50.5)), silence(3)));
  await until(() => s.history.filter(u => u.status === "dropped" && u.reason === "empty").length === 2);
  expect(s.history.filter(u => u.status === "delivered")).toHaveLength(1);
  s.startGauge();
  hum(s, 55.5);
  expect(s.gauges.at(-1)).toMatchObject({ outcome: "applied", threshold: 58 });
});

test("the peak leaves out the pause the cut kept, so a gauge compares speech", async () => {
  const { s, segmenter } = session(["short"]);
  await s.start();
  // 0.2 s of speech and the whole 2.5 s pause: most of the audio is quiet.
  segmenter.setTiming("silence", 2.5);
  segmenter.setTiming("post_roll", Infinity);
  play(s, concat(tone(0.2, 0.1), silence(3)));
  await until(() => s.history[0]?.status === "delivered");
  expect(s.history[0].cut).toEqual({ post_roll: 2.5, kept: 2.5, dropped: 0, capped: false });
  expect(s.history[0].peak).toBeCloseTo(level.rmsToPercent(level.rms(tone(0.02, 0.1))), 5);
});

test("the speech filter pads by the post-roll each utterance ended with", async () => {
  const { s, whisper, segmenter } = session(["one", "two", "three", "four"]);
  let open!: () => void;
  whisper.gate = new Promise(resolve => (open = resolve));
  await s.start();
  // The default 1 s, within the tests' 0.5 s silence window.
  speak(s);
  speak(s);
  // Changed while the second waits behind the first: it keeps its own.
  segmenter.setTiming("post_roll", 0);
  open();
  await until(() => s.history.filter(u => u.status === "delivered").length === 2);
  expect(whisper.pads).toEqual([0.5, 0.5]);
  // None at all; whisper.ts keeps the filter's own 30 ms.
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 3);
  expect(whisper.pads).toEqual([0.5, 0.5, 0]);
  expect(s.history[2].pad).toBe(0.03);
  // Whole pause pads by the silence window, here 0.5 s.
  segmenter.setTiming("post_roll", Infinity);
  speak(s);
  await until(() => s.history.filter(u => u.status === "delivered").length === 4);
  expect(whisper.pads).toEqual([0.5, 0.5, 0, 0.5]);
});

test("the log says what the cut kept and where Whisper heard the speech end", async () => {
  const lines: string[] = [],
    { s, whisper, segmenter } = session(["run the tests again", "send", "it"], { log: line => lines.push(line) });
  // The real server reports times such as this one.
  whisper.speech_end = 4.2700000000000005;
  await s.start();
  speak(s);
  await until(() => s.history[0]?.status === "delivered");
  expect(lines.find(l => l.startsWith("utterance 1:"))).toMatch(
    /^utterance 1: delivered duration=2s transcribe_ms=[\d.]+ deliver_ms=[\d.]+ post_roll=0\.5s kept=0\.5s dropped=0s pad=0\.5s speech_end=4\.27s$/,
  );
  // Without segment times, there is no speech end.
  whisper.speech_end = undefined;
  segmenter.setTiming("post_roll", 0.3);
  speak(s);
  await until(() => s.history[1]?.status === "delivered");
  expect(lines.find(l => l.startsWith("utterance 2:"))).toMatch(/ post_roll=0\.3s kept=0\.3s dropped=0\.2s pad=0\.3s$/);
  // The cut reports the 20 ms frames it kept: 0.75 s is 38 of them.
  segmenter.setTiming("silence", 2.5);
  segmenter.setTiming("post_roll", 0.75);
  speak(s);
  await until(() => s.history[2]?.status === "delivered");
  expect(lines.find(l => l.startsWith("utterance 3:"))).toMatch(
    / post_roll=0\.76s kept=0\.76s dropped=1\.74s pad=0\.76s$/,
  );
});

test("an utterance cut at 30 s logs no post-roll, as none was applied", async () => {
  const lines: string[] = [],
    { s } = session(["a long one", ""], { log: line => lines.push(line) });
  await s.start();
  // The cap comes 0.2 s into the pause, before the 0.5 s window ends it.
  play(s, concat(tone(29.8), silence(1)));
  await until(() => s.history[0]?.status === "delivered");
  expect(lines.find(l => l.startsWith("utterance 1:"))).toMatch(
    /^utterance 1: delivered duration=30s transcribe_ms=[\d.]+ deliver_ms=[\d.]+ capped kept=0\.2s dropped=0s pad=0\.5s$/,
  );
});

test("unmuting waits for a voice that can listen, but restoring the earlier state does not", async () => {
  const { s } = session([]);
  await s.start();
  s.setMuted(true);
  s.setAvailable(false, "mic_missing");
  s.setMuted(false);
  expect(s.muted).toBe(true);
  s.setMuted(false, true);
  expect(s.muted).toBe(false);
});

/** A session and recorder on one clock that moves 20 ms with each frame, as live audio does. */
function clocked(script: string[]) {
  let clock = 1_000_000;
  const dir = mkdtempSync(join(tmpdir(), "corgi-session-"));
  folders.push(dir);
  const tuning = { pause_break: 2, begin: () => {}, end: () => {} } as unknown as Tuning,
    r = new Recorder({ tuning, now: () => clock }),
    made = session(script, { recorder: r, now: () => clock }),
    play = (pcm: Int16Array) => {
      for (let at = 0; at < pcm.length; at += 320) {
        clock += 20;
        made.s.frame(pcm.subarray(at, at + 320));
      }
    };
  return { ...made, r, play, a: join(dir, "a.txt"), b: join(dir, "b.txt") };
}

test("a passage whose speech ended before a pause, in its silence window, is written (FR-004a)", async () => {
  const { s, r, play, a } = clocked(["said before the pause"]);
  await s.start();
  r.start(a);
  play(concat(tone(1.5), silence(0.2)));
  r.pause();
  play(silence(3));
  await until(() => s.history[0]?.status === "delivered" || s.history[0]?.status === "recorded");
  expect(transcript(a)).toBe("said before the pause\n");
});

test("a passage whose speech ended before a stop goes to that file, not to one started right after", async () => {
  const { s, r, play, a, b } = clocked(["the last words of a", "the first words of b"]);
  await s.start();
  r.start(a);
  play(concat(tone(1.5), silence(0.2)));
  const stopped = r.stop()!;
  r.start(b);
  play(silence(3));
  expect(await stopped).toEqual({ path: a, late: 0 });
  expect(transcript(a)).toBe("the last words of a\n");
  play(concat(tone(1.5), silence(3)));
  await until(() => transcript(b) === "the first words of b\n");
});

test("speech that goes on past a stop is not written to the stopped recording", async () => {
  const { s, r, play, a } = clocked(["still talking"]);
  await s.start();
  r.start(a);
  play(tone(1));
  const stopped = r.stop()!;
  play(concat(tone(1), silence(3)));
  expect(await stopped).toEqual({ path: a, late: 0 });
  await until(() => s.history[0]?.status === "delivered");
  expect(transcript(a)).toBe("");
});

test("a stop does not wait for, or count as late, speech that goes on past its bound", async () => {
  const { s, r, play, a } = clocked(["kept talking"]);
  await s.start();
  r.start(a);
  play(tone(1));
  const stopped = r.stop(100)!;
  play(tone(0.5));
  expect(await stopped).toEqual({ path: a, late: 0 });
  play(concat(tone(0.5), silence(3)));
  await until(() => s.history[0]?.status === "delivered");
  expect(transcript(a)).toBe("");
});

test("a stop holding the passage in progress settles at once when that passage is dropped", async () => {
  const { s, r, play, a } = clocked([]);
  await s.start();
  r.start(a);
  play(tone(0.06));
  const started = Date.now(),
    stopped = r.stop(5000)!;
  // Too short to count: dropped, and the stop need not wait for it.
  play(silence(3));
  expect(await stopped).toEqual({ path: a, late: 0 });
  expect(Date.now() - started).toBeLessThan(1000);
});

test("speech that goes on past a pause is not written to the paused recording", async () => {
  const { s, r, play, a } = clocked(["over the pause"]);
  await s.start();
  r.start(a);
  play(tone(1));
  r.pause();
  play(concat(tone(1), silence(3)));
  await until(() => s.history[0]?.status === "delivered");
  expect(transcript(a)).toBe("");
});

test("a passage begun without a viewer and cut loose by a pause keeps its reason and is never transcribed", async () => {
  const { s, r, play, a, link, whisper } = clocked(["never typed"]);
  await s.start();
  r.start(a);
  link.events.emitViewer(unreachable("marovo unreachable: no answer in time"));
  play(tone(1));
  expect(s.recording).toBe(true);
  r.pause();
  // The viewer is back before the speech ends; the passage stays untyped, and unwritten.
  link.events.emitViewer(seen(true, "dictation"));
  play(concat(tone(1), silence(3)));
  await Bun.sleep(30);
  expect(statuses(s)).toEqual([["discarded", "marovo unreachable: no answer in time"]]);
  expect(whisper.requests).toBe(0);
  expect(link.calls).toEqual([]);
  expect(transcript(a)).toBe("");
});

test("quitting in the silence window of a passage that ended before the stop counts it as left out", async () => {
  const { s, r, play, a } = clocked(["just before quit"]);
  await s.start();
  r.start(a);
  play(concat(tone(1.5), silence(0.2)));
  void r.stop();
  // A second quit press: close everything now.
  expect(r.finish()).toEqual([{ path: a, late: 1 }]);
  play(silence(3));
  await until(() => s.history[0]?.status !== "transcribing" && s.history[0]?.status !== "recording");
  expect(transcript(a)).toBe("");
});

test("speech that went on past a stop is not late, even when the bound or a quit lands between words", async () => {
  // The stop's bound passes in a short gap of speech that began after the stop.
  const one = clocked(["went on"]);
  await one.s.start();
  one.r.start(one.a);
  one.play(tone(1));
  const stopped = one.r.stop(100)!;
  one.play(concat(tone(0.5), silence(0.1)));
  expect(await stopped).toEqual({ path: one.a, late: 0 });
  // A second quit press in a short gap of speech that went on 1 s past the stop.
  const two = clocked(["went on too"]);
  await two.s.start();
  two.r.start(two.a);
  two.play(tone(1));
  void two.r.stop();
  two.play(concat(tone(1), silence(0.2)));
  expect(two.r.finish()).toEqual([{ path: two.a, late: 0 }]);
});
