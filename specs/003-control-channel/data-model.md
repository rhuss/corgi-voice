# Data Model: Control Channel

## VoiceState

| Field | Type | Rule |
|---|---|---|
| `pid` | number | process id of the voice window |
| `muted` | boolean | the mute setting (`session.muted`) |
| `mode` | `"listening" \| "muted"` | `muted` when `muted` or voice cannot listen |
| `unavailable` | `"mic_missing" \| "mic_denied" \| "mic_busy" \| "server_down" \| null` | `session.unavailable` |
| `reason` | string \| null | why there is no target, in the window's words |
| `recording` | `"none" \| "running" \| "paused"` | stopping counts as `none` |
| `target` | `{machine, label} \| null` | `label` = the window's Target text |
| `updated_at` | number (ms) | changes only when another field changes |

Cannot-listen words: `mic_missing` microphone missing, `mic_denied` microphone access denied, `mic_busy` microphone busy, `server_down` transcription server down.

## Session event

`{ at: number, text: "muted from outside" | "unmuted from outside" }`, shown as history rows.
