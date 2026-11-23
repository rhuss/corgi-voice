//! `corgi-voice --setup`: takes over the in-Corgi voice mode's settings and
//! models, checks the tools corgi-voice runs (whisper-server, ffmpeg and the
//! `corgi` command with `pane send --stdin`, and that it can talk to the
//! running Corgi), downloads the speech model and the speech filter, and
//! says whether voice is ready.
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import * as models from "./models";
import * as settings from "./settings";
import * as paths from "../util/paths";
import * as subprocess from "../util/subprocess";
import * as errors from "../util/errors";
import { migrate } from "../util/migrate";
import { spaced } from "../util/text";
import { resolveCorgi, checkCapabilities, checkReachable } from "../corgi/command";

export type Tool = "whisper-server" | "ffmpeg";

/** The platform's family, from /etc/os-release on Linux. */
function family(): "macos" | "arch" | "debian" | "linux" {
  if (process.platform === "darwin") return "macos";
  try {
    const ids = [...readFileSync("/etc/os-release", "utf8").matchAll(/^ID(?:_LIKE)?=(.*)$/gm)].map(m => m[1]).join(" ");
    if (/\barch\b/.test(ids)) return "arch";
    if (/\b(debian|ubuntu)\b/.test(ids)) return "debian";
  } catch {}
  return "linux";
}
/** How to install `tool` here. */
export function hint(tool: Tool, platform = family()): string {
  switch (platform) {
    case "macos":
      return tool === "ffmpeg" ? "brew install ffmpeg" : "brew install whisper-cpp";
    case "arch":
      return tool === "ffmpeg" ? "sudo pacman -S ffmpeg" : "sudo pacman -S whisper-cpp";
    case "debian":
      return tool === "ffmpeg" ? "sudo apt install ffmpeg" : "sudo apt install whisper.cpp-tools";
    case "linux":
      return tool === "ffmpeg"
        ? "install ffmpeg with your package manager"
        : "build whisper.cpp from source with CMake (build/bin/whisper-server)";
  }
}
/** Whether this whisper-server knows `--vad`, which the speech filter needs. */
async function hasVad(binary: string): Promise<boolean> {
  try {
    const out = await subprocess.run([binary, "--help"], { timeoutMs: 5000, env: process.env });
    return /--vad\b/.test(out.stdout + out.stderr);
  } catch {
    return false;
  }
}
/** Downloads `entry` into the cache, where `env` places it, through
 * `<file>.part`, checking its size and SHA-256 before it takes the file's
 * name, and with it the place of a broken file of that name. */
export async function download(
  entry: models.Entry,
  progress: (bytes: number) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = models.fileOf(entry, env),
    part = file + ".part";
  mkdirSync(dirname(file), { recursive: true });
  try {
    const reply = await fetch(entry.url);
    if (!reply.ok || !reply.body) throw Error("DownloadFailed");
    const hash = createHash("sha256");
    let bytes = 0;
    // The pipeline fails on a write error too (a full disk), and closes the file either way.
    await pipeline(
      reply.body,
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          bytes += chunk.length;
          if (bytes > entry.bytes) throw Error("ChecksumMismatch");
          progress(bytes);
          yield chunk;
        }
      },
      createWriteStream(part, { mode: 0o644 }),
    );
    if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256) throw Error("ChecksumMismatch");
    renameSync(part, file);
  } catch (error) {
    rmSync(part, { force: true });
    throw error;
  }
}
/** The executable `name` on `path`, or null. */
export function onPath(name: string, path = process.env.PATH ?? ""): string | null {
  return Bun.which(name, { PATH: path });
}
const mb = (bytes: number) => (bytes / 1e6).toFixed(1) + " MB";

/** Prints the readiness report; 0 when voice is ready, 1 otherwise. */
export async function run(
  /** The `--model` and `--corgi` flags; voice.json gives what they leave out. */
  opts: { model?: models.ModelName; corgi?: string | null },
  deps: {
    write?: (text: string) => void;
    entries?: { model: models.Entry; filter: models.Entry };
    path?: string;
    /** Where the old and new files are, settings and models alike; `process.env` by default. */
    env?: NodeJS.ProcessEnv;
    /** The bound of the `list --json` probe, in ms; 3000 by default. */
    reachMs?: number;
  } = {},
): Promise<number> {
  const write = deps.write ?? (text => void process.stdout.write(text)),
    path = deps.path ?? process.env.PATH ?? "",
    env = deps.env ?? process.env;
  // What the in-Corgi voice mode has is taken before anything is downloaded.
  for (const notice of migrate(env, deps.entries ? { entries: [deps.entries.model, deps.entries.filter] } : {}).notices)
    write(`[taken] ${notice}\n`);
  const saved = settings.read(paths.settingsFile(env)).settings,
    model = opts.model ?? saved.model,
    corgiCmd = opts.corgi !== undefined ? opts.corgi : saved.corgi,
    entries = deps.entries ?? { model: models.catalog[model], filter: models.filter };
  let ready = true;
  const whisper = onPath("whisper-server", path);
  if (!whisper) {
    ready = false;
    write(`[missing] whisper-server: install with ${hint("whisper-server")}\n`);
  } else if (!(await hasVad(whisper))) {
    ready = false;
    write(`[too old] whisper-server at ${whisper} has no --vad; update it: ${hint("whisper-server")}\n`);
  } else write(`[ok] whisper-server ${whisper}\n`);
  const ffmpeg = onPath("ffmpeg", path);
  if (ffmpeg) write(`[ok] ffmpeg ${ffmpeg}\n`);
  else {
    ready = false;
    write(`[missing] ffmpeg: install with ${hint("ffmpeg")}\n`);
  }
  const corgi = resolveCorgi({ flag: opts.corgi, setting: corgiCmd }, { ...env, PATH: path }),
    // The path and corgi's own error text may hold control characters: they
    // show as spaces, as everywhere on screen.
    say = (line: string) => write(spaced(line) + "\n");
  if (!corgi.ok) {
    ready = false;
    say(`[missing] corgi: ${corgi.error}`);
  } else {
    const able = await checkCapabilities(corgi.cmd);
    if (!able.ok) {
      ready = false;
      say(`[too old] corgi: ${able.error}`);
    } else {
      // A corgi of another build than the running Corgi has --stdin too, and
      // still cannot talk to it (FR-008, FR-009).
      const reach = await checkReachable(corgi.cmd, deps.reachMs);
      switch (reach.kind) {
        case "ok":
          say(`[ok] corgi ${corgi.cmd}`);
          break;
        case "not_running":
          say(`[note] corgi: Corgi is not running; could not check that ${corgi.cmd} talks to it`);
          break;
        case "no_answer":
          say("[note] corgi: no answer in time");
          break;
        case "mismatch":
          ready = false;
          say(`[mismatch] corgi ${corgi.cmd} cannot talk to the running Corgi: ${reach.detail}`);
          say(`         set "corgi" in voice.json, or pass --corgi, to the corgi your Corgi runs`);
      }
    }
  }
  for (const [label, entry] of [
    [`model ${model}`, entries.model],
    ["speech filter", entries.filter],
  ] as const) {
    if (models.installed(entry, env)) {
      write(`[ok] ${label} ${models.fileOf(entry, env)}\n`);
      continue;
    }
    let shown = "";
    try {
      const progress = (bytes: number) => {
        const line = `downloading ${label}  ${mb(bytes)} / ${mb(entry.bytes)}  ${Math.floor((bytes * 100) / entry.bytes)}%`;
        if (line !== shown) write(`\r\x1b[2K${(shown = line)}`);
      };
      await download(entry, progress, env);
      write(`\r\x1b[2K[ok] ${label} ${models.fileOf(entry, env)}\n`);
    } catch (error) {
      ready = false;
      const why = errors.is(error, "ChecksumMismatch")
        ? "the download did not match its checksum"
        : "the download failed";
      write(`\r\x1b[2K[failed] ${label}: ${why}; run corgi-voice --setup again\n`);
    }
  }
  write(ready ? "Voice is ready: run corgi-voice\n" : "Voice is not ready yet; see above.\n");
  return ready ? 0 : 1;
}
