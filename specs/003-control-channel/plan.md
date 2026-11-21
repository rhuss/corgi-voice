# Implementation Plan: Control Channel and Hotkey Mute

**Branch**: `003-control-channel` | **Date**: 2026-11-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/003-control-channel/spec.md`

## Summary

A Unix socket server inside the running corgi-voice (one JSON request per connection, `watch` streams), a pure state module shared by the window and the channel, a small client for the new `--mute`, `--unmute`, `--toggle-mute`, `--status` and `--watch` commands (handled before the terminal check, no settings read), a change hook on the recorder, a history row for mute changes from outside, a hand-run benchmark and a README hotkey section. Decisions in [research.md](research.md); wire format in [contracts/control-protocol.md](contracts/control-protocol.md).

## Technical Context

**Language/Version**: TypeScript (strict) on Bun 1.4+

**Primary Dependencies**: none at runtime (Bun's `Bun.listen` / `Bun.connect` with `unix`)

**Storage**: one socket file (FR-001)

**Testing**: `bun test` with a real Unix socket in a temporary folder and a stub session; command tests call `main()` with control flags and `terminal: false` against a test server; the benchmark spawns `src/main.ts`

**Target Platform**: macOS on Apple Silicon, Linux amd64

**Project Type**: single-project CLI / terminal UI

**Performance Goals**: `--toggle-mute` under 200 ms spawn to exit (p95 of 20, hand-run benchmark); `bun src/main.ts --help` takes 30 to 50 ms today with all static imports, so no import restructuring is needed

**Constraints**: no native code; the channel never types text (FR-006); slow clients never block the window

**Scale/Scope**: a handful of clients at most

## Constitution Check

Constitution is the unfilled template; no gates. Spec 001 rules hold (only `src/corgi/` spawns `corgi`, no `--enter`, no native code). Post-design: passes.

## Project Structure

```text
specs/003-control-channel/
├── spec.md  plan.md  research.md  data-model.md  quickstart.md
├── contracts/control-protocol.md
└── tasks.md

src/control/state.ts     # NEW pure: VoiceState from session + recorder, shortLine(), cannot-listen words, equal()
src/control/server.ts    # NEW: Bun.listen unix server, request parsing, watch, backpressure, idle close
src/control/client.ts    # NEW: request(op) and watch() over Bun.connect, 1 s timeout, exit codes
src/util/paths.ts        # socketPath(env) with the $TMPDIR fallback for long paths
src/voice/recorder.ts    # on("change") after start, pause, resume, stop, close
src/voice/session.ts     # events: rows "muted from outside" / "unmuted from outside" via note()
src/ui/ui.ts             # target() moved to src/control/state.ts and imported; history merges session events
src/main.ts              # control flags before setup/terminal check; start the server in `voice()` right after the session (held.control)
scripts/bench-toggle.ts  # NEW: hand-run benchmark (FR-009), package.json "bench:toggle"
README.md                # commands, state line and JSON, exit codes, hotkey recipes
tests/control/*.test.ts  tests/main.test.ts  tests/voice/recorder.test.ts  tests/ui/ui.test.ts
```

**Structure Decision**: a new `src/control/` keeps the channel and the commands separate from the window; the T018 benchmark checks the start-up cost of the commands.

## Key Design Points

1. **State** (FR-004): `stateOf({session, recorder, pid, now, previous})` builds `{pid, muted, mode, unavailable, reason, recording, target, updated_at}`; `mode` is `muted` when `session.muted` or `!session.available`; `recording` maps `running`/`paused` and reports `none` otherwise (stopping included); `target.label` is the window's Target text (the `target()` helper moves here, ui.ts imports it); `updated_at` keeps the previous value unless another field changed (`equal()` ignores it).
2. **Changes**: the server subscribes to `session.on("change")` and a new `recorder.on("change")`; on each event it computes the state and pushes it to watchers only when `equal()` is false. The window's own 20 Hz repaint is untouched.
3. **Mute from outside** (FR-003): `mute`/`unmute` call `session.setMuted(x)` (the `m` path), `toggle` decides from the shown `mode`; refused when unmuting while `!available` (`cannot_listen`); a row is added via `session.note("muted from outside")` only when `session.muted` actually changed. ui.ts merges `session.events` into the history like recorder notices.
4. **Server** (FR-001, FR-002, FR-005): path from `paths.socketPath()`; started in `voice()` right after the session exists (the lock is held by then), `unlink` a stale file first, `chmod 0600`; an outgoing queue per connection flushed on `drain` (Bun's `write` keeps nothing); per connection: buffer up to 4 KiB until `\n` (else `too_long`), 2 s idle close before the request, parse (`bad_json`, `unknown_op`), answer `{ok, state, err?}` and `end()`, except `watch` which answers the current state and stays; a watcher whose unsent bytes exceed 64 KiB is closed. `close()` stops listening, ends watchers, unlinks the socket; registered in `held` so every exit path runs it.
5. **Commands** (FR-007 to FR-010): `main()` checks the control flags right after parsing (before setup and the terminal check), validates combinations (exit 2), calls `client.request`/`watch` with a 1 s timeout (connect and answer), prints the short line or `--json` state on stdout, the refusal reason on stderr, and returns 0/1/3. The benchmark (point 6) guards the 200 ms budget; no lazy import is needed.
6. **Benchmark** (FR-009): `scripts/bench-toggle.ts` starts a stub server, spawns `bun src/main.ts --toggle-mute` 20 times, prints p50/p95; not part of `bun test`.

## Complexity Tracking

None.
