import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flags, message, quitter, lateMessage, muteWhileRecording, usage, version, main, ownPaneFrom } from "../src/main";
import { fakeCorgi } from "./fixtures/corgi";
import * as paths from "../src/util/paths";
import { acquire, type Lock } from "../src/util/lock";
import { Recorder } from "../src/voice/recorder";
import type { Tuning } from "../src/voice/tuning";
import type { Utterance } from "../src/voice/session";
import * as settings from "../src/voice/settings";
import pkg from "../package.json" with { type: "json" };

test("flags override settings within their ranges", () => {
  expect(
    flags([
      "--corgi",
      "/opt/corgi/bin/corgi",
      "--model",
      "small.en",
      "--threshold",
      "60",
      "--silence",
      "1.5",
      "--port",
      "9000",
      "--device",
      "1",
      "--no-filter",
      "--verbose",
    ]),
  ).toEqual({
    corgi: "/opt/corgi/bin/corgi",
    model: "small.en",
    threshold: 60,
    silence: 1.5,
    port: 9000,
    device: "1",
    speech_filter: false,
    verbose: true,
  });
  expect(flags([])).toEqual({});
  for (const bad of [
    ["--model", "large"],
    ["--threshold", "101"],
    ["--threshold", "4.5"],
    ["--silence", "0.2"],
    ["--port", "80"],
    ["--port", ""],
    // --ssh is gone; remote machines come through Corgi.
    ["--ssh", "devbox"],
    ["--corgi"],
    ["--corgi", "-x"],
    ["--corgi", " "],
    ["--setup", "--threshold", "10"],
    ["--device"],
    // Post-roll, like the other timings but silence, is set in voice.json or live.
    ["--post-roll", "1"],
    ["--bogus"],
  ])
    expect(() => flags(bad)).toThrow("Usage");
});

test("startup failures read as the CLI contract words them", () => {
  const local = { model: "base.en", port: 8234 };
  const say = (name: string, s: { model: string; port: number | null } = local) => message(Error(name), s);
  expect(say("ModelMissing")).toBe("voice model base.en is not installed; run: corgi-voice --setup --model base.en");
  expect(say("PortInUse")).toBe(
    'port 8234 is in use; set another "port" in voice.json, pass --port, or leave it unset',
  );
  expect(say("PortInUse", { model: "base.en", port: null })).toBe(
    "whisper-server's port was taken as it started; start corgi-voice again",
  );
  expect(say("WhisperMissing")).toStartWith("whisper-server not found; install: ");
  expect(say("TerminalRequired")).toBe("corgi-voice needs a terminal");
});

test("setup takes the model and the corgi command, and help lists every flag", () => {
  expect(flags(["--setup"])).toEqual({ setup: true });
  expect(flags(["--setup", "--model", "tiny.en", "--corgi", "corgi-custom"])).toEqual({
    setup: true,
    model: "tiny.en",
    corgi: "corgi-custom",
  });
  expect(flags(["--help"])).toEqual({ help: true });
  for (const flag of [
    "--model",
    "--threshold",
    "--silence",
    "--port",
    "--device",
    "--transcripts",
    "--no-filter",
    "--verbose",
    "--corgi",
    "--setup",
    "--help",
  ])
    expect(usage).toContain(flag);
  expect(usage).not.toContain("--ssh");
});

test("the version comes from package.json", () => {
  expect(version).toBe(pkg.version);
  expect(usage).toContain(`corgi-voice ${pkg.version}`);
});

test("--help prints the usage and a bad flag exits 2", async () => {
  const out: string[] = [],
    err: string[] = [];
  const write = process.stdout.write,
    ewrite = process.stderr.write;
  process.stdout.write = ((t: string) => (out.push(t), true)) as typeof process.stdout.write;
  process.stderr.write = ((t: string) => (err.push(t), true)) as typeof process.stderr.write;
  try {
    expect(await main(["--help"])).toBe(0);
    expect(await main(["--ssh", "devbox"])).toBe(2);
  } finally {
    process.stdout.write = write;
    process.stderr.write = ewrite;
  }
  expect(out.join("")).toBe(usage);
  expect(err.join("")).toContain("corgi-voice --help");
});

test("--transcripts names the folder for one run; it needs a value", () => {
  expect(flags(["--transcripts", "notes/calls"])).toEqual({ transcripts: "notes/calls" });
  expect(() => flags(["--transcripts"])).toThrow("Usage");
});

// What reaches the runtime during a recording is checked in session.test.ts.
test("--transcripts wins over voice.json and resolves against the start folder", () => {
  const env = { HOME: "/home/me" },
    folder = (args: string[]) =>
      settings.transcriptsFolder(settings.merge(settings.defaults(), flags(args)), env, "/work");
  expect(folder(["--transcripts", "calls"])).toBe("/work/calls");
  expect(folder(["--corgi", "corgi-custom"])).toBe("/home/me/.local/share/corgi/transcripts");
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A recorder running into a fresh file, with one passage still being transcribed. */
function busy() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-quit-")),
    tuning = { pause_break: 2, begin: () => {}, end: () => {} } as unknown as Tuning,
    recorder = new Recorder({ tuning, now: () => 0 }),
    path = join(dir, "t.txt");
  dirs.push(dir);
  recorder.start(path);
  const u = { speech_start: 0, speech_end: 1000, continues: false, record: null } as unknown as Utterance;
  recorder.claim(u);
  const view = { finishing: false };
  let quits = 0;
  const q = quitter(
    recorder,
    () => view,
    () => quits++,
  );
  return { recorder, path, u, view, q, quits: () => quits };
}

test("quitting with a recording waits for its transcript, then quits", async () => {
  const { recorder, u, view, q, quits } = busy();
  q.press();
  expect(view.finishing).toBe(true);
  expect(recorder.current).toBeNull();
  await Bun.sleep(5);
  expect(quits()).toBe(0);
  recorder.write(u, "Last words.");
  await Bun.sleep(0);
  expect(quits()).toBe(1);
  expect(q.finish().map(r => r.late)).toEqual([0]);
});

test("quitting again ends the wait, and the passage left out is reported", async () => {
  const { path, view, q, quits } = busy();
  q.press();
  q.press();
  expect(quits()).toBe(1);
  expect(view.finishing).toBe(true);
  const finished = q.finish();
  expect(finished).toEqual([{ path, late: 1 }]);
  await Bun.sleep(0);
  // The first wait ends too, without reporting it twice.
  expect(finished).toHaveLength(1);
  expect(lateMessage(path, 1)).toBe(
    `corgi-voice: 1 passage of ${path} did not finish in time and is not in the transcript\n`,
  );
  expect(lateMessage("/t\x1b]0;x\x07.txt", 2)).toBe(
    "corgi-voice: 2 passages of /t ]0;x .txt did not finish in time and are not in the transcript\n",
  );
});

test("quitting without a recording quits at once", () => {
  const recorder = new Recorder({ tuning: {} as Tuning, now: () => 0 }),
    view = { finishing: false };
  let quits = 0;
  quitter(
    recorder,
    () => view,
    () => quits++,
  ).press();
  expect(quits).toBe(1);
  expect(view.finishing).toBe(false);
});

/** A session's shared mute, counting what was sent. */
function mutable(muted: boolean) {
  const sent: boolean[] = [];
  const session = {
    muted,
    setMuted(m: boolean) {
      sent.push(m);
      session.muted = m;
    },
  };
  return { session, sent };
}

test("a recording mutes dictation, and stopping unmutes it", () => {
  const { session, sent } = mutable(false),
    recording = muteWhileRecording(session);
  recording(true);
  expect(session.muted).toBe(true);
  recording(false);
  expect(session.muted).toBe(false);
  expect(sent).toEqual([true, false]);
});

test("a mute that was on before the recording stays on after it", () => {
  const { session, sent } = mutable(true),
    recording = muteWhileRecording(session);
  recording(true);
  recording(false);
  expect(session.muted).toBe(true);
  expect(sent).toEqual([]);
  // Unmuted during the recording, it goes back to muted, as it was.
  recording(true);
  session.setMuted(false);
  recording(false);
  expect(session.muted).toBe(true);
});

test("muting by hand during a recording is undone on stop when it was off before", () => {
  const { session } = mutable(false),
    recording = muteWhileRecording(session);
  recording(true);
  session.setMuted(false);
  session.setMuted(true);
  recording(false);
  expect(session.muted).toBe(false);
  // An end without a start changes nothing.
  session.setMuted(true);
  recording(false);
  expect(session.muted).toBe(true);
});

test("the voice pane comes from CORGI_PANE: a whole number, 0 included", () => {
  expect(ownPaneFrom({})).toBeNull();
  expect(ownPaneFrom({ CORGI_PANE: "7" })).toBe(7);
  expect(ownPaneFrom({ CORGI_PANE: " 12 " })).toBe(12);
  expect(ownPaneFrom({ CORGI_PANE: "0" })).toBe(0);
  for (const bad of ["", "abc", "5abc", "-3", "1.5"]) expect(ownPaneFrom({ CORGI_PANE: bad })).toBeNull();
});

/** Runs `main` as a terminal start in private XDG folders; returns its status and stderr. */
async function start(args: string[], prepare: (env: NodeJS.ProcessEnv) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "cv-main-")),
    keys = ["XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"] as const,
    saved = keys.map(k => process.env[k]);
  for (const k of keys) process.env[k] = join(dir, k.toLowerCase());
  const err: string[] = [],
    ewrite = process.stderr.write;
  process.stderr.write = ((t: string) => (err.push(t), true)) as typeof process.stderr.write;
  try {
    prepare(process.env);
    const code = await main(args, { terminal: true });
    return { code, err: err.join("") };
  } finally {
    process.stderr.write = ewrite;
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a corgi without pane send --stdin stops the start with status 1, naming it", async () => {
  const fake = fakeCorgi({ help: { stdout: "Usage:\n  corgi pane send ID TEXT [--enter]\n" } });
  try {
    const { code, err } = await start(["--corgi", fake.cmd]);
    expect(code).toBe(1);
    expect(err).toContain('has no "pane send --stdin"');
  } finally {
    fake.cleanup();
  }
});

test("a corgi command that is not found stops the start, naming the value tried", async () => {
  const { code, err } = await start(["--corgi", "corgi-custom-not-on-path"]);
  expect(code).toBe(1);
  expect(err).toContain('"corgi-custom-not-on-path" was not found');
  expect(err).toContain("executable's path");
});

test("a second instance refuses to start while the first holds the lock", async () => {
  const fake = fakeCorgi();
  try {
    const held: Lock[] = [];
    const { code, err } = await start(["--corgi", fake.cmd], env => {
      // The parent process stands in for the corgi-voice that runs already.
      held.push(acquire(paths.lockFile(env), process.ppid));
    });
    expect(held[0].ok).toBe(true);
    expect(code).toBe(1);
    expect(err).toContain("already running");
  } finally {
    fake.cleanup();
  }
});

test("stopping a recording restores the earlier unmuted state even while voice cannot listen", () => {
  const sent: [boolean, boolean | undefined][] = [];
  const session = {
    muted: false,
    available: true,
    setMuted(m: boolean, restore?: boolean) {
      sent.push([m, restore]);
      if (!m && !session.available && !restore) return;
      session.muted = m;
    },
  };
  const recording = muteWhileRecording(session);
  recording(true);
  session.available = false;
  recording(false);
  expect(session.muted).toBe(false);
  expect(sent).toEqual([
    [true, undefined],
    [false, true],
  ]);
});
