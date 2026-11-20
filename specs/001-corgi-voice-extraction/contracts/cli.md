# Contract: corgi-voice command line, files and keys

## Commands

```
corgi-voice [--model NAME] [--threshold N] [--silence S] [--port N] [--device NAME]
            [--transcripts DIR] [--no-filter] [--verbose] [--corgi CMD]
corgi-voice --setup [--model NAME] [--corgi CMD]
corgi-voice --help
```

Flag meanings and ranges follow the source parser (`src/voice/main.ts` on Corgi `005-voice-transcripts`), with `--ssh` removed and `--corgi CMD` added.

Exit codes: 0 normal quit or setup ready; 1 setup incomplete, missing `corgi` capability, model missing, another instance running; 2 usage error.

## Files

| Path | Purpose | Mode |
|---|---|---|
| `$XDG_STATE_HOME/corgi-voice/voice.json` (else `~/.local/state/corgi-voice/voice.json`) | settings | 0600 when created |
| `$XDG_CACHE_HOME/corgi-voice/` (else `~/.cache/corgi-voice/`) | Whisper models, speech filter model | |
| `$XDG_DATA_HOME/corgi/transcripts/` (else `~/.local/share/corgi/transcripts/`) | default transcript folder (unchanged) | folders 0700, files 0600 |
| `$XDG_RUNTIME_DIR/corgi-voice.lock` (else state dir `lock`) | single instance | |
| `$XDG_STATE_HOME/corgi-voice/voice.log` | verbose log (`--verbose`) | 0600 |

Read only, never changed: `$XDG_STATE_HOME/corgi/voice.json` (or `~/.local/state/corgi/voice.json`), `$XDG_CACHE_HOME/corgi/voice/` (or `~/.cache/corgi/voice/`).

## Settings (`voice.json`)

All source keys (`threshold`, `silence`, `pre_roll`, `post_roll`, `min_speech`, `burst`, `model`, `port`, `speech_filter`, `device`, `transcripts`, `recording{threshold,silence,max_chunk,pause_break}`) plus:

- `corgi`: string, command name or path (default `corgi`).
- `theme`: `"auto" | "light" | "dark"` (default `"auto"`).

## Keys (voice window)

Unchanged from the source: `m` mute, `+`/`-` and wheel threshold, `t` gauge, `f` filter, `d` device picker (as in source), `?` help, `r`/`R`/`v` recording, history scroll keys, `q` quit. Recording file prompt: text field, Enter accept, Esc cancel, Backspace, Left/Right, Home/End, Ctrl+A/E/U/W.
