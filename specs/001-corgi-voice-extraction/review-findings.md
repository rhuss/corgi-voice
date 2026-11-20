# Deep Review Findings

**Date:** 2026-11-20
**Branch:** 001-corgi-voice-extraction
**Rounds:** 3 (plus one follow-up commit for a regression found in the round 3 re-review)
**Gate Outcome:** FAIL (1 Important remaining, classified ambiguous)
**Invocation:** quality-gate (ship pipeline, oversight: never)

## Summary

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| Critical | 0 | 0 | 0 |
| Important | 19 | 17 | 1 |
| Minor | 40 | 19 | 20 |
| Notable | 7 | - | 7 |
| **Total** | **66** | **36** | **28** |

One Important (Codex P1) and one Minor (Codex P2, transcript permissions) were dismissed with rationale and are neither fixed nor remaining.

**Agents completed:** 5/6 (+ 2 external tools: CodeRabbit, Codex)
**Agents skipped:** Goal Alignment (no PR found: the repository has no git remote)
**External tools:** CodeRabbit completed (4 runs: initial plus one per fix round); Codex completed (initial run); Copilot skipped (disabled in config)

Test command: `bun test` (auto-detected through package.json), plus `bun run check` (tsc).

## Findings

### FINDING-1 (lock races, merged)
- **Severity:** Important
- **Confidence:** 85
- **File:** src/util/lock.ts
- **Category:** correctness
- **Source:** coderabbit (3 findings), also reported by correctness-agent (Minor)
- **Round found:** 1
- **Resolution:** fixed (round 1), hardened in rounds 2 and 3

**What is wrong:** The single-instance lock was created with `wx` and the PID written after, so a second starter could read an empty file, treat it as stale and remove a live lock. A lock that could not be read (EIO) was also treated as stale. Two starters reaping the same stale lock could delete the replacement one of them had just created.

**Why this matters:** FR-005 requires that a second instance refuse to start, so the same speech is never typed twice.

**How it was resolved:** The lock file now appears whole by hard-linking a finished temporary file. An unreadable lock is kept and the start refused. A lock without a PID is reaped only after 2 s. Stale locks are removed only by a process holding a reaper turn (`<lock>.reap`, taken the same atomic way), which re-reads the lock under the turn. Tests: a deterministic `reap` test, an eight-process smoke test with a stdin barrier, and refusal, garbage and unreadable cases.

### FINDING-2
- **Severity:** Important
- **Confidence:** 80
- **File:** src/voice/session.ts, src/voice/recorder.ts
- **Category:** external
- **Source:** coderabbit
- **Round found:** 1
- **Resolution:** fixed (round 1), corrected in rounds 2, 3 and 525f5a9

**What is wrong:** A passage was assigned to a recording when its segment completed (after the silence window), not when its speech ended. Pausing or stopping within the silence window lost a passage whose speech had ended while recording; stopping A and starting B in that window put A's passage into B's file.

**Why this matters:** Corgi 005 FR-004a: a passage belongs to the recording state in effect when its speech ended.

**How it was resolved:** Recordings keep their running spans. A pause or stop holds the passage in progress; `claim()` assigns by `speech_end` against the spans. A held passage is let go when its speech went on past the pause or stop (decided by the segmenter's provisional speech end), so the stop neither waits for it nor counts it late. The session releases a hold wherever it drops the utterance in progress. Six clocked session tests cover pause, stop then start, speech past a stop, speech past a pause, drops, and quit in the silence window.

### FINDING-3
- **Severity:** Important
- **Confidence:** 80
- **File:** src/ui/ui.ts:1080-1110
- **Category:** external
- **Source:** coderabbit
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:** `ui.run` took raw mode, the alternate screen and listeners before its `try`, and `restore` read a `timer` constant declared later; a failure in setup or the first paint left the terminal broken and whisper-server running.

**How it was resolved:** Setup and the first paint moved inside the `try`, the timer is declared before `restore`, and `voice()` cleans up (whisper-server, recorder) when `ui.run` throws.

### FINDING-4
- **Severity:** Important
- **Confidence:** 80
- **File:** src/voice/recorder.ts
- **Category:** external
- **Source:** coderabbit, round 1 re-review (Minor follow-up)
- **Round found:** 1
- **Resolution:** fixed (rounds 1 and 2)

**What is wrong:** A write error cleared the pending passages without counting them, so a stop reported `late: 0` although passages were missing.

**How it was resolved:** The passage whose write failed and those still awaited count as left out; the history notice says how many were not written.

### FINDING-5
- **Severity:** Important
- **Confidence:** 75
- **File:** src/voice/segmenter.ts
- **Category:** external
- **Source:** coderabbit
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:** Speech shorter than the minimum that carried on a cut at the cap (10 s chunks while recording) was dropped, losing the end of a word.

**How it was resolved:** A continuation with any loud frames is kept; a continuation holding only quiet, and isolated short sounds, are still dropped. Test added.

### FINDING-6
- **Severity:** Important
- **Confidence:** 75
- **File:** src/voice/session.ts
- **Category:** external
- **Source:** coderabbit
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:** Recorded passages were always queued for Whisper, each holding its audio, with no limit, and the backlog count read the capped history.

**How it was resolved:** A `queued` counter, independent of the history, bounds waiting passages at 30 (about 10 MB); past it a passage fails with "backlog" and the recording notes that a passage was left out. Test added.

### FINDING-7 to FINDING-10 (test gaps)
- **Severity:** Important
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

- FINDING-7, tests/corgi/link.test.ts: nothing proved an abandoned `pane send` process is gone before the next delivery (FR-012). The fake corgi now logs its PID and the test asserts the process is dead; the timing check measures from the rejection.
- FINDING-8, src/main.ts: `CORGI_PANE` parsing was untested and treated pane 0 as none (FR-014). Now `ownPaneFrom(env)`, tested with unset, `7`, ` 12 `, `0` and invalid values.
- FINDING-9, src/main.ts: startup failures were untested (FR-004, FR-005, US6.2). `main` takes an injectable terminal check; tests cover a corgi without `--stdin`, a corgi that is not found, and a held lock.
- FINDING-10, src/corgi/errors.ts: two ssh patterns had no test (FR-013). A test covers every pattern with a sample that does not start with `ssh:`.

### FINDING-11 to FINDING-17 (re-review rounds)
- Round 1 re-review (Important): a stop counted the passage still being spoken as late and waited for it. Fixed in round 2.
- CodeRabbit round 1 (Important): stale-lock recovery could remove a replacement. Fixed in round 2 (reaper turn).
- CodeRabbit round 2 (Important, 2): a live reaper's turn reclaimed by age; turn removal racing a replacement. Fixed in round 3 (dead PID only; a minute for any turn) and 525f5a9.
- Round 3 re-review (Important): the round 3 heuristic (`pause > 0`) counted speech that went on past a stop as late when the bound fell between words. Fixed in 525f5a9 by deciding on the segmenter's provisional speech end; regression test added.

### FINDING-18 (dismissed)
- **Severity:** Important (Codex P1)
- **File:** src/voice/capture.ts:16
- **Resolution:** dismissed

**What was reported:** `:default` would be rejected by ffmpeg's avfoundation input on macOS.

**Why dismissed:** The capture arguments are identical to Corgi's 005 source, ffmpeg's avfoundation accepts `default` as a device name, and the quickstart walkthrough recorded working dictation with the default device.

### FINDING-19 (remaining)
- **Severity:** Important (CodeRabbit major)
- **Confidence:** 60
- **File:** src/util/lock.ts:65-85
- **Category:** external
- **Source:** coderabbit (round 3)
- **Round found:** 3
- **Resolution:** accepted (2026-11-20, ship pipeline oversight never): closing it needs a native OS lock, which SC-007 rules out; the window is documented in the code and in spec FR-005

**What is wrong:** If a reaper dies while holding its turn, two starters can both judge that turn stale; one removes it and takes a new turn, the other's delayed removal deletes the new turn, and two reapers can then run at once.

**Why this matters:** In that case two instances could both start (FR-005). It needs a reaper killed inside a microsecond window plus two starts at the same instant, so it is very unlikely; the code comment documents it.

**What is needed:** A path-based lock cannot close this without an OS lock primitive. `flock` through `bun:ffi` closes it fully but the repository's contract test bans `bun:ffi` (FR-001 / SC-007, no native bridge). Decide whether to accept the documented window or to allow an FFI `flock` (or another primitive) for the lock.

## Remaining Minor findings

**Update 2026-11-20 (after merge):** all items below are fixed: reconnect machinery and `closed` event removed, one control-character helper, typed `why` instead of matching display strings, stale comments reworded, `Target.gone` and `Poller.delivered()` instead of reaching into the poller, one `ThemeSetting`, cleanup armed from the first acquired resource (lock, whisper-server, capture, terminal), the late-passages line on signal exits, one `delivery:` log line per delivery (never the text), `machine list` failures logged once, SHA-256 check before taking an old-cache model, and the seven test gaps (now 502 tests). NOTABLE-1 and NOTABLE-2 are fixed as well; NOTABLE-3 to NOTABLE-7 remain observations.


- architecture: leftover reconnect machinery from Corgi's socket protocol in session.ts and link.ts (5 s retry, `closed` event, `VoiceLink.set`); dead `reason()` cases; dead modules and exports (src/util/json.ts, parts of util/text.ts and util/errors.ts); the control-character regex repeated in 8 places; display strings used as state (`unreachable` matching, "no viewer" vs "no viewer attached"); stale comments describing Corgi; CorgiLink reaching into Poller internals; `ThemeSetting` duplicated.
- production-readiness: crash handlers only exist while the window runs (a crash during model load leaves whisper-server running); a signal exit does not print the "passages did not finish" line; the verbose log has no per-delivery line (target, exit code, stderr) and the poller swallows `machine list` failures (also architecture F10).
- security: models taken from the old cache are checked by size only, not SHA-256.
- test-quality: vacuous "only text crosses" assertion; spec default constants (`bound_ms`, `machine_list_ms`, 10 s stop wait) not asserted; leading-space rule not tested across machines or viewers; delivery to the newly focused pane not asserted by argv; poller fallback-to-machine-list switch untested; setup test hides a `process.env` vs `deps.env` cache split; partial model in the new cache untested.
- lock (round 3 re-review): none left beyond FINDING-19; the refusal after all attempts now names the turn file to remove.

## Notable Observations

### NOTABLE-1
- **File:** src/corgi/link.ts:74-79
- **Category:** correctness
- **Description:** The delivery queue has no rejection handler; an exception before `deliver`'s try would wedge every later delivery.
- **Rationale:** No current path throws there, but one future change would stop dictation silently.

### NOTABLE-2
- **File:** src/voice/session.ts, src/corgi/link.ts
- **Category:** architecture
- **Description:** One delivery is bounded three times (link timer, subprocess timeout, session safety net).
- **Rationale:** Only the link's bound abandons the process; the others obscure which timer decides.

### NOTABLE-3
- **File:** src/voice/session.ts, src/ui/ui.ts
- **Category:** architecture
- **Description:** The session's change listeners have no production subscriber; the window repaints on a 20 Hz timer.
- **Rationale:** Two update models; FR-026 is met through row diffing.

### NOTABLE-4
- **File:** src/voice/whisper.ts
- **Category:** security
- **Description:** whisper-server listens on 127.0.0.1 without authentication (inherited from the source design).
- **Rationale:** A fixed `port` setting removes the only protection, the random port.

### NOTABLE-5
- **File:** src/util/subprocess.ts
- **Category:** production-readiness
- **Description:** Timeouts signal only the direct child, not grandchildren such as ssh.
- **Rationale:** Depends on whether `corgi` takes its ssh child down on SIGTERM.

### NOTABLE-6 and NOTABLE-7
- **File:** src/util/lock.ts
- **Category:** production-readiness
- **Description:** The rename-aside (round 1) and turn-based (round 2) reapers each leave a narrow multi-process window; see FINDING-19.

## Goal Alignment

Skipped: no PR found (the repository has no git remote).

## Post-Fix Spec Coverage

The fix loop removed code only inside rewritten functions (lock acquisition, recorder close and failure paths). Every functional requirement still has an implementation and passing tests; spot checks: post-roll (segmenter, settings, ui, whisper `vad_speech_pad_ms`), corgi commands (`machine list`, `list --json`, `--all-machines`, `pane send --stdin`), freshness (`fresh_ms`), voice pane, no-answer reason, lock, migration, theme detection, recording settings, speaker dash, file prompt, gauge. All spec requirements verified after the fix loop.

## Test Suite Results

| Round | Test Command | Exit Code | Failures | Status |
|-------|-------------|-----------|----------|--------|
| 1 | bun test; bun run check | 0 | 0 | passed (462 tests) |
| 2 | bun test; bun run check | 0 | 0 | passed (467 tests) |
| 3 | bun test; bun run check | 0 | 0 | passed (470 tests) |
| follow-up (525f5a9) | bun test; bun run check | 0 | 0 | passed (472 tests) |

Test suite passed in all fix rounds.

## Remaining Findings

FINDING-19 (Important, ambiguous) is the only Critical or Important finding left. It cannot be auto-fixed within the repository's own rules: closing the window needs an OS lock primitive, and the contract test forbids `bun:ffi`. A human decision is needed: accept and document the window, or allow an FFI `flock` for the single-instance lock.
