# Contract: `corgi-voice --trick` on Corgi's Tricks wire

Authoritative upstream: `docs/tricks.md` ("Title items", "Raw JSONL") on tals/corgi#198.

## Standard input (from Corgi), one JSON object per line

| Line | Handling |
|------|----------|
| `{"event":"ready","version":2,"config":{...},"kv":{}}` | start; `config.socket` (non-empty string) overrides the computed channel path |
| `{"event":"ui.press","action":"toggle-N","viewer":...}` | toggle if `action` is the armed one, else ignore |
| `{"id":null,"error":"<Kind>"}` or `{"id":...,"error":"<Kind>"}` | log `<Kind>` once per process on stderr |
| anything else, or not JSON | ignored |
| end of input | stop watching, exit 0 within 1 s |

## Standard output (to Corgi), one JSON object per line, no `id`

Pressable listening/muted item:

```json
{"op":"ui.set","key":"voice","view":{"kind":"title","spans":[{"text":"♫"}],"color":"accent","action":"toggle-1","slot":"voice"}}
```

```json
{"op":"ui.set","key":"voice","view":{"kind":"title","spans":[{"text":"♫"}],"color":"faint","action":"toggle-2","slot":"voice"}}
```

Recording items (no `action`, no `slot`):

```json
{"op":"ui.set","key":"voice","view":{"kind":"title","spans":[{"text":"●"}],"color":"hot"}}
```

```json
{"op":"ui.set","key":"voice","view":{"kind":"title","spans":[{"text":"●"}],"color":"warm"}}
```

Removal, only while an item is drawn:

```json
{"op":"ui.remove","key":"voice"}
```

Nothing else is ever written to standard output. Diagnostics go to standard error as `corgi-voice trick: <message>` lines.

## Control channel use

- `watch` on the channel path; reconnect every 2 s after it ends or fails.
- `toggle` once per accepted press.
- No other ops.
