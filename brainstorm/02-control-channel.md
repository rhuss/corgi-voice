# Brainstorm: Control Channel, Hotkey Mute and Voice Trick

**Date:** 2026-11-20
**Status:** active

## Problem Framing

With the extraction (`001-corgi-voice-extraction`), voice state and mute live only in the corgi-voice window. `corgi voice` inside Corgi had a sidebar indicator, a mute shortcut in every key preset, and a click on the indicator to mute (tals/corgi#36, dictation FR-019 to FR-023). corgi-voice dropped them on purpose (spec FR-016, FR-018), so today the user has to switch to the voice window and press `m`, and nothing in Corgi says whether speech is being typed.

Goal: mute and unmute from anywhere with one key, see the voice state while working in Corgi, and do both without changing Corgi's core.

Success:
- A global hotkey toggles mute within about 200 ms, whichever window has focus.
- `corgi-voice --status` tells scripts and status bars what voice is doing.
- Once Tricks (tals/corgi#74) lands, a voice card in Corgi shows listening, muted or recording and the target pane, with a button that toggles mute.

Anti-goals:
- A second way to type text into panes. The control channel carries state and mute commands only, never text to type.
- Network exposure: nothing listens beyond the user's own machine and account.
- Re-adding voice code to Corgi, or depending on #36 remnants in the custom build (`corgi action voice-mute`, the `voice` field in `list --json`).

## Findings

- corgi-voice already runs as a single instance per user (`src/util/lock.ts`, lock at `$XDG_RUNTIME_DIR/corgi-voice.lock`, else `~/.local/state/corgi-voice/lock`; `XDG_RUNTIME_DIR` is unset on this Mac). So there is at most one process to talk to, and it can own a well-known endpoint.
- Mute is `VoiceSession.setMuted()` (`src/voice/session.ts`): unmuting is refused while voice cannot listen, and a recording mutes on start and restores the earlier state on stop (Corgi 005 FR-013a). Any remote mute must go through the same call so these rules hold.
- Corgi's CLI has no way to bind a key to a shell command (`corgi keys` lists fixed presets; `corgi action NAME` runs built-in viewer actions only).
- Tricks (tals/corgi#74, open, updated 2026-11-19; `docs/tricks.md` in the `pr-74-tricks` worktree):
  - A trick is trusted local code running with the user's permissions, one process per daemon, not an OS sandbox.
  - Besides JS entries, a manifest may give `command = [...]`, an argv launched directly, speaking JSONL on stdin/stdout (`ready`, `subscribe`, `ui.set`, `ui.remove`).
  - `corgi.draw(key, {kind: "overlay", anchor, text|content})` draws a card in a pane corner, up to 12 lines; `ui.button(label, callback)` runs a callback when pressed.
  - Budgets: 128 MiB, 8 processes, 10% of one core; 1,000 commands per second.
  - No key-binding hook.
- A trick runs inside each machine's daemon. A trick on a remote machine runs there and cannot reach the laptop's corgi-voice.

## Approaches Considered

### Control channel

**A: Unix domain socket with JSON lines.** corgi-voice listens on `control.sock` next to its lock, a 0700 directory, socket mode 0600. Requests are one JSON object per line: `status`, `mute`, `unmute`, `toggle`, `watch`. Each answer carries the full state. `watch` keeps the connection open and pushes a state line on every change.
- Pros: answers (the hotkey can show the new state); push updates for the trick and status bars; one mechanism for everything; file permissions limit it to the user.
- Cons: a small server in the voice process; stale socket files (safe to remove while holding the lock).

**B: Signals plus a state file.** `SIGUSR1` toggles mute, `SIGUSR2` reloads; corgi-voice writes `state.json` atomically on every change.
- Pros: tiny; no server.
- Cons: no answer, no explicit mute or unmute (only toggle); readers poll the file; signals are awkward from a trick's JSONL process.

**C: Command file watched by corgi-voice.** Rejected: polling both ways, races, no answers.

### Hotkey

**A: `corgi-voice --toggle-mute` bound with a global hotkey tool.** macOS Shortcuts ("Run Shell Script"), skhd or Hammerspoon. The README documents all three with an absolute path, because those tools do not read the shell's `PATH`.
- Pros: works now, in any window, without Corgi.

**B: A Corgi key binding through Tricks.** Not possible today; ask upstream (see follow-ups).

### Indicator

**A: A raw JSONL trick that corgi-voice ships.** `tricks/voice/` holds a manifest with `command = ["corgi-voice", "--trick"]`. That mode connects to `control.sock` with `watch` and draws one overlay, for example `🎙 Listening · bat · corgi-voice` with a `Mute` button, or `MUTED`, or `● REC`. It clears the card, or shows `voice off`, while no corgi-voice runs, and reconnects every 2 s.
- Pros: no extra runtime; the trick and the tool ship and version together; the protocol stays private to corgi-voice.
- Cons: depends on #74's raw JSONL and button contract, which may still change.

**B: A JS trick reading a state file.** Rejected: needs approach B's state file and polling; and buttons would still need a way back.

**C: Sidebar decoration (`ui:agent.sidebar`).** Rejected: the sidebar rows belong to agents; voice is not an agent, and an overlay card is the documented way to show independent state.

## Decision

- Control channel A: a Unix socket with JSON lines, state and mute commands only.
- CLI commands: `--mute`, `--unmute`, `--toggle-mute`, `--status [--json]`, `--watch`, all talking to the running instance.
- Hotkey A, with a README recipe.
- Indicator A, as a second phase gated on #74 landing. Build the socket so the trick needs nothing more.

## Key Requirements

- `control.sock` lives in the lock's directory (`$XDG_RUNTIME_DIR/corgi-voice/`, else `~/.local/state/corgi-voice/`): socket 0600, directory 0700. The path stays below the 104-byte macOS limit. It is created after the lock is held, a stale one is removed first, and it is removed on every exit path (the cleanup routine in `src/main.ts`).
- Protocol: one JSON object per line, at most 4 KiB per request; unknown ops answer `{"ok":false,"err":"UnknownOp"}`.
  - State: `{ok, pid, mode: "listening"|"muted", available, reason, recording: "none"|"running"|"paused", target: {machine, label}|null, updated_at}`.
  - No op takes text or reaches `pane send`.
- `mute`, `unmute` and `toggle` call the same path as `m` in the window. Unmute while voice cannot listen answers `ok:false` with the reason, and the recording restore rules are unchanged.
- CLI exit codes:
  - 0 when the request succeeded;
  - 1 when the request was refused (for example unmute while voice cannot listen);
  - 3 when no corgi-voice is running.
  - With `--json` the state line is printed; otherwise one short line such as `muted` or `listening · bat · corgi-voice`.
- `--toggle-mute` round trip under 200 ms on this Mac, including Bun startup.
- The window shows a short history row when mute changes from outside ("muted from hotkey"), so a hidden change is visible later.
- `--watch` prints a state line per change, for status bars (sketchybar, tmux).
- Tests drive the socket with a fake session: permissions, stale socket removal, each op, refusal while unavailable, watch pushes, and cleanup on exit.
- Phase 2 (after #74):
  - `tricks/voice/` with its manifest and a `--trick` mode that speaks the JSONL protocol;
  - an overlay with the state and a Mute or Unmute button; cleared while no corgi-voice runs;
  - install instructions for Corgi's tricks folder;
  - within the trick budgets (one small process, idle when nothing changes).

## Open Questions

- Should the history row for an outside mute name the source (hotkey, trick, CLI), which needs a `source` field in the request?
- Which corner should the trick's card use by default, and should it appear only while recording or muted, so it stays out of the way while listening?
- Does #74's raw JSONL mode deliver button presses for `ui.set` views, and in what shape? Verify against #74 before phase 2.
- Where is Corgi's default tricks folder, and does `corgi tricks` offer an install command for a folder outside it?
- Should the overlay appear only on the local machine's panes (the trick runs in the local daemon), or does the viewer show local overlays while it shows a remote machine?

## Follow-ups (out of scope)

- Upstream: open an issue asking Tricks for key bindings (a trick registering a named action that presets can bind), and mention it when closing tals/corgi#36.
- Remove #36 from the custom Corgi build once the hotkey works, so `voice-mute` and the old `voice` state do not confuse.
