# Deep Review Findings

**Date:** 2026-11-21
**Branch:** 003-control-channel
**Rounds:** 2 (round 1 fixed the first Important findings; its re-review and CodeRabbit found two more Important findings, fixed in round 2)
**Gate Outcome:** PASS
**Invocation:** quality-gate (ship pipeline stage 7, oversight never)

## Summary

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| Critical | 0 | 0 | 0 |
| Important | 4 | 4 | 0 |
| Minor | 25 | 18 | 7 |
| Notable | 3 | - | 3 |
| **Total** | **32** | **22** | **10** |

**Agents completed:** 5/5 internal (Goal Alignment skipped: no PR, the repository has no git remote) + 2 external tools (CodeRabbit, Codex). Copilot: disabled in config.
**Agents failed:** none. The first CodeRabbit call used the `--files` flag, which the installed CLI does not have; it was re-run with `--committed --base main`.

## Findings

### FINDING-1
- **Severity:** Important
- **Confidence:** 80
- **File:** src/control/server.ts (startServer, bind to chmod)
- **Category:** security
- **Source:** security-agent (also reported by: production-agent, correctness-agent, coderabbit)
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:** `Bun.listen` created the socket with the process umask (0777 under umask 0, 0775 under 002) and `chmodSync(path, 0o600)` ran only after the bind. A socket is checked at connect time only, so a connection made in between was accepted and served. If `chmodSync` threw, `startServer` rejected with the listener still open and the socket file in place, while `voice()` showed "No control channel" and never closed it.

**Why this matters:** another local user could mute the window or watch its state when the umask is loose and the parent folder is traversable (an existing state folder is never tightened). A leaked listener also breaks FR-001 ("removed on every exit path").

**How it was resolved:** `Bun.listen` now runs under `process.umask(0o177)`, restored in `finally`, so the socket is 0600 from the bind; `chmodSync` stays as a second guard, and when it fails the listener is stopped and the socket removed before rethrowing. A test spies on `Bun.listen` and checks the mask in force at bind (a mutation without the umask fails it) and that the caller's umask is restored.

**External tool analysis (CodeRabbit):**
> Roll back the listener if initialization fails. If `chmodSync` throws after `Bun.listen` succeeds, `startServer` rejects without stopping the listener. `voice()` catches that rejection and continues without setting `held.control`. Application cleanup therefore cannot close the listener or remove its socket, as FR-001 requires.

### FINDING-2
- **Severity:** Important
- **Confidence:** 88
- **File:** README.md (no test under tests/)
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:** US3 scenario 1 (the README hotkey section) had no automated test.

**Why this matters:** FR-012 and SC-005 require a test for every acceptance scenario; the recipes could vanish unnoticed.

**How it was resolved:** a contract test reads the "Mute from anywhere" section and checks every command, `command -v corgi-voice`, the Shortcuts, skhd and Hammerspoon recipes, each JSON field, each exit code and two state lines.

### FINDING-3
- **Severity:** Important
- **Confidence:** 75
- **File:** src/util/paths.ts (socketPath, $TMPDIR parent check)
- **Category:** external
- **Source:** coderabbit (round 1 re-review)
- **Round found:** 2
- **Resolution:** fixed (round 2)

**What is wrong:** the round 1 parent check skipped every sticky `$TMPDIR`, but the owner of a sticky folder may still rename entries in it, so a sticky `$TMPDIR` owned by another unprivileged user could have the checked `corgi-voice-<uid>` folder swapped after the check.

**Why this matters:** the socket (or the client's connect) would land in a folder another user controls.

**How it was resolved:** the parent must belong to the user or root, and when others may write to it, it must be sticky.

**External tool analysis (CodeRabbit):**
> Reject untrusted parent owners even when the sticky bit is set. Under sticky-directory rules, the owner of a directory can rename entries in it, even entries that it does not own. Trust only the current user or root as the owner of a group- or other-writable parent.

### FINDING-4
- **Severity:** Important
- **Confidence:** 75
- **File:** tests/main.test.ts (command helper)
- **Category:** external
- **Source:** coderabbit (round 1 re-review)
- **Round found:** 2
- **Resolution:** fixed (round 2)

**What is wrong:** the round 1 helper checked `paths.socketMoved()` before its `try`, so a failure left five environment variables redirected for later tests, and its long folder names left only a few bytes of margin under the 103-byte socket limit.

**Why this matters:** a machine with a longer `TMPDIR` would fail every control command test and leak environment into the rest of the file.

**How it was resolved:** short folder names (`s`, `c`, `d`, `r`, `t` under a `cv-cm-` temp folder) and the setup checks moved inside the `try`/`finally`.

### FINDING-5
- **Severity:** Minor
- **File:** src/util/paths.ts (fallback path length)
- **Category:** external
- **Source:** codex (also reported by: coderabbit)
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:** the `$TMPDIR` fallback itself was not checked against the socket path limit.
**Why this matters:** a long `TMPDIR` gave an unusable path and an unclear bind error.
**How it was resolved:** a fallback still too long is refused as `SocketFolderUnsafe` with "too long for a socket too"; tested.

### FINDING-6
- **Severity:** Minor
- **File:** src/util/paths.ts (parent of the fallback folder)
- **Category:** security
- **Source:** security-agent (round 1); owner exemption reported by re-review agent and coderabbit (round 2)
- **Resolution:** fixed (rounds 1 and 2, see FINDING-3)

**What is wrong:** the parent of `corgi-voice-<uid>` was not checked; a writable, non-sticky `$TMPDIR` lets others replace the checked folder. The round 1 fix exempted a parent owned by the user, which is the case where others can still rename.
**How it was resolved:** see FINDING-3; tests cover 0777 (refused), 0700 and 01777 (accepted).

### FINDING-7
- **Severity:** Minor
- **File:** src/control/client.ts (converse)
- **Category:** security
- **Source:** security-agent
- **Resolution:** fixed (round 1), one part remaining

**What is wrong:** the client cast every line to `Answer` without checking it and buffered without limit.
**How it was resolved:** a line must be JSON with a boolean `ok` and an object `state`, else the conversation ends as no answer; the buffer is capped at 16 x 4 KiB. Not done: escaping control characters in labels printed by `shortLine` (only a hostile listener at the user's own socket path could send them).

### FINDING-8
- **Severity:** Minor
- **File:** src/control/client.ts (watch end)
- **Category:** correctness
- **Source:** correctness-agent
- **Resolution:** fixed (round 1)

**What is wrong:** a garbled line in the middle of `--watch` ended the watch as "closed", exit 0, the code for "corgi-voice quit".
**How it was resolved:** it now ends as no answer (exit 3); a client test covers garbage, `{"ok":true}` and `null` after a good first line.

### FINDING-9
- **Severity:** Minor
- **File:** src/control/server.ts (change listener)
- **Category:** production-readiness
- **Source:** production-agent
- **Resolution:** fixed (round 1)

**What is wrong:** the broadcast ran inside the session's and recorder's change callbacks without a guard.
**How it was resolved:** failures are caught and logged, so nothing from a watcher reaches the session.

### FINDING-10
- **Severity:** Minor
- **File:** src/control/server.ts (drop, refuse, mute)
- **Category:** production-readiness
- **Source:** production-agent
- **Resolution:** fixed (round 1)

**What is wrong:** mutes from outside, refusals and dropped clients left nothing in the verbose log.
**How it was resolved:** `control: muted from outside`, `control: refused: <err>` and `control: dropped a client|watcher: <why>` lines; tested.

### FINDING-11
- **Severity:** Minor
- **File:** src/control/state.ts (target, shortLine)
- **Category:** architecture
- **Source:** architecture-agent
- **Resolution:** fixed (round 1)

**What is wrong:** the reason head (`split(":")[0]`) was written twice.
**How it was resolved:** one `head()` helper.

### FINDING-12
- **Severity:** Minor
- **File:** src/control/server.ts (Conn.watching)
- **Category:** architecture
- **Source:** architecture-agent
- **Resolution:** fixed (round 1)

**What is wrong:** `watching` was set and never read.
**How it was resolved:** removed.

### FINDING-13
- **Severity:** Minor
- **File:** src/util/paths.ts (socketMoved)
- **Category:** architecture
- **Source:** architecture-agent
- **Resolution:** fixed (round 1)

**What is wrong:** `socketMoved` re-derived the usual place with a prefix test.
**How it was resolved:** `usualSocketPath()` (kept right after `socketPath`, the only place naming the socket, as the contract test requires) and an exact comparison.

### FINDING-14
- **Severity:** Minor
- **File:** src/control/server.ts (module header)
- **Category:** architecture
- **Source:** architecture-agent
- **Resolution:** fixed (round 1)

**What is wrong:** the header said the channel "never changes a setting", while its job is the mute setting.
**How it was resolved:** "never changes a stored setting (voice.json)".

### FINDING-15
- **Severity:** Minor
- **File:** tests/main.test.ts (command helper)
- **Category:** test-quality
- **Source:** test-quality-agent
- **Resolution:** fixed (rounds 1 and 2)

**What is wrong:** the helper did not redirect `TMPDIR`, so a slightly longer temp path would have put the tests on the shared `$TMPDIR/corgi-voice-<uid>/control.sock`, where a real corgi-voice may listen.
**How it was resolved:** `TMPDIR` is private, and the helper fails when `socketMoved()` is true.

### FINDING-16
- **Severity:** Minor
- **File:** tests/control/server.test.ts, tests/main.test.ts
- **Category:** test-quality
- **Source:** test-quality-agent
- **Resolution:** fixed (rounds 1 and 2)

**What is wrong:** the spec's limits (4 KiB, 2 s, 64 KiB) were never asserted, and the 1 s no-answer test had no lower bound.
**How it was resolved:** a constants test and a lower bound of 950 ms.

### FINDING-17
- **Severity:** Minor
- **File:** tests/control/server.test.ts
- **Category:** test-quality
- **Source:** test-quality-agent
- **Resolution:** fixed (round 2)

**What is wrong:** the edge case "a mute from outside while a gauge runs" had no test.
**How it was resolved:** a test with a real session: mute and unmute during a gauge, both rows, the gauge still running.

### FINDING-18
- **Severity:** Minor
- **File:** tests/control/server.test.ts
- **Category:** test-quality
- **Source:** test-quality-agent
- **Resolution:** fixed (round 1)

**What is wrong:** FR-001's state folder created 0700 was never checked.
**How it was resolved:** the umask test starts the server in a missing `state/corgi-voice/` folder and checks 0700.

### FINDING-19
- **Severity:** Minor
- **File:** tests/main.test.ts, tests/control/client.test.ts
- **Category:** test-quality
- **Source:** test-quality-agent
- **Resolution:** fixed (rounds 1 and 2)

**What is wrong:** fixed sleeps raced the watch's first line under load.
**How it was resolved:** the `--watch` CLI test waits until the first line is printed; the client watch test uses a 300 ms timeout and a 500 ms wait.

### FINDING-20
- **Severity:** Minor
- **File:** tests/control/server.test.ts
- **Category:** test-quality
- **Source:** test-quality-agent
- **Resolution:** fixed (round 1)

**What is wrong:** the 4 KiB limit was tested at 4096 and 5000 bytes, not at 4097.
**How it was resolved:** a 4097-byte line is refused `too_long`; the misleading "request in pieces" comment was removed.

### FINDING-21
- **Severity:** Minor
- **File:** tests/control/server.test.ts
- **Category:** test-quality
- **Source:** re-review agent (round 1)
- **Resolution:** fixed (round 2), one part remaining

**What is wrong:** the round 1 umask test passed with or without the umask, because the chmod gives 0600 either way.
**How it was resolved:** the test records the umask at `Bun.listen` (checked by mutation). Not done: a test where `chmodSync` fails (needs mocking `node:fs`).

### FINDING-22
- **Severity:** Minor
- **File:** src/control/state.ts:1-5, src/ui/ui.ts (mode)
- **Category:** architecture
- **Source:** architecture-agent
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** the mode rule (`muted || !available`) lives in both `stateOf` and the window's `mode()`; the state module's header claims more sharing than there is.
**What needs to happen:** export `modeOf()` from state.ts and use it in ui.ts, or narrow the header.

### FINDING-23
- **Severity:** Minor
- **File:** src/main.ts:35-49, src/control/server.ts:21-22
- **Category:** architecture
- **Source:** architecture-agent
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** `Control` in main.ts repeats `Op`, and the five `case` labels repeat `control_flags`.
**What needs to happen:** derive `Op` from `ops as const`, use it in main.ts, and look flags up in `control_flags`.

### FINDING-24
- **Severity:** Minor
- **File:** src/control/state.ts:62-84, src/control/server.ts:73-80
- **Category:** architecture
- **Source:** architecture-agent
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** `updated_at` stability is decided both by `stateOf(previous)` and by `current()`'s own `equal` check.
**What needs to happen:** keep one of the two.

### FINDING-25
- **Severity:** Minor
- **File:** tests/control/server.test.ts:289-297
- **Category:** test-quality
- **Source:** test-quality-agent
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** "two toggles at once" sleeps 20 ms between the connections, so it tests two toggles in a row.
**What needs to happen:** open both connections, then write both requests in the same tick.

### FINDING-26
- **Severity:** Minor
- **File:** src/main.ts (control, voice)
- **Category:** test-quality
- **Source:** test-quality-agent
- **Resolution:** remaining (unambiguous, deferred; the paths-level cases 0720 and 0755 were added)

**What is wrong:** no main-level test for `control()` exiting 3 with the `SocketFolderUnsafe` detail, the verbose log line when the socket moves, or the "No control channel" notice.
**What needs to happen:** a main-level test with an over-long `XDG_RUNTIME_DIR` and an unsafe fallback folder, and a test of the `voice()` startServer block with a fake logger.

### FINDING-27
- **Severity:** Minor
- **File:** tests/control/state.test.ts:140-165
- **Category:** test-quality
- **Source:** test-quality-agent
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** the SC-002 test compares only the mode against the window; target and REC agree by construction (ui.ts imports `target`), but no test drives recording and target changes through both.
**What needs to happen:** extend it with a real Recorder and a target change, comparing the drawn Target cell and REC with the state.

### FINDING-28
- **Severity:** Minor
- **File:** tests/control/server.test.ts:378-455
- **Category:** test-quality
- **Source:** test-quality-agent
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** SC-003 runs on stub sessions that fire `changed()` themselves; no watch test drives a real `VoiceSession` through availability and viewer changes.
**What needs to happen:** a watch test on `real()` with `setAvailable` and a viewer event, one line per change.

Duplicates were merged and counted once: the four reports of FINDING-1, Codex and CodeRabbit on FINDING-5, and the re-review agent and CodeRabbit on the owner exemption in FINDING-6.

## Notable Observations

### NOTABLE-1
- **File:** src/main.ts:5-31, 259
- **Category:** production-readiness
- **Source:** production-agent
- **Description:** a control command loads every window module (ui, whisper, capture, recorder, session, corgi link, setup) before returning at the control branch.
- **Rationale:** import cost is the largest controllable part of FR-009's 200 ms spawn-to-exit budget and grows with each window feature; lazy imports or a slim control entry would keep it flat.

### NOTABLE-2
- **File:** src/control/server.ts:73-80
- **Category:** architecture
- **Source:** architecture-agent
- **Description:** `current()` reads like a getter but is the broadcast mechanism; `toggle` calls it twice.
- **Rationale:** a later "harmless" call would emit watcher lines from unexpected places; a name like `refresh()` would say so.

### NOTABLE-3
- **File:** src/util/paths.ts (fallback name)
- **Category:** security
- **Source:** security-agent
- **Description:** on a shared `/tmp`, another user can create `/tmp/corgi-voice-<uid>` first; the checks refuse it (fails closed), which turns into a denial of the control channel.
- **Rationale:** safe as is; a note in the README or a less predictable name derived the same way on both sides would help.

## Post-Fix Spec Coverage

The fix rounds removed only dead code (`Conn.watching`) and replaced inline expressions with helpers.

| Requirement | Implementation | Status |
|-------------|---------------|--------|
| FR-001 socket path, 0600, stale removal, removed on exit | paths.socketPath, server.ts startServer/close, main.ts ending/exiting | ✓ |
| FR-002 one request per connection, 4 KiB, errors | server.ts received/request/refuse | ✓ |
| FR-003 mute as `m`, toggle by shown mode, history rows | server.ts mute/toggle | ✓ |
| FR-004 state fields | state.ts stateOf | ✓ |
| FR-005 watch, 64 KiB drop, no duplicates | server.ts current/send/flush | ✓ |
| FR-006 no text, no recording control, no settings | server.ts (contract test) | ✓ |
| FR-007 commands and short line | main.ts control, state.ts shortLine | ✓ |
| FR-008 exit codes | main.ts flags/control | ✓ |
| FR-009 benchmark | scripts/bench-toggle.ts | ✓ |
| FR-010 before the terminal check | main.ts main | ✓ |
| FR-011 README | README "Mute from anywhere" (now tested) | ✓ |
| FR-012 automated tests | tests/control, tests/main.test.ts, tests/contract.test.ts | ✓ |

All spec requirements verified after the fix loop.

## Test Suite Results

| Round | Test Command | Exit Code | Failures | Status |
|-------|-------------|-----------|----------|--------|
| 1 | `bun run check && bun test` | 0 | 0 | passed (624 tests, 150 s) |
| 2 | `bun run check && bun test` | 0 | 0 | passed (625 tests, 119 s) |

Test suite passed in all fix rounds; no flakes were seen.

## Remaining Findings

No Critical or Important findings remain. The seven remaining Minor findings (FINDING-22 to FINDING-28) are unambiguous and deferred: three refactors that remove duplicated rules, and four test gaps for behavior that is already covered at another level.
