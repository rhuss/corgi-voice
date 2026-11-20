#!/usr/bin/env bun
//! `corgi-voice` and `corgi-voice --setup`: voice dictation and transcript
//! recording on the machine with the microphone, typing into Corgi through
//! its command-line interface.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pkg from "../package.json" with { type: "json" };
import * as errors from "./util/errors";
import * as log from "./util/log";
import * as paths from "./util/paths";
import { migrate } from "./util/migrate";
import { acquire } from "./util/lock";
import * as settings from "./voice/settings";
import * as models from "./voice/models";
import * as setup from "./voice/setup";
import * as capture from "./voice/capture";
import * as transcript from "./voice/transcript";
import * as ui from "./ui/ui";
import * as palette from "./ui/palette";
import * as theme from "./ui/theme";
import { Segmenter } from "./voice/segmenter";
import { Tuning } from "./voice/tuning";
import { Recorder } from "./voice/recorder";
import { Server } from "./voice/whisper";
import { VoiceSession } from "./voice/session";
import type { VoiceLink } from "./voice/link";
import { CorgiLink } from "./corgi/link";
import { resolveCorgi, checkCapabilities } from "./corgi/command";

export const version: string = pkg.version;
type Flags = settings.VoiceFlags & { verbose?: boolean; setup?: boolean; help?: boolean };

export const usage = `corgi-voice ${version}: voice dictation and transcripts for Corgi

Usage:
  corgi-voice [--model NAME] [--threshold N] [--silence S] [--port N] [--device NAME]
              [--transcripts DIR] [--no-filter] [--verbose] [--corgi CMD]
  corgi-voice --setup [--model NAME] [--corgi CMD]
  corgi-voice --help

Flags:
  --model NAME       Whisper model: ${models.names.join(", ")} (default ${models.default_model})
  --threshold N      speech threshold, 0..100
  --silence S        seconds of silence that end an utterance, 0.5..10
  --port N           whisper-server port, 1024..65535 (default: a free one)
  --device NAME      microphone (default: the system's)
  --transcripts DIR  transcript folder for this run
  --no-filter        run Whisper without the speech filter
  --verbose          log to ${paths.logFile()}
  --corgi CMD        the corgi command: a name on PATH or a path (default: corgi)
  --setup            check tools and download the model and the speech filter
  --help             show this help
`;

/** Reads the arguments; anything else is a usage error. */
export function flags(args: string[]): Flags {
  const out: Flags = {},
    number = (value: string | undefined, min: number, max: number, integer: boolean) => {
      const n = Number(value);
      if (value === undefined || !value.trim() || !Number.isFinite(n) || n < min || n > max) throw Error("Usage");
      if (integer && !Number.isInteger(n)) throw Error("Usage");
      return n;
    };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    switch (args[i]) {
      case "--model":
        out.model = models.parseName(value ?? "") ?? throwUsage();
        i++;
        break;
      case "--threshold":
        out.threshold = number(value, 0, 100, true);
        i++;
        break;
      case "--silence":
        out.silence = number(value, 0.5, 10, false);
        i++;
        break;
      case "--port":
        out.port = number(value, 1024, 65535, true);
        i++;
        break;
      case "--device":
        if (!value) throw Error("Usage");
        out.device = value;
        i++;
        break;
      case "--transcripts":
        if (!value) throw Error("Usage");
        out.transcripts = value;
        i++;
        break;
      case "--corgi":
        if (!value || !value.trim() || value.startsWith("-")) throw Error("Usage");
        out.corgi = value;
        i++;
        break;
      case "--no-filter":
        out.speech_filter = false;
        break;
      case "--verbose":
        out.verbose = true;
        break;
      case "--setup":
        out.setup = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
      default:
        throw Error("Usage");
    }
  }
  // Setup takes only the model and the corgi command.
  if (out.setup && Object.keys(out).some(k => !["setup", "model", "corgi"].includes(k))) throw Error("Usage");
  return out;
}
function throwUsage(): never {
  throw Error("Usage");
}
/** The one line corgi-voice prints when it cannot start. */
export function message(error: unknown, s: { model: string; port: number | null }): string {
  const name = errors.name(error);
  switch (name) {
    case "ModelMissing":
      return `voice model ${s.model} is not installed; run: corgi-voice --setup --model ${s.model}`;
    case "WhisperMissing":
      return `whisper-server not found; install: ${setup.hint("whisper-server")}`;
    case "FfmpegMissing":
      return `ffmpeg not found; install: ${setup.hint("ffmpeg")}`;
    case "PortInUse":
      return s.port === null
        ? "whisper-server's port was taken as it started; start corgi-voice again"
        : `port ${s.port} is in use; set another "port" in voice.json, pass --port, or leave it unset`;
    case "Timeout":
      return "whisper-server did not answer within 60 s";
    case "WhisperStartFailed":
      return "whisper-server stopped while starting; run with --verbose and see voice.log";
    case "TerminalRequired":
      return "corgi-voice needs a terminal";
    case "Usage":
      return "usage: corgi-voice [flags]; see corgi-voice --help";
    default:
      return name ?? String(error);
  }
}
/** The `corgi` command for this run, checked; throws `CorgiMissing` with the reason as `detail`. */
async function corgiCommand(s: settings.VoiceSettings): Promise<string> {
  const found = resolveCorgi({ setting: s.corgi });
  if (!found.ok) throw Object.assign(Error("CorgiMissing"), { detail: found.error });
  const checked = await checkCapabilities(found.cmd);
  if (!checked.ok) throw Object.assign(Error("CorgiMissing"), { detail: checked.error });
  return found.cmd;
}

/** The pane corgi-voice runs in, from `CORGI_PANE`, when it runs inside a
 * Corgi pane (FR-014): a whole number, 0 included; anything else is none. */
export function ownPaneFrom(env: NodeJS.ProcessEnv = process.env): number | null {
  const value = env.CORGI_PANE?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const pane = Number(value);
  return Number.isSafeInteger(pane) ? pane : null;
}
/** `corgi-voice …`; returns the exit status. `terminal` stands in for the
 * check that stdin and stdout are a terminal, for tests. */
export async function main(args: string[], opts: { terminal?: boolean } = {}): Promise<number> {
  let given: Flags;
  try {
    given = flags(args);
  } catch {
    process.stderr.write(`corgi-voice: ${message(Error("Usage"), { model: "", port: null })}\n`);
    return 2;
  }
  if (given.help) {
    process.stdout.write(usage);
    return 0;
  }
  // Setup takes over the old settings itself, then reads what it lacks from them.
  if (given.setup) return setup.run({ model: given.model, corgi: given.corgi });
  if (!(opts.terminal ?? (process.stdin.isTTY && process.stdout.isTTY))) {
    process.stderr.write(`corgi-voice: ${message(Error("TerminalRequired"), { model: "", port: null })}\n`);
    return 1;
  }
  // The in-Corgi voice mode's settings and models, before the settings are read.
  const taken = migrate().notices;
  const read = settings.read(settings.path()),
    s = settings.merge(read.settings, given);
  if (given.verbose) {
    mkdirSync(dirname(paths.logFile()), { recursive: true, mode: 0o700 });
    log.configure({ file: paths.logFile(), verbose: true });
  }
  const logger = log.getLogger("voice");
  let release = () => {};
  try {
    const cmd = await corgiCommand(s);
    // One corgi-voice at a time, so the same speech is never typed twice.
    const lock = acquire();
    if (!lock.ok) throw Object.assign(Error("AlreadyRunning"), { detail: lock.message });
    release = lock.release;
    // A signal or a crash ends the process without the finally below.
    process.on("exit", release);
    return await voice(s, cmd, [...taken, ...read.notices], logger, !!given.verbose);
  } catch (error) {
    logger.error("corgi-voice stopped", { error });
    const detail = (error as { detail?: string }).detail;
    process.stderr.write(`corgi-voice: ${detail ?? message(error, s)}\n`);
    return errors.is(error, "Usage") ? 2 : 1;
  } finally {
    process.off("exit", release);
    release();
  }
}
/** `verbose`: --verbose, whose log also shows where Whisper heard the speech end. */
async function voice(
  s: settings.VoiceSettings,
  cmd: string,
  notices: string[],
  logger: log.Logger,
  verbose: boolean,
): Promise<number> {
  const model = models.catalog[s.model];
  if (!models.installed(model)) throw Error("ModelMissing");
  const binary = setup.onPath("whisper-server");
  if (!binary) throw Error("WhisperMissing");
  if (!setup.onPath("ffmpeg")) throw Error("FfmpegMissing");
  let vadModel: string | undefined;
  if (s.speech_filter && models.installed(models.filter)) vadModel = models.fileOf(models.filter);
  else if (s.speech_filter)
    notices = [...notices, "The speech filter is not installed, so noise may become text: run corgi-voice --setup"];
  // The pane corgi-voice runs in, when it runs inside Corgi: never typed into (FR-014).
  const ownPane = ownPaneFrom(process.env);
  const link = async (): Promise<VoiceLink> => new CorgiLink({ cmd, ownPane, log: line => logger.info(line) });
  const timing = {
      silence: s.silence,
      pre_roll: s.pre_roll,
      post_roll: s.post_roll,
      min_speech: s.min_speech,
      burst: s.burst,
    },
    segmenter = new Segmenter({ threshold: s.threshold, timing, now: Date.now });
  // Transcripts stay on this machine, whatever machine the text goes to.
  const tuning = new Tuning(segmenter, {
      dictation: { threshold: s.threshold, silence: s.silence },
      recording: s.recording,
      shared: { burst: s.burst, pre_roll: s.pre_roll, post_roll: s.post_roll, min_speech: s.min_speech },
      warn: text => recorder.notice("error", text),
    }),
    recorder = new Recorder({
      tuning,
      now: Date.now,
      log: line => logger.info(line),
      // The session exists by the time a recording starts.
      active: on => muting(on),
    }),
    folder = settings.transcriptsFolder(s, process.env, process.cwd()),
    home = settings.home(process.env),
    // The one place a typed transcript name becomes a file.
    resolveName = (name: string, dir: string) => transcript.resolve(name, dir, home);
  let server: Server | null = null,
    restarting = false;
  const crashed: ((code: number | null) => void)[] = [];
  const session = new VoiceSession({
    link,
    transcriber: {
      // What the filter switch cuts off, sent before it or during it, says so.
      // Only the --verbose log shows segment times, so only it asks for them.
      transcribe: (wav, opts) =>
        server
          ? server.transcribe(wav, { pad: opts.pad, segments: verbose }).catch(error => {
              throw restarting ? Error("ServerRestarting") : error;
            })
          : Promise.reject(Error(restarting ? "ServerRestarting" : "ServerDown")),
      on: (_event, fn) => void crashed.push(fn),
    },
    segmenter,
    now: Date.now,
    log: line => logger.info(line),
    recorder,
    // A gauged threshold goes through the tuning, as + and - do.
    setThreshold: pct => tuning.setThreshold(pct),
  });
  const muting = muteWhileRecording(session);
  // The link never fails to start: an unreachable Corgi shows in the window and is retried.
  await session.connect().catch(() => {});
  let mic: capture.Capture | null = null,
    cleaned: Promise<void> | null = null,
    starting: Promise<Server> | null = null;
  // A whisper-server still loading when corgi-voice ends is stopped too.
  const stopping = new AbortController();
  const cleanup = () =>
    (cleaned ??= (async () => {
      stopping.abort();
      mic?.stop();
      session.close();
      await server?.stop();
      // A start in progress notices the abort and stops its child; one that
      // just finished is stopped here. Either way, nothing keeps the port.
      await starting?.then(
        started => started.stop(),
        () => {},
      );
      logger.info("corgi-voice stopped");
    })());
  const start = async (vad: string | undefined) => {
    const pending = Server.start({
      binary,
      model: models.fileOf(model),
      port: s.port ?? undefined,
      vadModel: vad,
      language: models.multilingual(s.model) ? "auto" : undefined,
      signal: stopping.signal,
    });
    starting = pending;
    let started: Server;
    try {
      started = await pending;
    } finally {
      if (starting === pending) starting = null;
    }
    logger.info("whisper-server ready", { port: started.port, model: s.model, filter: vad !== undefined });
    started.on("crashed", code => {
      logger.error("whisper-server crashed", { code, output: started.output });
      for (const fn of crashed) fn(code);
    });
    return started;
  };
  // The filter is a server option: switching it restarts the server, and
  // what is said meanwhile fails rather than waits. A fresh server also
  // brings voice back after a crash.
  const toggleFilter = async (): Promise<ui.FilterState> => {
    if (!models.installed(models.filter)) return "not installed";
    vadModel = vadModel ? undefined : models.fileOf(models.filter);
    const old = server;
    server = null;
    restarting = true;
    await old?.stop();
    try {
      const fresh = await start(vadModel);
      if (cleaned) await fresh.stop();
      else {
        server = fresh;
        session.serverReady();
      }
    } catch (error) {
      logger.error("whisper-server restart failed", { error });
      for (const fn of crashed) fn(null);
    } finally {
      restarting = false;
    }
    return vadModel ? "on" : "off";
  };
  // Until the window takes the terminal, Ctrl+C or a signal while the model
  // loads still stops the server, which would otherwise keep the port.
  const onSignal = () => void cleanup().finally(() => process.exit(1)),
    signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, onSignal);
  try {
    server = await start(vadModel);
    mic = capture.Capture.start(
      s.device,
      f => session.frame(f),
      problem => {
        logger.warn("microphone", { problem });
        session.setAvailable(false, problem);
      },
    );
    // Light or dark, before the window reads the keyboard.
    palette.use(await theme.detect(s.theme));
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    for (const signal of signals) process.off(signal, onSignal);
  }
  let quit!: () => void;
  const stopped = new Promise<void>(resolve => (quit = resolve)),
    quitting = quitter(recorder, () => view, quit);
  const view = new ui.VoiceUi(session, {
    device: s.device ?? "(default)",
    model: s.model,
    threshold: s.threshold,
    filter: vadModel ? "on" : s.speech_filter ? "not installed" : "off",
    timing,
    setTiming: (name, seconds) => tuning.setTiming(name, seconds),
    toggleFilter,
    notices,
    setThreshold: pct => tuning.setThreshold(pct),
    listDevices: () => capture.listDevices(),
    switchDevice: device => {
      logger.info("microphone switched", { device: device.id });
      mic?.switch(device.id);
    },
    quit: quitting.press,
    recorder,
    tuning,
    folder,
    resolveName,
    startRecording: path => recorder.start(path),
    stopRecording: () => void recorder.stop(),
  });
  // A signal ends corgi-voice at once; the transcript is closed first.
  try {
    await ui.run(view, stopped, async () => {
      recorder.finish();
      await cleanup();
    });
  } catch (error) {
    // The window could not start: nothing may keep running, whisper-server above all.
    recorder.finish();
    await cleanup();
    throw error;
  }
  const finished = quitting.finish();
  await cleanup();
  for (const { path, late } of finished) if (late) process.stderr.write(lateMessage(path, late));
  return 0;
}
/** Muting while a recording runs: it records the conversation, not
 * dictation. A recording mutes dictation when it starts; when it ends, the
 * mute goes back to what it was before, so a mute that was on stays on. */
export function muteWhileRecording(session: {
  muted: boolean;
  /** `restore` puts the earlier state back even while voice cannot listen. */
  setMuted: (muted: boolean, restore?: boolean) => void;
}): (recording: boolean) => void {
  let before: boolean | null = null;
  return recording => {
    if (recording) {
      before = session.muted;
      if (!before) session.setMuted(true);
    } else if (before !== null) {
      if (session.muted !== before) session.setMuted(before, true);
      before = null;
    }
  };
}
/** Quitting: with a recording, the first `press` stops it and waits for its
 * transcript, with the window saying so, and a second press ends the wait.
 * Once the window is gone, `finish` closes what is left and returns each
 * recording closed on the way, with how many passages it left out. */
export function quitter(
  recorder: Recorder,
  view: () => { finishing: boolean },
  quit: () => void,
): { press: () => void; finish: () => { path: string; late: number }[] } {
  const finished: { path: string; late: number }[] = [];
  let given_up = false;
  return {
    press: () => {
      const v = view();
      if (v.finishing || (!recorder.current && !recorder.stopping.size)) return quit();
      v.finishing = true;
      void recorder.stop();
      void Promise.all([...recorder.stopping].map(r => r.done)).then(
        results => {
          // After a second press, `finish` reports them.
          if (!given_up) for (const r of results) if (r) finished.push(r);
          quit();
        },
        () => quit(),
      );
    },
    finish: () => {
      given_up = true;
      finished.push(...recorder.finish());
      return finished;
    },
  };
}
/** The line on the terminal for passages a recording left out on quit. */
export function lateMessage(path: string, late: number): string {
  const shown = path.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  return `corgi-voice: ${late} passage${late === 1 ? "" : "s"} of ${shown} did not finish in time and ${late === 1 ? "is" : "are"} not in the transcript\n`;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
