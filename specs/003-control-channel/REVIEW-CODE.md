# Code Review: Control Channel and Hotkey Mute

**Spec:** specs/003-control-channel/spec.md (with contracts/control-protocol.md)
**Date:** 2026-11-21
**Reviewer:** Claude (speckit.spex-gates.review-code, ship pipeline stage 7, oversight never)
**Scope:** `git diff main...HEAD` (src/control/ new, src/main.ts, src/util/paths.ts, src/voice/session.ts, src/voice/recorder.ts, src/ui/ui.ts, scripts/bench-toggle.ts, README, 9 test files)

## Compliance Summary

**Overall Score: 100% (39/39 live items)**

- Functional Requirements: 12/12
- Acceptance Scenarios: 12/12 (US1 1-6, US2 1-5, US3 1)
- Edge Cases: 9/9
- Success Criteria: 5/5 checkable (SC-001 by hand with `bun run bench:toggle`, SC-002 to SC-005 in tests)
- Clarifications: honored (socket paths, `--watch` first line, cannot-listen line, toggle while cannot listen, one request per connection)

There are no superseded or retired items. The spec has no `## Constants` section, so the constants check was skipped.

### Requirement map

| Item | Implementation | Status |
|------|----------------|--------|
| FR-001 | `paths.socketPath` (XDG_RUNTIME_DIR, state folder, `$TMPDIR` fallback with ownership checks); `startServer` creates the folder 0700, removes a stale socket, binds 0600; `held.control` closed by `ending()` cleanup and the `exiting` handler; started after the lock | Compliant |
| FR-002 | `received`/`request` in src/control/server.ts: one line of at most 4096 bytes, ops `status mute unmute toggle watch`, `{ok,state,err?}`, close after the answer except `watch` | Compliant |
| FR-003 | `mute()` goes through `session.setMuted` (the `m` path), refuses unmute while voice cannot listen, toggle follows the shown mode, history row only when `muted` changes | Compliant |
| FR-004 | `stateOf` in src/control/state.ts: all eight fields, a stopping recording reports `none`, `updated_at` changes only with another field | Compliant |
| FR-005 | `watch` sends the state first; session and recorder `change` events broadcast; watchers past 64 KiB unsent or gone are dropped; `equal()` prevents duplicates | Compliant |
| FR-006 | The server only reads state and calls `setMuted`/`note`; contract test forbids spawn, corgi and pane send in src/control/ | Compliant |
| FR-007 | `control()` in src/main.ts, `shortLine()`: mode and label, reason head, `cannot listen: <words>` winning over a missing target, `· REC` / `· REC paused`; `--json` prints the state only | Compliant |
| FR-008 | `flags()` usage errors (two control flags, mixed flags, stray `--json`) exit 2; refused 1 with the reason on stderr; not running or no answer 3 | Compliant |
| FR-009 | `scripts/bench-toggle.ts`, `bun run bench:toggle` (by hand) | Compliant |
| FR-010 | `main()` handles control flags right after `--help`, before setup, the terminal check, settings and migration | Compliant |
| FR-011 | README "Mute from anywhere" and the file table | Compliant |
| FR-012 | tests/control/*.test.ts, tests/main.test.ts, tests/contract.test.ts, tests/util/paths.test.ts, tests/ui/ui.test.ts, tests/voice/*.test.ts | Compliant (US3 and the gauge edge case got their tests in this stage) |

### Deviations found and fixed in this stage

| Item | Deviation | Fix |
|------|-----------|-----|
| FR-001 | The socket was bound under the process umask and tightened after; a failure after the bind left a listener and socket nothing would remove | Bound under umask 0177, rollback on failure (5998512) |
| FR-012 / US3 | The README hotkey section had no test | Contract test (5998512) |
| FR-012 / Edge case "mute during a gauge" | No test | Server test with a real session (89e6363) |
| Edge case `$TMPDIR` fallback | Parent folder not checked; a fallback still too long was returned | Parent must be the user's or root's and sticky when others may write; length checked (5998512, 89e6363) |

### Extra behavior (not in spec)

- Verbose log lines for mutes from outside, refusals and dropped clients (added in this review for diagnosis).
- The client caps its buffer and treats a line that is not an answer as no answer (exit 3), also in the middle of a watch.
- The `$TMPDIR` fallback also refuses a group-writable folder (the spec says "not writable by others"; stricter) and an untrusted parent. Candidate for a one-line spec update.

## Code Review Guide

Where to look and what to check when reviewing this branch by hand:

1. **Socket safety (FR-001, edge cases):** `src/util/paths.ts` `socketPath` (length, parent owner and sticky bit, folder owner and mode, lstat so a symbolic link is refused) and `src/control/server.ts` `startServer` (umask 0177 around `Bun.listen`, chmod as a second guard, rollback). Tests: `tests/util/paths.test.ts`, the umask and stale-socket tests in `tests/control/server.test.ts`.
2. **Protocol (FR-002, FR-005):** `received` (4 KiB check, bytes after the request ignored), `send`/`flush` (queue and 64 KiB drop), `current` (the broadcast with `updated_at` stability). Tests: the malformed, idle, drop and SC-003 tests in `tests/control/server.test.ts`.
3. **Mute semantics (FR-003):** `mute()` and the `toggle` case; `muteWhileRecording` in src/main.ts is unchanged. Tests: US1 scenarios 3 and 5, the gauge test.
4. **Command line (FR-007, FR-008, FR-010):** `flags()`, `control()` and the early return in `main()` in src/main.ts; `src/control/client.ts` (1 s for connect and first answer, then a watch runs as long as corgi-voice). Tests: tests/main.test.ts control section, tests/control/client.test.ts.
5. **Window side:** `VoiceSession.note`/`events` and the history rows in src/ui/ui.ts; `target()` moved from ui.ts to state.ts so the window and `--status` share it.
6. **README (FR-011):** "Mute from anywhere" and the file table; the contract test pins its content.

## Deep Review Report

**Gate Outcome:** PASS after fix round 2. 0 Critical and 0 Important findings remain. Full details: `review-findings.md`.

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| Critical | 0 | 0 | 0 |
| Important | 4 | 4 | 0 |
| Minor | 25 | 18 | 7 |
| Notable | 3 | - | 3 (captured to brainstorm/idea-inbox.md) |

### Review agents

| Agent | Found | Fixed | Remaining | Status |
|-------|-------|-------|-----------|--------|
| Correctness | 2 | 2 | 0 | completed |
| Architecture & Idioms | 8 | 4 | 3 (+1 Notable) | completed |
| Security | 4 | 3 | 0 (+1 Notable) | completed |
| Production Readiness | 4 | 3 | 0 (+1 Notable) | completed |
| Test Quality | 11 | 7 | 4 | completed |
| Goal Alignment | 0 | 0 | 0 | skipped (no PR: no git remote) |
| CodeRabbit (external) | 5 | 5 | 0 | completed (3 runs: 2 findings, 3 findings on the round 1 fix, 0 on the round 2 fix) |
| Codex (external) | 1 | 1 | 0 | completed |
| Copilot (external) | 0 | 0 | 0 | skipped (disabled in config) |
| Re-review (round 1) | 2 | 2 | 0 | completed |
| Test Suite (regression) | 0 | 0 | 0 | passed every round (625 tests at the end) |

Merged: Security FINDING-1, Production FINDING-1, Correctness FINDING-1 and CodeRabbit's major finding (the bind-to-chmod window and rollback); Codex and CodeRabbit on the fallback length; the re-review agent and CodeRabbit on the parent owner exemption.

MVP: Test Quality (11 findings)

### Key fixes applied

1. The socket is 0600 from the bind (umask 0177 around `Bun.listen`), and a failure after the bind stops the listener and removes the socket (Security, Production, Correctness, CodeRabbit; FR-001).
2. The `$TMPDIR` fallback refuses a path still too long and a parent folder another user could rename entries in: it must belong to the user or root, and be sticky when others may write to it (Codex, Security, CodeRabbit, re-review).
3. The client checks each answer line and caps its buffer; a garbled line mid-watch exits 3 instead of looking like a quit (Security, Correctness).
4. Watcher broadcast failures stay out of the session's change path; mutes from outside, refusals and dropped clients are logged (Production).
5. New tests: the README section (US3), mute during a gauge, the spec's limits, the 4097-byte boundary, the umask at bind, folder modes, log lines, a garbled watch, the 1 s lower bound (Test Quality, re-review).
6. Control command tests run with a private, short `TMPDIR` and assert the fallback is not used, so they can never reach a real corgi-voice's socket (Test Quality, CodeRabbit).
7. Cleanups: one helper for the reason head, `usualSocketPath`, the unused `watching` field removed, the module header corrected (Architecture).

### Remaining findings (Critical and Important)

None.

Remaining Minor findings (see review-findings.md for details), all unambiguous and deferred:

- Refactors: FINDING-22 (mode rule in both `stateOf` and the window), FINDING-23 (`Control` repeats `Op`), FINDING-24 (`updated_at` stability decided twice).
- Test gaps: FINDING-25 (two toggles are sequential, not concurrent), FINDING-26 (main-level fallback refusal, the verbose "path too long" line and the "No control channel" notice), FINDING-27 (SC-002 compares only the mode), FINDING-28 (no watch test on a real session's availability and viewer changes).
- Residual parts of fixed findings: printed labels are not escaped against a hostile listener (FINDING-7), and the chmod-failure rollback has no test (FINDING-21).

Post-fix spec coverage: 12/12 functional requirements verified after the fix loop.
