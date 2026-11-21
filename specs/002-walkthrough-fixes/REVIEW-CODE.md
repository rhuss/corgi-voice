# Code Review: Walkthrough Fixes

**Spec:** specs/002-walkthrough-fixes/spec.md
**Date:** 2026-11-20
**Reviewer:** Claude (speckit.spex-gates.review-code, ship pipeline stage 7, oversight never)
**Scope:** `git diff main...HEAD` (13 source files, 10 test files, README)

## Compliance Summary

**Overall Score: 98% (44/45 live items)**

- Functional Requirements: 12/13 (FR-008 has a wording deviation, see below)
- Acceptance Scenarios: 16/16 (US1 1-4, US2 1-7, US3 1-5)
- Edge Cases: 11/11
- Success Criteria: 5/5 checkable in tests (SC-001 timing test, SC-002 existing tests unchanged, SC-003 prompt test, SC-004 setup test with the walkthrough's error, SC-005 557 tests pass)

There are no superseded or retired items. The spec has no `## Constants` section, so the constants check was skipped.

### Requirement map

| Item | Implementation | Status |
|------|----------------|--------|
| FR-001 | `Recorder.letGoIfContinued` (src/voice/recorder.ts), called per frame while a passage is in progress (src/voice/session.ts); `speechEnd` is the end of the last loud stretch, so short bursts do not count (src/voice/segmenter.ts) | Compliant |
| FR-002 | Release settles the recording; `closed()` logs `waited_ms` from the stop and `late` without the released passage | Compliant |
| FR-003 | `unreserve`/`claim` keep passages that ended in time; `stop_wait_ms` unchanged | Compliant |
| FR-004 | `complete.ts` `base()`: transcript folder, `~/`, absolute | Compliant |
| FR-005 | Single match `name/`, common prefix, up to 8 listed, cycling with wrap, empty segment, code point order, other keys clear | Compliant |
| FR-006 | Text after caret kept, folders and links to folders only, hidden unless `.` typed, `..` escapes refused | Compliant |
| FR-007 | Unreadable folder: empty list, no error | Compliant |
| FR-008 | `checkReachable` (src/corgi/command.ts), 3 s bound, after the capability check; `[ok]`/`[note]`/`[mismatch]` in setup | Deviation (Minor): with no JSON `err`, all of standard error is classified, not only its first line |
| FR-009 | Mismatch line names the path, the first error line and the voice.json / `--corgi` fix | Compliant |
| FR-010 | `reach_patterns` next to `ssh_patterns` in src/corgi/errors.ts; setup treats unmatched as mismatch; window hints only on explicit patterns or a local reply without viewers | Compliant |
| FR-011 | `source` from `whyNone`, hint in status line and once per reason in history, local only | Compliant (after fix of FINDING-1) |
| FR-012 | Generated PCM, temp folders, the fake `corgi` | Compliant |
| FR-013 | README Tab completion section and "Corgi unreachable" troubleshooting | Compliant |

### Deviations found and fixed in this stage

| Item | Deviation | Fix |
|------|-----------|-----|
| FR-011 | The poller did not announce a change when the same reason moved to another machine ("Corgi output not understood" is one string for all), so the hint could be missing for a local mismatch or shown for a remote one | Change key includes the source (17d40bc) |
| FR-001 (test) | The "bursts shorter than the burst length do not count" rule had no test | Two session tests, click under and loud audio at the burst length (17d40bc) |

### Remaining deviation

| Item | Deviation | Classification |
|------|-----------|----------------|
| FR-008 | "The error text classified is ... else the first line of standard error": the code classifies all of standard error, which is more robust (a Bun connection error names `ConnectionRefused` on a later line) but can disagree with the window, which sees only the first line | Minor, ambiguous, spec evolution candidate (update the FR-008 wording, or classify only the first line) |

### Extra behavior (not in spec)

- `ECONNREFUSED` is an extra "not running" pattern next to `NoRuntime` and `ConnectionRefused`. It does no harm and could be added to the spec.
- A log line when a held passage is let go (added in this review for diagnosis).

## Code Review Guide

Where to look and what to check when reviewing this branch by hand:

1. **Stop and pause release (FR-001 to FR-003):** `src/voice/recorder.ts` `letGoIfContinued` uses the same boundary as `ranAt` (speech ending at the stop moment ended after it). `src/voice/session.ts` `frame` calls it last, after a cap cut has given the held passage its end. Tests: `tests/voice/recorder.test.ts` (unit, set `speechEnd`) and `tests/voice/session.test.ts` (clocked frame driver: SC-001, muted stop, burst rule, cap cut).
2. **Tab completion (FR-004 to FR-007):** `src/ui/complete.ts` is pure apart from `readdirSync`/`statSync`. `src/ui/prompt.ts` `tab()` holds the cycling state in code points. Tests: `tests/ui/complete.test.ts`, `tests/ui/prompt.test.ts`.
3. **Reachability (FR-008 to FR-010):** `src/corgi/errors.ts` (table, `classify`, `isMismatch`, `refused`), `src/corgi/command.ts` `checkReachable`, `src/voice/setup.ts` (lines through `spaced()`). Only `src/corgi/` spawns `corgi`, and the probe runs `list --json` only.
4. **Window hint (FR-011):** `src/corgi/viewers.ts` `whyNone` sets `source`, `src/corgi/poller.ts` `evaluate` announces source changes, `src/voice/session.ts` keeps `source`, `src/ui/ui.ts` `mismatched`/`hinted`/`sync`.
5. **README (FR-013):** the Tab completion paragraph and Troubleshooting, "Corgi unreachable".

## Deep Review Report

**Gate Outcome:** PASS after fix round 1 (round 2 closed a Minor gap found by the round 1 re-review). 0 Critical and 0 Important findings remain. Full details: `review-findings.md`.

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| Critical | 0 | 0 | 0 |
| Important | 2 | 2 | 0 |
| Minor | 19 | 6 | 12 (+1 dismissed) |
| Notable | 6 | - | 6 (captured to brainstorm/idea-inbox.md) |

Dismissed with rationale: CodeRabbit asked to exclude folder names with control characters, citing tasks.md; the live spec edge case says they are offered and shown as spaces.

### Review agents

| Agent | Found | Fixed | Remaining | Status |
|-------|-------|-------|-----------|--------|
| Correctness | 3 | 1 | 1 (+1 Notable) | completed |
| Architecture & Idioms | 9 | 3 | 5 (+1 Notable) | completed |
| Security | 3 | 1 | 0 (+2 Notable) | completed |
| Production Readiness | 5 | 1 | 2 (+1 Notable, +1 verification note) | completed |
| Test Quality | 8 | 3 | 4 (+1 Notable) | completed |
| Goal Alignment | 0 | 0 | 0 | skipped (no PR: no git remote) |
| CodeRabbit (external) | 1 | 0 | 0 (1 dismissed) | completed (2 runs; 0 findings on the fix commit) |
| Codex (external) | 1 | 1 | 0 | completed |
| Copilot (external) | 0 | 0 | 0 | skipped (disabled in config) |
| Re-review (round 1) | 3 | 1 | 0 (+2 verification notes) | completed |
| Test Suite (regression) | 0 | 0 | 0 | passed every round (557 tests at the end) |

The Codex finding and Correctness FINDING-1 were merged. So were Production FINDING-3 and Architecture FINDING-8, and Security FINDING-1 and the re-review finding.

MVP: Architecture & Idioms (9 findings)

### Key fixes applied

1. The poller announces a reason that moves to another machine, so the voice.json hint follows the local machine only (Codex, Correctness; FR-011).
2. Tests for the burst rule: a click under the burst length keeps the hold and the passage is written; loud audio of the burst length lets go and the stop closes promptly (Test Quality; FR-001).
3. A log line when a held passage is let go at a pause or stop (Production, Architecture).
4. Every `corgi` line in the setup report shows control characters as spaces (Security, re-review).
5. Stronger tests: the muted stop's timing; the probe's first-line-only detail and a reply that is not JSON (Test Quality).
6. The unused `parent` field was removed from the completion state, and the recorder doc comment corrected (Architecture).

### Remaining findings (Critical and Important)

None.

Remaining Minor findings (see review-findings.md for details):

- Ambiguous (design decision): FINDING-9, a spawn failure during the probe reads as `[mismatch]`; FINDING-13, the window decides the hint from the reason text; FINDING-15, synchronous `readdir` on a hung mount blocks the process; FINDING-16, history hint once per distinct reason text (as the contract says) versus once per episode.
- Unambiguous, deferred: FINDING-10 (segment start computed twice), 11 (unused `timedOut` parameter), 12 (`jsonFrom`/`unstarted` live in poller.ts), 14 (`Seen.source` optional), 17 (chmod test proves nothing), 18 (3 s bound only checked as a constant), 19 (no end-to-end pause/resume release test), 20 (prompt cycling under non-empty or astral parents).

Post-fix spec coverage: 13/13 functional requirements verified after the fix loop.
