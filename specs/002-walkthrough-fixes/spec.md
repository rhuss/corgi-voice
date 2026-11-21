# Feature Specification: Walkthrough Fixes

**Feature Branch**: `002-walkthrough-fixes`

**Created**: 2026-11-20

**Status**: Draft

**Input**: Brainstorm `brainstorm/01-walkthrough-fixes.md`. The first live walkthrough of corgi-voice (spec `001-corgi-voice-extraction`, `RUNBOOK.md`) passed 8 of 9 steps and found three rough edges: stopping a recording waited 10 seconds for nothing, the recording file prompt offers no quick way to pick a folder, and setup accepted a `corgi` command that could not talk to the running Corgi.

## Context

Terms from spec 001 and Corgi's `005-voice-transcripts` spec apply: a **passage** is one stretch of speech cut out and transcribed; a **recording** writes passages to one transcript file and can run, be paused or be stopped. The rule this feature relies on (Corgi 005 FR-004a, carried over by 001 FR-019): a passage belongs to the recording state in effect when its speech ended.

Observed on 2026-11-20:

- Stop: the log showed `recording: stopped …/2026-11-20-test.txt waited_ms=10001 late=0`, then `utterance 29: muted duration=17.3s`. Background noise above the recording threshold kept the speech detector "in speech" after `R`, the recording held that utterance for itself in case its speech had ended before the stop, and the close waited for its full 10 second bound.
- Prompt: the name field accepts sub-folders, `~/` and absolute paths, but the user has to type each folder name in full. The user asked for Tab completion rather than a folder browser.
- Setup: the user's shell aliases `corgi` to a custom build; `PATH` held an older release. Setup reported `[ok] corgi` because the old release supports `pane send --stdin`, but its `list --json` answered `{"ok":false,"err":"JSON Parse error: Unexpected identifier \"HTTP\""}` and the voice window could only say `Corgi unreachable: …`. Setting `"corgi"` in `voice.json` fixed it; nothing pointed the user there.

## Clarifications

### Session 2026-11-20

- Q: What counts as "loud audio after the stop" that proves the speech went on? → A: The speech detector's own notion: the end of the utterance's last loud stretch (bursts shorter than the burst length do not count) moving past the stop or pause moment. No new threshold.
- Q: What does Tab do when the typed segment is empty (right after a `/`, or an empty field)? → A: It treats all folders in that base folder as matches: shows up to 8 and the second Tab starts cycling, so a user can step into a folder and see what is inside. **SUPERSEDED** by the 2026-11-21 session.

### Session 2026-11-21 (walkthrough)

- Q: Is shell-style Tab completion enough to pick a folder? → A: No (user, walkthrough step 4): the choices are not visible, picking among several is unclear, and the transcript folder cannot be left. Replaced by an always-open folder pop-down with its own focus.
- Q: How far up may the user go? → A: Anywhere, up to the file system root; the path switches to `~/` or absolute form.
- Q (second round, after trying the list): Is the always-open list with two focus areas right? → A: No (user): the path showed three times and the list fought with the name. Replaced by one full-path field with a Tab pop-down at the caret; Backspace at the file name's start goes up; no `..` entry.
- Q: How does typing filter the list? → A: Prefix matches first, then substring matches, case-insensitive.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Stopping a recording closes it promptly (Priority: P1)

During a call with some background noise or music, the user presses `R`. Whatever was said before `R` is written and the transcript file is closed right after its transcription, not seconds later, whatever the background does.

*(Revised 2026-11-21 after walkthrough step 5: holding the passage in progress until it provably ended still waited 1.8 s with music, and could reach the 10 s bound with beat-heavy music near the threshold. A stop now cuts the passage at the stop, as the length cap does.)*

**Why this priority**: The 10 second wait happens in normal use whenever the room is not silent, and the file the notes workflow reads stays open meanwhile. It is a defect against the existing rule.

**Independent Test**: Feed continuous noise above the recording threshold through the speech detector, start a recording, stop it while the noise goes on, and check that the file closes within the silence window with nothing reported late.

**Acceptance Scenarios**:

1. **Given** a running recording and audio that continues after `R` (above the recording threshold, or between the recording and the dictation threshold, or with short peaks), **When** the user presses `R`, **Then** the passage in progress is cut at the stop, its part before `R` is transcribed and written, and the recording closes as soon as that transcription is done, with `late=0`.
2. **Given** a running recording and a passage whose speech ended just before `R` (its silence window not yet over), **When** the user presses `R`, **Then** that passage is cut at the stop and written, without waiting for the silence window.
3. **Given** a running recording, **When** the user pauses it with `r` while audio above the threshold continues, **Then** the speech that goes on past the pause is not held for the recording, and a later stop does not wait for it.
4. **Given** a passage still being transcribed when `R` is pressed, **Then** the stop still waits for it up to 10 seconds, as today.
5. **Given** a sentence that straddles `R`, **Then** its part before `R` is written and the rest goes on as an ordinary utterance outside the recording (typed when dictation is unmuted, dropped when muted).
6. **Given** less speech before `R` than the minimum speech length, **Then** nothing is written for it and the recording closes at once.

---

### User Story 2 - Edit the full path, with a folder pop-down on Tab (Priority: P2)

*(Revised twice on 2026-11-21 after the walkthrough: shell-style Tab completion hid the choices; a separate always-open folder list repeated the path three times and fought with the name field.)*

The recording file prompt is one field holding the full path of the transcript file, for example `~/.local/share/corgi/transcripts/2026-11-21-|.txt` (`|` being the caret). The user edits it like any text. Pressing Tab opens a small pop-down at the caret listing the folders that fit there; typing filters it, the arrows pick, Enter or Tab takes the choice. Backspace at the start of the file name removes the folder in front of it, so going up is one key per level.

**Why this priority**: Picking a folder matters because the notes workflow reads transcripts from fixed folders; the user wants one clear place to see and edit the path. Requested by the user.

**Independent Test**: Create `meetings/`, `meetups/`, `notes/` and `walkthrough-test/2026/` in a temporary transcript folder, open the prompt, and drive the keys below, checking the field, the caret and the pop-down after each.

**Acceptance Scenarios**:

1. **Given** the prompt opens, **Then** the field shows the full path in `~/` form (absolute outside the home folder) of the transcript folder plus the suggested name, with the caret before `.txt`, and the key hint line reads `tab folders  enter record  esc cancel`; there is no separate folder line, path note or `..` entry.
2. **Given** the caret in the file name, **When** the user presses Tab, **Then** a pop-down at the caret lists the sub-folders of the folder the file is in; **When** the user picks `walkthrough-test/` (arrows, then Enter or Tab), **Then** the field reads `…/transcripts/walkthrough-test/2026-11-21-|.txt` with the caret still before `.txt`, and the pop-down closes.
3. **Given** the pop-down is open, **When** the user types `wa`, **Then** the list shows folders starting with `wa` first, then those containing it, ignoring case, and the typed filter is shown in the pop-down's frame; Backspace edits the filter; Esc closes the pop-down and leaves the field unchanged.
4. **Given** the caret inside a folder part of the path (for example after `trans` in `…/share/corgi/trans|cripts/…`), **When** the user presses Tab, **Then** the pop-down lists the folders of that part's parent that match the text before the caret, and taking one replaces that whole part.
5. **Given** the caret at the start of the file name, **When** the user presses Backspace, **Then** the folder in front of the file name is removed (`…/transcripts/walkthrough-test/|2026-11-21-.txt` becomes `…/transcripts/|2026-11-21-.txt`); repeated presses walk up to `/`.
6. **Given** a folder with no sub-folders, or one that cannot be read, **When** the user presses Tab, **Then** the pop-down shows a short muted note (`no folders` or `cannot read`) and closes on the next key.
7. **Given** a path to an existing file, **Then** a muted line under the field says it will append; an invalid path (empty name, a folder name, a path through a file) shows why on that line and Enter does nothing.


### User Story 3 - Setup catches a `corgi` that cannot reach the running Corgi (Priority: P2)

The user runs `corgi-voice --setup` with a `corgi` on `PATH` that is a different build from the Corgi that runs. Setup says so and how to fix it, instead of reporting `[ok]`. If the problem appears later, the voice window says the same.

**Why this priority**: It cost a walkthrough step and needed source-level digging to explain. The fix (setting `corgi` in `voice.json`) already exists; users just need to be pointed to it.

**Independent Test**: With the fake `corgi`, make `list --json` answer with a JSON parse error, run setup, and check the `[mismatch]` line, the hint and exit code 1; make it answer normally and check `[ok]`; make the daemon absent and check `[note]` with exit code 0.

**Acceptance Scenarios**:

1. **Given** a `corgi` whose `list --json` answers with a `viewers` array (empty is fine: no viewer needs to be attached during setup), **When** setup runs, **Then** it reports `[ok] corgi <path>`.
2. **Given** no running Corgi (the command reports that no runtime is running or refuses the connection), **When** setup runs, **Then** it reports `[note] corgi: Corgi is not running; could not check that <path> talks to it` and does not count this as missing.
3. **Given** a `corgi` whose `list --json` fails with a parse or protocol error, an unknown command, or an answer without viewer data, **When** setup runs, **Then** it reports `[mismatch] corgi <path> cannot talk to the running Corgi` with the first line of the error and a hint to set `"corgi"` in `voice.json` or pass `--corgi` with the path of the build Corgi runs, and setup exits with status 1.
4. **Given** the voice window and a local machine whose `list --json` fails with a mismatch pattern or answers without `viewers` ("Corgi output not understood"), **Then** the status line under the options shows the reason followed by `; set "corgi" in voice.json to the corgi your Corgi runs`, and the hint is written once to the history.
5. **Given** a slow `corgi` (no answer within its bound, or `RequestTimedOut`), **When** setup runs, **Then** it reports `[note] corgi: no answer in time` rather than a mismatch, and setup still succeeds.

---

### Edge Cases

- A passage held at a pause whose speech then provably goes on (new loud audio after the pause) is released at that moment.
- A passage cut at a stop that has less than the minimum speech is dropped as too short; nothing is written for it.
- Quitting while a stop waits for a transcription closes at once, as today.
- Tab with the caret inside a folder part: the text before the caret filters, and the folder taken replaces the whole part (FR-005).
- Folder names with spaces or non-ASCII letters are listed as they are; filtering treats composed and decomposed letters alike.
- Hidden folders (starting with `.`) are listed only when the filter starts with `.`.
- A symbolic link whose target is a folder is listed like a folder.
- A folder that cannot be read: the pop-down says `cannot read`, no error, nothing changes.
- More than 8 folders: the pop-down shows 8, scrolls with the highlight, and says how many more there are.
- Control characters are shown as spaces wherever the prompt or setup displays a name or path (field, note line, pop-down, every `corgi` line of setup).
- In a narrow window (the 37 column minimum) the key hints use short forms (`⇥ folders  ↵ record  esc cancel`).
- Setup's `list --json` probe is bounded (3 seconds) and never touches panes.
- A mismatch error from a remote machine (not the local one) is not a build mismatch of the local command; only the local machine's reason gets the hint.

## Requirements *(mandatory)*

### Functional Requirements

**Recording stop and pause**

- **FR-001**: When a recording is stopped while a passage is in progress (being spoken or within its silence window), the passage MUST be cut at the stop, as the length cap cuts it: the audio before the stop forms a passage of that recording (written when it reaches the minimum speech), and the audio from the stop on continues as a new utterance outside the recording. When a recording is paused while a passage is being spoken, the recording MUST keep holding that passage only while its speech may have ended before the pause; as soon as the end of the passage's last loud stretch (bursts shorter than the burst length do not count) reaches or passes the pause moment, the hold MUST be released.
- **FR-002**: A stopped recording MUST close as soon as its pending passages (including one cut at the stop) are written; the dictation values MUST return at the stop; the log line MUST report the real waiting time.
- **FR-003**: Passages whose speech ended while the recording ran MUST still be written, and the 10 second bound for passages still being transcribed MUST stay unchanged.

**Path field and folder pop-down** *(revised twice on 2026-11-21)*

- **FR-004**: The recording file prompt MUST be one editable field holding the full path of the transcript file, shown in `~/` form under the home folder and absolute elsewhere, prefilled with the start folder (FR-007a) and the suggested name, the caret before `.txt`. A line under the field MUST appear only to say the file will be appended to (muted) or why the path is refused (in the warning color). There is no separate folder line or `..` entry.
- **FR-005**: Tab MUST open a pop-down anchored at the caret. With the caret in the file name (the part after the last `/`), it lists the sub-folders of the file's folder and taking one inserts `name/` in front of the file name, keeping the caret's place in the name. With the caret in a folder part, it lists the folders of that part's parent that match the text of the part before the caret, and taking one replaces the whole part (`name/`). While the pop-down is open, typed text filters it (prefix matches first, then substring matches, each in code point order, ignoring case) and is shown in its frame, Backspace edits the filter, the up and down arrows pick, Enter or Tab take the highlighted folder, and Esc closes it without changes; the field does not take keys while it is open.
- **FR-006**: The pop-down MUST list directories and symbolic links to directories, hide names starting with `.` unless the filter starts with `.`, show at most 8 rows scrolling with the highlight with a count of hidden ones, show control characters as spaces, and fit the voice window's minimum size (37 by 14) by narrowing or moving left; an empty or unreadable folder shows `no folders` or `cannot read`.
- **FR-007**: Backspace with the caret at the start of the file name MUST remove the whole folder part in front of it (never past `/`); everywhere else the field's editing keys work as today. Any path may be typed: relative paths resolve against the transcript folder, `~/` against the home folder; `..` parts are resolved and allowed. Listing MUST NOT create, change or show errors for folders.
- **FR-007a**: The folder of the last started recording MUST be the start folder of the next prompt in the same run of corgi-voice; each start of corgi-voice begins at the transcript folder.

**`corgi` reachability**

- **FR-008**: Setup MUST run the chosen `corgi` with `list --json` once, bounded at 3 seconds, after the existing capability check passes, and report one of: `[ok]` (the reply has a `viewers` array, empty included), `[note]` (Corgi not running: `NoRuntime`, `ConnectionRefused`; or no answer in time: the bound ran out or `RequestTimedOut`; setup still succeeds), or `[mismatch]` (anything else, including a reply without `viewers`; setup exits 1). The error text classified is the same the poller uses: the `err` field of an `{"ok":false,...}` reply on standard output, else the `err` of such a reply printed on standard error (older `corgi` releases do this), else standard error (all of it is classified, so a pattern on a later line still counts; the report quotes its first line).
- **FR-009**: The `[mismatch]` line MUST name the command path, quote the first line of the error, and say to set `"corgi"` in `voice.json` or pass `--corgi` with the path of the `corgi` build that the running Corgi uses.
- **FR-010**: The "not running" and "no answer" patterns and an explicit list of mismatch patterns (`JSON Parse error`, `unknown command`, `Unexpected`) MUST live in one table next to the existing error table (`src/corgi/errors.ts`), covered by tests. Setup treats unmatched errors as a mismatch; the window adds its hint only for the explicit mismatch patterns and for a local reply without `viewers`.
- **FR-011**: When the local machine's reason in the voice window matches the explicit mismatch patterns, or the local reply has no `viewers` ("Corgi output not understood"), the window MUST append `; set "corgi" in voice.json to the corgi your Corgi runs` to the reason in the status line and write it once to the history. Reasons from remote machines never get this hint.

**Quality**

- **FR-012**: Each behavior above MUST be covered by automated tests that need no microphone, Whisper or Corgi (replayed or generated audio, temporary folders, the fake `corgi`).
- **FR-013**: The README MUST document the path field and its Tab pop-down (keys, Backspace to go up) and a troubleshooting entry for "Corgi unreachable" caused by a mismatched `corgi` command.

### Key Entities

- **Held passage**: the passage in progress at a pause, held for that recording; released when its speech provably continued past the pause, or settled when it ends. A stop holds nothing: it cuts the passage in progress (FR-001).
- **Path field state**: the text, the caret, and while the pop-down is open its anchor, the part being completed, the folders, the filter, the highlighted one and the scroll offset.
- **Reachability result**: `ok`, `not_running` or `mismatch`, with the first error line.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the automated tests with noise continuing after the stop (above the recording threshold, between the two thresholds, and with short peaks only), the recording closes within two frames of the stop plus the transcription time, writing the part before the stop (first walkthrough: 10 seconds; second: 1.8 seconds).
- **SC-002**: No passage whose speech ended before a stop is lost: the existing recording tests for passages in their silence window at a stop pass unchanged.
- **SC-003**: From the opened prompt, putting the file in a sub-folder two levels deep takes at most Tab, 2 typed letters and Enter per level when names are unambiguous, then Enter to record; every choice is visible before it is taken, and the path appears on screen exactly once.
- **SC-004**: The walkthrough's mismatch case (old `corgi` against a newer running Corgi) is reported by setup as `[mismatch]` with the fix, before the voice window is ever opened.
- **SC-005**: The full test suite passes, with new tests for every acceptance scenario above.

## Revision Notes

- 2026-11-21: User Story 2 and FR-004 to FR-007 replaced (Tab completion → folder pop-down with focus areas), FR-007a added, SC-003 revised. Reason: walkthrough step 4 feedback on UX.
- 2026-11-21 (walkthrough step 5): User Story 1, FR-001, FR-002, FR-003 and SC-001 revised: a stop cuts the passage in progress at the stop instead of holding it until its speech provably ended. This changes Corgi 005 FR-004a for stops: the part of a passage before the stop is written even when its speech goes on after it. Pauses keep the hold.
- 2026-11-21 (second round): User Story 2, FR-004 to FR-007a and SC-003 replaced again: one full-path field with a Tab pop-down at the caret. Spec 001 FR-021's refusal of `..` in relative names is lifted: the field always shows a full path, and any folder may be chosen.

## Assumptions

- The silence window in effect during a recording is the recording `silence` setting (default 1.0 s); "within the silence window" refers to that value.
- `corgi` reports a stopped Corgi as `NoRuntime`, `ConnectionRefused` or `ECONNREFUSED` and a slow one as `RequestTimedOut` (see FR-008); a JSON parse error, an unknown command, or a reply without `viewers` is treated as a mismatch.
- Only folders are listed; listing existing transcript files (to append) is a possible later addition (brainstorm open question).
- The recording threshold of 20 is not changed by this feature.
