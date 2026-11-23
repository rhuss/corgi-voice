# Code Review: Sidebar Voice Icon

**Spec:** specs/004-sidebar-voice-icon/spec.md (Corgi API: `docs/tricks.md` on Corgi branch `011-tricks-title-item`, "Title items" and "Raw JSONL")
**Date:** 2026-11-22
**Reviewer:** Claude (speckit.spex-gates.review-code, ship pipeline stage 7, oversight never)
**Scope:** `git diff main...HEAD`. That covers the new src/trick/ (trick, item, install), src/main.ts, src/control/client.ts (abort signal), tricks/voice/, the README, and tests (tests/trick/*, contract, client, main).

## Compliance Summary

**Overall Score: 100% (46/46 live items)**

- Functional Requirements: 16/16
- Acceptance Scenarios: 14/14 (US1 1-6, US2 1-5, US3 1-3). The live Corgi check is a runbook step, as FR-015 allows.
- Edge Cases: 11/11
- Success Criteria: 5/5 checkable. SC-001 to SC-003 and SC-005 are checked in tests. SC-004 and the live parts of SC-001 and SC-002 are runbook steps.

There are no superseded or retired items. The spec has no `## Constants` section, so the constants check was skipped.

### Requirement map

| Item | Implementation | Status |
|------|----------------|--------|
| FR-001 | `runTrick` reads `ready`, `ui.press` and error replies from `lines(Bun.stdin.stream())` and writes one JSON command per line. Diagnostics go to stderr (`main()` wiring). | Compliant |
| FR-002 | `connect` uses `watch()` from src/control/client.ts. The only other op is `request(channel, "toggle")`. | Compliant |
| FR-003 | `item()` in src/trick/item.ts: recording `running` gives `●` hot, `paused` gives `●` warm. Otherwise, when available, `♫` accent or faint, else no item. One fixed key, `voice`. | Compliant |
| FR-004 | `show()` returns early on `sameItem` unless re-arming. `ui.remove` is sent only when an item is shown. | Compliant |
| FR-005 | Only `♫` gets an `action` and `slot`. The action is `toggle-N`, fresh per drawing. `press()` takes only the armed action, once, and ignores presses without a watch. `toggled()` redraws with a fresh action from the newer of the toggle answer and the watch state. | Compliant |
| FR-006 | The `watch` 1 s first-answer timeout, malformed lines and closes all end the watch. Then `show(null)`, a 2 s `pause`, and one log line per reachability transition. | Compliant |
| FR-007 | The end of input aborts the watch and the pause. `main` returns and `process.exit` ends the process even with a toggle in flight (measured at about 2 ms). | Compliant |
| FR-008 | `ready()` uses `config.socket` when it is a non-empty string, else `paths.socketPath(io.env)`. | Compliant |
| FR-009 | `main()` dispatches `--trick` right after `--help`, before setup, the terminal check, the lock and settings. The contract test forbids anything else in src/trick/. | Compliant |
| FR-010 | Blocked on stdin and the watch socket, no timers while connected. One process with no children, measured at about 30 MB RSS. | Compliant |
| FR-011 | `install()` and `manifest()`: `tricksDir()` precedence, `version`, `id`, `description`, absolute `command` (bun from `bunPath()`, realpath of main.ts, `--trick`), and `[config] socket`. | Compliant |
| FR-012 | Writes a temporary file and renames it. Prints the path and the next step and exits 0, or prints the reason and exits 1 (`installTrick`). `flags()` makes any combination a usage error (exit 2). | Compliant |
| FR-013 | tricks/voice/trick.toml and README.md | Compliant |
| FR-014 | README "Voice icon in Corgi": states, click, dots not pressable, install, reload, list, uninstall, the rerun note for XDG and TMPDIR, and the dependency on #74 and #198 | Compliant |
| FR-015 | tests/trick/trick.test.ts drives `runTrick` against a real control server with stub session and recorder. Also tests/trick/install.test.ts and the tests/main.test.ts trick section. | Compliant (3 test gaps fixed in this stage) |
| FR-016 | tests/contract.test.ts "src/trick/ reaches Corgi only on its own streams..." and the README test | Compliant |

### Deviations found and fixed in this stage

| Item | Deviation | Fix |
|------|-----------|-----|
| FR-014 / US3-3 | The uninstall command ignored `CORGI_TRICKS_DIR`, and the README gave the wrong symptom for a stale bun path | README fixed and pinned by the contract test (8c08600) |
| FR-015 / Edge case "press while no corgi-voice runs" | The test passed with the guard broken | A server is restarted at the same path during the retry pause (8c08600) |
| FR-015 | The trick test helpers' cleanup ran only for the first test file | `afterEach(cleanup)` in each file (8c08600) |
| FR-012 | A manifest with DEL or a lone surrogate would be invalid TOML while the install still exited 0 | Escape DEL, refuse with exit 1 (8c08600) |

### Extra behavior (not in spec)

- `bunPath()` prefers a PATH link to the running Bun (see the open point below). It is in the spirit of FR-011 (absolute paths that work under the daemon's PATH). Candidate for a one-line spec note.
- `Corgi refused the item: <kind>` is logged once per error kind for any error reply, not only for title errors. This matches the edge cases' "logs each error kind once".

### Open point: the bun path in the manifest

**Verdict: fixed.** `process.execPath` is canonical in Bun, so on Homebrew it is the versioned Cellar path that `brew upgrade bun` removes. The trick would then fail at the next Corgi start until the user installed again. `bunPath()` now searches the install's PATH, absolute entries only, for `bun`. It writes that link only when its realpath is the running binary, and otherwise falls back to `process.execPath`. The realpath check matters. Without it, `Bun.which` could write a version-manager shim, which picks another version in Corgi's reduced environment, or a different bun that appears earlier on PATH. The README keeps a rerun note for moving corgi-voice or switching to another Bun.

## Code Review Guide

Where to look and what to check when reviewing this branch by hand:

1. **Trick state machine (FR-003 to FR-006):** `runTrick` in src/trick/trick.ts. Check the interplay of `shown`, `armed`, `inflight`, `latest` and `reachable`. `answered()` holds back a pressable redraw while a toggle is out. `toggled()` picks the newer of the toggle answer and the watch state by `updated_at` and re-arms. `connect()` runs the retry loop. Tests: the press, stale-action, refused-unmute, toggle-race and reconnect tests in tests/trick/trick.test.ts.
2. **Derivation (FR-003):** `item()` and `sameItem()` in src/trick/item.ts. Tests: tests/trick/item.test.ts.
3. **Client abort:** `converse()` in src/control/client.ts, with the `signal` listener removed in `finish`. Tests: the abort tests in tests/control/client.test.ts.
4. **Install (FR-011, FR-012):** `tricksDir`, `str` (TOML escaping), `bunPath`, and the temp-file rename in `install()`. Then `installTrick` and `flags()` in src/main.ts. Tests: tests/trick/install.test.ts and the trick section in tests/main.test.ts.
5. **Boundaries (FR-009, FR-016):** the early `--trick` return in `main()`, and the contract test on src/trick/ imports and ops.
6. **Docs (FR-013, FR-014):** README "Voice icon in Corgi", tricks/voice/README.md and trick.toml. The contract test pins their content.

## Deep Review Report

**Gate Outcome:** PASS after fix round 2. 0 Critical and 0 Important findings remain. Full details: `review-findings.md`.

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| Critical | 0 | 0 | 0 |
| Important | 3 | 3 | 0 |
| Minor | 14 | 7 | 7 |
| Notable | 2 | - | 2 (captured to brainstorm/idea-inbox.md) |

### Review agents

| Agent | Found | Fixed | Remaining | Status |
|-------|-------|-------|-----------|--------|
| Correctness | 1 (Notable, merged into FINDING-1) | 1 | 0 | completed |
| Architecture & Idioms | 6 | 3 | 3 | completed |
| Security | 4 | 2 | 1 (+1 Notable) | completed |
| Production Readiness | 3 | 1 | 1 (+1 Notable) | completed |
| Test Quality | 6 | 4 | 2 | completed |
| Goal Alignment | 0 | 0 | 0 | skipped (no PR) |
| CodeRabbit (external) | 2 | 2 | 0 | completed (2 runs: 2 findings, then 0 on the round 1 fixes) |
| Codex (external) | 0 | 0 | 0 | completed |
| Copilot (external) | 0 | 0 | 0 | skipped (disabled in config) |
| Re-review (round 1) | 1 | 1 | 0 | completed |
| Test Suite (regression) | 0 | 0 | 0 | passed every round (674 tests) |

Merged: Production FINDING-1, Architecture FINDING-1, and the Correctness and Security Notables on the bun path became FINDING-1. Architecture FINDING-2 and CodeRabbit's uninstall finding became FINDING-6.

MVP: Architecture & Idioms (6 findings, tied with Test Quality, first alphabetically)

### Key fixes applied

1. The manifest's bun is a stable PATH link to the running binary when there is one, so `brew upgrade bun` no longer breaks the installed trick. Shims, other bun binaries and relative PATH entries fall back to `process.execPath` (Production, Architecture, Correctness, Security, re-review).
2. The trick test helpers' cleanup runs for every test file, not just the first (Test Quality).
3. The press-while-unreachable test now fails if the guard breaks, and the 2 s retry is pinned (Test Quality).
4. The manifest is always valid TOML: DEL is escaped and lone surrogates are refused with exit 1 (Security).
5. README: `CORGI_TRICKS_DIR` must match the daemon, uninstall honors it, and a stale program path is told apart from a stale socket path. The contract test now pins uninstall and the click text (Architecture, CodeRabbit, Test Quality).
6. The quickstart's manual command keeps the terminal on the trick's input (CodeRabbit).

### Remaining findings (Critical and Important)

None.

Remaining Minor findings (see review-findings.md), deferred:

- Refactors: FINDING-7 (one `detail()` helper for error reasons), FINDING-8 (`lines()` into src/util/ with a cap), FINDING-10 (reference manifest description not pinned).
- Diagnostics: FINDING-11 (the "not reachable" log could name the path and the end reason).
- Hardening: FINDING-5 (no folder trust check for a `config.socket` path).
- Test precision: FINDING-14 (connection close at trick level), FINDING-15 (the 1 s first-answer bound is pinned in the client test only).

Post-fix spec coverage: 16/16 functional requirements verified after the fix loop.
