import { test, expect } from "bun:test";
import { item, sameItem } from "../../src/trick/item";
import type { VoiceState } from "../../src/control/state";

const base: VoiceState = {
  pid: 1,
  muted: false,
  mode: "listening",
  unavailable: null,
  reason: null,
  recording: "none",
  target: { machine: "local", label: "bat · corgi-voice" },
  updated_at: 1,
};
const at = (over: Partial<VoiceState>): VoiceState => ({ ...base, ...over });

test("every row of the derivation (FR-003)", () => {
  expect(item(null)).toBeNull();
  expect(item(at({ recording: "running" }))).toEqual({ glyph: "●", color: "hot", pressable: false });
  expect(item(at({ recording: "paused" }))).toEqual({ glyph: "●", color: "warm", pressable: false });
  expect(item(at({ mode: "muted", unavailable: "mic_missing" }))).toBeNull();
  expect(item(at({ mode: "listening" }))).toEqual({ glyph: "♫", color: "accent", pressable: true });
  expect(item(at({ mode: "muted", muted: true }))).toEqual({ glyph: "♫", color: "faint", pressable: true });
});

test("a recording wins over voice being unable to listen, for every reason", () => {
  for (const why of ["mic_missing", "mic_denied", "mic_busy", "server_down"] as const) {
    expect(item(at({ mode: "muted", unavailable: why }))).toBeNull();
    expect(item(at({ mode: "muted", unavailable: why, recording: "running" }))).toEqual({ glyph: "●", color: "hot", pressable: false });
    expect(item(at({ mode: "muted", unavailable: why, recording: "paused" }))).toEqual({ glyph: "●", color: "warm", pressable: false });
  }
  // Muted or listening, a recording looks the same.
  expect(item(at({ mode: "muted", muted: true, recording: "running" }))).toEqual(item(at({ recording: "running" })));
});

test("the target, its reason, the pid, muted and updated_at never change the item (clarification Q1)", () => {
  for (const s of [at({}), at({ mode: "muted" }), at({ recording: "running" }), at({ recording: "paused" })]) {
    const want = item(s);
    for (const over of [
      { target: null, reason: "no viewer attached" },
      { target: null, reason: "Corgi unreachable" },
      { target: { machine: "marovo", label: "marovo → api" } },
      { pid: 99, updated_at: 12345 },
    ])
      expect(item({ ...s, ...over })).toEqual(want);
  }
  // The setting alone does not decide: the mode the window shows does.
  expect(item(at({ muted: true, mode: "listening" }))?.color).toBe("accent");
});

test("each glyph is one character and items compare by look and press", () => {
  for (const s of [at({}), at({ mode: "muted" }), at({ recording: "running" }), at({ recording: "paused" })])
    expect([...item(s)!.glyph]).toHaveLength(1);
  expect(sameItem(null, null)).toBe(true);
  expect(sameItem(item(at({})), null)).toBe(false);
  expect(sameItem(null, item(at({})))).toBe(false);
  expect(sameItem(item(at({})), item(at({ target: null })))).toBe(true);
  expect(sameItem(item(at({})), item(at({ mode: "muted" })))).toBe(false);
  expect(sameItem(item(at({ recording: "running" })), item(at({ recording: "paused" })))).toBe(false);
  expect(sameItem({ glyph: "♫", color: "accent", pressable: true }, { glyph: "♫", color: "accent", pressable: false })).toBe(false);
});
