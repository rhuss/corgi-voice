# Feature Specification: Sidebar Voice Icon

**Feature Branch**: `004-sidebar-voice-icon`

**Created**: 2026-11-22

**Status**: Draft

**Input**: User description: "Build the corgi-voice side of brainstorm 03: a Corgi trick and a `corgi-voice --trick` mode that show the voice state as a sidebar title-row item and toggle mute on press. The Corgi side is tals/corgi#198 (title items for tricks); do not change Corgi."

## Clarifications

### Session 2026-11-22

- Q: Should the icon show while corgi-voice runs but has no target (no viewer attached, Corgi unreachable)? → A: Yes; the icon follows mute, availability and recording only, the target stays in the voice window.
- Q: Should a paused recording look different from a running one? → A: Yes; running shows a red `●`, paused shows `●` in the warm (amber) color.
- Q: What happens when two Corgi daemons on this machine both run the trick? → A: Each keeps its own item from the same channel (the channel accepts several watchers); a press in either toggles once.

## Context

Since the extraction (`001-corgi-voice-extraction`), Corgi shows nothing about voice. tals/corgi#36 drew a `♫` in the sidebar title row, left of `[ + ]`: accent while listening, faint while muted, and a click toggled mute. `003-control-channel` gave corgi-voice a local control channel (`status`, `mute`, `unmute`, `toggle`, `watch`) and CLI commands. tals/corgi#198, stacked on Tricks (tals/corgi#74), lets a trick keep one short item (1 to 4 cells, optionally pressable) in the sidebar title row. This feature connects the two: a small trick that corgi-voice ships and runs.

The API contract for the Corgi side is `docs/tricks.md` on branch `011-tricks-title-item` of the Corgi repo, sections "Title items" and "Raw JSONL", summarized in `brainstorm/03-sidebar-voice-icon.md` ("Update 2026-11-22"). This feature changes nothing in Corgi.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the voice state in Corgi's sidebar (Priority: P1)

While working in Corgi, the user glances at the sidebar's title row and sees whether dictation is listening, muted, or a transcript is being recorded, without switching to the voice window.

**Why this priority**: This is the core value: the state is visible where the user already looks. Without it nothing else in this feature matters.

**Independent Test**: With the trick installed and corgi-voice running, change the mute state and start a recording in the voice window; the title row follows each change. Testable without Corgi by driving `--trick` with a fake control channel and checking the JSON lines it writes.

**Acceptance Scenarios**:

1. **Given** corgi-voice is running and listening, **When** Corgi starts the trick, **Then** the title row shows `♫` in the listening color.
2. **Given** the icon shows listening, **When** the user presses `m` in the voice window, **Then** within one second the icon shows `♫` in the faint (muted) color.
3. **Given** voice is listening or muted, **When** a recording starts, **Then** the icon shows a red `●` while the recording runs and an amber `●` while it is paused, and returns to `♫` in the color of the current mute state when it ends.
4. **Given** the icon is shown, **When** corgi-voice quits, **Then** the item disappears from the title row within one second.
5. **Given** corgi-voice is not running, **When** it starts later, **Then** the icon appears within 3 seconds of corgi-voice being ready, without restarting the trick or Corgi.
6. **Given** corgi-voice is running, **When** voice cannot listen (microphone missing, denied or busy, or transcription server down), **Then** no item is shown while no recording runs, and the icon returns when voice can listen again.

---

### User Story 2 - Toggle mute by clicking the icon (Priority: P1)

The user clicks the icon (or focuses it with Corgi's trick-button keys and presses Enter) to mute or unmute dictation, exactly as with `m` in the voice window or the global hotkey.

**Why this priority**: The click was half of #36's indicator and is what makes the icon useful while dictating into a pane.

**Independent Test**: Deliver a `ui.press` event with the item's current action to `--trick` connected to a fake channel; the channel receives one `toggle` request and the trick redraws from the resulting state.

**Acceptance Scenarios**:

1. **Given** the icon shows listening, **When** the user clicks it, **Then** voice is muted (the window shows MUTED and adds its "muted from outside" history row) and the icon turns faint.
2. **Given** the icon shows muted, **When** the user clicks it, **Then** voice listens again and the icon shows the listening color.
3. **Given** the icon shows muted and the microphone disappears just before the click, **When** the channel refuses the unmute, **Then** nothing changes, the item re-arms or disappears with the next state, and the trick keeps running.
4. **Given** a click arrives for an item drawn before the state changed, or a second click on the same drawing, **When** the trick receives it, **Then** it is ignored rather than toggling the wrong way.
5. **Given** a recording runs, **When** the user clicks the `●`, **Then** nothing happens (the recording item is not pressable).

---

### User Story 3 - Install the trick (Priority: P2)

The user installs the trick into Corgi's tricks folder with one corgi-voice command and gets the icon without editing files, even though Corgi starts tricks with a reduced environment.

**Why this priority**: Without an easy, reliable install the icon never shows; but the icon itself (stories 1 and 2) is the value.

**Independent Test**: Run the install command with a temporary config folder; check the written manifest (id, command with absolute paths, config) and that a second run updates it in place.

**Acceptance Scenarios**:

1. **Given** no voice trick is installed, **When** the user runs `corgi-voice --install-trick`, **Then** a `corgi-voice` folder with a valid manifest appears in Corgi's tricks folder, the command prints where it wrote it and how to reload Corgi's tricks, and exits 0.
2. **Given** the trick was installed before, **When** the user runs the install again (for example after moving corgi-voice), **Then** the manifest is rewritten with the current paths and nothing else in the tricks folder is touched.
3. **Given** the README, **When** the user follows its Corgi section, **Then** they can install, reload, verify (`corgi tricks list`) and uninstall the trick.

### Edge Cases

- Corgi without title-item support (no tals/corgi#198): `ui.set` of a title item fails with an error reply; the trick logs each error kind once per process to standard error and keeps running; later state changes still send their one `ui.set` each, never a retry loop.
- `TitleExists`, `TitleTooWide`, `InvalidTitle` replies: the trick uses one fixed key and a one-cell glyph, so these indicate a contract change; handled like the previous case.
- The control channel answers garbage, closes mid-watch, or gives no first answer within 1 second: the trick removes the item and reconnects on its retry schedule; it never exits because of corgi-voice.
- Two quick clicks on the same drawing: only the first sends a `toggle`; the item re-arms after the answer.
- Corgi closes the trick's standard input (reload, disable, daemon exit): the trick exits promptly, closing its channel connection.
- corgi-voice restarts quickly: the trick reconnects and redraws; at most one item is ever drawn.
- The trick runs on a remote machine's daemon (tricks synced or installed there): no control channel exists there, so it draws nothing, stays idle and quiet, and Corgi shows no voice item for it (Corgi shows title items only from the viewer's first daemon anyway).
- The trick's environment lacks `XDG_STATE_HOME`/`XDG_RUNTIME_DIR` that corgi-voice itself sees: the trick still finds the channel because the installed manifest carries the channel's path.
- A press arrives while no corgi-voice runs: ignored.
- A recording runs while voice cannot listen: the recording `●` is shown (recording state wins over availability).
- corgi-voice runs without a target (no viewer attached, Corgi unreachable): the icon still follows mute and recording; the target is not part of the icon.
- Two Corgi daemons on this machine both run the trick: each keeps its own item from its own `watch`; a press in either sends one `toggle`.

## Requirements *(mandatory)*

### Functional Requirements

**Trick mode**

- **FR-001**: `corgi-voice --trick` MUST run as a Corgi raw JSONL trick: read the `ready` event from standard input, then write one JSON command per line on standard output; diagnostics go to standard error only.
- **FR-002**: The trick MUST obtain the voice state through the existing control channel's `watch` request (`003-control-channel` FR-005), with no new channel ops and no other access to corgi-voice internals.
- **FR-003**: The trick MUST keep at most one title item under one fixed key, derived from the state, independent of the target and `reason` fields: while `recording` is `running`, `●` in Corgi's `hot` color; while it is `paused`, `●` in `warm`; otherwise, while voice can listen (`unavailable` is null), `♫` in `accent` when `mode` is `listening` and in `faint` when `mode` is `muted`; otherwise (voice cannot listen, no recording) no item. Each glyph is one cell. The color names are Corgi palette names (`docs/tricks.md`).
- **FR-004**: The trick MUST send `ui.set` only when the shown glyph, color or pressability changes (or to re-arm a press, FR-005), and `ui.remove` only when an item is currently drawn and no corgi-voice is reachable or the state calls for no item.
- **FR-005**: The `♫` item MUST be pressable; the recording `●` items MUST NOT be (no `action`), so a click during a recording cannot silently unmute dictation; the window and the hotkey still work then. A pressable item carries a fixed `slot` (so keyboard focus stays on it across redraws) and a fresh action ID per drawing (unique per revision, at most 80 ASCII characters). The trick MUST accept at most one press per action ID: the first `ui.press` with the current action sends one `toggle`; later presses with that action, stale or unknown actions, and presses while no corgi-voice is reachable MUST be ignored. When the toggle request ends (answered, refused, timed out or failed), the trick MUST redraw with a fresh action ID (re-arming the item) if the state still calls for a pressable item. The trick does not second-guess the channel's mute rules (FR-003 of 003).
- **FR-006**: When the channel is absent, the connection closes, a line from it is malformed, or the first `watch` answer does not arrive within 1 second (003's timeout), the trick MUST remove the item and retry connecting every 2 seconds. After the first answer, silence on a `watch` means "no change" and is never treated as a stall. The trick MUST NOT exit or log on every retry (at most one log line per transition between reachable and unreachable).
- **FR-007**: When standard input closes, the trick MUST exit within one second.
- **FR-008**: The trick MUST find the channel at the path given in the `ready` event's `config.socket` when present, else at the path corgi-voice computes from the trick's own environment (`003-control-channel` FR-001).
- **FR-009**: The trick MUST NOT type text, start or stop recordings, change settings, take the single-instance lock, start a voice window, or touch the microphone, Whisper or Corgi beyond its own JSONL standard input and output. It handles `--trick` before the terminal check, like the control commands.
- **FR-010**: While idle the trick MUST stay blocked on input (no polling while connected) and stay well within Corgi's trick budgets (one process, no children, low memory).

**Install**

- **FR-011**: `corgi-voice --install-trick` MUST write `corgi-voice/trick.toml` into Corgi's tricks folder (`$CORGI_TRICKS_DIR` when set, else `${XDG_CONFIG_HOME:-~/.config}/corgi/tricks`), creating folders as needed. The manifest has `version = 1`, `id = "corgi-voice"`, a short `description`, a `command` that runs `--trick` through absolute paths (so it works with the daemon's PATH), and a `[config]` table with `socket = "<path>"`, the channel path corgi-voice computes in the install's environment (FR-008).
- **FR-012**: The install MUST be idempotent: rerunning replaces only that manifest, written atomically (a temporary file renamed into place, since Corgi reloads on TOML changes). It MUST print the written path and the next step (`corgi tricks reload`, then `corgi tricks list`), and exit 0; on failure it MUST print the reason and exit 1. It MUST NOT run Corgi or need a terminal. `--trick` and `--install-trick` combined with each other, with control flags or with voice-window flags are usage errors (exit 2, as in 003 FR-008).
- **FR-013**: The repository MUST contain `tricks/voice/` with a reference manifest and a short README pointing to `--install-trick`.

**Documentation and quality**

- **FR-014**: The README MUST document the icon's states, the click (and that recording dots are not pressable), the install, reload, verification and uninstall steps, the need to rerun the install after changing `XDG_RUNTIME_DIR`, `XDG_STATE_HOME` or `TMPDIR` (a stale socket path leaves the trick idle), and the dependency on Corgi with Tricks and title items (tals/corgi#74 and tals/corgi#198, or a custom build containing both).
- **FR-015**: Every acceptance scenario except those needing a live Corgi MUST be covered by automated tests that need no microphone, Whisper or Corgi: the trick is driven through its standard input and output against a fake control channel. The live check in Corgi is a runbook step.
- **FR-016**: The contract test (`tests/contract.test.ts`) MUST keep passing, extended for this feature: Corgi is reached only through the documented Tricks JSONL interface on the trick's own standard streams and, for `--install-trick`, by writing the manifest into Corgi's tricks folder; no Corgi state, sockets or protocol otherwise; no `bun:ffi`. The trick reaches the control channel only through the existing client in `src/control/`.

### Key Entities

- **Voice state** (from 003): `mode`, `unavailable`, `recording`, and the other fields; the only input of the trick.
- **Title item**: one key, one span (glyph and color), and for the pressable `♫` only a fixed slot and an action ID per drawing; the only output of the trick.
- **Trick manifest**: `trick.toml` with id, description, command and config (channel path).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a mute change, start or end of a recording, or corgi-voice quitting, the title row shows the new state within 1 second in 100% of automated checks (measured at the trick's output) and in the runbook's live check.
- **SC-002**: A click on the icon mutes or unmutes dictation in one step, matching `m` in the window, in every automated press scenario and the live check.
- **SC-003**: With corgi-voice not running for 60 seconds, the trick writes at most one diagnostic line and no `ui.set` or `ui.remove` command.
- **SC-004**: Installing takes one command and no file edits; a fresh install shows the icon after `corgi tricks reload` in the live check.
- **SC-005**: The full test suite passes, with tests for every acceptance scenario not needing a live Corgi.

## Assumptions

- The Corgi side (title items) is tals/corgi#198 on top of tals/corgi#74; until both are in the running Corgi (upstream or the user's custom build), the trick logs an error reply and shows nothing. Supporting older Corgi versions with an overlay fallback is out of scope.
- The installed manifest is machine-specific (absolute paths); if it is synced to another machine whose paths differ, Corgi reports the trick as failed there, which is acceptable since the icon only matters on the laptop.
- Corgi shows title items only from the viewer's first daemon, so the icon is shown for the laptop's corgi-voice only; no remote handling beyond staying quiet is needed.
- The trick defers all mute rules to the control channel and shows the state it reports. During a recording the icon is not pressable (FR-005), which realizes the brainstorm's "a click during recording does nothing" without a rule in the channel.
- Corgi starts raw tricks with a reduced environment (HOME, PATH, locale, TZ, TERM, TMPDIR and `CORGI_*`), so the install writes absolute paths and the channel path into the manifest.
- Out of scope: a Corgi key binding for mute (tals/corgi#190), the "where does my text go" hint on the target agent's row, owning the corgi-voice process from a trick, and any change to the Corgi repo.
