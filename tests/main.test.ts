import { test, expect, afterEach } from "bun:test";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  flags,
  message,
  quitter,
  lateMessage,
  muteWhileRecording,
  usage,
  version,
  main,
  ownPaneFrom,
  ending,
  type Held,
} from "../src/main";
import * as models from "../src/voice/models";
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

// What reaches Corgi during a recording is checked in corgi/integration.test.ts.
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

/** An ending whose exit and stderr the test keeps, over `held`. */
function end(held: Held) {
  const written: string[] = [],
    exits: number[] = [],
    logged: string[] = [];
  return {
    written,
    exits,
    logged,
    ...ending(held, {
      exit: code => void exits.push(code),
      write: text => void written.push(text),
      log: line => void logged.push(line),
    }),
  };
}

test("the cleanup gives back what is held, once: terminal, recordings, microphone, link, server, lock", async () => {
  const order: string[] = [],
    held: Held = {
      lock: () => void order.push("lock"),
      link: () => void order.push("link"),
      server: async () => {
        order.push("server stopping");
        await Bun.sleep(20);
        order.push("server stopped");
      },
      capture: () => void order.push("capture"),
      recordings: () => (order.push("recordings"), []),
      terminal: () => void order.push("terminal"),
    },
    e = end(held);
  const first = e.cleanup();
  // What needs no waiting is done before the call returns: the terminal above all.
  expect(order).toEqual(["terminal", "recordings", "capture", "link", "server stopping"]);
  expect(held.ended).toBe(true);
  // A second call, while it runs or after, starts nothing again.
  await Promise.all([first, e.cleanup()]);
  await e.cleanup();
  expect(order).toEqual(["terminal", "recordings", "capture", "link", "server stopping", "server stopped", "lock"]);
  expect(e.logged).toEqual(["corgi-voice stopped"]);
  expect(e.exits).toEqual([]);
});

test("the cleanup takes what is held when it runs, and a step that fails does not stop the next", async () => {
  const order: string[] = [],
    held: Held = { lock: () => void order.push("lock") },
    e = end(held);
  // Acquired after the handlers were armed, as each resource is.
  held.link = () => {
    throw Error("link broke");
  };
  held.server = async () => {
    order.push("server");
    throw Error("server broke");
  };
  held.terminal = () => {
    throw Error("terminal broke");
  };
  await e.cleanup();
  expect(order).toEqual(["server", "lock"]);
});

test("a signal runs the cleanup, then exits with status 1", async () => {
  const order: string[] = [],
    e = end({
      server: async () => {
        await Bun.sleep(10);
        order.push("server");
      },
      lock: () => void order.push("lock"),
    });
  e.signal();
  expect(e.exits).toEqual([]);
  await e.cleanup();
  await Bun.sleep(0);
  expect(order).toEqual(["server", "lock"]);
  expect(e.exits).toEqual([1]);
});

test("a crash gives the terminal back before the error is printed, cleans up, and exits with status 1", async () => {
  const order: string[] = [],
    held: Held = {
      terminal: () => void order.push("terminal"),
      server: async () => void order.push("server"),
      lock: () => void order.push("lock"),
    },
    written: string[] = [],
    exits: number[] = [],
    e = ending(held, {
      exit: code => void exits.push(code),
      write: text => {
        order.push("error printed");
        written.push(text);
      },
    });
  e.crash(Error("the model broke"));
  expect(order.slice(0, 2)).toEqual(["terminal", "error printed"]);
  expect(written.join("")).toStartWith("corgi-voice: Error: the model broke");
  await e.cleanup();
  await Bun.sleep(0);
  expect(order).toEqual(["terminal", "error printed", "terminal", "server", "lock"]);
  expect(exits).toEqual([1]);
  // Something that is no Error is printed as it is.
  const other = end({});
  other.crash("just a string");
  expect(other.written).toEqual(["corgi-voice: just a string\n"]);
});

test("armed, the signals, uncaught errors and unhandled rejections all end through the cleanup; disarmed, none do", () => {
  const events = ["SIGINT", "SIGTERM", "SIGHUP", "uncaughtException", "unhandledRejection", "exit"] as const,
    counts = () => events.map(name => process.listenerCount(name)),
    before = counts(),
    e = end({});
  e.arm();
  expect(counts()).toEqual(before.map(n => n + 1));
  e.disarm();
  expect(counts()).toEqual(before);
});

test("a signal during a recording closes it without the wait and prints the passages left out", async () => {
  const { recorder, path, q } = busy(),
    e = end({ recordings: q.finish }),
    started = performance.now();
  e.signal();
  await e.cleanup();
  await Bun.sleep(0);
  // Closed at once, not after the 10 s a stop would wait for the passage.
  expect(performance.now() - started).toBeLessThan(1000);
  expect([recorder.current, recorder.stopping.size]).toEqual([null, 0]);
  expect(e.written).toEqual([lateMessage(path, 1)]);
  expect(e.exits).toEqual([1]);
});

test("a signal after a stop, while a passage is awaited, prints the same line; with none left out, nothing", async () => {
  const waiting = busy(),
    e = end({ recordings: waiting.q.finish });
  // R was pressed: the recording waits for its passage.
  void waiting.recorder.stop();
  expect(waiting.recorder.stopping.size).toBe(1);
  e.signal();
  await e.cleanup();
  expect(e.written).toEqual([lateMessage(waiting.path, 1)]);
  // Every passage written before the signal: the transcript is whole.
  const whole = busy(),
    quiet = end({ recordings: whole.q.finish });
  whole.recorder.write(whole.u, "Last words.");
  quiet.signal();
  await quiet.cleanup();
  await Bun.sleep(0);
  expect(quiet.written).toEqual([]);
  expect(quiet.exits).toEqual([1]);
});

const fixtures = resolve(import.meta.dir, "fixtures"),
  runner = join(fixtures, "run-main.ts");
/** corgi-voice in a process of its own, with fake tools and private folders,
 * its whisper-server never done loading. With `crash`, an error is thrown in
 * it, outside every catch, once whisper-server has started. `stop` ends what
 * is left of it. */
function loading(opts: { crash?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cv-main-run-")),
    fake = fakeCorgi(),
    log = join(dir, "whisper.log"),
    env: Record<string, string> = {
      PATH: `${join(fixtures, "voice")}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: dir,
      XDG_STATE_HOME: join(dir, "state"),
      XDG_CACHE_HOME: join(dir, "cache"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_RUNTIME_DIR: join(dir, "run"),
      CORGI_FAKE_WHISPER_LOG: log,
      CORGI_FAKE_WHISPER_MODE: "no_health",
      ...(opts.crash ? { CV_TEST_CRASH_WHEN: log } : {}),
    };
  // A model of the pinned size, so the start gets as far as loading it.
  const entry = models.catalog[models.default_model],
    model = models.fileOf(entry, env);
  mkdirSync(dirname(model), { recursive: true });
  mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });
  const fd = openSync(model, "w");
  ftruncateSync(fd, entry.bytes);
  closeSync(fd);
  const child = Bun.spawn([process.execPath, runner, "--corgi", fake.cmd], {
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  /** The fake whisper-server's PID, once it has started. */
  const whisper = (): number | null => {
    try {
      return (JSON.parse(readFileSync(log, "utf8").split("\n")[0]) as { pid: number }).pid;
    } catch {
      return null;
    }
  };
  return {
    child,
    lock: join(env.XDG_RUNTIME_DIR, "corgi-voice.lock"),
    whisper,
    /** The exit status, or "still running" after 15 s. */
    ended: () => Promise.race([child.exited, Bun.sleep(15_000).then(() => "still running" as const)]),
    stop: () => {
      child.kill("SIGKILL");
      const pid = whisper();
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {}
      fake.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const runs = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a crash while the model loads stops whisper-server and releases the lock", async () => {
  const run = loading({ crash: true });
  try {
    expect(await run.ended()).toBe(1);
    expect(await new Response(run.child.stderr).text()).toContain("corgi-voice: Error: crashed while the model loads");
    // It had started, and it is gone.
    const pid = run.whisper();
    expect(pid).not.toBeNull();
    expect(runs(pid!)).toBe(false);
    expect(existsSync(run.lock)).toBe(false);
  } finally {
    run.stop();
  }
}, 30_000);

test("a signal while the model loads stops whisper-server and releases the lock", async () => {
  const run = loading();
  try {
    const end = Date.now() + 15_000;
    while (run.whisper() === null && Date.now() < end) await Bun.sleep(20);
    const pid = run.whisper()!;
    expect(pid).not.toBeNull();
    expect([runs(pid), existsSync(run.lock)]).toEqual([true, true]);
    run.child.kill("SIGTERM");
    expect(await run.ended()).toBe(1);
    expect(runs(pid)).toBe(false);
    expect(existsSync(run.lock)).toBe(false);
  } finally {
    run.stop();
  }
}, 30_000);
