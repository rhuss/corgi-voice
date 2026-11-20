import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { parseReply, variantOf, detect } from "../../src/ui/theme";

test("OSC 11 replies are parsed with BEL or ST and any digit count", () => {
  expect(parseReply("\x1b]11;rgb:1818/1b1b/2020\x07")).toEqual([24, 27, 32]);
  expect(parseReply("\x1b]11;rgb:fafa/fafa/f8f8\x1b\\")).toEqual([250, 250, 248]);
  expect(parseReply("\x1b]11;rgb:ff/80/00\x07")).toEqual([255, 128, 0]);
  expect(parseReply("\x1b]11;rgb:f/0/f\x07")).toEqual([255, 0, 255]);
  expect(parseReply("\x1b]11;rgba:ffff/ffff/ffff/ffff\x07")).toEqual([255, 255, 255]);
  expect(parseReply("garbage")).toBeNull();
  expect(parseReply("\x1b]10;rgb:ffff/ffff/ffff\x07")).toBeNull();
});

test("luminance under 0.5 is dark", () => {
  expect(variantOf([24, 27, 32])).toBe("dark");
  expect(variantOf([250, 250, 248])).toBe("light");
  expect(variantOf([128, 128, 128])).toBe("dark");
  expect(variantOf([200, 200, 200])).toBe("light");
});

/** A terminal that answers the query with `reply` after `ms`, or never. */
function terminal(reply: string | null, ms = 10, tty = true) {
  const input = Object.assign(new EventEmitter(), {
      isTTY: tty,
      isRaw: false,
      raw: [] as boolean[],
      setRawMode(raw: boolean) {
        this.raw.push(raw);
        this.isRaw = raw;
      },
      resume() {},
      pause() {},
    }),
    written: string[] = [],
    output = {
      isTTY: tty,
      write(text: string) {
        written.push(text);
        if (reply !== null) setTimeout(() => input.emit("data", Buffer.from(reply, "latin1")), ms);
      },
    };
  return { input, output, written };
}

test("the setting wins over the terminal", async () => {
  const t = terminal("\x1b]11;rgb:ffff/ffff/ffff\x07");
  expect(await detect("dark", t)).toBe("dark");
  expect(await detect("light", terminal("\x1b]11;rgb:0000/0000/0000\x07"))).toBe("light");
  expect(t.written).toEqual([]);
});

test("auto asks the terminal and follows its background", async () => {
  const light = terminal("\x1b]11;rgb:ffff/ffff/ffff\x07");
  expect(await detect("auto", light)).toBe("light");
  expect(light.written).toEqual(["\x1b]11;?\x07"]);
  // Raw mode is put back as it was.
  expect(light.input.raw).toEqual([true, false]);
  expect(light.input.listenerCount("data")).toBe(0);
  expect(await detect("auto", terminal("\x1b]11;rgb:1818/1b1b/2020\x07"))).toBe("dark");
});

test("no answer within 200 ms is dark", async () => {
  const started = Date.now();
  expect(await detect("auto", terminal(null))).toBe("dark");
  expect(Date.now() - started).toBeLessThan(400);
  // A late answer does not count.
  expect(await detect("auto", terminal("\x1b]11;rgb:ffff/ffff/ffff\x07", 400))).toBe("dark");
});

test("without a terminal there is no query", async () => {
  const t = terminal("\x1b]11;rgb:ffff/ffff/ffff\x07", 10, false);
  expect(await detect("auto", t)).toBe("dark");
  expect(t.written).toEqual([]);
});
