# Brainstorm: Sidebar Voice Icon

**Date:** 2026-11-22
**Status:** active

## Problem Framing

Since the extraction, Corgi shows nothing about voice. tals/corgi#36 had a `♫` in the sidebar title row, left of `[ + ]`: green while listening, faint while muted, and a click toggled mute. corgi-voice dropped it with the rest of the Corgi-side voice code (001 FR-016, FR-018). Today the voice state is visible only in the voice window, through `corgi-voice --status`, or through a global hotkey that gives no lasting feedback.

This is phase 2 of brainstorm #02, which planned an overlay card. The user wants the icon back in the sidebar title row instead, in the same spot #36 used, because a fixed spot is where the eye already goes and an overlay covers terminal content.

The custom Corgi build now contains Tricks (tals/corgi#74, patch 10 in `scripts/custom-build list`), so the work can start before #74 merges upstream.

Success:
- While corgi-voice runs, the sidebar title row shows its state within about a second of a change, in every Corgi viewer on this machine.
- A click on the icon toggles mute through the existing control channel.
- When corgi-voice is not running, the title row looks exactly as it does today.
- The Corgi change is a general Tricks feature that upstream can accept, offered as a PR stacked on `tals:tricks` and added to the custom build.

Anti-goals:
- Voice code in Corgi. Corgi learns about "a trick's title-row item", never about voice, `control.sock`, or corgi-voice.
- A second path that types text. The trick reads state and sends mute commands only (same rule as #02).
- Crowding the title row. When it is too narrow, the item disappears before Corgi's own title, scope selector, `[ + ]` or `<` lose space.
- Depending on #36 remnants (`corgi action voice-mute`, the `voice` field in `list --json`).

## Findings

- #36's indicator (`005-voice-transcripts`, `src/sidebar.ts`): `voiceLabel()` placed `♫` left of `[ + ]` with a space, `voice_on` in the accent color and bold, `voice_off` faint; the title text was shortened (down to "work…") to make room; a click hit-tested to `{ tag: "voice" }`.
- The current title row (`drawTitle` in `src/sidebar.ts`) holds the corgi badge, the "workspaces" title, an optional workspace scope selector, `[ + ]`, and the `<` collapse button. Its layout depends on whether a scope is shown.
- Tricks today (`docs/tricks.md`, `src/tricks.ts`): surfaces are `sidebar`, `popover` and `pane`, all per agent; `overlay` draws an independent card in a pane corner. Nothing places independent content in the sidebar chrome.
- Raw JSONL tricks already have what the voice side needs: `ui.set`/`ui.remove`, button content with `action` IDs, and `{event:"ui.press", action, viewer}` delivered to the owning process. Budgets: 128 MiB, 8 processes, 10% of a core; idle tricks block on input.
- Each trick runs once per daemon. A trick on a remote machine cannot reach the laptop's `control.sock`.
- The custom build tool accepts PR refs (`scripts/custom-build add tals/corgi#N`) and merges patches in list order, so a stacked PR goes after #74.
- Direction from Corgi's maintainer: Tricks is meant to gain first-class subprocess support (reaping processes when a viewer dies or something crashes); its UI and shortcuts still need work; local code changes are to sync to remote machines automatically. So the Tricks UI API may still move, and tricks may end up running on remote daemons as well.

## Approaches Considered

### A: A title-row slot in Tricks, plus a voice trick in corgi-voice (chosen)

Corgi PR, stacked on `tals:tricks`: a trick may place one short item in the sidebar title row, with an optional button action. Raw JSONL tricks use a new drawing kind; code tricks get a matching small API. A click arrives as the existing `ui.press` event. corgi-voice ships `tricks/voice/` with a raw command manifest and a `--trick` mode that watches `control.sock` and keeps the item current.
- Pros: exactly #36's spot and behavior; general enough for upstream; reuses Tricks' budgets, press routing, lifetime handling and cleanup.
- Cons: a Corgi PR to maintain until #74 merges, rebased whenever `tricks` moves; the Tricks UI API may change under it.

### B: Decorate the target agent's sidebar row

The trick appends `♫` to the sidebar row of the pane that receives dictation. No Corgi change.
- Pros: works today; also shows where text will go.
- Cons: the icon moves with the target, and vanishes when the target is a plain shell pane or there is none. Not the fixed spot the user wants. Possible later as an optional "where does my text go" hint.

### C: A status slot set through a Corgi CLI command

`corgi status set voice "♫"` stores an item in the daemon and the sidebar draws it.
- Pros: no trick process.
- Cons: new daemon state and a new CLI in Corgi; a click has no way back to corgi-voice; a second extension mechanism next to Tricks that upstream is unlikely to want. Dropped.

### Dropped earlier (#02)

The overlay card from #02's decision is replaced by A: it covers terminal content and sits in a pane, not in a fixed spot.

## Decision

Approach A. Two deliverables:

1. A Corgi PR against `tals/corgi:tricks` adding a sidebar title-row item for tricks, added to the custom build after #74 with `scripts/custom-build add`.
2. A corgi-voice feature: `tricks/voice/` and `corgi-voice --trick`, drawing the voice icon through that item.

Keep the corgi-voice trick thin (state in, one item out, mute on press), so it survives changes to the Tricks UI API and a later move to first-class subprocesses.

## Key Requirements

Icon (user agreed):
- Same spot as #36: the sidebar title row, left of `[ + ]`.
- `♫` in the accent color while listening; `♫` faint while muted.
- Proposal (my call, agreed in playback): a red `●` while recording, since corgi-voice records transcripts and #36 did not.
- Nothing shown while corgi-voice is not running or voice is unavailable, so the row looks as it does today.

Click (agreed):
- Toggles mute through `control.sock`, the same path as `m` in the window and `--toggle-mute`.
- While recording, the toggle is refused (recording keeps voice muted); the icon stays red with no extra feedback (my call, agreed in playback).

Corgi side (general Tricks feature):
- Any trick may place one short item (an icon or a few characters, optionally a button) in the title row. It is not voice-specific.
- Bounded width (my proposal: a few cells per item, a small total); the item is dropped, not truncated into Corgi's own controls, when the row is too narrow. Corgi's title may shorten to make room, as #36 did, but `[ + ]` and `<` never move out of reach.
- Works for raw JSONL tricks (a new drawing kind beside `overlay` and `decorate`) and code tricks (a small API beside `corgi.draw`).
- Presses reuse `ui.press`; removal, crash, disable and reload clear the item like other drawings.
- Fits the existing per-trick UI budget and viewer wire rules (capability-advertised, older viewers may omit it).
- Documented in `docs/tricks.md` and covered by tests in the Corgi repo's style; offered upstream as a PR whose base is `tricks`.

corgi-voice side:
- `tricks/voice/trick.toml` with `command = ["corgi-voice", "--trick"]`; install instructions for Corgi's tricks folder (`${XDG_CONFIG_HOME:-~/.config}/corgi/tricks`).
- `--trick` speaks the raw JSONL protocol: waits for `ready`, uses the control channel's `watch`, sets or removes the item on each change, sends `toggle` on a press.
- Reconnects to `control.sock` when corgi-voice starts later or restarts; clears the item while none runs. Idle when nothing changes, well inside the trick budgets.
- On a daemon where `control.sock` does not exist (for example a remote machine), it draws nothing and stays quiet.
- The control channel stays as specified in `003-control-channel`; no new ops unless the spec shows a need.
- Hotkey tools must work without the shell's `PATH`: the manifest may need the absolute path of `corgi-voice` or `bun` (see the handoff gotcha about `/opt/homebrew/bin`).

## Open Questions

- Shape of the Corgi API: a new raw kind (`kind: "title"`?) and code call (`corgi.draw(key, {kind: "title", ...})`?), or a new surface name. Pick the one closest to how #74 already models overlays.
- Several tricks with title-row items: order, total width cap, and which drops first when space runs out.
- Where the item goes when the workspace scope selector is shown, and in the framed sidebar layout.
- Which daemon's title-row items a viewer shows when it shows a remote machine. The voice trick only works on the laptop's daemon.
- Does a raw command trick get the shell `PATH`, so `corgi-voice` resolves, or does the manifest need an absolute path? (Tricks pass "home, path, ..." through; verify.)
- Where the Corgi-side spec lives (`corgi-specs` or the Corgi fork) and whether to open an upstream issue before the PR.
- Should a refused click during recording give feedback after all (a short flash, or a hover hint)?

## Follow-ups (out of scope)

- B as an optional hint on the target agent's row.
- tals/corgi#190 (trick-registered actions) for a Corgi key that toggles mute.
- Revisit once Tricks gains first-class subprocess support: a trick could own the corgi-voice process itself.
