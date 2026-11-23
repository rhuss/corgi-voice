# Deep Review Findings

**Date:** 2026-11-22
**Branch:** 004-sidebar-voice-icon
**Rounds:** 2 (round 1 fixed the Important findings, round 2 a Minor finding from the re-review)
**Gate Outcome:** PASS
**Invocation:** quality-gate (ship pipeline, oversight never)

## Summary

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| Critical | 0 | 0 | 0 |
| Important | 3 | 3 | 0 |
| Minor | 14 | 7 | 7 |
| Notable | 2 | - | 2 |
| **Total** | **19** | **10** | **9** |

**Agents completed:** 5/5 internal (Goal Alignment skipped: no PR) + 2 external tools (CodeRabbit, Codex) + 1 re-review agent
**Agents failed:** none. CodeRabbit's first invocation used the unsupported `--files` flag. It was rerun with `--committed --base main`, which also covered spec artifacts. Its spec-artifact finding (quickstart) was kept because it was a real defect in the walkthrough command.

## Findings

### FINDING-1
- **Severity:** Important
- **Confidence:** 90
- **File:** src/trick/install.ts:36-41
- **Category:** production-readiness
- **Source:** production-readiness-agent (also reported by: architecture-agent; correctness-agent and security-agent as Notable)
- **Round found:** 1
- **Resolution:** fixed (round 1, hardened in round 2)

**What is wrong:**
The manifest's `command[0]` was `process.execPath`. Bun canonicalizes that path, so on Homebrew it is `/opt/homebrew/Cellar/bun/1.4.4/bin/bun`, never the `/opt/homebrew/bin/bun` link. By default, `brew upgrade bun` removes the old keg.

**Why this matters:**
A trick that is already running keeps working. The next Corgi start, reload or reboot then fails to spawn it, and Corgi keeps it stopped until the user runs the install again. Bun releases every few weeks, so this break would recur. The README also gave the wrong symptom ("idle, showing nothing", which is what a stale socket path does).

**How it was resolved:**
`bunPath(env, running)` searches the install's PATH, using absolute entries only, for `bun`. It writes that link only when its realpath equals the realpath of `process.execPath`. Otherwise it writes `process.execPath`. That check rejects:
- version-manager shims (asdf, mise, proto), which would resolve another version in Corgi's reduced environment
- another bun earlier on PATH
- relative PATH entries

A Homebrew upgrade now keeps working through the link. The remaining effect is that the trick runs the upgraded Bun without a reinstall, which the `corgi-voice` shebang already does. The README now separates the two cases: a stale program path shows as "failed" in `corgi tricks list`, and a stale socket path leaves the trick idle. Tests cover the link case, a shim placed first on PATH, an empty PATH, no PATH and a relative entry, plus an install that writes the link.

### FINDING-2
- **Severity:** Important
- **Confidence:** 92
- **File:** tests/trick/helpers.ts:12-20
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:**
The helper module registered `afterEach` at its top level. Bun loads the module once per run, so the hook attached only to the first test file that imported it. In a full run the trick tests' servers, fake Corgis and temporary folders were never cleaned up. The agent measured 113 leaked folders per run.

**Why this matters:**
Tests are not isolated: open sockets and retry timers carried over into later test files, and temporary folders piled up.

**How it was resolved:**
The helper exports `cleanup()`, and `trick.test.ts` and `install.test.ts` each call `afterEach(cleanup)`.

### FINDING-3
- **Severity:** Important
- **Confidence:** 85
- **File:** tests/trick/trick.test.ts:398-408
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:**
"A press while corgi-voice is not reachable is ignored" passed even with the guard broken. With the server gone, a wrongly sent toggle ended as `not_running` and left no trace.

**Why this matters:**
The edge case and that part of FR-005 were not really verified, which FR-015 requires.

**How it was resolved:**
The test now starts a server at the same path during the 60 s retry pause, so a toggle sent anyway would reach it and show up in its session. The re-review agent confirmed the test fails when the guards are broken.

### FINDING-4
- **Severity:** Minor
- **Confidence:** 90
- **File:** src/trick/install.ts:19-20
- **Category:** security
- **Source:** security-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:**
`JSON.stringify` is not quite TOML. It leaves DEL (0x7F) raw and writes lone surrogates as `\udXXX`, and TOML rejects both. Such a manifest would be invalid while the install still printed "Installed" and exited 0.

**How it was resolved:**
`str()` escapes DEL and throws `NotUnicode`, with a `detail`, for strings that are not well formed. The install then prints the reason and exits 1. Tested.

### FINDING-5
- **Severity:** Minor
- **Confidence:** 70
- **File:** src/trick/trick.ts:120-135
- **Category:** security
- **Source:** security-agent
- **Round found:** 1
- **Resolution:** remaining

**What is wrong:**
A `config.socket` path from the ready event is used without the folder ownership and mode checks that `paths.socketPath` runs on a path it computes. On a shared host where the `$TMPDIR` fallback folder is removed, another user could listen there.

**Why it remains:**
The impact is limited because the trick sends only `watch` and `toggle` and maps any state to fixed glyphs. The manifest's writer already controls `command`. The fix needs a new export from `src/util/paths.ts` for a narrow scenario, which is better done together with the `$TMPDIR` squatting item already in the idea inbox.

### FINDING-6
- **Severity:** Minor
- **Confidence:** 90
- **File:** README.md:294, 300-305
- **Category:** architecture
- **Source:** architecture-agent (also reported by: coderabbit)
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:**
The uninstall command ignored `CORGI_TRICKS_DIR`, although the install honors it. The README also did not say that the variable must match the daemon's value.

**How it was resolved:**
Uninstall uses `${CORGI_TRICKS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/corgi/tricks}/corgi-voice`. The install paragraph now says `CORGI_TRICKS_DIR` must match the daemon's. The contract test pins both.

**External tool analysis (CodeRabbit):**
> If `CORGI_TRICKS_DIR` is set, installation writes there, but this command removes the default directory. Reload then leaves the installed trick running. Use the same directory precedence as installation.

### FINDING-7
- **Severity:** Minor
- **Confidence:** 85
- **File:** src/main.ts:257, src/trick/trick.ts:130
- **Category:** architecture
- **Source:** architecture-agent
- **Round found:** 1
- **Resolution:** remaining

**What is wrong:**
The `detail ?? message ?? String(error)` expression now appears three times, and two older call sites in src/main.ts use variants of it.

**Why it remains:**
The right fix is one `detail()` helper in `src/util/errors.ts` that all call sites use, including code that predates this feature. That refactor belongs in its own change.

### FINDING-8
- **Severity:** Minor
- **Confidence:** 75
- **File:** src/trick/trick.ts:163-176
- **Category:** architecture
- **Source:** architecture-agent
- **Round found:** 1
- **Resolution:** remaining

**What is wrong:**
`lines()` is a general line splitter that lives in the trick module and is imported by main.ts. The control client splits lines its own way, with a cap.

**Why it remains:**
Moving it to `src/util/` with an optional cap is a cleanup with no behavior change. The related Notable is in the idea inbox.

### FINDING-9
- **Severity:** Minor
- **Confidence:** 75
- **File:** src/main.ts:32-33
- **Category:** architecture
- **Source:** architecture-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:**
The namespace `trick` named the install module, next to imports from `./trick/trick`.

**How it was resolved:**
Renamed to `trickInstall`.

### FINDING-10
- **Severity:** Minor
- **Confidence:** 70
- **File:** tricks/voice/trick.toml, src/trick/install.ts:26
- **Category:** architecture
- **Source:** architecture-agent
- **Round found:** 1
- **Resolution:** remaining

**What is wrong:**
The reference manifest repeats the description by hand, and the contract test pins only its `id` and `command`. The repository folder is `voice` while the installed one is `corgi-voice`.

**Why it remains:**
The folder name is fixed by FR-013, and both READMEs point to `--install-trick` instead of copying the folder. Pinning the description is optional.

### FINDING-11
- **Severity:** Minor
- **Confidence:** 75
- **File:** src/trick/trick.ts:106-113
- **Category:** production-readiness
- **Source:** production-readiness-agent
- **Round found:** 1
- **Resolution:** remaining

**What is wrong:**
The "not reachable" log line does not name the watched path or how the watch ended (`not_running` or `no_answer`). That information would help diagnose a stale `config.socket`.

**Why it remains:**
Adding it changes the line format that five trick tests compare exactly. It is a diagnostics improvement for a follow-up change.

### FINDING-12
- **Severity:** Minor
- **Confidence:** 85
- **File:** tests/trick/trick.test.ts, src/trick/trick.ts:18
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:**
No test pinned the 2 s retry default that FR-006 and US1 scenario 5 depend on.

**How it was resolved:**
A test pins `retry_ms === 2000`.

### FINDING-13
- **Severity:** Minor
- **Confidence:** 85
- **File:** tests/contract.test.ts:182-208
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:**
The README contract test did not check the uninstall steps (US3 scenario 3) or the click text (FR-014).

**How it was resolved:**
It now checks for "To uninstall", the uninstall command that honors `CORGI_TRICKS_DIR`, and "muted from outside".

### FINDING-14
- **Severity:** Minor
- **Confidence:** 72
- **File:** tests/trick/trick.test.ts:130-142
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** remaining

**What is wrong:**
The test for the end of input checks the exit code and timing, but not at trick level that the channel connection closes. The client's abort test covers that.

**Why it remains:**
The agent itself noted that the timing assertion would catch a watch that is not aborted, because `await watching` would hang. The coverage gap is small.

### FINDING-15
- **Severity:** Minor
- **Confidence:** 70
- **File:** tests/trick/trick.test.ts:195-202
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** remaining

**What is wrong:**
The test for "never answers within a second" passes with any first-answer timeout below about 2.9 s.

**Why it remains:**
The 1 s value lives in the client and is pinned by "the default timeout is one second" in tests/control/client.test.ts, and the trick passes no other timeout. Tightening the gap would add timing sensitivity to a suite that already has flaky timing tests.

### FINDING-16
- **Severity:** Minor
- **Confidence:** 75
- **File:** specs/004-sidebar-voice-icon/quickstart.md:16
- **Category:** external
- **Source:** coderabbit
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:**
In `printf ... | cat - /dev/stdin | corgi-voice --trick`, `/dev/stdin` is the pipe and not the terminal, so typed presses never reached the trick.

**How it was resolved:**
The command is now `{ printf '...\n'; cat; } | corgi-voice --trick`.

**External tool analysis (CodeRabbit):**
> Both `-` and `/dev/stdin` read the pipe from `printf`, not the terminal. When `printf` exits, `cat` reaches EOF. The trick therefore cannot receive the interactive presses described below.

### FINDING-17
- **Severity:** Minor
- **Confidence:** 80
- **File:** src/trick/install.ts:29-37
- **Category:** correctness
- **Source:** re-review agent (round 1)
- **Round found:** 2
- **Resolution:** fixed (round 2)

**What is wrong:**
`Bun.which` resolves relative PATH entries against the working folder, so the `isAbsolute` guard never rejected anything. The manifest could then point at a link in a short-lived folder.

**How it was resolved:**
PATH is filtered to absolute entries before the lookup. Tested with a relative entry.

## Notable Observations

### NOTABLE-1
- **File:** src/trick/trick.ts:165-177
- **Category:** security
- **Source:** security-agent
- **Description:** `lines()` buffers standard input with no cap. Only the trusted Corgi daemon writes to it, and its pipe is bounded.
- **Rationale:** It differs from the client's capped buffer. A shared splitter with a cap would make both readers behave the same way.

### NOTABLE-2
- **File:** src/trick/install.ts:38
- **Category:** production-readiness
- **Source:** production-readiness-agent
- **Description:** The install pins the realpath of the `main.ts` it ran from, so an install from a worktree or temporary checkout breaks once that folder is removed.
- **Rationale:** Printing the written command, or warning on such paths, would make this visible.

## Post-Fix Spec Coverage

The fix loop removed no code paths. It changed the bun path choice, string escaping, tests and docs. All 16 functional requirements still map to the same implementation, and all spec requirements were verified after the fix loop.

## Test Suite Results

| Round | Test Command | Exit Code | Failures | Status |
|-------|-------------|-----------|----------|--------|
| 1 | bun test | 0 | 0 | passed (674 tests) |
| 2 | bun run check; bun test tests/trick/install.test.ts | 0 | 0 | passed |

The test suite passed in all fix rounds.

## Remaining Findings

No Critical or Important findings remain. The seven remaining Minor findings (5, 7, 8, 10, 11, 14 and 15) are described above. None of them blocks the gate.
