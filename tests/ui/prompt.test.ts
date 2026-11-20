import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilePrompt } from "../../src/ui/prompt";
import { keys } from "../../src/ui/keys";
import * as transcript from "../../src/voice/transcript";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function make(now = new Date(2026, 10, 20, 9, 30)) {
  const folder = mkdtempSync(join(tmpdir(), "cv-prompt-"));
  dirs.push(folder);
  const prompt = new FilePrompt({
    folder,
    now,
    resolve: name => transcript.resolve(name, folder, "/home/me"),
  });
  /** Feeds terminal input; returns the last result. */
  const type = (data: string) => {
    let result: ReturnType<FilePrompt["key"]> = "none";
    for (const k of keys(data)) result = prompt.key(k);
    return result;
  };
  return { prompt, folder, type };
}
/** The text a frame leaves on a `cols` × `rows` screen. */
function screen(frame: string, cols: number, rows: number): string[] {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let x = 0,
    y = 0;
  for (let i = 0; i < frame.length; ) {
    const csi = /^\x1b\[([0-9;?]*)([@-~])/.exec(frame.slice(i));
    if (csi) {
      if (csi[2] === "H") [y, x] = csi[1].split(";").map(v => Number(v || 1) - 1);
      i += csi[0].length;
      continue;
    }
    const ch = String.fromCodePoint(frame.codePointAt(i)!);
    if (y < rows && x < cols) grid[y][x] = ch;
    x++;
    i += ch.length;
  }
  return grid.map(r => r.join(""));
}
const at = (y: number, x: number) => `\x1b[${y + 1};${x + 1}H`;

test("the suggested name is today's date in local time, the caret before .txt", () => {
  const { prompt } = make(new Date(2026, 0, 5, 23, 59));
  expect(prompt.text).toBe("2026-01-05-.txt");
  expect(prompt.caret).toBe("2026-01-05-".length);
});

test("typing goes in at the caret; the note shows the file in the transcript folder", () => {
  const { prompt, folder, type } = make();
  type("standup");
  expect(prompt.text).toBe("2026-11-20-standup.txt");
  expect(prompt.note()).toEqual({ text: join(folder, "2026-11-20-standup.txt"), warn: false });
});

test("the prompt shows the folder the file goes to", () => {
  const { prompt, folder, type } = make();
  const rows = screen(prompt.draw(200, 20, at), 200, 20).join("\n");
  expect(rows).toContain("Record a transcript");
  expect(rows).toContain("File name");
  expect(rows).toContain(`Folder  ${folder}`);
  type("\x05\x15calls/2026/a.txt");
  expect(screen(prompt.draw(200, 20, at), 200, 20).join("\n")).toContain(`Folder  ${join(folder, "calls", "2026")}`);
});

test("relative names, sub-folders included, always resolve against the transcript folder", () => {
  const { prompt, folder, type } = make();
  type("\x05\x15calls/x.txt");
  expect(prompt.resolve()).toEqual({ path: join(folder, "calls", "x.txt") });
  expect(type("\r")).toBe("accept");
});

test("a name that leaves the folder with .. is refused with a message, and Enter keeps the prompt", () => {
  const { prompt, type } = make();
  type("\x05\x15../x.txt");
  expect(prompt.note()).toEqual({ text: "the name may not leave the transcript folder with ..", warn: true });
  expect(type("\r")).toBe("none");
  expect(screen(prompt.draw(80, 20, at), 80, 20).join("\n")).toContain("may not leave the transcript folder");
});

test("~/ and absolute names are used as given", () => {
  const { prompt, type } = make();
  type("\x05\x15~/notes/x.txt");
  expect(prompt.resolve()).toEqual({ path: "/home/me/notes/x.txt" });
  type("\x05\x15/tmp/y.txt");
  expect(prompt.resolve()).toEqual({ path: "/tmp/y.txt" });
});

test("an empty name is refused and whitespace is trimmed", () => {
  const { prompt, folder, type } = make();
  type("\x05\x15   ");
  expect(prompt.note()).toEqual({ text: "name is empty", warn: true });
  expect(type("\r")).toBe("none");
  type("\x05\x15  call.txt  ");
  expect(prompt.resolve()).toEqual({ path: join(folder, "call.txt") });
});

test("an existing file is appended to, and the prompt says so", () => {
  const { prompt, folder, type } = make();
  writeFileSync(join(folder, "notes.txt"), "Earlier.\n");
  type("\x05\x15notes.txt");
  expect(prompt.note()).toEqual({ text: `appends to the existing file: ${join(folder, "notes.txt")}`, warn: true });
  expect(screen(prompt.draw(120, 20, at), 120, 20).join("\n")).toContain("appends to the existing file");
});

test("Enter accepts, Esc cancels, Ctrl+C quits", () => {
  expect(make().type("\r")).toBe("accept");
  expect(make().type("\x1b")).toBe("cancel");
  expect(make().type("\x03")).toBe("quit");
});

test("editing keys: Backspace, Left/Right, Home/End, Ctrl+A/E/U/W", () => {
  const { prompt, type } = make();
  type("\x05\x15hello world.txt");
  expect(prompt.caret).toBe(prompt.text.length);
  type("\x7f");
  expect(prompt.text).toBe("hello world.tx");
  // Two to the left, the caret is before "tx": Backspace takes the dot.
  type("\x1b[D\x1b[D\x7f");
  expect(prompt.text).toBe("hello worldtx");
  type("\x1b[C");
  expect(prompt.caret).toBe("hello worldt".length);
  type("\x1b[H");
  expect(prompt.caret).toBe(0);
  type("\x1b[F");
  expect(prompt.caret).toBe(prompt.text.length);
  type("\x01");
  expect(prompt.caret).toBe(0);
  type("X");
  expect(prompt.text).toBe("Xhello worldtx");
  type("\x05");
  expect(prompt.caret).toBe(prompt.text.length);
  // Ctrl+W deletes the word before the caret, with the spaces before it.
  type("\x17");
  expect(prompt.text).toBe("Xhello ");
  type("\x17");
  expect(prompt.text).toBe("");
  type("a b c\x1b[D\x1b[D\x15");
  expect([prompt.text, prompt.caret]).toEqual([" c", 0]);
  // Left at the start and Backspace at the start change nothing.
  type("\x1b[D\x7f");
  expect([prompt.text, prompt.caret]).toEqual([" c", 0]);
});

test("a name arrives as UTF-8 in latin1 bytes, split across reads", () => {
  const { prompt, folder, type } = make();
  const bytes = Buffer.from("café-日本.txt", "utf8").toString("latin1");
  type("\x05\x15");
  type(bytes.slice(0, 4));
  type(bytes.slice(4));
  expect(prompt.text).toBe("café-日本.txt");
  expect(prompt.resolve()).toEqual({ path: join(folder, "café-日本.txt") });
  // The caret moves by characters, not bytes.
  type("\x7f\x7f\x7f\x7f\x7f");
  expect(prompt.text).toBe("café-日");
});

test("a paste goes in whole, without line breaks", () => {
  const { prompt, type } = make();
  type("\x05\x15\x1b[200~call\nnotes.txt\x1b[201~");
  expect(prompt.text).toBe("call notes.txt");
});

test("the field draws its own caret and scrolls to keep it in view", () => {
  const { prompt, type } = make();
  // The voice window hides the terminal's cursor: the caret is reverse video.
  expect(prompt.draw(80, 20, at)).toContain("\x1b[7m.");
  type("\x05\x15" + "x".repeat(100) + "END");
  const rows = screen(prompt.draw(37, 14, at), 37, 14).join("\n");
  expect(rows).toContain("END");
});

test("the prompt fits the smallest voice window", () => {
  const { prompt } = make();
  const rows = screen(prompt.draw(37, 14, at), 37, 14);
  const text = rows.join("\n");
  expect(text).toContain("File name");
  expect(text).toContain("enter");
  expect(text).toContain("esc");
  for (const r of rows) expect(Bun.stringWidth(r)).toBe(37);
});
