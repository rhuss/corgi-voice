# Implementation Plan: corgi-voice Extraction

**Branch**: `001-corgi-voice-extraction` | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-corgi-voice-extraction/spec.md`

## Summary

Port Corgi's voice mode (branch `005-voice-transcripts`, `src/voice/`, about 4.3k lines of source plus 4.3k of tests) into this repository as the standalone Bun program `corgi-voice`. Keep the voice logic (capture, segmenter, level, wav, Whisper server, models, setup, settings, session, recorder, transcript, reading, tuning, turns, text) nearly unchanged. Replace the daemon link, SSH bridge and sidebar presence with a `corgi` CLI link that polls viewer data per machine and delivers with `pane send --stdin`. Replace the Corgi UI building blocks and native helpers with small local modules and an own row-diff screen layer. See [research.md](research.md) for the decisions.

## Technical Context

**Language/Version**: TypeScript (strict) on Bun 1.4+

**Primary Dependencies**: none at runtime; dev: `typescript`, `@types/bun`. External tools: `whisper-server`, `ffmpeg`, `corgi`

**Storage**: files only (settings JSON, model cache, transcript text files, lock file, verbose log)

**Testing**: `bun test`; a fake `corgi` executable driven by scenario files; ported source unit tests

**Target Platform**: macOS on Apple Silicon, Linux amd64, in a terminal emulator with SGR mouse support

**Project Type**: single-project CLI / terminal UI

**Performance Goals**: local delivery adds at most about 200 ms over source (SC-002); remote adds at most 0.7 s over local (SC-003); viewer data fresh within 2 s

**Constraints**: no native code; Corgi only via the commands in [contracts/corgi-cli.md](contracts/corgi-cli.md); never `--enter`; one `pane send` at a time, each bounded at 2 s

**Scale/Scope**: one user, a handful of machines, recordings of 500+ passages

## Constitution Check

The project constitution (`.specify/memory/constitution.md`) is still the unfilled template, so there are no ratified gates. The plan follows the spec's own quality rules instead: CLI as the only contract (FR-002), tests without hardware (FR-029), no native code (SC-007). No violations to justify.

Post-design re-check: unchanged, passes.

## Project Structure

### Documentation (this feature)

```text
specs/001-corgi-voice-extraction/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── corgi-cli.md
│   └── cli.md
└── tasks.md
```

### Source Code (repository root)

```text
package.json            # "bin": {"corgi-voice": "src/main.ts"}, scripts: test, check
tsconfig.json
bunfig.toml
README.md
src/
├── main.ts             # entry (shebang), flag parsing, --setup, --help, wiring (port of voice/main.ts)
├── util/               # pure helpers replacing Corgi utilities
│   ├── errors.ts  failure.ts  json.ts  log.ts
│   ├── subprocess.ts   # Bun.spawn run/spawn with bounds and kill
│   ├── text.ts         # displayWidth (Bun.stringWidth), ellipsis, Writer
│   ├── paths.ts        # XDG paths, old-location lookup, migration (FR-024)
│   └── lock.ts         # single instance (FR-005)
├── corgi/              # the only code that runs `corgi`
│   ├── command.ts      # resolve corgi command (FR-003), capability check (FR-004)
│   ├── viewers.ts      # parse list JSON, PaneInfo labels, resolve() target (pure)
│   ├── poller.ts       # machine list + per-machine poll loops (FR-007)
│   ├── errors.ts       # corgi error -> reason table (FR-013)
│   └── link.ts         # CorgiLink: viewer events, deliver queue, space rule, own-pane check
├── voice/              # ported logic, imports rewritten to ../util, ../ui
│   ├── capture.ts  segmenter.ts  level.ts  wav.ts  whisper.ts  models.ts
│   ├── setup.ts  settings.ts  session.ts  recorder.ts  transcript.ts
│   ├── reading.ts  tuning.ts  turns.ts  text.ts
└── ui/
    ├── screen.ts       # alt screen, mouse, row differ, restore (replaces frame_diff)
    ├── keys.ts         # port of terminal_keys
    ├── palette.ts      # token subset, light/dark variants, mix, fgRgb, keycap
    ├── theme.ts        # OSC 11 detection (FR-027)
    ├── scroll_thumb.ts
    ├── prompt.ts       # recording file prompt (FR-021)
    └── ui.ts           # port of voice/ui.ts on top of screen/prompt
tests/
├── fixtures/fake-corgi.ts  fake-corgi (shell shim)
├── corgi/  util/  ui/  voice/   # ported and new tests
```

**Structure Decision**: Single project. `src/voice/` keeps the source file names so diffs against Corgi's branch stay readable. Everything that talks to Corgi sits in `src/corgi/`, which makes the contract auditable in one directory.

## Key Design Points

1. **Link seam**. `session.ts` depends on a `VoiceLink` interface (`watch(): Promise<Seen>`, `set`, `type`, `on(viewer|closed)`, `close`; exact signatures in tasks T013). CorgiLink owns the 2 s delivery bound; the session keeps a 2.5 s safety net. `CorgiLink` implements it: `watch` starts the poller and returns the first `Seen`; `set` resolves locally (mute lives in the tool, no sync); `type` enqueues a delivery; `viewer` events fire when the resolved target or its label changes. Session code that only existed for runtime sync (owed state, resend, refusals like `VoiceTaken`/`OldRuntime`) is removed; `link_state` maps to poller health (`connected` when at least one machine is fresh).
2. **Seen gains detail**. `Seen` becomes `{viewer, focus, machine, reason}` so the header can show the machine and "Corgi unreachable: ..." (FR-008, FR-009).
3. **Delivery** (FR-010 to FR-014): own-pane check, `exited`/`dormant` pre-check, leading-space rule, spawn with stdin, 2 s bound, kill, error mapping, strictly serial queue.
4. **Recording prompt**. `ui.ts` uses `prompt.ts` instead of `nameDialog`/`folderDialog`; relative names resolve against the transcript folder, `..` escape refused (FR-021).
5. **Screen layer**. `ui.ts` keeps building row strings; `screen.ts` diffs and writes them. Minimum size 37x14 as in source.
6. **Dropped**: `bridge.ts`, `link.ts` (daemon), `presence.ts` and their tests; `--ssh`; animation preview tool.
7. **Migration** (FR-024) runs in `main.ts` before settings load and in setup before downloads.

## Phasing

1. Scaffold (package, tsconfig, util ports, test runner) with ported pure tests green.
2. Corgi CLI layer with fake-corgi tests (resolution, polling isolation, delivery, errors, never-Enter).
3. Port voice logic and adapt `session.ts` to `CorgiLink`; port tests.
4. Screen layer, palette/theme, prompt, `ui.ts` port with tests.
5. `main.ts`, setup, migration, lock, README, quickstart run.

## Complexity Tracking

No constitution violations. One deliberate duplication: palette tokens copied from Corgi (accepted look drift, spec Assumptions).
