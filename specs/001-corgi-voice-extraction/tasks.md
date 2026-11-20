# Tasks: corgi-voice Extraction

**Input**: Design documents from `specs/001-corgi-voice-extraction/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/corgi-cli.md, contracts/cli.md, quickstart.md

**Tests**: Required. FR-029 asks for automated tests of everything that does not need a microphone, Whisper or Corgi.

**Source**: `SRC` below means `~/Development/context-engineering/corgi/.claude/worktrees/005-voice-transcripts` (read only, never modified). "Port" means: copy the file, rewrite imports to this repository's modules, remove code for dropped features (`--ssh`, bridge, presence, daemon link, command words), keep behavior and comments otherwise.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 to US7)

---

## Phase 1: Setup

- [X] T001 Create `package.json` (name `corgi-voice`, `"type": "module"`, `"bin": {"corgi-voice": "src/main.ts"}`, scripts `test` = `bun test`, `check` = `tsc --noEmit`, devDependencies `typescript`, `@types/bun`, no runtime dependencies) and `tsconfig.json` (strict, `moduleResolution: bundler`, `types: ["bun"]`, `noEmit`) at the repository root
- [X] T002 [P] Create `bunfig.toml` (test root `tests/`) and confirm `.gitignore` covers `node_modules/`, `dist/`, `.mcp.json`; run `bun install` to produce `bun.lock`

---

## Phase 2: Foundational (blocking)

**Purpose**: Utilities, pure voice logic and the fake `corgi` used by every story.

- [X] T003 [P] Port `SRC/src/errors.ts`, `SRC/src/failure.ts`, `SRC/src/json.ts` to `src/util/errors.ts`, `src/util/failure.ts`, `src/util/json.ts` with their tests from `SRC/src/json.test.ts` and `SRC/src/failure.test.ts` (tests live next to the sources in `SRC/src/`) into `tests/util/`
- [X] T004 [P] Write `src/util/log.ts` (`getLogger(name)`, `configure({file, verbose})`, append-only file with mode 0600, no-op when not configured; API compatible with the calls in `SRC/src/voice/*.ts`) with tests in `tests/util/log.test.ts`
- [X] T005 [P] Write `src/util/subprocess.ts` on `Bun.spawn`: `run(cmd, {stdin?, timeoutMs, env?})` returning `{code, stdout, stderr, timedOut}`, kill with SIGTERM then SIGKILL after 200 ms on timeout, and `spawnError(error)` matching the source signature used by `SRC/src/voice/capture.ts`, `whisper.ts`, `setup.ts`; tests in `tests/util/subprocess.test.ts`
- [X] T006 [P] Write `src/util/text.ts` (`displayWidth` via `Bun.stringWidth`, `ellipsis`, `Writer`) matching the behavior the source `SRC/src/text.ts` exposes to `voice/ui.ts` and `voice/reading.ts`; port the relevant cases of `SRC/src/text.test.ts` into `tests/util/text.test.ts`
- [X] T007 [P] Write `src/util/paths.ts`: `settingsFile()` = `$XDG_STATE_HOME/corgi-voice/voice.json` else `~/.local/state/corgi-voice/voice.json`; `cacheDir()` = `$XDG_CACHE_HOME/corgi-voice/` else `~/.cache/corgi-voice/`; `oldSettingsFile()` = `$XDG_STATE_HOME/corgi/voice.json` else `~/.local/state/corgi/voice.json`; `oldCacheDir()` = `$XDG_CACHE_HOME/corgi/voice/` else `~/.cache/corgi/voice/`; `transcriptsDefault()` = `$XDG_DATA_HOME/corgi/transcripts/` else `~/.local/share/corgi/transcripts/`; `logFile()`; `lockFile()` = `$XDG_RUNTIME_DIR/corgi-voice.lock` else state dir `lock`. Tests with env overrides in `tests/util/paths.test.ts`
- [X] T008 [P] Port `SRC/src/terminal_keys.ts` to `src/ui/keys.ts` and `SRC/src/scroll_thumb.ts` to `src/ui/scroll_thumb.ts` (pure copies) with their tests from `SRC/src/terminal_keys.test.ts` and `SRC/src/scroll_thumb.test.ts` into `tests/ui/`; extend `src/ui/keys.ts` to discard OSC sequences (`ESC ]` up to `BEL` or `ESC \`) for the whole session, so a late OSC 11 reply is never read as keys (its `rgb:` would otherwise press `r`); test that a late reply yields no key events
- [X] T009 [P] Write `src/ui/palette.ts`: the subset of `SRC/src/palette.ts` used by voice (`Token`, `Rgb`, `Style`, `colors`, `mix`, `fgRgb`, `keycap`, `derived`) with two variants, each defining its own `bg`, `selected` and `line` backgrounds that the UI actually paints: dark = the `corgi` theme values from `SRC/src/palette.ts` (`bg` `[24, 27, 32]`, `selected` `[51, 57, 65]`, its `line`); light = light backgrounds (for example `bg` `[250, 250, 248]`, `selected` `[225, 228, 232]`, matching `line`) with the foreground hues darkened (HSL lightness lowered) until each pair passes; port relevant cases of `SRC/src/palette.test.ts`; test in `tests/ui/palette.test.ts` that every foreground-on-background pair the UI uses reaches contrast ratio >= 3:1 in both variants (FR-027)
  - Implementation note (checkpoint 1): the dark variant keeps every `corgi` value except `line`, which is lifted from `[80, 90, 101]` (2.5:1 on `bg`) to 3:1, because the window draws separators and box edges in `line` and FR-027 requires 3:1 for every foreground token. The light `accent` is darkened until the listening note (accent faded 35% toward `bg`) also reaches 3:1.
- [X] T010 Copy `SRC/tests/fixtures/voice/` (`make_pcm.ts`, `*.pcm`, fake `ffmpeg`, `pactl`, `system_profiler`, `whisper-server`; skip anything only used for `ssh`) to `tests/fixtures/voice/`, then port the pure voice modules from `SRC/src/voice/` to `src/voice/`: `level.ts`, `wav.ts`, `segmenter.ts`, `text.ts`, `turns.ts`, `tuning.ts`, `transcript.ts`, `models.ts`, plus their tests to `tests/voice/` (imports rewritten to `../../src/...`, fixture paths to `tests/fixtures/voice/`); all ported tests pass (`tuning.ts` imports a type from `settings.ts`, so `bun run check` passes only after T012)
- [X] T011 Port `SRC/src/voice/whisper.ts`, `SRC/src/voice/capture.ts` and the `SRC/src/voice/setup.ts` module (downloads, readiness report; migration and corgi checks are added in T042) to `src/voice/` using `src/util/subprocess.ts` and `Bun.which` instead of `discovery.onPath`, model files under `cacheDir()`; port `whisper.test.ts`, `capture.test.ts` and `setup.test.ts` to `tests/voice/`
- [X] T012 (after T007) Port `SRC/src/voice/settings.ts` to `src/voice/settings.ts` reading `settingsFile()` from `src/util/paths.ts`; add keys `corgi` (non-empty string or null, default null) and `theme` (`"auto" | "light" | "dark"`, default `"auto"`), invalid values fall back with a notice naming the field (FR-025); `transcripts` default from `transcriptsDefault()`; remove `ssh`; port `settings.test.ts` and add cases for the new keys in `tests/voice/settings.test.ts`
- [X] T013 Create `src/voice/link.ts` with `Seen = {viewer: boolean; focus: string | null; machine: string | null; reason: string | null}`, `Typed = {machine: string; pane: number; viewer: number}`, `LinkEvents` (`viewer`, `closed`; `muted` removed), `Events` and `bounded()` copied from `SRC/src/voice/link.ts`, and the interface `VoiceLink { watch(): Promise<Seen>; set(state: {muted?: boolean; available?: boolean}): Promise<{muted: boolean}>; type(text: string): Promise<Typed>; on(event, fn): void; close(): void }`. `type()` rejects with `Error("Timeout")` (abandoned), `Error("VoicePane")`, `Error("NoViewer")` or `Error(reason)` from `reasonFor()`. `WatchRequest` and `Watched` are removed (no daemon code, no `protocol`/`rpc` imports)
- [X] T013a Port `SRC/src/voice/recorder.ts` and `SRC/src/voice/reading.ts` to `src/voice/` with `recorder.test.ts` and `reading.test.ts` in `tests/voice/` (session, ui and main import them as values, so they must exist before US1)
- [X] T014 Create the fake `corgi` in `tests/fixtures/fake-corgi.ts` plus executable shim `tests/fixtures/fake-corgi` (`#!/bin/sh` `exec bun "$(dirname "$0")/fake-corgi.ts" "$@"`): reads scenario JSON from `FAKE_CORGI_SCENARIO` (per machine: `list` reply or error, delay ms; `machine list` reply; `pane send` exit code and stderr per pane; `--help` text), appends every call as a JSON line `{argv, stdin}` to `FAKE_CORGI_LOG`; helper `tests/fixtures/corgi.ts` to write scenarios and read the log

**Checkpoint**: `bun test` passes with utilities and pure voice logic (`bun run check` joins the US1 checkpoint, because `recorder.ts` imports the `Utterance` type from `session.ts`, ported in T023).

---

## Phase 3: User Story 1 - Dictate into the focused pane without Corgi changes (P1) MVP

**Goal**: Local dictation through `corgi pane send --stdin`, never Enter.

**Independent Test**: Quickstart Scenario 2 against a real Corgi; automated: `bun test tests/corgi tests/voice/session.test.ts`.

### Tests

- [X] T015 [P] [US1] Tests for `src/corgi/viewers.ts` in `tests/corgi/viewers.test.ts`: parse observed JSON (contracts/corgi-cli.md), invalid or truncated JSON gives `not-understood`, unknown fields ignored, viewer missing `id` or numeric `active` dropped, missing `viewers` array gives `not-understood`; pane label rule (`name`, else `agent`/`command` plus `cwd` basename, else `pane <id>`); `resolve()` per data-model.md steps 1 to 5 including "`active` values from different machines are never compared" and "machine whose data is older than 2000 ms is not a candidate"
- [X] T016 [P] [US1] Tests for `src/corgi/errors.ts` in `tests/corgi/errors.test.ts`: every row of the error mapping table in contracts/corgi-cli.md, prefix `corgi: ` removed, fallback first line cut to 60 columns, empty stderr with non-zero exit gives `corgi exited with code N`
- [X] T016a [P] [US1] Tests for `src/corgi/command.ts` in `tests/corgi/command.test.ts`: `--corgi` beats setting `corgi` beats `corgi` on PATH; a path that is not executable fails; the not-found message names the value and mentions replacing a shell alias with the executable's path; help text without `--stdin` fails naming `pane send --stdin`; the help call is bounded at 3000 ms
- [X] T017 [P] [US1] Tests for delivery in `tests/corgi/link.test.ts` using the fake corgi: when only stale machine data exists at delivery start, no `pane send` runs and `type()` rejects with `NoViewer`; a `corgi` executable that vanished after startup (spawn ENOENT) and a non-zero exit with empty stderr each give a failed row with a readable reason; argv is `pane send ID --stdin` (plus `--machine X` for non-local), never contains `--enter` across 50 deliveries (SC-004), stdin equals the text with no trailing newline; leading space only when previous successful delivery has same machine, viewer, pane and unchanged `active` (failed/abandoned do not count); a 5 s fake delay is abandoned at 2 s with reason "no answer in time; may have been typed", the process is killed, and the next delivery starts only afterwards; deliveries run strictly in order; own pane (`CORGI_PANE` on local) fails with "focused pane is the voice pane"; `exited` gives "pane gone", `dormant` gives "pane hibernated" without calling `pane send`

### Implementation

- [X] T018 [P] [US1] Implement `src/corgi/viewers.ts` (types `Machine`, `Viewer`, `PaneInfo`, `Target` from data-model.md; `parseList(json)`, `paneLabel(pane)`, `resolve(machines, previous, now)`)
- [X] T019 [P] [US1] Implement `src/corgi/errors.ts` (`reasonFor(stderr, machine)` with the table from contracts/corgi-cli.md in one constant)
- [X] T020 [US1] Implement `src/corgi/command.ts`: `resolveCorgi({flag, setting})` with precedence `--corgi` > setting `corgi` > `corgi` (`Bun.which` for names, existence and executable bit for paths); not found returns an error naming the value and saying a shell alias must be replaced by the executable's path (FR-003); `checkCapabilities(cmd)` runs `pane send --help` (3 s bound) and requires `--stdin` (FR-004)
- [X] T021 [US1] Implement `src/corgi/poller.ts` for the local machine: `corgi list --json` every 1000 ms, each call bounded at 1500 ms, stores `Machine` state with `fetchedAt`; emits `change` when the resolved target, its label or the reason changes; `stop()` kills in-flight calls (multi-machine support follows in US2)
- [X] T022 [US1] Implement `src/corgi/link.ts` `CorgiLink implements VoiceLink`: `watch()` starts the poller and resolves with the first `Seen`; `set()` resolves locally with the given mute; `type(text)` enqueues a serial delivery per T017 using `src/util/subprocess.ts`; when a delivery starts it re-runs `resolve(machines, previous, now)` (stale data rule applies; no candidate rejects with `NoViewer` without calling `corgi`); CorgiLink owns the 2000 ms delivery bound and rejects per the T013 interface; `viewer` events from poller changes; `close()` stops poller and kills a running send
- [X] T023 [US1] Port `SRC/src/voice/session.ts` to `src/voice/session.ts` against `CorgiLink`: remove runtime mute sync (`owed`, `resend`, `updating`, `applyMuted` from the link), remove refusals (`VoiceTaken`, `OldRuntime`), raise the session's own `bounded()` around `link.type` to 2500 ms as a safety net only (CorgiLink owns the 2000 ms bound), `applyViewer` compares all four `Seen` fields (`viewer`, `focus`, `machine`, `reason`) with a test that a change in `machine` or `reason` alone reaches the UI, failure rows, mute dropping, no-viewer hold-off and recorder hooks; `link_state` is `connected` when the poller has at least one fresh machine; port `session.test.ts` to `tests/voice/session.test.ts` with a fake link, dropping cases for removed behavior
- [X] T024 [US1] Implement `src/ui/screen.ts`: enter alt screen, hide cursor, enable SGR mouse (1000, 1006), `render(rows: string[])` writes only changed rows (`CSI r;1H` + row + `CSI K`) inside synchronized output (`CSI ?2026h/l`), full redraw on resize, `restore()` on exit and on SIGINT/SIGTERM/uncaught errors; tests with a fake output stream in `tests/ui/screen.test.ts`
- [X] T025 [US1] Implement `src/ui/theme.ts`: OSC 11 query with a 200 ms timeout, luminance < 0.5 is dark, no answer is dark, `theme` setting overrides; tests for reply parsing in `tests/ui/theme.test.ts`
- [X] T026 [US1] Port `SRC/src/voice/ui.ts` to `src/ui/ui.ts` on top of `src/ui/screen.ts`, `src/ui/keys.ts`, `src/ui/palette.ts`, `src/util/text.ts` (no `frame_diff`, `name_dialog`, `new_workspace`, `pane/terminal`); header shows target machine (when not `local`) and pane label from `Seen`; keep row order and labels and the 37x14 minimum; leave the recording prompt as a stub that US5 replaces; port `ui.test.ts` to `tests/ui/ui.test.ts`, dropping sidebar and `--ssh` cases
- [X] T027 [US1] Port `SRC/src/voice/main.ts` to `src/main.ts` (shebang `#!/usr/bin/env bun`): move `exitError` from the dropped `bridge.ts` into `src/main.ts` (or drop its test cases), take the version from `package.json` instead of `build_config`; flags per contracts/cli.md (remove `--ssh`, add `--corgi CMD`, `--help`), resolve corgi and check capabilities before opening the window (exit 1 with message on failure), pass `CORGI_PANE` as own pane, wire `CorgiLink`, session, capture, whisper and UI; port `main.test.ts` to `tests/main.test.ts` (replace its `build_config` import with the `package.json` version)

**Checkpoint**: `bun test` and `bun run check` pass; local dictation works end to end; MVP.

---

## Phase 4: User Story 2 - Dictate into a pane on a Corgi remote machine (P1)

**Goal**: Per-machine polling and remote delivery.

**Independent Test**: Quickstart Scenario 3; automated `bun test tests/corgi/poller.test.ts`.

- [X] T028 [P] [US2] Tests in `tests/corgi/poller.test.ts` with the fake corgi: machine names from `machine list` (notice line before the JSON is skipped); a remote machine delayed 10 s never delays the local target being fresh; a machine with stale data (> 2000 ms) stops being a candidate; `watched` tie-break across machines; previous-delivery and `local` tie-breaks; a machine added or removed between refreshes gains or loses its loop; fallback to `list --all-machines --json` when `machine list` fails, reading `ok:false` entries per machine despite exit code 1
- [X] T029 [US2] Extend `src/corgi/poller.ts`: `corgi machine list` on start and every 30000 ms (3000 ms bound, parse from the first `{`), one independent loop per machine (`corgi --machine NAME list --json` every 1000 ms, 1500 ms bound); on each refresh start loops for new names and stop and drop machines no longer listed (killing in-flight calls); fallback `list --all-machines --json` every 5000 ms per research R2 (implementation note, checkpoint 2: changed to every 1000 ms with a 1500 ms bound so fallback data stays fresh under FR-007; R2 and contracts/corgi-cli.md updated)
- [X] T030 [US2] In `src/corgi/link.ts` pass `--machine NAME` for non-local targets, map unreachable errors to "<machine> unreachable" (FR-013), record the delivered machine as `previous` for `resolve()`; extend `tests/corgi/link.test.ts` with remote cases

---

## Phase 5: User Story 3 - Hold off when no viewer is attached (P1)

**Goal**: No transcription without a candidate; clear reasons; retries.

**Independent Test**: Quickstart Scenario 4; automated cases below.

- [X] T031 [P] [US3] Tests in `tests/corgi/link.test.ts` and `tests/voice/session.test.ts`: no candidate gives `Seen {viewer:false, reason:"no viewer attached"}`; daemon not answering gives reason "Corgi unreachable: <reason>" and polling continues; `viewers` key missing on the local daemon's first answer gives "Corgi output not understood" and holds off without exiting; session records and transcribes nothing for dictation while `viewer` is false, while an active recording keeps receiving passages (FR-009); a viewer appearing resumes within one poll; the poller's spawn hitting ENOENT after startup gives `Seen {viewer:false, reason:"Corgi unreachable: corgi not found: <cmd>"}` and polling continues
- [X] T032 [US3] Implement the reasons in `src/corgi/poller.ts` and `src/corgi/link.ts`, and show them in the header of `src/ui/ui.ts` (FR-008)

---

## Phase 6: User Story 4 - Mute in the tool (P1)

**Goal**: Mute is local only.

**Independent Test**: press `m`, speak, nothing typed; automated session tests.

- [X] T033 [US4] Verify and test in `tests/voice/session.test.ts` that `m` toggles mute without any `corgi` call, in-flight utterances are dropped without a history row, MUTED shows while the tool cannot listen, and nothing in `src/` sends voice state to Corgi (assert the fake corgi log contains only `list`, `machine list`, `pane send` and `--help` calls)

---

## Phase 7: User Story 5 - Record a transcript and follow it in the reading view (P1)

**Goal**: Recording with the tool's own file prompt.

**Independent Test**: Quickstart Scenario 5; automated recorder, prompt and reading tests.

- [X] T034 [P] [US5] In `src/voice/recorder.ts` (ported in T013a) use `transcriptsDefault()` for the default folder and enforce new files 0600 and created folders 0700; add cases to `tests/voice/recorder.test.ts`
- [X] T035 [P] [US5] Tests in `tests/ui/prompt.test.ts`: suggested name `YYYY-MM-DD-.txt` (local date) with caret before `.txt`; shows the folder; relative names (with sub-folders) resolve against the transcript folder every time; a name that leaves it via `..` is refused with a message; `~/` and absolute paths used as given; empty name refused; whitespace trimmed; "will append" shown when the file exists; Enter accepts, Esc cancels; editing keys Backspace, Left/Right, Home/End, Ctrl+A/E/U/W
- [X] T036 [US5] Implement `src/ui/prompt.ts` per T035 and wire it into the recording start in `src/ui/ui.ts` replacing the stub from T026 (FR-021)
- [X] T037 [US5] Ensure sound-event markers (`*clap*`, `(music)`, `[laughter]` and the source's marker patterns) are dropped before writing, display or typing (FR-020) in `src/voice/text.ts`; add cases to `tests/voice/text.test.ts`
- [X] T038 [US5] Wire recording in `src/main.ts` (`--transcripts DIR`, mute on start and restore on stop, quit waiting up to 10 s, late message) and port the recording cases of `main.test.ts`; verify recording continues while no viewer is attached with rows marked "recorded, not typed" and the reason

---

## Phase 8: User Story 6 - Set up and run without Corgi's source or build (P2)

**Goal**: Setup, migration, single instance.

**Independent Test**: Quickstart Scenario 1.

- [X] T039 [P] [US6] Tests in `tests/util/migrate.test.ts`: settings copied from the old file when the new one is missing (notice, mode 0600), not copied when the new one exists; each missing model file taken from the old cache by hard link, by copy on link failure; old files unchanged; runs both at start and in setup
- [X] T040 [P] [US6] Tests in `tests/util/lock.test.ts`: second acquire fails with a message naming the running PID; a stale lock (dead PID) is replaced; lock removed on release
- [X] T041 [US6] Implement `src/util/migrate.ts` (FR-024) and `src/util/lock.ts` (FR-005, research R8)
- [X] T042 [US6] Extend `src/voice/setup.ts` (ported in T011): run `migrate()` before downloads, check `whisper-server`, `ffmpeg` and the corgi command with capabilities, readiness report with install hints, exit 1 when something required is missing; add cases to `tests/voice/setup.test.ts`; in `src/main.ts` call `migrate()` before loading settings, wire `--setup [--model NAME]` and acquire the lock before opening the window

---

## Phase 9: User Story 7 - Tune the microphone and see what happened (P2)

**Goal**: All tuning controls behave as in the source.

**Independent Test**: the ported UI tests plus a manual pass over the keys.

- [X] T043 [US7] Confirm the ported `tests/ui/ui.test.ts` covers threshold keys and wheel (step 2), options menus (silence, pre-roll, post-roll, min speech, burst), filter toggle, device picker, gauge (`t`), help overlay, history scrolling and the 37x14 minimum with "too small" below it; add any case that was dropped with the old UI helpers
  - Implementation note: the threshold gauge and its animation do not exist on `005-voice-transcripts`; they were ported from Corgi's `001-voice-dictation` branch (`gauge.ts`, the session's `startGauge`/`cancelGauge`, the window's `t` key, tick, countdown, sniffing corgi, glide and gauge rows) with their tests. A gauge does not start during a recording (it has its own threshold). The post-roll option also exists only on `001-voice-dictation` (its segmenter differs from `005`'s), so it is not ported; the options lines are those of `005` (silence, burst, filter; pre-roll, min speech).

---

## Phase 10: Polish & Cross-Cutting

- [X] T044 [P] Write `README.md`: install (`bun install`, `bun link`), prerequisites (Bun, `whisper-server`, `ffmpeg`, `corgi` with `pane send --stdin` and viewer data), setup, usage, keys, settings including `corgi` and `theme`, file locations (contracts/cli.md), differences from `corgi voice` (no sidebar indicator, no Corgi mute shortcut, no `--ssh`, remote machines via Corgi), and a warning not to run `corgi-voice` alongside `corgi voice` (FR-030)
- [X] T045 [P] Add `tests/contract.test.ts`: no file under `src/` imports outside the repository, no file outside `src/corgi/` spawns the corgi command, the string `--enter` appears nowhere in `src/`, and `cc-deck` appears nowhere in `src/` (FR-002, FR-031, SC-004, SC-007)
- [X] T046 Run `bun run check` and `bun test`; fix failures; check that no em-dash or en-dash characters were added to `README.md`
- [X] T047 Walk through quickstart.md Scenarios 1 to 5 against the local Corgi where possible (use a `cat` pane, never a real agent prompt); with `--verbose`, record `deliver_ms` for 10 local and 10 remote deliveries (where a remote machine is reachable) against SC-002 (2 s) and SC-003 (+0.7 s); record the outcome in `specs/001-corgi-voice-extraction/quickstart.md` under a "Results" heading

---

## Dependencies & Execution Order

- Phase 1 then Phase 2 (blocks everything).
- US1 (Phase 3) is the MVP; it needs T013a (recorder, reading) and T011 (setup module) because session, ui and main import them and blocks US2, US3, US4 (they extend `poller.ts`, `link.ts`, `session.ts`).
- US5 depends on US1's `ui.ts` port (T026). US6 depends on T012 and T020. US7 depends on T026.
- Polish last.

## Parallel Opportunities

- Phase 2: T003 to T009 in parallel; T010, T013, T014 after T003 to T006; T011 after T007 and T010; T012 after T007; T013a after T012; `bun run check` is green only after T023 (US1).
- US1: T015, T016, T017 in parallel; T018, T019 in parallel.
- After US1: US5 (T034, T035) and US6 (T039, T040) can start in parallel with US2 to US4.

## Implementation Strategy

MVP is Phase 1 + 2 + US1: local dictation against an unmodified Corgi. Then US2 to US4 (remote, hold-off, mute), US5 (recording), US6 (setup and migration), US7 (tuning check), polish.
