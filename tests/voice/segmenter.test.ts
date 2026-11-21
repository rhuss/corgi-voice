import { test, expect } from "bun:test";
import { Segmenter, type Segment, type Timing } from "../../src/voice/segmenter";
import { shapes, concat, silence, tone } from "../fixtures/voice/make_pcm";

/** A segmenter fed 20 ms frames on a clock that moves with them; `ends` holds
 * the clock at each segment that came out. */
function live(opts: { threshold?: number; cap?: number } & Partial<Timing> = {}) {
  let clock = 0;
  const { threshold = 44, cap, ...timing } = opts;
  const segmenter = new Segmenter({ threshold, timing, now: () => clock }),
    segments: Segment[] = [],
    ends: number[] = [];
  if (cap !== undefined) segmenter.setCap(cap);
  const push = (pcm: Int16Array) => {
    for (let at = 0; at < pcm.length; at += 320) {
      clock += 20;
      for (const s of segmenter.push(pcm.subarray(at, at + 320))) {
        segments.push(s);
        ends.push(clock);
      }
    }
  };
  return { segmenter, segments, ends, push };
}
/** Feeds `pcm` in 20 ms frames on a clock that moves with the frames. */
function feed(pcm: Int16Array, opts: { threshold?: number; cap?: number } & Partial<Timing> = {}) {
  const l = live(opts);
  l.push(pcm);
  return l;
}
/** Speech, then a soft ending under the threshold (44 is RMS about 0.0154),
 * then a pause longer than the silence window. */
const softEnding = () => concat(tone(1.5), tone(0.8, 0.005), silence(3));

test("one burst of speech is one utterance, with pre-roll and trimmed silence", () => {
  const { segments, segmenter } = feed(concat(silence(1), shapes.speech()));
  expect(segments).toHaveLength(1);
  // 0.3 s pre-roll, 1.5 s of speech, 1 s of the silence (the default post-roll).
  expect(segments[0].duration).toBeCloseTo(2.8, 5);
  expect(segments[0].pcm.length).toBe(2.8 * 16000);
  expect(segments[0].started_at).toBe(1000 - 300 + 20);
  expect(segmenter.recording).toBe(false);
});

test("noise below the threshold is no utterance", () => {
  const { segments, segmenter } = feed(shapes.noise());
  expect(segments).toHaveLength(0);
  expect(segmenter.recording).toBe(false);
  // The same noise above the threshold would have been one.
  expect(feed(shapes.noise(), { threshold: 0 }).segments).toHaveLength(1);
});

test("a long utterance goes out at 30 s and listening carries on", () => {
  const { segments } = feed(concat(shapes.long(), silence(3)));
  expect(segments).toHaveLength(2);
  expect(segments[0].duration).toBe(30);
  expect(segments[1].duration).toBeCloseTo(6, 5);
});

test("speech times leave out the pre-roll and the quiet after the speech", () => {
  const [s] = feed(concat(silence(1), shapes.speech())).segments;
  // Frames count from started_at, the start of the 0.3 s pre-roll.
  expect(s.speech_start).toBe(s.started_at + 300);
  expect(s.speech_end - s.speech_start).toBe(1500);
  expect(s.capped).toBe(false);
  // Without pre-roll the speech starts with the utterance.
  const [bare] = feed(concat(silence(1), shapes.speech()), { pre_roll: 0 }).segments;
  expect(bare.speech_start).toBe(bare.started_at);
  expect(bare.speech_end - bare.speech_start).toBe(1500);
  // Short peaks after the speech belong to the pause, not to the speech.
  const beats = Array.from({ length: 20 }, () => concat(silence(0.18), tone(0.02)));
  const [music] = feed(concat(tone(1.5), ...beats, silence(3)), { silence: 1 }).segments;
  expect(music.speech_end - music.speech_start).toBe(1500);
  // Two bursts 3 s apart: the gap between them is the quiet, without pre-roll or trail.
  const [a, b] = feed(shapes.two()).segments;
  expect(b.speech_start - a.speech_end).toBe(3000);
});

test("a capped utterance carries on in the next one, without a gap", () => {
  const { segments } = feed(concat(silence(1), tone(35), silence(3)));
  expect(segments.map(s => s.capped)).toEqual([true, false]);
  expect(segments.map(s => s.continues)).toEqual([false, true]);
  const [first, next] = segments;
  // The cut is where the next one's speech starts, exactly.
  expect(first.cut_at).toBe(next.speech_start);
  expect(next.cut_at).toBeNull();
  expect(first.speech_start).toBe(first.started_at + 300);
  // The cap cuts at 30 s including the pre-roll; the speech runs up to the cut.
  expect(first.speech_end).toBe(first.started_at + 30_000);
  // The next one starts with the first frame after the cut.
  expect(next.speech_start).toBe(first.speech_end);
  expect(next.speech_end - next.speech_start).toBe(5300);
});

test("the cap can be lowered, but not past 30 s", () => {
  const ten = feed(concat(tone(25), silence(3)), { cap: 10 }).segments;
  expect(ten.map(s => s.duration)).toEqual([10, 10, 6]);
  expect(ten.map(s => s.capped)).toEqual([true, true, false]);
  expect(ten.map(s => s.continues)).toEqual([false, true, true]);
  expect(ten[1].speech_start).toBe(ten[0].speech_end);
  expect(ten[2].speech_start).toBe(ten[1].speech_end);
  expect(ten[2].speech_end - ten[0].speech_start).toBe(25_000);
  // Asked for more, it stays at the 30 s transcription window.
  expect(feed(concat(shapes.long(), silence(3)), { cap: 60 }).segments.map(s => s.duration)).toEqual([30, 6]);
});

test("speech after a cut whose quiet rest was dropped does not continue it", () => {
  // Speech stops 0.1 s before the cut: the rest is too short and is dropped.
  const { segments } = feed(concat(tone(9.9), silence(4), tone(1), silence(3)), { cap: 10, silence: 1 });
  expect(segments.map(s => [s.capped, s.continues])).toEqual([
    [true, false],
    [false, false],
  ]);
});

test("speech shorter than the minimum is kept when it carries on a cut at the cap", () => {
  // 0.1 s of speech after a 10 s cut, under the 0.2 s minimum: the end of a word, kept.
  const { segments } = feed(concat(tone(10.1), silence(3)), { cap: 10, silence: 1 });
  expect(segments.map(s => [s.capped, s.continues])).toEqual([
    [true, false],
    [false, true],
  ]);
  expect(segments[1].speech_end - segments[1].speech_start).toBe(100);
  // The same short sound on its own is still too little.
  expect(feed(concat(silence(1), tone(0.1), silence(3)), { silence: 1 }).segments).toEqual([]);
});

test("a cut sends what the utterance holds so far, untrimmed, and listening carries on (FR-001)", () => {
  const { segmenter, segments, push } = live({ silence: 1 });
  // Speech, then 0.4 s into the silence window.
  push(concat(silence(1), tone(1.5), silence(0.4)));
  const end = segmenter.speechEnd,
    [s, ...more] = segmenter.cut();
  expect(more).toEqual([]);
  // 0.3 s pre-roll, the speech and the quiet so far: no post-roll trimming, as at the cap.
  expect(s.duration).toBeCloseTo(2.2, 5);
  expect(s.pcm.length).toBe(2.2 * 16000);
  expect([s.capped, s.continues, s.kept, s.dropped]).toEqual([true, false, 0.4, 0]);
  // The speech ends where its last loud stretch did, not at the cut.
  expect(s.speech_start).toBe(s.started_at + 300);
  expect(s.speech_end).toBe(s.speech_start + 1500);
  expect(s.speech_end).toBe(end!);
  expect(s.cut_at).toBe(s.started_at + 2200);
  // The rest carries on the cut: it starts there, exactly.
  expect(segmenter.recording).toBe(true);
  push(concat(tone(0.5), silence(3)));
  expect(segments).toHaveLength(1);
  expect(segments[0].continues).toBe(true);
  expect(segments[0].speech_start).toBe(s.cut_at!);
  expect(segments[0].speech_end - segments[0].speech_start).toBe(500);
});

test("a cut while speech goes on ends the speech at the cut", () => {
  const { segmenter } = feed(concat(silence(1), tone(1)));
  const [s] = segmenter.cut();
  expect(s.speech_end).toBe(s.cut_at!);
  expect(s.kept).toBe(0);
  expect(segmenter.recording).toBe(true);
});

test("a cut with too little speech sends nothing, and a quiet rest ends without a segment", () => {
  const { segmenter, segments, push } = live({ silence: 1 });
  push(concat(silence(1), tone(0.1)));
  expect(segmenter.cut()).toEqual([]);
  expect(segmenter.recording).toBe(true);
  push(silence(3));
  expect(segments).toEqual([]);
  expect(segmenter.recording).toBe(false);
  // Nothing in progress: nothing to cut.
  expect(segmenter.cut()).toEqual([]);
  expect(segmenter.recording).toBe(false);
});

test("two bursts are two utterances", () => {
  // The first starts the stream, so only the second has pre-roll.
  expect(feed(shapes.two()).segments.map(s => s.duration)).toEqual([2.5, 2.8]);
});

test("short peaks, as in music under the threshold, do not hold an utterance open", () => {
  // A 20 ms beat every 0.2 s for 4 s after the speech.
  const beats = Array.from({ length: 20 }, () => concat(silence(0.18), tone(0.02)));
  const { segments } = feed(concat(tone(1.5), ...beats, silence(3)), { silence: 1 });
  // The speech ends 1 s after it stops, not after the beats; the beats alone are too little speech.
  expect(segments.map(s => s.duration)).toEqual([1.5 + 1]);
  // Dense peaks, 60 ms in every 100 ms, count as pause too: it ends 1 s after the speech.
  const dense = Array.from({ length: 40 }, () => concat(silence(0.04), tone(0.06)));
  expect(feed(concat(tone(1.5), ...dense, silence(3)), { silence: 1 }).segments[0].duration).toBeCloseTo(2.5, 5);
  // Speech that resumes within the window still continues the utterance.
  expect(feed(concat(tone(1), silence(0.6), tone(1), silence(3)), { silence: 1 }).segments).toHaveLength(1);
});

test("too little speech is dropped", () => {
  expect(feed(concat(tone(0.1), silence(3))).segments).toHaveLength(0);
});

test("the threshold and the silence window apply", () => {
  expect(feed(shapes.speech(), { threshold: 90 }).segments).toHaveLength(0);
  expect(feed(concat(tone(1), silence(1), tone(1), silence(3)), { silence: 0.5 }).segments).toHaveLength(2);
  // Raised mid-utterance, the threshold makes the same tone quiet: the pause runs out during it.
  const { segmenter } = feed(concat(tone(1), silence(1)));
  segmenter.setThreshold(100);
  const out: Segment[] = [],
    loud = tone(2);
  for (let at = 0; at < loud.length; at += 320) out.push(...segmenter.push(loud.subarray(at, at + 320)));
  expect(out).toHaveLength(1);
  expect(segmenter.recording).toBe(false);
  // At the old threshold, the tone keeps it open.
  const kept = feed(concat(tone(1), silence(1), tone(2)));
  expect(kept.segments).toHaveLength(0);
  expect(kept.segmenter.recording).toBe(true);
});

test("the silence window can change mid-stream, and the pause shows how far it is", () => {
  let clock = 0;
  const s = new Segmenter({ threshold: 44, now: () => clock }),
    out: Segment[] = [];
  const push = (pcm: Int16Array) => {
    for (let at = 0; at < pcm.length; at += 320) {
      clock += 20;
      out.push(...s.push(pcm.subarray(at, at + 320)));
    }
  };
  push(concat(tone(1), silence(0.5)));
  expect(s.pause).toBeCloseTo(0.2, 5);
  // A shorter window ends the utterance on the next quiet frame.
  s.setTiming("silence", 0.5);
  push(silence(0.02));
  expect(out).toHaveLength(1);
  expect(s.pause).toBe(0);
});

test("pre-roll, minimum speech and burst length apply, also when changed", () => {
  // No pre-roll: the utterance starts with the speech.
  expect(feed(concat(silence(1), shapes.speech()), { pre_roll: 0 }).segments[0].duration).toBeCloseTo(2.5, 5);
  expect(feed(concat(silence(1), shapes.speech()), { pre_roll: 0.5 }).segments[0].duration).toBeCloseTo(3, 5);
  // 0.1 s of speech counts once the minimum is lower.
  expect(feed(concat(tone(0.1), silence(3)), { min_speech: 0.05 }).segments).toHaveLength(1);
  // With 20 ms bursts counting as speech, the beats hold the utterance open.
  const beats = Array.from({ length: 20 }, () => concat(silence(0.18), tone(0.02)));
  expect(feed(concat(tone(1.5), ...beats, silence(3)), { silence: 1, burst: 0.02 }).segments[0].duration).toBeCloseTo(
    1.5 + 4 + 1,
    5,
  );
  // A pre-roll shortened mid-stream keeps only the new length.
  let clock = 0;
  const s = new Segmenter({ threshold: 44, now: () => clock }),
    out: Segment[] = [];
  const push = (pcm: Int16Array) => {
    for (let at = 0; at < pcm.length; at += 320) {
      clock += 20;
      out.push(...s.push(pcm.subarray(at, at + 320)));
    }
  };
  push(silence(1));
  s.setTiming("pre_roll", 0.1);
  push(concat(tone(1), silence(3)));
  expect(out.map(s => s.duration)).toEqual([2.1]);
});

test("abort drops the utterance in progress", () => {
  const s = new Segmenter({ threshold: 44, now: () => 0 });
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.push(pcm.subarray(at, at + 320));
  expect(s.recording).toBe(true);
  s.abort();
  expect(s.recording).toBe(false);
  const out: Segment[] = [];
  for (let at = 16000; at < pcm.length; at += 320) out.push(...s.push(pcm.subarray(at, at + 320)));
  // Only the rest of the burst comes out: 0.5 s of it and 1 s of silence.
  expect(out.map(s => s.duration)).toEqual([1.5]);
});

test("post-roll keeps a quiet sentence ending under the threshold", () => {
  const pcm = softEnding(),
    ending = pcm.subarray(1.5 * 16000, 2.3 * 16000);
  // The default 1 s holds the whole 0.8 s ending.
  const [kept] = feed(pcm).segments;
  expect(kept.duration).toBeCloseTo(2.5, 5);
  expect(kept.pcm.subarray(1.5 * 16000, 2.3 * 16000)).toEqual(ending);
  expect(kept.post_roll).toBe(1);
  expect(kept.kept).toBeCloseTo(1, 5);
  expect(kept.dropped).toBeCloseTo(1.5, 5);
  // 0.3 s, the old fixed trim, ends it 0.3 s after the last burst.
  const [cut] = feed(pcm, { post_roll: 0.3 }).segments;
  expect(cut.pcm.length).toBe(1.8 * 16000);
  // The speech and the first 0.3 s of the ending; its last 0.5 s is lost.
  expect(cut.pcm).toEqual(pcm.subarray(0, 1.8 * 16000));
  expect(cut.post_roll).toBe(0.3);
  expect(cut.kept).toBeCloseTo(0.3, 5);
  expect(cut.dropped).toBeCloseTo(2.2, 5);
  // The speech ends where the last loud frame does, whatever the post-roll.
  expect(kept.speech_end - kept.speech_start).toBe(1500);
  expect(cut.speech_end - cut.speech_start).toBe(1500);
});

test("whole pause, or a post-roll past the silence window, keeps the pause up to the window's end", () => {
  for (const post_roll of [Infinity, 5]) {
    const [s] = feed(softEnding(), { post_roll }).segments;
    expect(s.duration).toBeCloseTo(1.5 + 2.5, 5);
    expect(s.post_roll).toBe(2.5);
    expect(s.kept).toBeCloseTo(2.5, 5);
    expect(s.dropped).toBe(0);
  }
  // None ends the audio with the last burst.
  const [none] = feed(softEnding(), { post_roll: 0 }).segments;
  expect(none.duration).toBeCloseTo(1.5, 5);
  expect(none).toMatchObject({ post_roll: 0, kept: 0 });
  expect(none.dropped).toBeCloseTo(2.5, 5);
});

test("a peak shorter than a burst after the speech does not move the cut", () => {
  // 40 ms over the threshold 0.4 s after the speech; a burst is 0.1 s.
  const pcm = concat(tone(1.5), silence(0.4), tone(0.04), silence(3));
  const [s] = feed(pcm, { post_roll: 0.3 }).segments;
  expect(s.duration).toBeCloseTo(1.8, 5);
  expect(s.kept).toBeCloseTo(0.3, 5);
  // Were it a burst, the cut would follow it.
  expect(feed(pcm, { post_roll: 0.3, burst: 0.04 }).segments[0].duration).toBeCloseTo(1.5 + 0.4 + 0.04 + 0.3, 5);
});

test("with a burst longer than the first loud run, the cut follows that run", () => {
  // 0.2 s of speech, then a 0.1 s peak 0.3 s later; a burst is 0.3 s.
  const [s] = feed(concat(tone(0.2), silence(0.3), tone(0.1), silence(3)), { burst: 0.3, post_roll: 0.3 }).segments;
  expect(s.duration).toBeCloseTo(0.5, 5);
  expect(s.kept).toBeCloseTo(0.3, 5);
  expect(s.dropped).toBeCloseTo(2.2, 5);
});

test("an utterance cut at the cap is sent whole", () => {
  // During speech: nothing follows the last burst.
  const [during] = feed(shapes.long(), { post_roll: 0.3 }).segments;
  expect(during).toMatchObject({ duration: 30, kept: 0, dropped: 0, capped: true });
  // During the closing pause: the second of it so far stays.
  const { segments, segmenter } = feed(concat(tone(29), silence(4)), { post_roll: 0.3 });
  expect(segments).toHaveLength(1);
  expect(segments[0].duration).toBe(30);
  expect(segments[0].kept).toBeCloseTo(1, 5);
  expect(segments[0].dropped).toBe(0);
  expect(segments[0].capped).toBe(true);
  // Listening carried on; the pause alone was too little speech.
  expect(segmenter.recording).toBe(false);
  // A recording's lower cap sends its pieces whole too.
  const ten = feed(concat(tone(9.5), silence(4)), { cap: 10, silence: 1, post_roll: 0.3 }).segments;
  expect(ten).toHaveLength(1);
  expect(ten[0]).toMatchObject({ duration: 10, capped: true, dropped: 0 });
  expect(ten[0].kept).toBeCloseTo(0.5, 5);
});

test("post-roll never changes when an utterance ends", () => {
  const ends = [0.3, 1, Infinity].map(post_roll => feed(softEnding(), { post_roll }).ends);
  // 1.5 s of speech and the 2.5 s window.
  expect(ends).toEqual([[4000], [4000], [4000]]);
});

test("post-roll changes neither how an utterance starts, which ones count, nor the cap", () => {
  // Pre-roll, speech, a short peak, then a sound too short to count.
  const pcm = concat(silence(1), tone(1.5), silence(0.4), tone(0.04), silence(3), tone(0.1), silence(3)),
    base = feed(pcm, { post_roll: 0 });
  expect(base.segments).toHaveLength(1);
  expect(base.segments[0].capped).toBe(false);
  for (const post_roll of [0.3, 1, Infinity]) {
    const run = feed(pcm, { post_roll });
    expect(run.ends).toEqual(base.ends);
    expect(run.segments.map(s => s.started_at)).toEqual(base.segments.map(s => s.started_at));
    // The same speech times, so a recording's contributions break as before.
    expect(run.segments.map(s => [s.speech_start, s.speech_end])).toEqual(
      base.segments.map(s => [s.speech_start, s.speech_end]),
    );
    // The same pre-roll and speech, then more of the pause.
    expect(run.segments[0].pcm.subarray(0, base.segments[0].pcm.length)).toEqual(base.segments[0].pcm);
  }
  for (const post_roll of [0, Infinity])
    expect(feed(shapes.long(), { post_roll }).segments[0]).toMatchObject({ duration: 30, capped: true });
});

test("the cut reports the whole frames it kept", () => {
  // 0.75 s is 37.5 frames of 20 ms; the cut keeps 38.
  const [s] = feed(softEnding(), { post_roll: 0.75 }).segments;
  expect(s.post_roll).toBe(0.76);
  expect(s.kept).toBe(0.76);
  expect(s.dropped).toBeCloseTo(1.74, 5);
});

test("post-roll changed mid-utterance applies when it ends, within the silence window then", () => {
  const l = live();
  l.push(concat(tone(1), silence(1)));
  l.segmenter.setTiming("post_roll", 0.5);
  l.push(silence(2));
  expect(l.segments).toHaveLength(1);
  expect(l.segments[0].duration).toBeCloseTo(1.5, 5);
  expect(l.segments[0].post_roll).toBe(0.5);
  expect(l.segments[0].kept).toBeCloseTo(0.5, 5);
  expect(l.segments[0].dropped).toBeCloseTo(2, 5);
  // Whole pause reports the silence window in effect as the utterance ends.
  l.segmenter.setTiming("post_roll", Infinity);
  l.segmenter.setTiming("silence", 1);
  l.push(concat(tone(1), silence(2)));
  expect(l.segments).toHaveLength(2);
  expect(l.segments[1].post_roll).toBe(1);
  expect(l.segments[1].kept).toBeCloseTo(1, 5);
  expect(l.segments[1].dropped).toBe(0);
  // The timing reads back as set.
  expect(l.segmenter.timing.post_roll).toBe(Infinity);
});

test("whole pause follows a silence window changed mid-utterance", () => {
  const l = live({ silence: 1, post_roll: Infinity });
  l.push(concat(tone(1), silence(0.5)));
  l.segmenter.setTiming("silence", 2);
  l.push(silence(3));
  expect(l.segments).toHaveLength(1);
  expect(l.segments[0].duration).toBeCloseTo(3, 5);
  expect(l.segments[0].post_roll).toBe(2);
  expect(l.segments[0].kept).toBeCloseTo(2, 5);
  expect(l.segments[0].dropped).toBe(0);
  // Shortened below the pause so far, it ends the utterance on the next frame
  // and keeps no more than the new window, as any longer post-roll would.
  for (const post_roll of [Infinity, 1.2]) {
    const short = live({ post_roll });
    short.push(concat(tone(1), silence(1.5)));
    short.segmenter.setTiming("silence", 1);
    short.push(silence(0.02));
    expect(short.segments).toHaveLength(1);
    expect(short.segments[0].post_roll).toBe(1);
    expect(short.segments[0].kept).toBeCloseTo(1, 5);
    expect(short.segments[0].dropped).toBeCloseTo(0.52, 5);
    expect(short.segments[0].duration).toBeCloseTo(2, 5);
  }
});
