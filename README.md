# corgi-voice

Voice dictation and transcript recording for [Corgi](https://github.com/tals/corgi).
You speak, a local Whisper server transcribes, and the text is typed into the Corgi pane you are working in.
Nothing is submitted: Enter is never pressed.
You can also record a conversation to a plain text transcript and follow it in a reading view.

corgi-voice is the voice mode that used to live inside Corgi as `corgi voice`, now a program of its own.
It talks to Corgi only through the `corgi` command line, so it works with a stock Corgi build.

## Prerequisites

- [Bun](https://bun.sh) 1.4 or newer.
- `whisper-server` from [whisper.cpp](https://github.com/ggml-org/whisper.cpp), a version that knows `--vad` (`brew install whisper-cpp` on macOS).
- `ffmpeg` for audio capture (`brew install ffmpeg`, or your distribution's package).
  On macOS it records through AVFoundation, on Linux through PulseAudio or PipeWire.
- `corgi` with `corgi pane send ID --stdin` and viewer data in `corgi list --json`.
  Run `corgi pane send --help`: the usage line must mention `--stdin`.

No Corgi source tree, native build or Zig toolchain is needed.

## Install

From a clone of this repository:

```bash
bun install
bun link        # puts corgi-voice on PATH
```

`bun install -g` from the repository works as well.

## Setup

```bash
corgi-voice --setup                  # default model base.en
corgi-voice --setup --model small.en
```

Setup checks for `whisper-server`, `ffmpeg` and the `corgi` command, downloads the Whisper model and the speech filter (Silero VAD) with progress, and prints what is ready and what is missing, with install hints.
It exits with status 1 while something required is missing.

If you used `corgi voice` before, setup (and the first start) takes over its settings and models:
the settings file is copied, and each model is hard linked (or copied) from the old cache instead of downloaded.
A model is taken only when its SHA-256 checksum is the pinned one; a file that does not match is left where it is, named in a notice, and downloaded by setup instead.
The old files are never changed or removed.

Models: `tiny.en`, `base.en` (default), `small.en`, `medium`, `large-v3-turbo`.

## Usage

Start Corgi, attach a viewer, focus a pane, then in another terminal:

```bash
corgi-voice
```

Speak, pause, and the sentence appears in the focused pane.
A second utterance into the same pane, with no typing of yours in between, is joined with one space.
The header shows where the next text goes: the pane's name, after its machine when that is a Corgi remote machine.

Flags:

| Flag | Meaning |
|---|---|
| `--model NAME` | Whisper model for this run |
| `--threshold N` | speech threshold, 0 to 100 |
| `--silence S` | seconds of silence that end an utterance, 0.5 to 10 |
| `--port N` | whisper-server port, 1024 to 65535 (default: a free one) |
| `--device NAME` | microphone (default: the system's) |
| `--transcripts DIR` | transcript folder for this run |
| `--no-filter` | run Whisper without the speech filter |
| `--verbose` | write a log to `voice.log` in the state folder |
| `--corgi CMD` | the `corgi` command: a name on `PATH` or a path to an executable |
| `--setup` | check tools and download models |
| `--help` | list the flags |

### Finding corgi

corgi-voice runs `--corgi CMD` if given, else the `corgi` setting in `voice.json`, else `corgi` on `PATH`.
A shell alias (such as `alias corgi=~/bin/corgi-custom`) cannot be run by another program.
If your `corgi` is an alias, pass the executable's path: `corgi-voice --corgi ~/bin/corgi-custom`, or set it in `voice.json`.

### Remote machines

When your viewer shows a Corgi remote machine, the text goes to the focused pane there.
corgi-voice asks `corgi machine list` for the machines and polls each one on its own, so a slow machine never holds up the local one.
Audio never leaves your machine; only the text goes to `corgi pane send --machine NAME`.

When several viewers on several machines have a focused pane, the one whose terminal window has focus wins.
Otherwise the machine of the last delivery, then the local machine.

### No viewer, no Corgi

Without an attached viewer, or while Corgi does not answer, the window says so and dictation records nothing.
It resumes on its own within a couple of seconds once a viewer attaches.
A running recording goes on meanwhile; its passages are written and marked "recorded, not typed".

## Keys

| Key | Action |
|---|---|
| `m` | mute or unmute (a click on the note or the mode does too) |
| `+` `-`, mouse wheel | threshold up or down by 2 |
| `t` | gauge the threshold: stay quiet 10 s while the music plays; Esc cancels |
| `f` | speech filter on or off (restarts the Whisper server) |
| `d` | pick the microphone |
| `?` | help on every option |
| `r` | record a transcript; again to pause and resume |
| `R` | stop the recording |
| `v` | reading view of the recording |
| `j` `k`, arrows, PgUp PgDn, Ctrl+U/D/B/F, `g` `G` | scroll the history or the reading view |
| `q`, Ctrl+C | quit (with a recording, the first press waits for its last passages) |

A click on an option opens a menu of values: silence, burst, post-roll, pre-roll and min speech.

Post-roll is how much of the pause after your last loud stretch is kept, 1 second by default.
It keeps a quiet sentence ending, such as soft last words under music, so it reaches Whisper.
Its menu offers 0.3 to 2 seconds and "whole pause", which keeps everything up to the end of the silence window (the options line then reads `pause`).
With the speech filter on, the filter pads the speech it finds by the same amount, from the next utterance on, without a server restart.
Longer keeps more of a soft ending but sends more background sound to Whisper, which can become a stray word.
An utterance cut at the 30 second cap (or a recording's `max_chunk`) is sent whole, without post-roll trimming.

### Recording

`r` opens a prompt for the file name, suggested as `YYYY-MM-DD-.txt` with the caret before `.txt`.
A relative name goes into the transcript folder (sub-folders are made, private to you); `~/` and absolute paths are used as given.
A name that leaves the transcript folder with `..` is refused.
If the file exists, the prompt says so and the recording appends after one blank line.
Editing keys: Backspace, Left and Right, Home and End, Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+W. Enter records, Esc cancels.

The transcript has one line per passage and a blank line before each new contribution (a pause longer than `pause_break`).
Each passage is synced to disk as it is written.
Starting a recording mutes dictation; stopping it puts the mute back as it was.
When corgi-voice ends while passages are still being transcribed, by a second quit press or by a signal, the transcript is closed without them and the terminal says how many were left out.

## Settings

`voice.json` holds the defaults; flags override them for one run.
An invalid value falls back to its default with a notice naming the field.

```json
{
  "threshold": 44,
  "silence": 2.5,
  "pre_roll": 0.3,
  "post_roll": 1,
  "min_speech": 0.2,
  "burst": 0.1,
  "model": "base.en",
  "port": null,
  "speech_filter": true,
  "device": null,
  "transcripts": "~/Notes/transcripts",
  "recording": { "threshold": 20, "silence": 1.0, "max_chunk": 10, "pause_break": 2.0 },
  "corgi": "/path/to/corgi",
  "theme": "auto"
}
```

`theme` is `auto` (from the terminal's background), `light` or `dark`.
`post_roll` is 0 to 10 seconds, or `"pause"` for the whole pause; it has no flag, like `pre_roll`, `min_speech` and `burst`, and applies to dictation and recording alike.
`recording.threshold` set to `null` follows the dictation threshold.

## Files

| Path | What |
|---|---|
| `$XDG_STATE_HOME/corgi-voice/voice.json` (else `~/.local/state/corgi-voice/voice.json`) | settings |
| `$XDG_CACHE_HOME/corgi-voice/` (else `~/.cache/corgi-voice/`) | Whisper models and the speech filter |
| `$XDG_DATA_HOME/corgi/transcripts/` (else `~/.local/share/corgi/transcripts/`) | default transcript folder, the same as `corgi voice` used |
| `$XDG_RUNTIME_DIR/corgi-voice.lock` (else `lock` in the state folder) | single-instance lock |
| `$XDG_STATE_HOME/corgi-voice/voice.log` | log with `--verbose` |

With `--verbose`, each utterance's line in `voice.log` also shows its cut: `post_roll=` used (`capped` for an utterance cut at the cap, which keeps everything), how much audio after the last loud stretch was `kept=` and `dropped=`, the speech filter's padding `pad=`, and `speech_end=`, where Whisper's last segment ends.
That end includes the filter's padding, so compare it with `kept=` and `pad=` rather than reading it as your last word.
To report it, `--verbose` asks Whisper for subtitles instead of plain text, as their cues carry the segment times.
If sentence endings are lost with music or a raised threshold, lengthen post-roll or pick "whole pause", and compare these values with the utterance's duration.

The log also has one `delivery:` line per `corgi pane send`: whether it was delivered, failed or abandoned at the 2 second bound, the machine and pane, the time it took, the exit code, and the first line of what `corgi` said when it failed.
The dictated text itself is never logged.
A machine, or `corgi machine list`, that stops answering is logged once per distinct failure, and once when it answers again.

Read only, for taking over from `corgi voice`: `$XDG_STATE_HOME/corgi/voice.json` and `$XDG_CACHE_HOME/corgi/voice/` (or their `~/.local/state` and `~/.cache` forms).

## Differences from `corgi voice`

- No voice indicator in Corgi's sidebar, and no mute shortcut inside Corgi: the voice window is the only place showing voice state, and `m` there is the mute.
- No `--ssh`: remote machines come through Corgi's own remote machines.
- Settings and models live in corgi-voice's own folders (taken over on first start).
- The recording prompt is a single file name field; Corgi's folder browser is not reproduced.

## Do not run both

Do not run `corgi-voice` and `corgi voice` at the same time.
Both would hear the same speech, and with copied settings they use the same Whisper port, so the one started second fails with "port in use".
Two corgi-voice instances are prevented: the second refuses to start.

## Development

```bash
bun test          # no microphone, Whisper or Corgi needed: a fake corgi stands in
bun run check     # tsc --noEmit
```

The code that runs `corgi` lives in `src/corgi/`; the commands it may use are listed in `specs/001-corgi-voice-extraction/contracts/corgi-cli.md`.
