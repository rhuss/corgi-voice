import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as log from "../../src/util/log";

const dirs: string[] = [];
afterEach(() => {
  log.configure({ file: null, verbose: false });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "cv-log-"));
  dirs.push(dir);
  return join(dir, "voice.log");
}

test("a logger is a no-op until configured", () => {
  const f = file();
  log.getLogger("voice").info("hello");
  expect(existsSync(f)).toBe(false);
  log.configure({ file: f, verbose: false });
  log.getLogger("voice").info("hello");
  expect(existsSync(f)).toBe(false);
});

test("verbose logging appends JSON lines to a private file", () => {
  const f = file();
  log.configure({ file: f, verbose: true });
  const logger = log.getLogger("voice");
  logger.info("first", { n: 1 });
  logger.warn("second", { error: Error("Boom") });
  logger.debug("hidden");
  const lines = readFileSync(f, "utf8").trim().split("\n");
  expect(lines.length).toBe(2);
  expect(lines[0]).toStartWith("info(voice): ");
  const first = JSON.parse(lines[0].slice("info(voice): ".length));
  expect(first.message).toBe("first");
  expect(first.n).toBe(1);
  expect(typeof first.at).toBe("number");
  expect(lines[1]).toContain('"message":"Boom"');
  expect(statSync(f).mode & 0o777).toBe(0o600);
});

test("circular fields do not break logging", () => {
  const f = file();
  log.configure({ file: f, verbose: true });
  const a: Record<string, unknown> = {};
  a.self = a;
  log.getLogger("x").error("loop", { a });
  expect(readFileSync(f, "utf8")).toContain("[Circular]");
});
