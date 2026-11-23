# Tasks: Sidebar Voice Icon

**Input**: Design documents from `specs/004-sidebar-voice-icon/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Requested by the spec (FR-015, SC-005): every acceptance scenario not needing a live Corgi gets an automated test. Tests reuse the patterns in `tests/control/server.test.ts` (`serve()` with a fake `SessionLike`, short socket paths from `socket()`, `until()`), copied or factored into a small helper as needed.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Create `tests/trick/helpers.ts` with the test helpers the trick tests share, adapted from `tests/control/server.test.ts`: a short socket path in a temp folder, `serve()` starting a real `src/control/server.ts` on it with a fake `SessionLike`/`RecorderLike` whose mute, availability and recording can be changed from the test, `until(check, ms)`, and a fake Corgi side (an async line queue for the trick's input plus an array collecting written lines, parsed as JSON)

## Phase 2: Foundational (blocks all stories)

- [X] T002 Add an optional `signal?: AbortSignal` to `watch()` and the internal `converse()` in `src/control/client.ts`: on abort, end the socket and resolve the watch with `"closed"`; an already aborted signal resolves immediately without connecting. Keep `request()` unchanged. Add tests in `tests/control/client.test.ts` (abort mid-watch resolves "closed" and the server sees the watcher leave; pre-aborted signal never connects) (research R5)
- [X] T003 Add `trick` and `install_trick` flags to `Flags`/`flags()` in `src/main.ts`: `--trick` and `--install-trick` each set their field; either one combined with any other flag (each other, control flags, `--json`, `--setup`, `--help`, `--verbose`, voice-window flags) throws `Usage` (exit 2). Extend the `usage` text per `contracts/cli.md`. Tests in `tests/main.test.ts` for accepted forms and every usage-error combination (FR-012, contracts/cli.md)

## Phase 3: User Story 1 - See the voice state in Corgi's sidebar (P1) MVP

**Goal**: `corgi-voice --trick` keeps one title item in sync with the voice state.

**Independent Test**: drive `runTrick` over in-memory stdin/stdout against a real control server with a fake session; change mute, recording and availability and check the JSON lines written.

- [X] T004 [P] [US1] Implement `item(state: State | null): Item | null` and `sameItem(a, b)` in `src/trick/item.ts`, exactly per data-model.md "Derivation": no state → null; `recording` = `running` → `{glyph:"●", color:"hot", pressable:false}`; `paused` → `{glyph:"●", color:"warm", pressable:false}`; `unavailable` ≠ null → null; `mode` = `listening` → `{glyph:"♫", color:"accent", pressable:true}`; else `{glyph:"♫", color:"faint", pressable:true}`. Ignore `target`, `reason`, `pid`, `muted`, `updated_at` (FR-003, clarification Q1)
- [X] T005 [P] [US1] Tests for `item()` in `tests/trick/item.test.ts`: every row of the derivation, recording winning over `unavailable`, target/reason changes not changing the item
- [X] T006 [US1] Implement `runTrick(io: {input: AsyncIterable<string> (lines), write(line: string): void, log(line: string): void, env: Env, retryMs?: number}): Promise<number>` in `src/trick/trick.ts`: wait for the `ready` event (draw nothing before it); channel path = `ready.config.socket` if a non-empty string else `paths.socketPath(env)` (if that throws, log once `corgi-voice trick: <reason>` and stay idle until input ends); loop `watch(path, onAnswer, {signal})` from `src/control/client.ts`; on each answer compute `item(state)` and write per `contracts/trick-jsonl.md` only when it differs from `shown` (key `"voice"`, `kind:"title"`, `spans:[{text}]`, `color`; commands without `id`); when a watch ends (`closed`/`not_running`/`no_answer`): write `ui.remove` only if an item is shown, then wait `retryMs` (default 2000) and retry; log `corgi-voice trick: corgi-voice not reachable` / `... reachable again` only on transitions; on input end abort the watch and pending timer and resolve 0 (FR-001, FR-002, FR-004, FR-006, FR-007, FR-008, FR-010)
- [X] T007 [US1] In `src/trick/trick.ts`, handle Corgi error lines (`{"error": "<Kind>", "id": ...}`): log `corgi-voice trick: Corgi refused the item: <Kind>` once per kind per process; ignore non-JSON and unknown lines (Edge Cases, research R3)
- [X] T008 [US1] Wire `--trick` in `src/main.ts`: dispatch right after `--help`, before the working-folder and terminal checks; feed stdin lines (Bun stdin text stream split on `\n`), write commands to stdout, logs to stderr; return the exit code (FR-009, contracts/cli.md)
- [X] T009 [US1] Tests in `tests/trick/trick.test.ts` for US1 acceptance scenarios 1 to 6 and edge cases: listening item on start; mute change → faint within 1 s; recording running → hot `●`, paused → warm `●`, end → back to `♫`; server stopped → `ui.remove` within 1 s and one log line; server started later → item within 3 s (use a small `retryMs`); unavailable → no item and no `ui.set`; nothing drawn before `ready`; `config.socket` honored; error replies logged once per kind; input end resolves 0 within 1 s; with no server for a while (scaled-down period) at most one log line and no `ui.set`/`ui.remove` (SC-001, SC-003). Also: a socket stub (`Bun.listen` in the test) that answers garbage, and one that never answers within 1 s → `ui.remove` (if drawn) and reconnect (FR-006); garbage and non-JSON input lines ignored; `config.socket` missing, empty or not a string → `socketPath(env)` used; `socketPath()` throwing (env with an overlong `XDG_STATE_HOME` and an unsafe `TMPDIR`, or an injected path function) → one log line, idle, exit 0 on input end; a `target`/`reason`-only change writes nothing (FR-004); connected and idle for about 1 s → no output lines and no new connections to the server (FR-010). Factor `socketPath` as an injectable `io.socketPath?` defaulting to `paths.socketPath` if that keeps the test simple.

**Checkpoint**: US1 works on its own (icon visible, not yet clickable is acceptable only if T010 is pending; ship both P1 stories together).

## Phase 4: User Story 2 - Toggle mute by clicking the icon (P1)

**Goal**: a press on `♫` sends one `toggle`; recording items are not pressable.

**Independent Test**: send `ui.press` lines to `runTrick` connected to a real server with a fake session and check the session's mute calls and the redraws.

- [X] T010 [US2] Add press handling to `src/trick/trick.ts` per data-model.md "Transitions": pressable items carry `action: "toggle-<seq>"` (fresh per drawing, ≤ 80 ASCII characters) and `slot: "voice"`; recording items carry neither; `armed` holds the current action; a `ui.press` whose `action` equals `armed` disarms, sets `inflight` and sends `request(path, "toggle")`. Follow data-model.md "Transitions" exactly, so the order of the watch push and the toggle answer (two sockets, same tick in `server.ts`) does not matter: every watch answer updates `latest` (reset when the watch ends); while in flight, pressable states from the watch are not drawn (non-pressable or no item is drawn at once); when the request ends, draw nothing if the watch is not connected, else draw the newer of `answer.state` and `latest` by `updated_at` (tie → `latest`; no answer → `latest`) with a fresh action if pressable, so a click yields exactly one `ui.set`. Presses with other actions, a second press on the same action, presses in flight, while unreachable or before `ready` are ignored (FR-004, FR-005)
- [X] T011 [US2] Tests in `tests/trick/trick.test.ts` for US2 scenarios 1 to 5: press mutes (session muted via the same path as `m`) with exactly one `ui.set` after the press, press unmutes, refused unmute (the fake session becomes unable to listen just before the press is handled): mute unchanged, no history row, exactly one `ui.remove`, trick still running, then making it available again yields one armed `♫` `ui.set`; server quits during a toggle → the item stays removed; a recording starts during a toggle → `●` stays drawn after the toggle ends; stale action ignored, double press sends one toggle, press while unreachable ignored, recording item has no `action`/`slot` and a press for an old action during recording does nothing; two trick instances on one server each keep their own item and one press toggles once (clarification Q3) (SC-002)

**Checkpoint**: both P1 stories done: the icon shows state and toggles mute.

## Phase 5: User Story 3 - Install the trick (P2)

**Goal**: `corgi-voice --install-trick` writes a working manifest.

**Independent Test**: run the install with a temporary `CORGI_TRICKS_DIR`/`XDG_CONFIG_HOME` and check the file.

- [X] T012 [P] [US3] Implement `tricksDir(env)`, `manifest({bun, main, socket}): string` and `install(env, opts: {bun?: string; main?: string} = {}): {path}` in `src/trick/install.ts` (defaults: `bun = process.execPath`, `main = realpathSync(fileURLToPath(new URL("../main.ts", import.meta.url)))`; `socketPath` errors propagate as the failure reason): dir = `$CORGI_TRICKS_DIR` else `${XDG_CONFIG_HOME:-$HOME/.config}/corgi/tricks`; manifest exactly as data-model.md "Manifest" (`version = 1`, `id = "corgi-voice"`, description, `command = [<process.execPath>, <realpath of src/main.ts>, "--trick"]`, `[config] socket = <paths.socketPath(env)>`), strings as JSON-escaped TOML basic strings; create `corgi-voice/` with `mkdirSync(recursive)`, write `trick.toml.tmp-<pid>` then `renameSync` to `trick.toml`; touch nothing else (FR-011, FR-012)
- [X] T013 [US3] Wire `--install-trick` in `src/main.ts` before the terminal check: on success print `Installed the corgi-voice trick: <path>` and `Next: corgi tricks reload, then corgi tricks list`, exit 0; on failure print `corgi-voice: cannot install the trick: <reason>` to stderr, exit 1 (contracts/cli.md). Tests in `tests/main.test.ts`: `main(["--install-trick"], {terminal: false})` with a temporary `CORGI_TRICKS_DIR` set on `process.env` and restored afterwards (output lines, exit 0, file present) and with an unwritable folder (stderr message, exit 1); `--trick` dispatch tested as a subprocess `bun src/main.ts --trick` with empty stdin and no terminal: exits 0, no terminal error, nothing on stdout (FR-009, FR-012)
- [X] T014 [US3] Tests in `tests/trick/install.test.ts`: content (id, command with absolute paths ending in `--trick`, `[config] socket` equal to `socketPath(env)`), `CORGI_TRICKS_DIR` vs `XDG_CONFIG_HOME` vs `HOME` resolution, rerun replaces only `corgi-voice/trick.toml` (a sibling trick folder is untouched, no temp file left), unwritable folder → error, `socketPath()` refusal → error, and paths with a space and a double quote round-tripping through `Bun.TOML.parse` (US3 scenarios 1 and 2)
- [X] T015 [P] [US3] Add `tricks/voice/trick.toml` (reference manifest with `command = ["corgi-voice", "--trick"]` and a comment to prefer `--install-trick`) and `tricks/voice/README.md` (what it shows, install with `corgi-voice --install-trick`, requires tals/corgi#74 and tals/corgi#198) (FR-013)

## Phase 6: Polish & Cross-Cutting

- [X] T016 Add a README section `## Voice icon in Corgi` in `README.md`: the four states (listening `♫` accent, muted `♫` faint, recording `●` hot, paused `●` warm, nothing while voice cannot listen or corgi-voice is not running), click toggles mute and recording dots are not pressable, `corgi-voice --install-trick`, `corgi tricks reload`, `corgi tricks list`, uninstall (remove the folder, reload), rerun the install after changing `XDG_RUNTIME_DIR`, `XDG_STATE_HOME` or `TMPDIR`, the dependency on Corgi with tals/corgi#74 and tals/corgi#198, and that the installed manifest is machine-specific (absolute paths), so it should not be synced to remote machines (FR-014, US3 scenario 3)
- [X] T017 Extend `tests/contract.test.ts` (FR-016, research R6): `src/trick/` has no `spawn`/`exec`/`node:child_process`, no `../corgi/` or `../util/subprocess` imports, no `Bun.connect`, no `pane send`/`"send"`; among files under `src/trick/`, only `install.ts` uses `writeFileSync`, `renameSync` or `mkdirSync`; the README `## Voice icon in Corgi` section mentions `corgi-voice --install-trick`, `corgi tricks reload`, `accent`, `faint`, `hot`, `warm`
- [X] T018 Run `bun run check` and the full `bun test`; fix failures (rerun single flaky timing files under load before treating them as regressions)
- [X] T019 Validate `quickstart.md` "Manual, without Corgi" by running `corgi-voice --trick` against a running corgi-voice if one is available in the environment; otherwise record that it is left to the runbook

## Dependencies & Execution Order

- Phase 1 → Phase 2 → stories. T001 blocks T009, T011; T002 blocks T006; T003 blocks T008 and T013.
- US1 (T004 to T009) before US2 (T010, T011): press handling extends the trick loop.
- US3 (T012 to T015) depends only on Phase 2 and can run in parallel with US1/US2 (different files), except T013 edits `src/main.ts` like T008 (do them sequentially).
- Polish after all stories.

## Parallel Opportunities

- T004 and T005 (item.ts and its test) in parallel with T012 and T015 (install.ts, tricks/voice/).
- T014 after T012; T011 after T010.

## Implementation Strategy

MVP = US1 + US2 (both P1): the icon shows state and toggles mute. Then US3 makes it installable with one command, then the README and contract test.
