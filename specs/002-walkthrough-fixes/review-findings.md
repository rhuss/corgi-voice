# Deep Review Findings

**Date:** 2026-11-20
**Branch:** 002-walkthrough-fixes
**Rounds:** 2 (round 1 cleared every Important finding; round 2 closed a Minor gap the round 1 re-review found)
**Gate Outcome:** PASS
**Invocation:** quality-gate (ship pipeline stage 7, oversight never)

## Summary

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| Critical | 0 | 0 | 0 |
| Important | 2 | 2 | 0 |
| Minor | 19 | 6 | 12 (1 dismissed) |
| Notable | 6 | - | 6 |
| **Total** | **27** | **8** | **18** |

Not counted: three verification notes (Production FINDING-5 and re-review FINDING-2 and FINDING-3), which say that checked code is clean.

**Agents completed:** 5/5 internal (Goal Alignment skipped: no PR, the repository has no git remote) + 2 external tools (CodeRabbit, Codex). Copilot: disabled in config.
**Agents failed:** none. The first CodeRabbit call used the `--files` flag, which the installed CLI no longer has; it was re-run with `--base main --committed`.

## Findings

### FINDING-1
- **Severity:** Important
- **Confidence:** 85
- **File:** src/corgi/poller.ts:304-311
- **Category:** correctness
- **Source:** codex (also reported by: correctness-agent)
- **Round found:** 1
- **Resolution:** fixed (round 1, 17d40bc)

**What is wrong:**
`Poller.evaluate()` announced a change only when the target or the reason text changed. Its key for "no target" was `[r.reason]`. This branch added `source` (the machine whose error forms the reason) to `Resolution`, but the key did not include it.

**Why this matters:**
"Corgi output not understood" is the same string for every machine. When it moves from a remote machine to the local one (or back), the poller stays silent, `VoiceSession.source` keeps the old machine, and the FR-011 hint is missing for a local mismatch or shown for a remote one ("Reasons from remote machines never get this hint").

**How it was resolved:**
The key is now `[r.reason, r.source]`. `why` follows from reason and source in every branch of `whyNone`, so it is not needed. A new poller test drives both machines to "not understood", then makes local fail, and expects a second announcement with `source: "marovo"`. It fails without the fix and passes with it.

**External tool analysis (Codex):**
> [P2] Include source changes in poller notifications. When the reason stays the same but its source changes (especially the fixed `Corgi output not understood` reason), `Poller.evaluate()` suppresses the update because its change key only includes the reason. `VoiceSession.source` then stays stale, so the UI can show a local mismatch hint for a remote error, or fail to show the hint after the error moves local.

### FINDING-2
- **Severity:** Important
- **Confidence:** 85
- **File:** tests/voice/session.test.ts (behavior at src/voice/recorder.ts letGoIfContinued, src/voice/segmenter.ts speechEnd)
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** fixed (round 1, 17d40bc)

**What is wrong:**
FR-001 and the clarification say that bursts shorter than the burst length do not count as speech going on past the stop. No test covered this: every new test played continuous tone after the stop, or set `speechEnd` by hand.

**Why this matters:**
This is the main regression risk of the release rule. If it switched to raw loudness, a click after `R` would release a passage that ended before the stop, and that passage would be lost (US1-2, SC-002). The existing tests play only silence after the stop and would still pass.

**How it was resolved:**
Two session tests on the clocked frame driver. In the first, a passage ends, `R` is pressed, and a 40 ms click (under the 0.1 s burst) is followed by quiet: the passage is still written and `late` is 0. In the second, 0.2 s of loud audio after the stop releases the passage, the stop settles within the burst length plus 100 ms, and nothing is written. The round 1 re-review confirmed that each test fails without the behavior it names.

### FINDING-3
- **Severity:** Minor
- **Confidence:** 72
- **File:** src/voice/recorder.ts:228-238
- **Category:** production-readiness
- **Source:** production-agent (also reported by: architecture-agent as Notable)
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:** Releasing a held passage wrote no log line, so a quick close because of a release looked the same as a stop with nothing held.
**Why this matters:** The original defect was diagnosed from these log lines; a missing last sentence could not be told apart from a release.
**How it was resolved:** `recording: let go of utterance <id>, its speech went on past the pause|stop of <path>` is logged once per hold. The guard returns early on later frames, so it cannot repeat.

### FINDING-4
- **Severity:** Minor
- **Confidence:** 90
- **File:** src/ui/prompt.ts:61-64, 167-173
- **Category:** architecture
- **Source:** architecture-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:** The completion state stored a `parent` field that nothing read.
**Why this matters:** Unused state implies a dependency that does not exist.
**How it was resolved:** The field was removed.

### FINDING-5
- **Severity:** Minor
- **Confidence:** 70
- **File:** src/voice/recorder.ts:222-227
- **Category:** architecture
- **Source:** architecture-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:** The doc comment said the session calls `letGoIfContinued` once per frame; it does so only while a passage is in progress.
**How it was resolved:** The comment was reworded to match session.ts.

### FINDING-6
- **Severity:** Minor
- **Confidence:** 75
- **File:** src/voice/setup.ts:136-166 (and src/corgi/command.ts)
- **Category:** security
- **Source:** security-agent (also reported by: round 1 re-review)
- **Round found:** 1
- **Resolution:** fixed (round 2, 02c221d)

**What is wrong:** The setup lines for `corgi` printed the command path and a spawn error without passing them through `spaced()`. Every other path for error text on screen does that.
**Why this matters:** A path or error holding ESC or CR would reach the terminal as control sequences. The input is user-controlled, so the risk is low.
**How it was resolved:** Round 1 sanitized only the spawn-error detail; the re-review pointed out that the path is printed raw on every run. Round 2 writes every `corgi` setup line through one `say()` helper that applies `spaced()`, and drops the per-branch call.

### FINDING-7
- **Severity:** Minor
- **Confidence:** 75
- **File:** tests/voice/session.test.ts ("a stop in a muted recording while noise goes on closes promptly")
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:** The test did not check how long the stop took, although its name says "promptly".
**How it was resolved:** It now asserts that the stop settles within the silence window plus 100 ms, as the SC-001 test does.

### FINDING-8
- **Severity:** Minor
- **Confidence:** 70
- **File:** tests/corgi/command.test.ts
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** fixed (round 1)

**What is wrong:** No test covered multi-line standard error (FR-009 quotes only the first line) or a reply that is not JSON at all with exit code 0.
**How it was resolved:** Both cases were added: detail is the first line only, and `HTTP/1.1 400 Bad Request` reads as a mismatch, "Corgi output not understood".

### FINDING-9
- **Severity:** Minor
- **Confidence:** 70
- **File:** src/corgi/command.ts:39-44 (checkReachable spawn failure)
- **Category:** correctness
- **Source:** correctness-agent
- **Round found:** 1
- **Resolution:** remaining (ambiguous)

**What is wrong:** If the `corgi` process cannot be started for the probe (the file vanished after the capability check, EMFILE, EAGAIN), setup reports `[mismatch]` with the voice.json hint and exits 1.
**Why this matters:** A spawn failure is not proof of another build, so the hint can point to the wrong fix. It can only happen when the file changes or the system is short of resources between two spawns of the same command a moment apart.
**What is needed:** FR-008 says "anything else" is a mismatch, which literally covers this. A decision is needed on whether a spawn failure should print a `[missing]`-style line instead.

### FINDING-10
- **Severity:** Minor
- **Confidence:** 80
- **File:** src/ui/prompt.ts:166-170 with src/ui/complete.ts:32-35
- **Category:** architecture
- **Source:** architecture-agent
- **Round found:** 1
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** The rule for where the segment starts (leading spaces trimmed) is computed in `complete()` and again in `FilePrompt.tab()`.
**What is needed:** Return the segment start from `complete()` and use it in `tab()`.

### FINDING-11
- **Severity:** Minor
- **Confidence:** 85
- **File:** src/corgi/errors.ts:36-43
- **Category:** architecture
- **Source:** architecture-agent
- **Round found:** 1
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** `classify(text, timedOut)` takes a `timedOut` flag that only tests pass; `checkReachable` handles the timeout itself.
**What is needed:** Drop the parameter or route the timeout through it, one of the two.

### FINDING-12
- **Severity:** Minor
- **Confidence:** 75
- **File:** src/corgi/command.ts:7-9, src/corgi/poller.ts
- **Category:** architecture
- **Source:** architecture-agent
- **Round found:** 1
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** `refused` moved to errors.ts, but `jsonFrom` and `unstarted` stayed in poller.ts as exports, so command.ts imports the polling module for two pure helpers.
**What is needed:** Move both next to `refused` in errors.ts (or a small reply module).

### FINDING-13
- **Severity:** Minor
- **Confidence:** 72
- **File:** src/ui/ui.ts:21, 233-246
- **Category:** architecture
- **Source:** architecture-agent
- **Round found:** 1
- **Resolution:** remaining (ambiguous)

**What is wrong:** The UI decides whether a reason is a mismatched local `corgi`: it imports `isMismatch` from src/corgi, matches it against the displayed reason, and hard-codes `"local"`.
**Why this matters:** Changing the reason wording could change whether the hint appears.
**What is needed:** A design choice: compute a `hint` flag in `whyNone` and carry it through `Seen`, or keep the check in the window, where FR-010 says "the window adds its hint".

### FINDING-14
- **Severity:** Minor
- **Confidence:** 72
- **File:** src/voice/link.ts:16-17
- **Category:** architecture
- **Source:** architecture-agent
- **Round found:** 1
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** `Seen.source` is optional while every other field is required and explicitly null, so the session repeats `?? null`.
**What is needed:** Make it required and add `source: null` to the test fixtures.

### FINDING-15
- **Severity:** Minor
- **Confidence:** 80
- **File:** src/ui/complete.ts:59-91 (from src/ui/prompt.ts tab())
- **Category:** production-readiness
- **Source:** production-agent
- **Round found:** 1
- **Resolution:** remaining (ambiguous)

**What is wrong:** Tab completion calls `readdirSync`/`statSync` on the event loop. On a hung network mount, the whole voice process (audio capture included) blocks while the call hangs.
**What is needed:** A design decision: async completion with a short bound, which adds in-flight state to the prompt. FR-007 covers unreadable folders, not hanging ones.

### FINDING-16
- **Severity:** Minor
- **Confidence:** 70
- **File:** src/ui/ui.ts:438-439, 462-467
- **Category:** production-readiness
- **Source:** production-agent
- **Round found:** 1
- **Resolution:** remaining (ambiguous)

**What is wrong:** The once-only hint is keyed on the full reason text in a Set that never shrinks. If corgi's error text changes from poll to poll, each new text adds a history line.
**What is needed:** The contract (contracts/setup-output.md) says "one history notice per distinct reason", which is what the code does. Switching to one notice per mismatch episode would change that contract.

### FINDING-17
- **Severity:** Minor
- **Confidence:** 80
- **File:** tests/ui/complete.test.ts (unreadable folder test)
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** The `chmod 000` folder is empty, so the test passes whether or not it is readable (and root can read it anyway). The injected-throw test covers the catch branch for real.
**What is needed:** Put a sub-folder in `locked/`, and skip or assert unreadability when running as root.

### FINDING-18
- **Severity:** Minor
- **Confidence:** 75
- **File:** tests/corgi/command.test.ts ("the probe is bounded at 3 s by default")
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** The test checks only `reach_ms === 3000`, not that the probe uses it.
**What is needed:** A timed test against a fake that delays 5 s (expect `no_answer` after 2.9 to 4 s), as the help check has.

### FINDING-19
- **Severity:** Minor
- **Confidence:** 70
- **File:** tests/voice/session.test.ts
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** There is no end-to-end test of a passage released at a pause and then claimed by the resumed recording, or released at a stop and claimed by a recording started right after.
**What is needed:** Two session tests on the clocked driver.

### FINDING-20
- **Severity:** Minor
- **Confidence:** 70
- **File:** tests/ui/prompt.test.ts
- **Category:** test-quality
- **Source:** test-quality-agent
- **Round found:** 1
- **Resolution:** remaining (unambiguous, deferred)

**What is wrong:** Prompt-level cycling is tested only with an empty ASCII parent. There is no test of an empty segment at the prompt, a `notes/` parent, or an astral-character parent.
**What is needed:** Three prompt tests (the correctness agent verified the code point arithmetic by reading the code).

### FINDING-21
- **Severity:** Minor
- **Confidence:** 75
- **File:** src/ui/complete.ts:72
- **Category:** external
- **Source:** coderabbit
- **Round found:** 1
- **Resolution:** dismissed

**What is wrong (claimed):** Folder names with control characters should be excluded from completion.
**Why dismissed:** The live spec says the opposite: "control characters in names are shown as spaces in the match list, as elsewhere" (Edge Cases). CodeRabbit cites tasks.md wording, and a completed task's wording is not a spec obligation. The code follows the spec, and the prompt shows such names as spaces.

**External tool analysis (CodeRabbit):**
> If a directory is named `"notes\n"`, typing `no` and pressing Tab inserts `"notes\n/"` into the filename. The prompt displays the newline as a space, so the displayed name differs from the inserted name. Reject control-character names before returning matches.

## Notable Observations

### NOTABLE-1
- **File:** src/corgi/command.ts:50-51
- **Category:** correctness (spec boundary)
- **Source:** correctness-agent
- **Description:** With no JSON `err`, `checkReachable` classifies all of standard error, while FR-008 says "else the first line of standard error". So setup and the window can classify the same failure differently.
- **Rationale:** All of the text is more robust (a Bun error puts `code: "ConnectionRefused"` on a later line). Either update the FR-008 wording or classify the first line only.

### NOTABLE-2
- **File:** src/ui/prompt.ts:86-91, 150-157
- **Category:** architecture
- **Source:** architecture-agent
- **Description:** While Tab cycles through matches, there is no way to accept a match and go one level deeper; another key has to end cycling first.
- **Rationale:** This matches FR-005. Users of zsh menu completion may expect `/` to accept.

### NOTABLE-3
- **File:** src/ui/complete.ts:49-56, 77-86
- **Category:** security
- **Source:** security-agent
- **Description:** "Does not leave the transcript folder" holds for the path as written, not on disk: a symlink inside the folder to a folder outside is offered (FR-006 edge case) and accepted.
- **Rationale:** The spec asks for this; only the user can plant such a link.

### NOTABLE-4
- **File:** src/util/text.ts:7-14
- **Category:** security
- **Source:** security-agent
- **Description:** `spaced()` keeps Unicode bidi and format characters (U+202E, U+200B, U+2066 to U+2069), and completion is a new way for them to reach the screen.
- **Rationale:** They cannot inject escape sequences, but they can make a name look like a different one.

### NOTABLE-5
- **File:** src/util/subprocess.ts:84-110
- **Category:** production-readiness
- **Source:** production-agent
- **Description:** A probe that runs past its bound is killed (SIGTERM, then SIGKILL), but only the direct child: a wrapper script that does not `exec` leaves the real `corgi` running.
- **Rationale:** At worst a stray process after setup exits.

### NOTABLE-6
- **File:** tests/ui/ui.test.ts
- **Category:** test-quality
- **Source:** test-quality-agent
- **Description:** The FR-011 tests set the session fields directly; no single test drives a mismatch reply from the fake `corgi` through poller, link, session and window.
- **Rationale:** Each layer is tested, and FINDING-1's poller test now covers the source, but the walkthrough scenario has no end-to-end check.

## Post-Fix Spec Coverage

The fix rounds removed only an unused field and moved a `spaced()` call. Every requirement was checked again after the fixes:

| Requirement | Implementation | Status |
|-------------|---------------|--------|
| FR-001 | src/voice/recorder.ts letGoIfContinued, called from src/voice/session.ts frame | ✓ |
| FR-002 | src/voice/recorder.ts closed (waited_ms, late) | ✓ |
| FR-003 | src/voice/recorder.ts unreserve/claim, stop_wait_ms unchanged | ✓ |
| FR-004 | src/ui/complete.ts base() | ✓ |
| FR-005 | src/ui/complete.ts complete(); src/ui/prompt.ts tab(), matchList() | ✓ |
| FR-006 | src/ui/complete.ts folders(), isFolder(), base() | ✓ |
| FR-007 | src/ui/complete.ts folders() catch | ✓ |
| FR-008 | src/corgi/command.ts checkReachable; src/voice/setup.ts | ✓ (see NOTABLE-1 on the wording) |
| FR-009 | src/voice/setup.ts mismatch lines | ✓ |
| FR-010 | src/corgi/errors.ts reach_patterns, classify, isMismatch | ✓ |
| FR-011 | src/corgi/viewers.ts whyNone source; src/corgi/poller.ts evaluate; src/ui/ui.ts hinted/sync | ✓ |
| FR-012 | tests with generated audio, temp folders, the fake corgi | ✓ |
| FR-013 | README.md Tab completion and Troubleshooting | ✓ |

All spec requirements verified after the fix loop.

## Test Suite Results

| Round | Test Command | Exit Code | Failures | Status |
|-------|-------------|-----------|----------|--------|
| baseline | bun run check && bun test | 0 | 0 | passed (554) |
| 1 | bun run check && bun test | 0 | 0 | passed (557) |
| 2 | bun run check && bun test | 0 | 0 | passed (557) |

Test suite passed in all fix rounds.

## Remaining Findings

No Critical or Important findings remain. The 12 remaining Minor findings are FINDING-9 to FINDING-20 (FINDING-21 was dismissed). 8 are unambiguous cleanups or test additions, deferred (FINDING-10, 11, 12, 14, 17, 18, 19, 20), and 4 are ambiguous design choices (FINDING-9, 13, 15, 16).
