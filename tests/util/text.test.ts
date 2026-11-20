import { expect, test } from "bun:test";
import { shortPath, displayWidth, ellipsis, clipped } from "../../src/util/text";

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

test("a short path keeps its first two components, then its last, then those nearest the last", () => {
  expect(shortPath("./.claude/worktrees/bonus-round", 40)).toBe("./.claude/worktrees/bonus-round");
  expect(shortPath("./.claude/worktrees/bonus-round", 24)).toBe("./.claude/…/bonus-round");
  expect(shortPath("~/src/github.com/acme/billing-service/worktrees/fix-invoice-rounding", 40)).toBe(
    "~/src/…/worktrees/fix-invoice-rounding",
  );
  expect(shortPath("/tmp/claude-501/worktrees/green-field-dc53", 40)).toBe("/tmp/claude-501/…/green-field-dc53");
  expect(shortPath("$TMPDIR/corgi-wt/scroll-fix", 24)).toBe("$TMPDIR/…/scroll-fix");
  expect(shortPath("$TMPDIR/corgi-wt/scroll-fix", 18)).toBe("$TMPDIR/…/scroll-…");
  expect(shortPath("../corgi-remote-input", 18)).toBe("../corgi-remote-i…");
});
