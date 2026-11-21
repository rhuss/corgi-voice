# Tasks: Control Channel and Hotkey Mute

**Input**: `specs/003-control-channel/` (spec.md, plan.md, research.md, data-model.md, contracts/control-protocol.md, quickstart.md)

**Tests**: Required (FR-012). Write each story's tests first and see them fail.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Confirm the baseline: `bun install --frozen-lockfile`, `bun run check` and `bun test` pass on the branch; note the test count

---

## Phase 2: Foundational

- [X] T002 [P] First update `tests/contract.test.ts` "nothing reads Corgi's state, sockets or protocol": it forbids `control.sock` and `Bun.connect({ unix` in all of `src/`; exempt `src/control/` and `socketPath()` in `src/util/paths.ts`, keep forbidding Corgi's own socket and state folder, and add an assertion that `socketPath()` always returns a path under corgi-voice's own folders (`corgi-voice.sock`, `corgi-voice/control.sock`, `corgi-voice-<uid>/control.sock`). Then `socketPath(env)` in `src/util/paths.ts`: `$XDG_RUNTIME_DIR/corgi-voice.sock` when set, else `control.sock` in `stateDir(env)`; when the result is longer than 103 bytes, `$TMPDIR/corgi-voice-<uid>/control.sock` (create the folder 0700 when missing; refuse it when not owned by the user or group/world writable). Tests in `tests/util/paths.test.ts` with env overrides and a long `XDG_STATE_HOME` (check the computed fallback path; Bun may bind long paths without error, so never rely on a failing bind)
- [X] T003 [P] `src/control/state.ts` (pure): `VoiceState` per data-model.md; `stateOf({session, recorder, pid, now, previous})` with `mode` = `muted` when `session.muted` or `!session.available`, `recording` `running`/`paused` else `none` (stopping counts as none), `target` `{machine, label}` with `label` from `target()` moved here from `src/ui/ui.ts` (ui.ts imports it; behavior unchanged), `target` null exactly when there is no viewer, and `reason` then = the same text the window's `target()` shows (its fallback to `Corgi unreachable` or `no viewer attached` when `session.reason` is null), else null; `updated_at` kept from `previous` unless another field changed; `equal(a, b)` ignoring `updated_at`; `shortLine(state)` per FR-007 (cannot-listen words table, reason head = text before the first `:`, `· REC` / `· REC paused`). Tests in `tests/control/state.test.ts`: every short-line form of US2 scenarios 1, 4, 5 and the cannot-listen form, remote target label `marovo → <label>`, stopping recording as `none`, `updated_at` stable when nothing else changed, and SC-002 parity: `state.mode === "muted"` exactly when `ui.mode(session).muted` across muted, cannot-listen and listening sessions
- [X] T004 [P] `recorder.on("change", fn)` in `src/voice/recorder.ts`, fired after start, pause, resume, stop and close (also a close after a write failure); tests in `tests/voice/recorder.test.ts`
- [X] T005 [P] Session events in `src/voice/session.ts`: `events: {at, text}[]` (bounded like notices, 200), `note(text)` that adds one and emits `change`; ui.ts merges `session.events` into the history rows in time order with an info glyph, like recorder notices. Tests in `tests/voice/session.test.ts` and `tests/ui/ui.test.ts` (a row `muted from outside` appears)

---

## Phase 3: User Story 1 - Toggle mute with a global hotkey (P1)

**Goal**: the channel and the mute commands (FR-001 to FR-004, FR-006, FR-008, FR-010).

**Independent Test**: `bun test tests/control tests/main.test.ts`.

- [X] T006 [US1] Interfaces (used by T010, T012, T016, T018): `type SessionLike` (the session fields and methods the channel uses: `muted`, `available`, `unavailable`, `viewer`, `focus`, `machine`, `reason`, `link_state`, `setMuted`, `note`, `on("change")`) and `RecorderLike` (`current?.state`, `on("change")`); `startServer({path, session, recorder, pid, idleMs?, maxUnsent?}): Promise<{close(): void}>` in `src/control/server.ts`; `request(path, op, {timeoutMs?}): Promise<{ok:true, answer} | {ok:false, why:"not_running"|"no_answer"}>` and `watch(path, onAnswer, {timeoutMs?}): Promise<"closed" | "not_running" | "no_answer">` (`closed`: the server ended the watch, exit 0; the others exit 3) in `src/control/client.ts`. Tests in `tests/control/server.test.ts` using a real Unix socket in a temp folder and a stub session (`muted`, `available`, `setMuted`, `note`, `on("change")`, viewer fields) and stub recorder: socket mode 0600; stale socket file removed at start; `status` answers `{ok:true,state}` and closes; `mute`/`unmute` change `session.muted` through `setMuted` and add one event row only when it changed (no-op adds none); `toggle` follows the shown mode; unmute while `!available` answers `{ok:false, err:"cannot_listen"}` with no change and no row (US1 scenario 3); bad JSON, unknown op, a line over 4 KiB answer the matching `err` and close; a silent client is closed after 2 s (use an injectable idle time); `close()` unlinks the socket; the channel has no op that types text or controls recordings (FR-006); two concurrent `toggle` requests get answers in arrival order with one history row each; US1 scenario 5 with a real `VoiceSession`, a real `Recorder` and the exported `muteWhileRecording`: unmuting from outside during a recording, then stopping it, restores the mute state from before the recording, both when listening and when muted before it
- [X] T007 [US1] Implement `src/control/server.ts` per plan point 4: `Bun.listen({unix})` refuses an existing file, so unlink first; chmod the socket 0600 (it is created 0755 under umask 022); per-connection input buffer; an outgoing queue per connection, because Bun 1.4's `socket.write` returns the bytes accepted and keeps nothing (flush in the `drain` handler, count queued bytes against the 64 KiB limit, `end()` a one-shot answer only after its queue is empty); `close()` ignores ENOENT (`server.stop()` may already remove the file); injectable idle and backlog limits for tests
- [X] T008 [US1] Tests in `tests/control/client.test.ts`: `request(path, op, {timeoutMs})` returns the answer; a missing socket or a socket nobody listens on gives `not_running`; a server that accepts and never answers gives `no_answer` within the timeout (use 100 ms in tests)
- [X] T009 [US1] Implement `src/control/client.ts` (`request`, `watch`) on `Bun.connect({unix})` with a 1 s default timeout covering connect and the first answer only (a watch then runs as long as corgi-voice does); ECONNREFUSED and ENOENT map to `not_running`
- [X] T010 [US1] Tests in `tests/main.test.ts` that call `main()` with control flags and no terminal (`terminal: false`) against a test server on a temp `XDG_RUNTIME_DIR`: `--toggle-mute` prints `muted · <label>` and returns 0 (US1 scenario 1), again prints the listening line (scenario 2); refused unmute prints exactly `corgi-voice: cannot unmute: microphone missing` on stderr (words per the FR-007 table) and returns 1 (scenario 3); no server prints `corgi-voice is not running` and returns 3 (scenario 4); a silent server prints `corgi-voice did not answer` and returns 3 (scenario 6); usage errors return 2 (two control flags, control plus voice-window flags such as `--model`, `--json` with `--mute`); no `voice.json` is read and no migration runs (point `XDG_STATE_HOME` at a folder with an old-location `voice.json` and assert nothing was copied), and no lock file exists after a control command (FR-010)
- [X] T011 [US1] Wire the commands in `src/main.ts`: parse the control flags in `flags()`, handle them right after parsing (before `--setup` and the terminal check); usage text lists them
- [X] T012 [US1] Start the server inside `voice()` in `src/main.ts` right after `new VoiceSession` (the session and recorder exist only there; the lock is already held), pass `session`, `recorder`, `process.pid`; add `control?: () => void` to `Held`, call it in `ending().cleanup` after the terminal step and before the lock, and in the exit path with a synchronous unlink; update the order assertions in `tests/main.test.ts` (around lines 392 to 459); tests: with the `loading()` harness of `tests/fixtures/run-main.ts`, the socket exists while whisper loads and is gone after SIGTERM and after a crash; the normal quit path through an `ending()` unit test

---

## Phase 4: User Story 2 - Read the state from scripts and status bars (P2)

**Goal**: `--status [--json]` and `--watch [--json]` (FR-005, FR-007).

**Independent Test**: `bun test tests/control tests/main.test.ts`.

- [X] T013 [US2] Tests in `tests/control/server.test.ts`: `watch` answers the current state first, then one line per change of mute, availability, recording, target or reason, in order, no duplicates across a scripted sequence of 10 changes (SC-003); a change of `updated_at` alone sends nothing; a watcher that stops reading is dropped after 64 KiB unsent (injectable limit) without blocking other requests; watchers end when the server closes
- [X] T014 [US2] Implement watch in `src/control/server.ts`: subscribe to `session.on("change")` and `recorder.on("change")`, compute `stateOf`, send when `!equal`
- [X] T015 [US2] Tests in `tests/main.test.ts` (and a client test that a watch running longer than 1 s keeps going): `--status` prints the short line (US2 scenario 1), `--status --json` prints the `state` object only (scenario 2), `--watch` prints a line per change and returns 0 when the server closes (scenario 3); `--watch --json` prints state objects
- [X] T016 [US2] Implement `--status` and `--watch` printing in `src/main.ts` / `src/control/client.ts`

---

## Phase 5: User Story 3 - Set up the hotkey from the README (P2)

- [X] T017 [US3] README section "Mute from anywhere": the commands, the short line and the JSON fields, exit codes, and one recipe each for macOS Shortcuts (Run Shell Script), skhd and Hammerspoon using the absolute path from `command -v corgi-voice`; mention `--watch` for status bars (FR-011)

---

## Phase 6: Polish

- [X] T018 [P] `scripts/bench-toggle.ts` and `package.json` script `bench:toggle`: start a stub server on a temp socket, spawn `bun src/main.ts --toggle-mute` 20 times, print p50 and p95 and whether p95 is under 200 ms (FR-009); run it once and record the numbers in quickstart.md under "Results"
- [X] T019 Extend `tests/contract.test.ts`: `src/control/` never spawns `corgi` and contains no `pane send`
- [X] T020 Run `bun run check` and the full `bun test` twice; fix anything; no em-dash or en-dash characters added

## Dependencies

- T001 first; T002 to T005 in parallel; US1 (T006 to T012) needs T002, T003, T005; US2 (T013 to T016) needs US1's server and T004; US3 and polish last.

## Parallel Opportunities

- T002, T003, T004, T005 together; T006 and T008 together.
