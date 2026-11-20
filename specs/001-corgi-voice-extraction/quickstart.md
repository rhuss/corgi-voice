# Quickstart Validation: corgi-voice

## Prerequisites

- Bun 1.4 or newer, `whisper-server` (whisper.cpp), `ffmpeg` (audio capture), and a `corgi` release with `pane send --stdin` and viewer data in `list --json`.

## Install and automated checks

```bash
bun install
bun run check        # tsc --noEmit
bun test             # no microphone, Whisper or Corgi needed
bun link             # puts corgi-voice on PATH
```

Expected: type check clean, all tests pass.

## Scenario 1: setup (US6)

```bash
corgi-voice --setup
```

Expected: checks for `whisper-server`, `ffmpeg`, `corgi`; reuses models from `~/.cache/corgi/voice/` when present, otherwise downloads `base.en` and the speech filter with progress; prints a readiness report; exit 0. With `--corgi does-not-exist`: names the command, mentions aliases, exit 1.

## Scenario 2: local dictation (US1, US4)

1. Open a Corgi viewer and focus a pane running `cat`.
2. In another terminal: `corgi-voice`.
3. Header shows the pane label; say "hello world", pause.

Expected: `hello world` (Whisper casing) appears in the `cat` pane, no newline. Say a second sentence: it follows after one space. Press `m`, speak: nothing typed.

## Scenario 3: remote machine (US2)

Switch the viewer to a remote machine (for example `marovo`), focus a `cat` pane, speak. Expected: text appears there; header names the machine. Stop the remote machine's network: the next row shows `✗ marovo unreachable`.

## Scenario 4: no viewer (US3)

Detach all viewers. Expected: window says no viewer is attached; speech is not transcribed. Reattach: dictation resumes within 2 seconds.

## Scenario 5: recording (US5)

Press `r`, Enter on `YYYY-MM-DD-.txt`, speak three sentences with a 3 s pause between two of them, press `v`, then `R`. Expected: file in `~/.local/share/corgi/transcripts/` with one line per passage and one blank line at the long pause; reading view showed blocks; nothing typed into any pane; mute restored.

## Scenario 6: never Enter (SC-004)

`bun test tests/corgi` asserts that no recorded fake-`corgi` call contains `--enter` and that every `pane send` stdin lacks a trailing newline.

## Results

Run on 2026-11-20 during implementation (macOS, Apple Silicon, Bun 1.4.4, `whisper-server` and `ffmpeg` from Homebrew, the local Corgi build at `corgi-integration/dist/corgi-custom`, which is a shell alias for `corgi` in the user's shell). This was an unattended pipeline run: no microphone input and no interaction with the user's Corgi panes, so the scenarios that need speech were checked only up to the point before typing.

- **Automated checks**: `bun run check` clean; `bun test` 418 pass, 0 fail (39 files, about 70 s).
- **Scenario 1 (setup)**: run with `HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` pointing at a scratch folder whose old locations held a `voice.json` and links to the existing `base.en` and Silero models. Setup copied the settings (new file mode 0600), took both models from the old cache without downloading, reported `[ok]` for `whisper-server`, `ffmpeg`, `corgi`, the model and the speech filter, and exited 0 in about 4 s. With `--corgi does-not-exist` it reported `[missing] corgi: ... If "does-not-exist" is a shell alias, other programs cannot run it: pass --corgi or set "corgi" in voice.json to the executable's path` and exited 1. The scratch folder was removed afterwards; the old model files are unchanged.
- **Scenario 2 (local dictation)**: not run with speech (no microphone input in this run). Read-only check instead: `CorgiLink.watch()` against the real Corgi returned `{"viewer":true,"focus":"claude · cc-rosa-rhoai","machine":"local","reason":null}` after 137 ms, parsing a 1.1 MB `list --json` reply; the resolved target was viewer 4, pane 207, `active` 10720. No `pane send` went to any real pane. Timing of `corgi pane send 999999 --stdin` (a pane id that does not exist, so nothing is typed): 100, 99, 121, 120, 95, 93, 92, 108, 99, 95 ms, so the CLI adds about 0.1 s per local delivery, well inside SC-002's 2 s.
- **Scenario 3 (remote machine)**: `corgi machine list` named `local` and `marovo`; marovo did not answer (its SSH login fails on this machine: `Permission denied (publickey,...)`). The poller marked it `no answer in time` after 1.5 s while the local machine stayed fresh and kept the target, which is the FR-007 isolation. Remote delivery timing (SC-003) could not be measured; the remote path is covered by `tests/corgi/link.test.ts` and `tests/corgi/poller.test.ts` with the fake `corgi`.
- **Scenario 4 (no viewer)**: not run against the real Corgi (it would mean detaching the user's viewer); covered by `tests/corgi/integration.test.ts` and `tests/corgi/link.test.ts`.
- **Scenario 5 (recording)**: not run with speech; covered by `tests/voice/recorder.test.ts`, `tests/voice/session.test.ts`, `tests/ui/prompt.test.ts` and `tests/ui/ui.test.ts`.
- **Scenario 6 (never Enter)**: passes (50 deliveries in `tests/corgi/link.test.ts`, plus the `--enter` scan of `src/` in `tests/contract.test.ts`).
