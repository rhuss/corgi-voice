import { expect, test } from "bun:test";
import { displayWidth, ellipsis, clipped, spaced, controls } from "../../src/util/text";

test("display width counts cells and ignores escape sequences", () => {
  expect(displayWidth("abc")).toBe(3);
  expect(displayWidth("日本")).toBe(4);
  expect(displayWidth("\x1b[1;38;2;1;2;3mab\x1b[0m")).toBe(2);
  expect(displayWidth("▁▂▃")).toBe(3);
  expect(displayWidth("✗")).toBe(1);
});

test("ellipsis cuts to the room with one … cell", () => {
  expect(ellipsis("hello", 5)).toBe("hello");
  expect(ellipsis("hello world", 6)).toBe("hello…");
  expect(ellipsis("日本語", 4)).toBe("日…");
  expect(ellipsis("abc", 0)).toBe("");
  expect(clipped("日本語", 5)).toBe("日本");
});

test("spaced puts a space for every control character, C0, DEL and C1 alike, and nothing else", () => {
  expect(spaced("plain text, 日本語, ✗ and é")).toBe("plain text, 日本語, ✗ and é");
  expect(spaced("a\x00b\tc\nd\re\x1bf\x1fg")).toBe("a b c d e f g");
  expect(spaced("del\x7f csi\x9b osc\x9d nel\x85 end\x9f")).toBe("del  csi  osc  nel  end ");
  // The neighbours of each range stay: space and ~ around C0 and DEL, NBSP after C1.
  expect(spaced(" ~\xa0")).toBe(" ~\xa0");
  // Every one of the 65, each replaced on its own.
  const all = [...Array(0x20).keys(), ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i)];
  expect(spaced(String.fromCharCode(...all))).toBe(" ".repeat(65));
});

test("controls is the same class as a source string, for a pattern that names more", () => {
  const word = new RegExp(`^[^\\s${controls}]+$`);
  expect(word.test("dev.box-1")).toBe(true);
  for (const bad of ["a b", "a\x1bb", "a\x7fb", "a\x9bb", ""]) expect(word.test(bad)).toBe(false);
});
