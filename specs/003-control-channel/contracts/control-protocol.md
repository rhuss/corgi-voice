# Contract: corgi-voice control protocol

Socket: `$XDG_RUNTIME_DIR/corgi-voice.sock`, else `<state folder>/control.sock`, else (path too long) `$TMPDIR/corgi-voice-<uid>/control.sock`. Mode 0600.

Request (one per connection, one line, at most 4 KiB): `{"op":"status"|"mute"|"unmute"|"toggle"|"watch"}`

Answer (one line): `{"ok":true,"state":{...}}` or `{"ok":false,"state":{...},"err":"bad_json"|"too_long"|"unknown_op"|"cannot_listen"}`; the server closes the connection after it, except for `watch`, which follows with one state line (`{"ok":true,"state":{...}}`) per change.

Idle: a connection with no complete request within 2 s is closed. Watchers with more than 64 KiB unsent are closed.

CLI: `corgi-voice --mute|--unmute|--toggle-mute|--status [--json]|--watch [--json]`; stdout: short line or the `state` JSON; stderr: refusal reason; exit 0 ok, 1 refused, 2 usage, 3 not running or no answer in 1 s.

Short line: `<mode> · <target label>` | `<mode> · <reason head>` | `muted · cannot listen: <words>`; `· REC` / `· REC paused` appended during a recording.
