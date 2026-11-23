# Research: Sidebar Voice Icon

Sources: `docs/tricks.md` on Corgi branch `011-tricks-title-item` (tals/corgi#198), `src/agent_env.ts` and `src/trick_host.ts` there (read-only), corgi-voice `src/control/`, `src/util/paths.ts`, `src/main.ts`, `tests/contract.test.ts`.

## R1: Wire shape of a title item

- **Decision**: `{"op":"ui.set","key":"voice","view":{"kind":"title","spans":[{"text":"♫"}],"color":"accent","action":"toggle-3","slot":"voice"}}`; recording items omit `action` and `slot`. Remove with `{"op":"ui.remove","key":"voice"}`.
- **Rationale**: matches the documented example and rules: one line of 1 to 4 cells, optional `color`, `action`, `slot` following the button rules (action IDs at most 80 ASCII characters, slots at most 120).
- **Alternatives**: color per span instead of the view's `color` (equivalent; the view color is simpler and is the documented default for uncolored spans).

## R2: Palette names

- **Decision**: listening `accent`, muted `faint`, recording `hot`, paused `warm`.
- **Rationale**: `docs/tricks.md` "Palette and branding" lists `bg`, `surface`, `selected`, `line`, `faint`, `muted`, `text`, `strong`, `accent`, `warm`, `hot`; `accent` is "work and focus" (close to #36's accent `♫`), `warm` attention, `hot` alerts. There is no `green`/`red`/`amber`.
- **Alternatives**: `muted` for the muted state (rejected: "muted gray" is also the default for an uncolored item and reads as "no color chosen"; `faint` matches #36's `voice_off`).

## R3: Messages the trick receives

- **Decision**: handle `{"event":"ready",...}` (read `config.socket`), `{"event":"ui.press","action":...}`, and error replies (`error` field); ignore everything else. Send commands without `id`.
- **Rationale**: raw programs default to no events until they subscribe, and presses are delivered "independent of metadata subscriptions"; commands without IDs get no success replies, errors arrive with `id: null`. So the trick never subscribes.
- **Alternatives**: send `id`s and wait for replies (rejected: extra bookkeeping for no gain; a failed `ui.set` changes nothing the trick could fix).

## R4: Environment and paths in the trick

- **Decision**: the install writes absolute paths (`process.execPath` for bun, the real path of `src/main.ts`) and `[config] socket` with `paths.socketPath()` computed at install time; `--trick` prefers `config.socket`, else computes `socketPath()` from its own environment.
- **Rationale**: Corgi's `agentEnv.trick()` passes only `HOME`, `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `TMPDIR` plus `CORGI_*`. Without `XDG_RUNTIME_DIR`/`XDG_STATE_HOME` the trick would compute the default path, which differs whenever the user sets those. The `#!/usr/bin/env bun` shebang would also fail if the daemon's PATH lacks `/opt/homebrew/bin` (handoff gotcha). The manifest's `[config]` table is delivered in `ready.config` for raw command manifests.
- **Alternatives**: pass the path on the command line (works, but `[config]` is the documented place and keeps `command` stable); rely on PATH (fragile, rejected).

## R5: Ending a watch

- **Decision**: add an optional `signal?: AbortSignal` to `watch()` (and the internal `converse`) in `src/control/client.ts`; abort ends the socket and resolves with `"closed"`.
- **Rationale**: the trick must stop watching when stdin closes (FR-007) and tests must end watches deterministically. Today a watch ends only when corgi-voice ends it. The change stays inside the pinned `src/control/` file set and adds no process or pane access.
- **Alternatives**: `process.exit()` on stdin end without closing (works for the real trick but leaves tests without a clean stop; rejected as the only mechanism, though the real trick still exits after cleanup).

## R6: Contract test boundaries

- **Decision**: extend `tests/contract.test.ts`: `src/trick/` never spawns processes, never runs `corgi`, never uses `Bun.connect` (only the control client), never mentions `pane send`; the install writes only below the tricks folder; README has a Corgi section naming `--install-trick`, the four states, `corgi tricks reload` and the rerun note.
- **Rationale**: FR-016 and the project's habit of pinning boundaries in tests.
- **Alternatives**: none considered.

## R7: Where the code goes

- **Decision**: `src/trick/item.ts`, `src/trick/trick.ts`, `src/trick/install.ts`; flags in `src/main.ts` (`trick`, `install_trick` fields, mutually exclusive with everything else, dispatched before the working-folder and terminal checks).
- **Rationale**: `src/control/` is pinned to three files; `src/corgi/` is about running the corgi CLI; a separate folder is clearest.

## R8: Glyph width

- **Decision**: `♫` (U+266B) and `●` (U+25CF), each one cell.
- **Rationale**: #36 used `♫` in the same spot; both are East Asian Width "Ambiguous" but render as one cell in Corgi's sidebar (Corgi measures them as one, which #36 relied on). Title items reject more than 4 cells, so even a two-cell rendering would pass.
