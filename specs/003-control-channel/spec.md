# Feature Specification: Control Channel and Hotkey Mute

**Feature Branch**: `003-control-channel`

**Created**: 2026-11-21

**Status**: Draft

**Input**: Brainstorm `brainstorm/02-control-channel.md`. Since the extraction (spec 001), voice state and mute live only in the corgi-voice window: muting means switching to that window and pressing `m`, and nothing outside it says whether speech is being typed. This feature gives the running corgi-voice a local control channel, command-line commands that use it, and a documented global hotkey, so the user can mute from anywhere and scripts can read the state. Showing the state inside Corgi (a Trick, brainstorm phase 2) waits for tals/corgi#74 and is out of scope; the channel is designed so that trick needs nothing more.

## Clarifications

### Session 2026-11-21

- Q: What are the socket's exact paths? → A: `$XDG_RUNTIME_DIR/corgi-voice.sock` when `XDG_RUNTIME_DIR` is set (next to `corgi-voice.lock`), else `control.sock` in the state folder (`$XDG_STATE_HOME/corgi-voice/`, else `~/.local/state/corgi-voice/`, next to `lock`).
- Q: Does `--watch` print the current state before any change? → A: Yes: the first line is the state at connect time, then one line per change.
- Q: What does the short line say while voice cannot listen? → A: `muted · cannot listen: <words>` (voice shows MUTED while it cannot listen), for example `muted · cannot listen: microphone missing`; cannot-listen wins over a missing target.
- Q: What does `toggle` do while voice cannot listen? → A: It follows the mode the window shows (MUTED), so it means unmute and is refused; `mode` in the state is the shown mode.
- Q: How many requests per connection? → A: One; the connection closes after the answer, except `watch`, which stays open.

## Context

- corgi-voice runs as a single instance per user (spec 001 FR-005); its lock lives at `$XDG_RUNTIME_DIR/corgi-voice.lock`, else `lock` in the state folder (`$XDG_STATE_HOME/corgi-voice/`, else `~/.local/state/corgi-voice/`).
- Mute today: `m` in the window toggles it; unmuting is refused while voice cannot listen (no microphone, server down); a recording mutes dictation on start and restores the earlier state on stop (Corgi 005 FR-013a). Any outside mute must follow the same rules.
- Corgi cannot bind a key to a shell command, so a global hotkey tool (macOS Shortcuts, skhd, Hammerspoon) runs the command instead.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Toggle mute with a global hotkey (Priority: P1)

The user is in a video call in another window and wants dictation to stop typing. They press a global hotkey; corgi-voice mutes within a moment, and the voice window shows MUTED with a history row saying it was muted from outside. Pressing the hotkey again unmutes.

**Why this priority**: Muting without switching windows is the main reason for this feature.

**Independent Test**: With corgi-voice running (fake corgi, generated audio), run `corgi-voice --toggle-mute` twice and check the session's mute state, the printed state line and the exit codes.

**Acceptance Scenarios**:

1. **Given** corgi-voice running and listening, **When** `corgi-voice --toggle-mute` runs, **Then** corgi-voice is muted, the command prints the muted state line (`muted · <label>`) and exits 0, and the window shows MUTED with a history row `muted from outside`.
2. **Given** corgi-voice muted, **When** `corgi-voice --toggle-mute` runs, **Then** it is unmuted, the command prints the listening state line and exits 0.
3. **Given** corgi-voice cannot listen (microphone missing or server down), **When** `corgi-voice --unmute` or `--toggle-mute` would unmute, **Then** nothing changes, the command prints the reason and exits 1.
4. **Given** no corgi-voice running, **When** any control command runs, **Then** it prints `corgi-voice is not running` and exits 3.
5. **Given** a recording running (which muted dictation), **When** the user unmutes from outside, **Then** dictation is unmuted as with `m`, and stopping the recording later restores the mute state from before the recording, as today.
6. **Given** corgi-voice running but not answering within 1 second (for example a stuck process), **When** a control command runs, **Then** it prints `corgi-voice did not answer` and exits 3.

---

### User Story 2 - Read the state from scripts and status bars (Priority: P2)

The user shows voice state in a status bar (sketchybar, tmux). `corgi-voice --status` prints one short line; `--status --json` prints the full state; `--watch` keeps printing a line on every change.

**Why this priority**: Makes the state visible outside the window; also the base for the Corgi trick later.

**Independent Test**: Run `--status`, `--status --json` and `--watch` against a running corgi-voice; change mute, start and stop a recording, change the target; check each printed line.

**Acceptance Scenarios**:

1. **Given** corgi-voice listening with target `bat · corgi-voice`, **When** `corgi-voice --status` runs, **Then** it prints `listening · bat · corgi-voice` and exits 0.
2. **Given** the same, **When** `corgi-voice --status --json` runs, **Then** it prints the state as one JSON object (FR-004) and exits 0.
3. **Given** `corgi-voice --watch` running, **When** mute, recording state, availability or the target change, **Then** it prints one line per change (JSON with `--json`), and it exits 0 when corgi-voice quits.
4. **Given** no viewer attached, **Then** the short line reads `listening · no viewer attached` (or `muted · no viewer attached`); for other causes it shows the same head the window shows, for example `listening · Corgi unreachable` or `listening · marovo unreachable`.
5. **Given** a recording running, **Then** the short line ends in `· REC` (`· REC paused` when paused).

---

### User Story 3 - Set up the hotkey from the README (Priority: P2)

The README shows how to bind `corgi-voice --toggle-mute` to a global key with macOS Shortcuts, skhd and Hammerspoon, using the absolute path because those tools do not read the shell's `PATH`.

**Why this priority**: The command alone is not useful until it is bound to a key.

**Independent Test**: Follow one recipe and press the key.

**Acceptance Scenarios**:

1. **Given** the README, **Then** it has a short section with one recipe each for Shortcuts, skhd and Hammerspoon, the command to find the absolute path (`command -v corgi-voice`), and the meaning of the exit codes.

---

### Edge Cases

- A stale socket file from a crashed corgi-voice: the new instance (which holds the lock) removes it before listening; a control command that finds a socket nobody answers treats it as "not running" (exit 3).
- A control command gets no answer within 1 second (connect and answer together): it prints `corgi-voice did not answer` and exits 3.
- Two control commands at the same time: each gets its own answer; mute changes apply in arrival order.
- A client that connects and sends nothing for 2 seconds is closed; an oversized or malformed line is answered with `ok: false` (`too_long`, `bad_json`, `unknown_op`) and the connection closes; none of this affects the voice window. The idle close does not apply to a `watch` connection after its request.
- A `--watch` client that stops reading: corgi-voice drops it once more than 64 KiB wait unsent, instead of blocking.
- corgi-voice quits while a `--watch` runs: the watch prints nothing more and exits 0.
- The socket path would exceed the operating system limit for socket paths (104 bytes on macOS): both corgi-voice and the commands use `$TMPDIR/corgi-voice-<uid>/control.sock` instead (folder created 0700 when missing, and used only when it is owned by the user and writable by nobody else, group included; its parent must belong to the user or root and, when others may write to it, have the sticky bit; a fallback path that is still too long is refused); corgi-voice says so in the verbose log.
- A mute change from outside while a gauge runs: allowed, as `m` is during a gauge.
- The control channel never accepts text to type and never reaches `corgi pane send`.
- The `$TMPDIR` fallback folder is unsafe (not the user's, or writable by others): a control command prints that folder's reason and exits 3, since no corgi-voice could listen there.
- The channel cannot be started (for example an unsafe fallback folder): the voice window still starts and shows a notice that the control commands cannot reach it.

## Requirements *(mandatory)*

### Functional Requirements

**Control channel**

- **FR-001**: While running, corgi-voice MUST listen on a local socket next to its single-instance lock, `$XDG_RUNTIME_DIR/corgi-voice.sock` when `XDG_RUNTIME_DIR` is set, else `control.sock` in the state folder (`$XDG_STATE_HOME/corgi-voice/`, else `~/.local/state/corgi-voice/`), next to `lock`, or the `$TMPDIR` fallback in Edge Cases when the path is too long (socket mode 0600; the state folder is created 0700 when missing; `$XDG_RUNTIME_DIR` is never changed), created after the lock is held, removing a stale socket file first, and removed on every exit path.
- **FR-002**: The channel MUST accept one request per connection: one JSON object on one line (at most 4 KiB) with an `op` of `status`, `mute`, `unmute`, `toggle` or `watch`. It MUST answer with one JSON line `{ok, state, err?}` (state per FR-004) and close the connection, except after `watch`. `err` is one of `bad_json`, `too_long`, `unknown_op`, `cannot_listen`; none of these affect the window.
- **FR-003**: `mute` and `unmute` MUST go through the same path as `m` in the window, so unmuting while voice cannot listen is refused (`ok: false`, `err: cannot_listen`) and the recording's mute and restore rules stay as they are. `toggle` MUST mean unmute when the shown `mode` is `muted` (including while voice cannot listen, so it is refused then) and mute otherwise. A request that changes the mute setting (the `muted` field, FR-004; also while voice cannot listen, where it decides the mode once voice can listen again) MUST add a history row `muted from outside` or `unmuted from outside`; a no-op or a refusal adds none.
- **FR-004**: The state MUST hold `pid`; `muted`, the mute setting (true or false), which decides the mode whenever voice can listen; `mode`, the mode the window shows (`listening`, or `muted` when muted or while voice cannot listen); `unavailable`, why voice cannot listen (`mic_missing`, `mic_denied`, `mic_busy`, `server_down`, or null); `reason`, why there is no target, in the window's words (for example `no viewer attached`, `Corgi unreachable: ...`), or null; `recording` (`none`, `running`, `paused`; a stopping recording reports `none`, as the window hides REC at once); `target` (`{machine, label}` with the window's Target text as `label`, or null); and `updated_at` (ms since the epoch, changed only when another field changes).
- **FR-005**: `watch` MUST answer with the current state first, then keep the connection open and push one state line on every change of mute, availability, recording state, target or reason; a watcher with more than 64 KiB unsent, or gone, MUST be dropped without blocking corgi-voice. A change means a change in any field except `updated_at`, so watchers never see duplicates.
- **FR-006**: The channel MUST only carry state and mute commands: it MUST NOT accept text to type, recording control, or settings changes.

**Command line**

- **FR-007**: `corgi-voice --mute`, `--unmute`, `--toggle-mute`, `--status [--json]` and `--watch [--json]` MUST talk to the running instance through the channel and print the resulting state: a short line by default: `<mode> · <label>`, or `<mode> · <head of reason>` without a target (`no viewer attached`, `Corgi unreachable`, `marovo unreachable`, as the window's Target cell), or `muted · cannot listen: <words>` while voice cannot listen (`microphone missing`, `microphone access denied`, `microphone busy`, `transcription server down`; this wins over a missing target), with `· REC` or `· REC paused` appended during a recording. With `--json` it prints the `state` object only (not the answer).
- **FR-008**: Exit codes MUST be: 0 success; 1 the request was refused (the reason on standard error, the state line or JSON on standard output as usual); 2 usage error (more than one control flag, control flags mixed with voice-window flags, or `--json` without `--status` or `--watch`); 3 no corgi-voice running or no answer within 1 second.
- **FR-009**: `--toggle-mute` MUST complete from spawn to exit (start, request, answer, exit) within 200 ms at the 95th percentile over 20 runs on a current Apple Silicon Mac when corgi-voice is running. This is a benchmark run by hand (`bun run bench:toggle` or similar), not part of the automated test suite.
- **FR-010**: The control commands MUST NOT start a voice window, take the lock, or touch the microphone, Whisper or Corgi; they MUST NOT need a terminal (hotkey tools have none), read `voice.json` or run the migration: they are handled before the terminal check.

**Documentation and quality**

- **FR-011**: The README MUST document the commands, the state line and JSON fields, the exit codes, and hotkey recipes for macOS Shortcuts, skhd and Hammerspoon using the absolute path from `command -v corgi-voice`.
- **FR-012**: The channel, the commands and every acceptance scenario MUST be covered by automated tests that need no microphone, Whisper or Corgi (FR-009's timing excepted).

### Key Entities

- **Voice state**: `pid`, `muted`, `mode`, `unavailable`, `reason`, `recording`, `target`, `updated_at`; the single description of what voice is doing, shared by the window, the channel and future consumers.
- **Control request**: one JSON line with `op`, one per connection; **Control answer**: one JSON line `{ok, state, err?}`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `corgi-voice --toggle-mute` mutes or unmutes dictation within 200 ms from spawn to exit (95th percentile over 20 runs, measured by hand), so a global hotkey works from any window without switching to the voice window.
- **SC-002**: `--status` reports the same mode and target as the voice window in 100% of automated checks across mute, recording and target changes.
- **SC-003**: A `--watch` client sees every state change, in order, with no duplicates, across a scripted sequence of 10 changes.
- **SC-004**: Malformed, oversized, silent and stalled clients never block or crash corgi-voice in automated tests.
- **SC-005**: The full test suite passes, with tests for every acceptance scenario.

## Assumptions

- Out of scope: the Corgi trick that shows the state and a mute button (brainstorm phase 2, waits for tals/corgi#74), a Corgi key binding (needs a Trick key-binding hook upstream), and a separate state file (the `--status` command covers scripts).
- A mute from outside is recorded in the history without naming the source (hotkey, script); the channel carries no source field.
- The socket is local to the user's machine and account; file permissions are the access control, as for the lock.
