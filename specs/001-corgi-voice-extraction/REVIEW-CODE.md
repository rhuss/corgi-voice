# Code Review: corgi-voice Extraction

**Spec:** specs/001-corgi-voice-extraction/spec.md
**Date:** 2026-11-20
**Reviewer:** Claude (speckit.spex-gates.review-code, ship pipeline stage 7)
**Carried-over references:** Corgi `001-voice-dictation` spec (dictation, post-roll FR-034 to FR-036, gauge) and `005-voice-transcripts` spec (recording)

## Compliance Summary

**Overall Score: 98% (44/45 live items)** (initial score before this stage's fixes: 89%, 40/45)

- Functional Requirements: 31/32 (97%)
- Edge Cases: 13/13 (100%)
- Non-Functional / Success Criteria checkable in code: covered by tests (SC-001, SC-004, SC-007, SC-008); SC-002, SC-003, SC-005, SC-006, SC-009 need real hardware and were not scored

No `## Constants` section in the spec; the constants check was skipped.

### Deviations found and fixed in this stage

| Item | Deviation | Fix |
|------|-----------|-----|
| FR-017 (dictation FR-034 to FR-036, FR-031, User Story 7) | Post-roll was missing entirely: a fixed 0.3 s trail, no `post_roll` setting, no options-line entry or menu, no help entry, no per-request filter padding, no cut diagnostics (the port came from the 005 branch, which predates post-roll) | Ported from Corgi 001 (2434ad2): segmenter post-roll with whole pause and window limit, `post_roll` setting, shared timing for dictation and recording, options line and menu, help entry, `vad_speech_pad_ms` per request, srt segment times and `kept`/`dropped`/`pad`/`speech_end` in the verbose log, README |
| Edge case "pane gone" / FR-013 | A hibernated pane was refused as "pane hibernated", a reason the spec does not name | Reads "pane gone" (1547854) |
| FR-012 | The subprocess bound and abort listener were armed after stdin was written | Armed from the spawn (1547854) |
| Edge case "recording while Corgi unreachable", User Story 2 scenario 3 | Rows said "no viewer attached" / "no viewer" instead of the reason (for example "marovo unreachable") | Rows carry the window's reason (c0bf9d1) |
| Edge case "output format changes" | A viewer missing `id` or `active` was dropped and another chosen | The reply is "Corgi output not understood" (41b96e9) |
| Corgi 005 FR-004a (via FR-019) | Passages were assigned at segment end, not at end of speech | Assigned by recording run spans at `speech_end` (41b96e9 to 525f5a9) |

### Remaining deviation

| Item | Deviation | Classification |
|------|-----------|----------------|
| FR-008 | The pane label falls back to the agent (or command) and the last segment of its cwd before the pane id; the spec says "its title when `corgi list` reports one, else its id" | Minor, spec evolution candidate (helpful extra; update the spec) |

## Code Review Guide

Where to look and what to check when reviewing this branch by hand:

1. **Corgi boundary (FR-002, FR-010 to FR-015):** `src/corgi/` is the only code that runs `corgi`. `poller.ts` polls each machine on its own (1 s, bounded at 1.5 s); `viewers.ts` holds the pure target rules (FR-006) and freshness (2 s); `link.ts` delivers one utterance at a time with `pane send --stdin`, bounded at 2 s, and adds the leading space; `errors.ts` is the one table of error patterns. `tests/contract.test.ts` pins the boundary.
2. **Session (`src/voice/session.ts`):** hold-off without a target (FR-009), mute (FR-016), backlog and the 30-passage audio bound, reasons on rows.
3. **Recording (`src/voice/recorder.ts`, `turns.ts`, `transcript.ts`):** run spans and the hold on the passage in progress at a pause or stop (005 FR-004a), late counts, write errors.
4. **Segmenter (`src/voice/segmenter.ts`):** post-roll cut, capped segments untrimmed, short continuations of a cap cut kept, `speechEnd` for the recorder.
5. **Lock (`src/util/lock.ts`):** atomic creation, reaper turn; see the remaining finding below.
6. **Startup (`src/main.ts`):** order of checks (corgi command, lock, model, tools), cleanup on every exit path.

## Deep Review Report

**Gate Outcome:** FAIL after 3 fix rounds (plus a follow-up commit for a round 3 regression): 1 Important finding remains, classified ambiguous (needs a design decision). Full details: `review-findings.md`.

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| Critical | 0 | 0 | 0 |
| Important | 19 | 17 | 0 (1 dismissed, 1 accepted: FINDING-19 lock race, see resolution below) |
| Minor | 40 | 19 | 20 |
| Notable | 7 | - | 7 |

Dismissed with rationale (not fixed, not remaining): Codex P1 (macOS `:default` capture device, identical to the source and confirmed by the walkthrough), Codex P2 (tighten permissions of an existing transcript; the 005 spec keeps existing file permissions).

### Review agents

| Agent | Found | Fixed | Remaining | Status |
|-------|-------|-------|-----------|--------|
| Correctness | 4 | 3 | 0 (+1 Notable) | completed |
| Architecture & Idioms | 14 | 3 | 9 (+2 Notable) | completed |
| Security | 4 | 2 | 1 (+1 Notable) | completed |
| Production Readiness | 5 | 1 | 3 (+1 Notable) | completed |
| Test Quality | 13 | 6 | 7 | completed |
| Goal Alignment | 0 | 0 | 0 | skipped (no PR: no git remote) |
| CodeRabbit (external) | 13 | 12 | 1 | completed (4 runs) |
| Codex (external) | 3 | 1 | 0 (2 dismissed) | completed |
| Copilot (external) | 0 | 0 | 0 | skipped (disabled in config) |
| Re-review agents (rounds 1 to 3) | 10 | 8 | 0 (+2 Notable) | completed |
| Test Suite (regression) | 0 | 0 | 0 | passed every round (472 tests at the end) |

MVP: Architecture & Idioms (14 findings)

### Key fixes applied

1. Post-roll ported from Corgi 001 (FR-017, User Story 7).
2. Passages assigned to the recording running when their speech ended; a hold on the passage in progress at a pause or stop, let go when the speech went on (005 FR-004a).
3. Single-instance lock: atomic creation, unreadable locks kept, reaper turn for stale locks, release on exit (FR-005).
4. `ui.run` restores the terminal and stops whisper-server when setup or the first frame fails.
5. Late counts include passages lost to a write error; at most 30 passages wait for Whisper.
6. Short speech continuing a cap cut is kept.
7. Malformed viewer data holds dictation off as "Corgi output not understood"; ids and machine names validated before reaching `--machine` or `pane send`.
8. Voice pane from `CORGI_PANE` through a tested helper (pane 0 included); mute restored after a recording even while voice cannot listen.
9. Tests: abandoned `pane send` process proven dead (FR-012), every ssh pattern (FR-013), startup failures and single-instance refusal, inner line breaks.

### Remaining findings (Critical and Important)

- **Important, ambiguous:** `src/util/lock.ts:65-85` (CodeRabbit). If a reaper dies while holding its turn and two starters judge that turn stale at the same instant, one can delete the other's new turn and both can then reap, so two instances could start. It is very unlikely and documented in the code. Closing it needs an OS lock primitive (`flock`), and the repository's contract test forbids `bun:ffi`. Decide whether to accept the window or to allow FFI for the lock.
  - **Resolution (ship pipeline, oversight never, 2026-11-20):** accepted. FFI would break SC-007 (no native code); the window is documented in the code and in spec FR-005. FR-008 pane label wording updated in the spec to match the implemented label rule.

Post-fix spec coverage: all functional requirements verified after the fix loop.
