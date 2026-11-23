# Implementation Plan: Sidebar Voice Icon

**Branch**: `004-sidebar-voice-icon` | **Date**: 2026-11-22 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-sidebar-voice-icon/spec.md`

## Summary

Add two modes to `corgi-voice`: `--trick`, a Corgi raw JSONL trick that watches the 003 control channel and keeps one sidebar title-row item (`♫` accent/faint, `●` hot/warm) in sync, toggling mute on a press; and `--install-trick`, which writes a manifest with absolute paths and the channel path into Corgi's tricks folder. The trick is a small state machine (pure function from voice state to item, plus press bookkeeping) around a stdin/stdout JSONL loop and the existing control client. Nothing changes in Corgi or in the channel protocol.

## Technical Context

**Language/Version**: TypeScript on Bun (as the rest of corgi-voice; `bun` runs `src/main.ts` directly)

**Primary Dependencies**: none new (no runtime npm dependencies, contract test); Bun's built-ins for stdin lines, Unix sockets (via `src/control/client.ts`), files

**Storage**: one file written by `--install-trick`: `<tricks dir>/corgi-voice/trick.toml`

**Testing**: `bun test`; the trick is driven through injected stdin/stdout streams against a real control server (`src/control/server.ts`) fed by a fake session, as in `tests/control/`

**Target Platform**: macOS (primary), Linux; Corgi with Tricks (tals/corgi#74) and title items (tals/corgi#198)

**Project Type**: single CLI project

**Performance Goals**: state change to `ui.set` under 1 s (in practice a few ms: watch push plus one write); reconnect within 2 s of corgi-voice becoming ready (spec allows 3 s)

**Constraints**: idle without polling while connected; one process, no children (Corgi budgets: 128 MiB, 8 processes, 10% of a core); reduced environment (HOME, PATH, LANG, LC_*, TZ, TERM, TMPDIR, `CORGI_*`); stdout carries only JSONL commands

**Scale/Scope**: one item, one connection; roughly 250 lines of source plus tests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template, so there are no ratified principles to check. The project's de facto rules are enforced by `tests/contract.test.ts` and earlier specs; this plan keeps them:

- CLI is the only contract with Corgi: the trick talks to Corgi only through its own stdin/stdout (the Tricks JSONL interface Corgi documents) and the install only writes a manifest file. No Corgi state, socket or protocol is read. PASS (contract test extended, see research R6).
- No native code, no npm runtime dependencies. PASS.
- The control channel stays state and mute only; the trick sends only `watch` and `toggle`. PASS.
- Control-style commands run before the terminal check and never take the lock. PASS.

Post-design re-check: unchanged, PASS.

## Project Structure

### Documentation (this feature)

```text
specs/004-sidebar-voice-icon/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── trick-jsonl.md   # What --trick reads and writes (Corgi Tricks wire)
│   └── cli.md           # --trick and --install-trick flags, exit codes, manifest
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
src/
├── main.ts              # flags: --trick, --install-trick; dispatch before terminal check
├── control/
│   └── client.ts        # watch(): optional AbortSignal to end a watch (stdin closed, tests)
└── trick/
    ├── item.ts          # pure: voice state -> title item (glyph, color, pressable) or none
    ├── trick.ts         # the --trick loop: ready, watch/reconnect, ui.set/ui.remove, presses
    └── install.ts       # --install-trick: tricks dir, manifest text, atomic write

tricks/voice/
├── trick.toml           # reference manifest (command uses PATH; install writes absolute paths)
└── README.md            # points to corgi-voice --install-trick

tests/
├── trick/
│   ├── item.test.ts     # every state -> item mapping (FR-003)
│   ├── trick.test.ts    # JSONL loop against a real control server + fake session
│   └── install.test.ts  # manifest content, idempotence, atomic write, failures
├── main.test.ts         # flag parsing and usage errors for the new flags
└── contract.test.ts     # extended: src/trick/ boundaries, README Corgi section
```

**Structure Decision**: a new `src/trick/` folder keeps the trick separate from `src/control/` (whose file list the contract test pins) and from `src/corgi/` (the only place that runs the `corgi` command; the trick never runs it). The trick reaches the channel only through `src/control/client.ts`.

## Key Design Points

1. **Item derivation is a pure function** (`item.ts`): `(state | null) -> {glyph, color, pressable} | null`, per FR-003 and the clarifications. Comparing the previous and next item decides whether a `ui.set` or `ui.remove` is needed (FR-004).
2. **Press bookkeeping**: a counter makes action IDs (`toggle-<n>`); `armed` holds the current action or null. A press matching `armed` disarms and sends `request(path, "toggle")`; while it is in flight, pressable watch states are only recorded, and when it ends the trick draws the answer's state (or the latest watch state on failure) with a new action, so the arrival order of the watch push and the answer never matters and a click yields one `ui.set` (FR-004, FR-005; data-model.md "Transitions"). Recording items have no `action` and no `slot`; the `♫` item uses the fixed slot `voice`.
3. **Connection loop**: `watch(path, onAnswer, {signal})`; on `not_running`, `no_answer` or `closed`, remove the item if drawn, log only on reachable/unreachable transitions, wait 2 s, retry (FR-006). The first-answer timeout is the client's existing 1 s.
4. **Channel path**: `ready.config.socket` when a non-empty string, else `paths.socketPath(process.env)`; if `socketPath` throws (`SocketFolderUnsafe`), log once and stay idle (FR-008).
5. **Shutdown**: stdin end aborts the watch and any retry timer and exits 0 (FR-007).
6. **Error replies** from Corgi (`{"id":null,"error":...}` or an `id`ed error) are logged once per error kind; commands are sent without `id` (Corgi omits success replies then), so stdin carries only `ready`, `ui.press` and error lines the trick cares about.
7. **Install**: resolve the tricks dir (`CORGI_TRICKS_DIR`, else `${XDG_CONFIG_HOME:-$HOME/.config}/corgi/tricks`), build the manifest with `command = [<bun>, <realpath of main.ts>, "--trick"]` and `[config] socket = <socketPath()>`, write `trick.toml.tmp-<pid>` then rename (FR-011, FR-012).

## Complexity Tracking

No violations to justify.
