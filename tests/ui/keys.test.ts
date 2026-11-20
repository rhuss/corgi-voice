import { test, expect } from "bun:test";
import { keys, incomplete, KeyFeed, esc_ms, osc_hold_ms } from "../../src/ui/keys";

test("a read that ends inside a key or a paste is cut before it", () => {
  expect(incomplete("abc")).toBe(3);
  expect(incomplete("ab\x1b")).toBe(2);
  expect(incomplete("ab\x1b[")).toBe(2);
  expect(incomplete("ab\x1bO")).toBe(2);
  expect(incomplete("q\x1b[<0;5;3")).toBe(1);
  expect(incomplete("\x1b[1;5")).toBe(0);
  expect(incomplete("\x1b[Aq")).toBe(4);
  expect(incomplete("\x1b[<0;5;3M")).toBe(9);
  expect(incomplete("x\x1b[200~pas")).toBe(1);
  expect(incomplete("\x1b[200~pasted\x1b[201~y")).toBe(19);
  // The rest, once it arrives, makes the key the read split.
  const first = "m\x1b[",
    cut = incomplete(first);
  expect(keys(first.slice(0, cut))).toEqual([{ kind: "text", text: "m" }]);
  expect(keys(first.slice(cut) + "B")).toEqual([{ kind: "down" }]);
});

test("clicks, drags, releases and wheel notches come from SGR mouse reports", () => {
  expect(keys("\x1b[<0;5;3M\x1b[<32;5;6M\x1b[<0;5;7m")).toEqual([
    { kind: "click", x: 4, y: 2 },
    { kind: "drag", x: 4, y: 5 },
    { kind: "release", x: 4, y: 6 },
  ]);
  expect(keys("\x1b[<64;10;3M\x1b[<65;1;1M")).toEqual([
    { kind: "wheel", dir: 1, x: 9, y: 2 },
    { kind: "wheel", dir: -1, x: 0, y: 0 },
  ]);
  expect(keys("\x1b[<2;5;3M\x1b[<35;5;3M")).toEqual([]);
});

test("Home and End in each terminal's spelling", () => {
  expect(keys("\x1b[H\x1bOH\x1b[1~\x1b[7~").map(k => k.kind)).toEqual(Array(4).fill("home"));
  expect(keys("\x1b[F\x1bOF\x1b[4~\x1b[8~").map(k => k.kind)).toEqual(Array(4).fill("end"));
});

test("named keys, text and pastes", () => {
  expect(keys("\x1b[5~\x1b[6~\x1b[A\x1bOB\r\t\x7f\x03")).toEqual([
    { kind: "pageup" },
    { kind: "pagedown" },
    { kind: "up" },
    { kind: "down" },
    { kind: "enter" },
    { kind: "tab" },
    { kind: "backspace" },
    { kind: "cancel" },
  ]);
  expect(keys("q\x1b[200~pasted\x1b[201~\x1b")).toEqual([
    { kind: "text", text: "q" },
    { kind: "text", text: "pasted" },
    { kind: "esc" },
  ]);
  expect(keys("\x1b[1;5Cx")).toEqual([{ kind: "text", text: "x" }]);
  // Ctrl and a letter, for vi-style paging.
  expect(keys("\x04\x15\x06\x02")).toEqual(["d", "u", "f", "b"].map(key => ({ kind: "ctrl", key })));
  // SS3 keys without a name (F1 here) are skipped whole, not read as Esc.
  expect(keys("\x1bOPx")).toEqual([{ kind: "text", text: "x" }]);
});

test("a late OSC 11 reply yields no key events", () => {
  expect(keys("\x1b]11;rgb:1818/1b1b/2020\x07")).toEqual([]);
  expect(keys("\x1b]11;rgb:fafa/fafa/f8f8\x1b\\")).toEqual([]);
  expect(keys("m\x1b]11;rgb:1818/1b1b/2020\x07q")).toEqual([
    { kind: "text", text: "m" },
    { kind: "text", text: "q" },
  ]);
});

test("an OSC reply split across reads is held until it ends", () => {
  const first = "x\x1b]11;rgb:18";
  const cut = incomplete(first);
  expect(cut).toBe(1);
  expect(keys(first.slice(0, cut))).toEqual([{ kind: "text", text: "x" }]);
  expect(keys(first.slice(cut) + "18/1b1b/2020\x07r")).toEqual([{ kind: "text", text: "r" }]);
  const whole = "\x1b]11;rgb:1818/1b1b/2020\x07";
  expect(incomplete(whole)).toBe(whole.length);
});

test("the feed holds an OSC answer that comes apart, even with a pause between the parts", () => {
  const feed = new KeyFeed();
  expect(feed.push("m\x1b]11;rgb:18", 0)).toBe("m");
  expect(feed.waiting).toBe(true);
  expect(feed.delay()).toBe(osc_hold_ms);
  // 100 ms later nothing more came: the start is still held, not read as keys.
  expect(feed.flush(100)).toBe("");
  expect(feed.waiting).toBe(true);
  expect(keys(feed.push("18/1b1b/2020\x07r", 150))).toEqual([{ kind: "text", text: "r" }]);
  expect(feed.waiting).toBe(false);
});

test("an OSC answer whose end comes after the hold is dropped too", () => {
  const feed = new KeyFeed();
  expect(feed.push("\x1b]11;rgb:1818/1b", 0)).toBe("");
  expect(feed.flush(osc_hold_ms + 1)).toBe("");
  expect(feed.waiting).toBe(false);
  // The tail arrives later still: it is recognised and dropped, not typed.
  expect(keys(feed.push("1b/2020\x07q", osc_hold_ms + 50))).toEqual([{ kind: "text", text: "q" }]);
  expect(keys(feed.push("rgb:ffff/ffff/ffff\x1b\\", 2000))).toEqual([]);
});

test("a lone Escape is handed out after the short wait", () => {
  const feed = new KeyFeed();
  expect(feed.push("\x1b", 0)).toBe("");
  expect(feed.delay()).toBe(esc_ms);
  expect(keys(feed.flush(60))).toEqual([{ kind: "esc" }]);
  expect(keys(feed.push("\x1b[", 0) + feed.push("A", 1))).toEqual([{ kind: "up" }]);
});
