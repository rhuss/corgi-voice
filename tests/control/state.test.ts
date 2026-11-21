import { test, expect } from "bun:test";
import { stateOf, equal, shortLine, target, type StateSource, type VoiceState } from "../../src/control/state";
import { VoiceSession } from "../../src/voice/session";
import { Segmenter } from "../../src/voice/segmenter";
import type { VoiceLink } from "../../src/voice/link";
import type { RecordingState } from "../../src/voice/recorder";
import * as ui from "../../src/ui/ui";

/** A session listening with a local viewer on `focus`. */
function source(over: Partial<StateSource> = {}): StateSource {
  return {
    muted: false,
    available: true,
    unavailable: null,
    viewer: true,
    focus: "bat · corgi-voice",
    machine: "local",
    reason: null,
    link_state: "connected",
    ...over,
  };
}
const none = { current: null },
  rec = (state: RecordingState) => ({ current: { state } });
const state = (s: StateSource, r: { current: { state: RecordingState } | null } = none, now = 1000) =>
  stateOf({ session: s, recorder: r, pid: 42, now: () => now });

test("listening with a target: the full state and its short line (US2 scenario 1)", () => {
  const st = state(source());
  expect(st).toEqual({
    pid: 42,
    muted: false,
    mode: "listening",
    unavailable: null,
    reason: null,
    recording: "none",
    target: { machine: "local", label: "bat · corgi-voice" },
    updated_at: 1000,
  });
  expect(shortLine(st)).toBe("listening · bat · corgi-voice");
  expect(shortLine(state(source({ muted: true })))).toBe("muted · bat · corgi-voice");
});

test("without a target the line shows the reason's head, as the window's Target cell (US2 scenario 4)", () => {
  const no_viewer = state(source({ viewer: false, focus: null, machine: null, reason: "no viewer attached" }));
  expect([no_viewer.target, no_viewer.reason]).toEqual([null, "no viewer attached"]);
  expect(shortLine(no_viewer)).toBe("listening · no viewer attached");
  expect(shortLine(state(source({ viewer: false, focus: null, reason: "no viewer attached", muted: true })))).toBe(
    "muted · no viewer attached",
  );
  const lost = state(
    source({ viewer: false, focus: null, machine: null, reason: "Corgi unreachable: connection refused", link_state: "lost" }),
  );
  expect(lost.reason).toBe("Corgi unreachable: connection refused");
  expect(shortLine(lost)).toBe("listening · Corgi unreachable");
  expect(shortLine(state(source({ viewer: false, focus: null, reason: "marovo unreachable: ssh timed out" })))).toBe(
    "listening · marovo unreachable",
  );
  // No reason from the link: the window's own fallbacks.
  expect(state(source({ viewer: false, reason: null, link_state: "lost" })).reason).toBe("Corgi unreachable");
  expect(state(source({ viewer: false, reason: null })).reason).toBe("no viewer attached");
  // The reason is null exactly when there is a target.
  expect(state(source()).reason).toBeNull();
});

test("a remote target's label names its machine", () => {
  const st = state(source({ machine: "marovo", focus: "api · logs" }));
  expect(st.target).toEqual({ machine: "marovo", label: "marovo → api · logs" });
  expect(shortLine(st)).toBe("listening · marovo → api · logs");
  // A viewer without a focused pane: the machine alone.
  expect(state(source({ focus: null, machine: null })).target).toEqual({ machine: "local", label: "local" });
});

test("while voice cannot listen the mode is muted and the line says why, over a missing target", () => {
  const words = {
    mic_missing: "microphone missing",
    mic_denied: "microphone access denied",
    mic_busy: "microphone busy",
    server_down: "transcription server down",
  } as const;
  for (const [unavailable, text] of Object.entries(words)) {
    const st = state(source({ available: false, unavailable: unavailable as keyof typeof words }));
    expect([st.muted, st.mode, st.unavailable]).toEqual([false, "muted", unavailable as keyof typeof words]);
    expect(shortLine(st)).toBe(`muted · cannot listen: ${text}`);
  }
  expect(shortLine(state(source({ available: false, unavailable: "mic_missing", viewer: false, reason: "no viewer attached" })))).toBe(
    "muted · cannot listen: microphone missing",
  );
});

test("a recording ends the line in REC, REC paused while paused; a stopping one counts as none (US2 scenario 5)", () => {
  expect(shortLine(state(source({ muted: true }), rec("running")))).toBe("muted · bat · corgi-voice · REC");
  expect(shortLine(state(source(), rec("paused")))).toBe("listening · bat · corgi-voice · REC paused");
  expect(state(source(), rec("stopping")).recording).toBe("none");
  expect(state(source(), rec("closed")).recording).toBe("none");
  expect(shortLine(state(source(), rec("stopping")))).toBe("listening · bat · corgi-voice");
});

test("updated_at moves only when another field changes", () => {
  const first = state(source(), none, 1000),
    again = stateOf({ session: source(), recorder: none, pid: 42, now: () => 2000, previous: first });
  expect(again.updated_at).toBe(1000);
  expect(equal(first, again)).toBe(true);
  const muted = stateOf({ session: source({ muted: true }), recorder: none, pid: 42, now: () => 3000, previous: again });
  expect(muted.updated_at).toBe(3000);
  expect(equal(again, muted)).toBe(false);
  // equal() looks at every field but updated_at.
  const base = state(source());
  for (const change of [
    { pid: 7 },
    { muted: true },
    { mode: "muted" },
    { unavailable: "mic_busy" },
    { reason: "x" },
    { recording: "paused" },
    { target: null },
    { target: { machine: "m", label: "bat · corgi-voice" } },
    { target: { machine: "local", label: "other" } },
  ] as Partial<VoiceState>[])
    expect(equal(base, { ...base, ...change })).toBe(false);
  expect(equal(base, { ...base, updated_at: 5 })).toBe(true);
});

test("the Target cell's text comes from here, unchanged", () => {
  expect(target(source())).toBe("bat · corgi-voice");
  expect(target(source({ viewer: false, reason: "Corgi unreachable: refused" }))).toBe("Corgi unreachable");
  expect(target(source({ viewer: false, reason: null, link_state: "lost" }))).toBe("Corgi unreachable");
  expect(target(source({ viewer: false, reason: null }))).toBe("no viewer attached");
});

const idle: VoiceLink = {
  watch: () => new Promise(() => {}),
  type: async () => {
    throw Error("NoViewer");
  },
  on: () => {},
  close: () => {},
};

test("the state's mode is muted exactly when the window shows MUTED (SC-002)", () => {
  const session = new VoiceSession({
    link: idle,
    transcriber: { transcribe: async () => ({ text: "" }), on: () => {} },
    segmenter: new Segmenter({ threshold: 44, now: () => 0 }),
    now: () => 0,
  });
  session.link_state = "connected";
  const check = () =>
    expect(state(session).mode === "muted").toBe(ui.mode(session).muted);
  check();
  session.setMuted(true);
  check();
  session.setMuted(false);
  check();
  session.setAvailable(false, "mic_missing");
  check();
  session.setMuted(true);
  check();
  session.setAvailable(true, null);
  check();
  session.setMuted(false);
  session.viewer = false;
  check();
  expect(state(session).target).toBeNull();
});
