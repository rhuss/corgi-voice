//! Transcript files: default names, name resolution and the append-only
//! writer that keeps one blank line before each contribution.
import * as fs from "node:fs";
import * as path from "node:path";

/** The suggested name, `YYYY-MM-DD-.txt` in local time, and where the caret
 * starts: after the date, so a description goes in before the extension, as
 * in `2026-05-11-standup.txt`. */
export function defaultName(now: Date): { name: string; caret: number } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-.txt`;
  return { name, caret: name.length - ".txt".length };
}

/** The file a typed path stands for: `~/` is the home folder, absolute paths
 * are used as given, and relative ones resolve against `folder`, the
 * transcript folder; `..` parts are resolved, and may lead anywhere. A path
 * without a file name after its last `/` is refused. */
export function resolve(name: string, folder: string, home: string): { path: string } | { error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: "name is empty" };
  const file = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  if (!file || file === "." || file === "..") return { error: "no file name after the last /" };
  if (trimmed.startsWith("~/")) return { path: path.join(home, trimmed.slice(2)) };
  if (path.isAbsolute(trimmed)) return { path: path.normalize(trimmed) };
  return { path: path.join(folder, trimmed) };
}

/** What is at `file`: a file (anything but a folder), a folder (links
 * followed), or nothing. */
export type Kind = "file" | "folder" | "missing";
export function kind(file: string): Kind {
  try {
    return fs.statSync(file).isDirectory() ? "folder" : "file";
  } catch {
    return "missing";
  }
}

/** Why a recording cannot go to `file`, or null: it is a folder, or a folder
 * on its way is a file. Only reads. */
export function refusal(file: string, at: (file: string) => Kind = kind): string | null {
  if (at(file) === "folder") return "this is a folder, not a file";
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const found = at(dir);
    if (found === "folder") return null;
    if (found === "file") return `${path.basename(dir)} is a file, not a folder`;
    if (path.dirname(dir) === dir) return null;
  }
}

/** An open transcript, appended to one passage per line and synced after each. */
export class TranscriptFile {
  private fd: number;
  /** The file has text; any byte counts, whitespace included. */
  private lines: boolean;
  /** The file's last line has no line break yet. */
  private needs_newline: boolean;
  /** The file already ends with a blank line. */
  private blank_tail: boolean;
  private constructor(fd: number, tail: string) {
    this.fd = fd;
    this.lines = tail.length > 0;
    this.needs_newline = tail.length > 0 && !tail.endsWith("\n");
    // A file from Windows ends its blank line in \r\n.
    this.blank_tail = /\n\r?\n$/.test(tail);
  }
  /** Opens `file` for appending (mode 0600), creating missing folders (0700).
   * Throws with the OS message when it cannot. */
  static open(file: string): TranscriptFile {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // "a+" so the tail can be read through the same descriptor.
    const fd = fs.openSync(file, "a+", 0o600);
    try {
      const size = fs.fstatSync(fd).size;
      const tail = Buffer.alloc(Math.min(3, size));
      if (tail.length) fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      return new TranscriptFile(fd, tail.toString("latin1"));
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  /** Appends one passage; a passage that starts a contribution gets one blank
   * line before it, except at the start of the file. */
  write(text: string, starts_contribution: boolean): void {
    let out = "";
    if (this.needs_newline) out += "\n";
    if (this.lines && starts_contribution && !this.blank_tail) out += "\n";
    out += text + "\n";
    const bytes = Buffer.from(out, "utf8");
    for (let done = 0; done < bytes.length;) done += fs.writeSync(this.fd, bytes, done);
    fs.fsyncSync(this.fd);
    this.lines = true;
    this.needs_newline = false;
    this.blank_tail = false;
  }
  close(): void {
    if (this.fd < 0) return;
    const fd = this.fd;
    this.fd = -1;
    fs.closeSync(fd);
  }
}
