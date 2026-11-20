# Research: corgi-voice Extraction

All facts below were checked on 2026-11-19/20 against the local Corgi installation (`corgi` on `PATH`, release with remote machines) and the source branch `005-voice-transcripts` at `~/Development/context-engineering/corgi/.claude/worktrees/005-voice-transcripts` (commit `6d499962`).

## R1. Shape of `corgi list --json`

- **Decision**: Read `viewers` from the top level of the reply, next to `ok` and `result`. Each viewer is `{id, pid, active, workspace, pane, watched}`; `pane` is `null` while the viewer does not show this machine. Pane details come from `result.panes[]` (`id, name, agent, command, cwd, dormant, exited, ...`); there is no `title` field.
- **Rationale**: Observed output: `{"ok":true,"result":{...},"viewers":[{"id":4,"pid":0,"active":10720,"workspace":20,"pane":207,"watched":false}]}`. A local call takes about 150 ms.
- **Pane label**: `name` when non-empty, else `agent` or `command` plus the last path segment of `cwd` (for example `claude · cc-rosa-rhoai`), else `pane <id>`. This satisfies FR-008 ("title when reported, else id").
- **Alternatives**: `corgi list` text output (not stable, rejected).

## R2. Per-machine polling instead of `list --all-machines`

- **Decision**: Get machine names from `corgi machine list` (JSON object `{"machines":[{"name":"local"},{"name":"marovo",...}]}`, preceded by an "experimental" notice line on stderr or stdout that must be skipped by parsing from the first `{`). Poll each machine with its own loop: `corgi list --json` for `local`, `corgi --machine NAME list --json` for others, every 1 s, each call bounded at 1.5 s and killed on timeout. Refresh the machine list on start and every 30 s.
- **Rationale**: `list --all-machines --json` waits for every machine and returns `{"machine":"marovo","ok":false,"err":"RequestTimedOut"}` after a timeout, so one slow machine would stall the local target (FR-007). Separate loops keep the local machine fresh.
- **Fallback**: When `machine list` fails or is unsupported, poll `local` only, and use `list --all-machines --json` (entries read individually; `ok:false` marks only that machine) as a fallback for remote machines, every 1 s with a 1.5 s bound. (Changed at implementation checkpoint 2 from "every 5 s, 3 s bound": with the 2 s freshness rule of FR-007, a 5 s interval left remote targets usable for only 2 s out of every 5, and FR-007 bounds every viewer fetch below 2 s. A slow machine still makes the whole call time out, so the fallback gives no remote data while one machine is slow.)
- **Alternatives**: Only `--all-machines` (stalls); speaking Corgi's protocol (violates FR-002).

## R3. `pane send` behavior and errors

- **Decision**: Run `corgi [--machine X] pane send ID --stdin`, write the text with no trailing newline, close stdin, wait for exit, bound at 2 s (FR-012), kill on timeout.
- **Observed errors**: `corgi: NoPane` (exit 2) for a missing pane; `corgi: UnknownMachine` (exit 1); remote timeouts report `RequestTimedOut`. Map: `NoPane` and similar (`PaneExited`, `NoSuchPane`) to "pane gone"; `UnknownMachine`, `RequestTimedOut`, `ConnectionRefused`, SSH failures to "<machine> unreachable"; anything else to the first line with the `corgi: ` prefix removed. The table lives in `src/corgi/errors.ts` (FR-013).
- **Pre-check**: When the polled pane entry says `exited` or `dormant`, delivery fails with "pane gone" (exited) or "pane hibernated" (dormant) without calling `pane send`.
- **Capability check**: `corgi pane send --help` output contains `--stdin` (observed: `corgi pane send ID|current TEXT|--stdin [--enter]`).

## R4. Own pane detection

- **Decision**: `CORGI_PANE` in the environment names the pane `corgi-voice` runs in (observed `CORGI_PANE=817`). It always refers to the local machine, so FR-014 compares `(machine=local, pane=CORGI_PANE)`.

## R5. Runtime and libraries

- **Decision**: Bun 1.4 (installed 1.4.4), TypeScript, no npm runtime dependencies. Dev dependencies: `@types/bun`, `typescript` for `tsc --noEmit`.
- **Rationale**: The source is TypeScript on Bun; Bun gives `Bun.spawn`, `Bun.file`, `Bun.stringWidth` and `bun test`. No native code (SC-007).
- **Replacements for Corgi modules**:
  | Corgi module | Used for | Replacement |
  |---|---|---|
  | `errors`, `failure`, `json` | error names, change-only logging, safe JSON | copied (pure, 72 lines) into `src/util/` |
  | `log` | `getLogger`, `configure` | small file logger in `src/util/log.ts` (no `clock` dependency) |
  | `subprocess` (native bridge) | `run`, `spawnError` | `Bun.spawn` wrapper in `src/util/subprocess.ts` |
  | `discovery.onPath` | find executables | `Bun.which` |
  | `os.socketPath` | bridge only | dropped with the bridge |
  | `build_config.releaseVersion` | version string | `package.json` version |
  | `text` (native widths) | `displayWidth`, `ellipsis`, `Writer` | `Bun.stringWidth`-based port in `src/util/text.ts` |
  | `palette`, `terminal_palette` | color tokens, mix, fgRgb, keycap | copied token subset in `src/ui/palette.ts`, OSC 11 detection in `src/ui/theme.ts` |
  | `terminal_keys` | key parsing | copied (pure, 105 lines) into `src/ui/keys.ts` |
  | `scroll_thumb` | scrollbar | copied (9 lines) |
  | `frame_diff` (Zig FFI) | minimal redraw | row-based differ in `src/ui/screen.ts` |
  | `name_dialog`, `new_workspace` | file name prompt and folder browser | own `src/ui/prompt.ts` (single field, FR-021) |
  | `pane/terminal.closeReadiness` | terminal reset on exit | own restore sequence in `src/ui/screen.ts` |
  | `protocol`, `rpc`, `websocket_socket`, `link.ts`, `bridge.ts`, `presence.ts` | daemon link, SSH bridge, sidebar presence | `src/corgi/` CLI link; bridge and presence dropped |

## R6. Screen redraw without `frame_diff`

- **Decision**: Render each frame to an array of row strings (with SGR codes). Compare with the previous array; for changed rows emit `CSI row;1H` + row + `CSI K`. Full redraw on resize. Synchronized output (`CSI ? 2026 h/l`) around a frame. Alternate screen, hidden cursor, SGR mouse mode (1000 + 1006) on enter; restored on exit and on signals.
- **Rationale**: The window is about 40 rows; row diffing is enough and keeps the code plain TypeScript.

## R7. Theme detection

- **Decision**: Send `OSC 11 ; ? BEL` at startup, wait up to 200 ms for `OSC 11 ; rgb:RRRR/GGGG/BBBB`, classify by relative luminance (< 0.5 dark). No answer: dark. `theme` setting overrides. Colors: Corgi has no light/dark variants (themes `corgi` and `animal_style`), so the dark variant uses the `corgi` theme values including its own backgrounds (`bg` `[24, 27, 32]`, `selected` `[51, 57, 65]`, `line`), and the light variant defines light backgrounds and darkens the foreground hues until every pair passes; the UI paints the variant's `bg`, and a unit test checks every foreground-on-background pair the UI uses at 3:1 in both variants (FR-027). The key parser discards OSC sequences so a late OSC 11 reply is never read as keys.

## R8. Single instance

- **Decision**: Lock file `$XDG_RUNTIME_DIR/corgi-voice.lock` (else `$XDG_STATE_HOME/corgi-voice/lock`, else `~/.local/state/corgi-voice/lock`), created with exclusive create, holding the PID. A lock whose PID is not alive (`process.kill(pid, 0)` throws `ESRCH`) is stale and replaced. Removed on exit.

## R9. Storage and migration (FR-024)

- **Decision**: Settings `$XDG_STATE_HOME/corgi-voice/voice.json` (else `~/.local/state/corgi-voice/voice.json`). Old: `$XDG_STATE_HOME/corgi/voice.json` (else `~/.local/state/corgi/voice.json`), copied with mode 0600 when the new file is missing. Models `$XDG_CACHE_HOME/corgi-voice/` (else `~/.cache/corgi-voice/`); old `$XDG_CACHE_HOME/corgi/voice/` (else `~/.cache/corgi/voice/`), each missing file taken by `link()` and on `EXDEV` copied. Runs in both startup and `--setup`.

## R10. Space joining (FR-011)

- **Decision**: After a successful send, remember `{machine, viewer, pane, active}` using the `active` from the poll result that chose the target. Before the next send, re-check with the newest poll result for that machine: same viewer and pane and same `active` adds one leading space. Assumes `pane send` does not change `active` (spec assumption).

## R11. Tests without microphone, Whisper or Corgi

- **Decision**: `bun test`. The ported unit tests from the source branch come along (adjusted imports). A fake `corgi` executable (`tests/fixtures/fake-corgi.ts`, run through a shell shim) reads a JSON scenario file named by `FAKE_CORGI_SCENARIO` and records calls and stdin to a log, so tests can assert "never `--enter`", no trailing newline, error mapping, timeouts and per-machine isolation.
