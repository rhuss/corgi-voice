# Contract: `corgi` commands consumed by corgi-voice

This is the complete list of Corgi interfaces corgi-voice uses (FR-002). Anything not listed here is off limits.

| Command | When | Bound | Parsed |
|---|---|---|---|
| `corgi pane send --help` | startup, setup | 3 s | stdout+stderr contain `--stdin` |
| `corgi machine list` | startup, every 30 s | 3 s | JSON object from the first `{`: `machines[].name` |
| `corgi list --json` | every 1 s (local) | 1.5 s | `viewers[]`, `result.panes[]` |
| `corgi --machine NAME list --json` | every 1 s per remote machine | 1.5 s | same as above |
| `corgi list --all-machines --json` | fallback only (no `machine list`), every 1 s | 1.5 s | `machines[]` entries `{machine, ok, err, viewers, result}`; exit code ignored when JSON parses |
| `corgi [--machine NAME] pane send ID --stdin` | each dictated utterance | 2 s | exit code, first stderr line |

The command name comes from `--corgi`, else setting `corgi`, else `corgi` (FR-003). `--machine` is omitted for `local`.

## Invariants

- `--enter` never appears in any argument list.
- `pane send` stdin is exactly the delivered text (no trailing newline), then closed.
- A call that exceeds its bound is killed (SIGTERM, then SIGKILL after 200 ms).
- At most one `pane send` runs at a time.

## Error mapping (`src/corgi/errors.ts`)

| corgi output (after `corgi: ` prefix) | Reason shown |
|---|---|
| `NoPane`, `PaneExited`, `NoSuchPane` | `pane gone` |
| `UnknownMachine`, `RequestTimedOut`, `ConnectionRefused`, `NoRuntime`, `ssh:` lines | `<machine> unreachable` |
| timeout of our own bound | `no answer in time; may have been typed` |
| non-zero exit, empty output | `corgi exited with code N` |
| spawn fails (`ENOENT`) | `corgi not found: <cmd>` |
| anything else | first line, prefix removed, at most 60 columns |

## Viewer JSON (observed)

```json
{"ok":true,"result":{"panes":[{"id":207,"name":"","agent":"claude","command":"claude","cwd":"/path","dormant":false,"exited":false}]},
 "viewers":[{"id":4,"pid":0,"active":10720,"workspace":20,"pane":207,"watched":false}]}
```
