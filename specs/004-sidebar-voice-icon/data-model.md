# Data Model: Sidebar Voice Icon

## Voice state (input, from 003)

Only these fields matter to the trick: `mode` (`listening` | `muted`), `unavailable` (string | null), `recording` (`none` | `running` | `paused`). `target`, `reason`, `pid`, `muted`, `updated_at` are ignored.

## Item (derived)

| Field | Type | Rule |
|-------|------|------|
| glyph | `"♫"` or `"●"` | `●` while recording, else `♫` |
| color | `accent` \| `faint` \| `hot` \| `warm` | running `hot`, paused `warm`, listening `accent`, muted `faint` |
| pressable | boolean | true only for `♫` |

Derivation (`item(state)`):

1. no state (corgi-voice unreachable) → none
2. `recording` = `running` → `●` hot, not pressable
3. `recording` = `paused` → `●` warm, not pressable
4. `unavailable` ≠ null → none
5. `mode` = `listening` → `♫` accent, pressable
6. otherwise → `♫` faint, pressable

Two items are equal when glyph, color and pressable are equal.

## Trick runtime state

| Field | Meaning |
|-------|---------|
| `socket` | channel path (from `ready.config.socket` or `socketPath()`) |
| `ready` | `ready` event seen; nothing is drawn before it |
| `shown` | the item currently drawn, or none |
| `armed` | the action ID that a press may use, or null (not pressable, or a toggle is in flight) |
| `seq` | counter for action IDs (`toggle-<seq>`) |
| `inflight` | a `toggle` request is pending |
| `latest` | the newest watch state on the current watch connection, or none while not connected |
| `reachable` | last known reachability, for transition-only logging |
| `logged` | set of Corgi error kinds already logged |

### Transitions

- watch answer, no toggle in flight → `next = item(state)`; if `next` ≠ `shown`: draw (`ui.set`, with a new action and `slot` if pressable) or remove (`ui.remove`, only if `shown`); update `shown`, `armed`.
- every watch answer is recorded as `latest` (the newest watch state overall; reset to none when the watch ends).
- watch answer while a toggle is in flight → if `item(latest)` is not pressable or none (a recording started, voice became unavailable), draw/remove it at once (no action); otherwise draw nothing yet.
- press with `action == armed` → `armed = null`, `inflight = true`; send `toggle`.
- toggle ends → `inflight = false`; if the watch is not connected (`latest` is none), draw nothing (the item was removed when the watch ended; the next watch answer redraws). Otherwise `state` = the newer of `answer.state` and `latest` by `updated_at`, preferring `latest` on a tie (the watch stream is ordered), or `latest` when there is no answer; draw `item(state)` if it differs from `shown` or if it is pressable and `armed` is null (re-arm with a new action). Exactly one `ui.set` per click when the item stays pressable.
- press otherwise (stale action, second press on the same action, in flight, unreachable, before `ready`) → ignored.
- watch ends (`closed`, `not_running`, `no_answer`) → remove if `shown`; `armed = null`; log on transition to unreachable; retry in 2 s.
- stdin ends → abort watch and timers, exit 0.

## Manifest (written by `--install-trick`)

```toml
version = 1
id = "corgi-voice"
description = "Shows **corgi-voice** in the sidebar title row; click to mute."
command = ["/opt/homebrew/bin/bun", "/path/to/corgi-voice/src/main.ts", "--trick"]

[config]
socket = "/Users/me/.local/state/corgi-voice/control.sock"
```

Strings are written as TOML basic strings (JSON-escaped). Location: `$CORGI_TRICKS_DIR/corgi-voice/trick.toml`, else `${XDG_CONFIG_HOME:-$HOME/.config}/corgi/tricks/corgi-voice/trick.toml`.
