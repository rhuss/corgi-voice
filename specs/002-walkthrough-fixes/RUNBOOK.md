---
runbook_version: 1
feature: 002-walkthrough-fixes
status: passed
mode: light
steps_total: 5
step_results: passed,passed,passed,passed,passed
drafted_at: 452f4ef
drafted_fingerprint: 22311ab986115c3166ead06f64c8695bb492540205b6ef3125039ffb6f3d5f99
tested_at: 0a9d163
tested_fingerprint: 3cf16a773b813ef211ed542f023fc41a6f48c9afa84f2e5b40af43e195adcf01
updated: 2026-11-21
---

# Try it: Walkthrough Fixes

<!-- runbook-status -->
> **Status:** passed · 5 of 5 steps (5 passed) · Mode: light · Tested at 0a9d163 · 2026-11-21
<!-- /runbook-status -->






## What you're testing

The three fixes from the first walkthrough: setup now catches a `corgi` command that cannot talk to the running Corgi, the recording file prompt is one path field with a Tab folder pop-down, and stopping a recording no longer waits 10 seconds when background noise goes on.

Order: tests, setup against the wrong and the right `corgi`, then in the voice window the folder pop-down and a recording stopped while noise continues.

## Test environment

No fixtures. It uses your running Corgi, the old release at `~/.local/bin/corgi` (which cannot talk to it), your custom build, a microphone, and some steady background sound (music or a fan) for the last step.

## Steps

### Step 1 of 5: Run the automated checks (US1, US2, US3)

**Why this step:** every scenario has a test that needs no microphone, Whisper or Corgi.

**Run:**

```
bun run check && bun test
```

**What you should see:** the type check prints nothing and `bun test` ends with about 557 pass and 0 fail.

**If you see something else:** a failing test names the file; `tests/voice/recorder.test.ts` and `tests/voice/session.test.ts` hold the stop cases, `tests/ui/complete.test.ts` and `tests/ui/prompt.test.ts` the completion, `tests/corgi/command.test.ts` and `tests/voice/setup.test.ts` the probe.

**Result:** passed (agent, 2026-11-21). `bun run check` clean; `bun test` 557 pass, 0 fail (39 files, 93 s). Log: `specs/002-walkthrough-fixes/.walkthrough/step-1.log`. Later fixes in this walkthrough raised the suite to 572.

### Step 2 of 5: Setup with the old corgi reports a mismatch (US3)

**Why this step:** this is the walkthrough's failure; setup should now catch it before the voice window opens.

**Run:**

```
bun src/main.ts --setup --corgi ~/.local/bin/corgi; echo "exit=$?"
```

**What you should see:** a `[mismatch] corgi /Users/rhuss/.local/bin/corgi cannot talk to the running Corgi: JSON Parse error: ...` line, the hint to set `"corgi"` in `voice.json` or pass `--corgi`, exactly one `corgi` line, and `exit=1`.

**If you see something else:** `[ok] corgi` means the probe did not run or the old release can talk to Corgi after all; `[note]` means Corgi is not running.

**Result:** passed after a fix (agent). First run: `[mismatch]`, exit 1, one corgi line, but the quoted error was the raw reply `{"ok":false,"err":"JSON Parse error: ...` because the old release prints it on standard error (exit 2). Fixed in `aeff051` (read `err` from either stream, tests for setup and the poller). Rerun: `[mismatch] corgi /Users/rhuss/.local/bin/corgi cannot talk to the running Corgi: JSON Parse error: Unexpected identifier "HTTP"`, the hint, exit 1.

### Step 3 of 5: Setup with your custom build reports ok (US3)

**Why this step:** the right command must still pass, with an empty viewer list being fine.

**Run:**

```
bun src/main.ts --setup; echo "exit=$?"
```

**What you should see:** `[ok] corgi /Users/rhuss/Development/context-engineering/corgi-integration/dist/corgi-custom` (taken from `voice.json`), the other `[ok]` lines, `Voice is ready`, and `exit=0`.

**If you see something else:** `[mismatch]` here means the custom build's reply was not understood; the quoted error line says why.

**Result:** passed (agent). `[ok] corgi /Users/rhuss/Development/context-engineering/corgi-integration/dist/corgi-custom` (from voice.json), all other `[ok]`, `Voice is ready`, exit 0.

### Step 4 of 5: Pick a folder with the Tab pop-down (US2)

**Why this step:** the path should be visible once, editable, and folders easy to pick, including going up.

**Needs:** sub-folders in the transcript folder; create them with the command below.

**Run:**

```
mkdir -p ~/.local/share/corgi/transcripts/walkthrough-test/2025 ~/.local/share/corgi/transcripts/walkthrough-test/2026
```

**Do:**

1. Start the voice window from this worktree: `bun src/main.ts --verbose` (verbose, so step 5 can read the log).
2. Press `r`. One field shows `~/.local/share/corgi/transcripts/` plus today's suggested name, caret before `.txt`.
3. Press Tab, type `walk`, press Enter: the field reads `.../transcripts/walkthrough-test/<name>.txt`, caret still in the name.
4. Press Tab again, pick `2026/` with the arrows, press Enter: `.../walkthrough-test/2026/<name>.txt`.
5. Move the caret to the start of the file name (Left until it sits right after `2026/`) and press Backspace twice: the field walks up to `.../transcripts/<name>.txt`; keep pressing to go above the transcript folder.
6. Press Esc to leave without recording.

**What you should see:** the path on screen exactly once; the pop-down at the caret with the filter in its frame; every choice visible before it is taken; Backspace at the file name start removes one folder per press; Esc cancels without creating a file.

**If you see something else:** Tab with nothing listed shows `no folders` or `cannot read`; a pop-down that does not filter means the typed letters went into the field (it was not open).

**Result:** passed on the third design (user). Tab completion alone hid the choices and could not leave the transcript folder; the always-open folder list repeated the path three times and fought with the name field (screenshot feedback). Final design (`e5f7522`): one full-path field with a Tab pop-down at the caret, filter in the frame, Backspace at the file name start goes up one folder. User: "works".

### Step 5 of 5: Stop a recording while noise goes on (US1)

**Why this step:** the walkthrough's 10 second wait; a stop now cuts the passage in progress at `R`, so the file closes right after that part is transcribed.

**Needs:** Step 4's window still open; steady background sound above the recording threshold (start some music).

**Do:**

1. Press `r`, Enter (use `walkthrough-test/` in front of the name if you like).
2. Say a sentence, then while the music keeps playing press `R`.
3. Quit with `q`, then run the command below.

**Run:**

```
rg "recording: (stopped|cut|let go)" ~/.local/state/corgi-voice/voice.log | tail -3
```

**What you should see:** a `recording: cut utterance N at the stop` line, then `recording: stopped ... waited_ms=` with a value of a few hundred ms (the transcription of the cut part, not about 10000 or 1800) and `late=0`. The sentence you said before `R` is in the file.

**If you see something else:** `waited_ms=10001` again means the hold was not released; the log lines just before it show what the speech detector did.

**Result:** passed after two fixes (user, log checked by agent). First run: `waited_ms=1785` (the dictation threshold returned at the stop while music sat between 20 and 44). Second (`4e1bb11`, recording values kept for the held passage): `waited_ms=1869` (music peaks shorter than the burst length kept the silence count from finishing). Final design (`0a9d163`, a stop cuts the passage in progress): `recording: cut utterance 2 at the stop`, `waited_ms=90 late=0`, the file holds `Hello!` (mode 0600).

## Coverage

All three user stories: US1 (step 5, plus tests in step 1), US2 (step 4), US3 (steps 2 and 3).

## Results

Run on 2026-11-21 with the user: 5 steps, 5 passed, three of them after fixes found live. Setup now names a `corgi` build that cannot talk to the running Corgi, with the fix (`[mismatch]`, exit 1), and passes the right one. The recording file prompt is one path field with a Tab folder pop-down (third design, after two rounds of feedback). Stopping a recording cuts the passage in progress at the stop, writes its part before the stop, and closes the file in about 0.1 s even with music (was 10 s, then 1.8 s).
