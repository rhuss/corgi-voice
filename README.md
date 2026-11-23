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
bun link        # creates ~/.bun/bin/corgi-voice
```

`bun install -g` from the repository works as well. Both put the command in `~/.bun/bin`, which the Bun installer adds to `PATH`. If `which corgi-voice` finds nothing, add `~/.bun/bin` to `PATH` or link the command into a directory that is already on it:

```bash
ln -s ~/.bun/bin/corgi-voice ~/.local/bin/corgi-voice
```

## Setup

```bash
corgi-voice --setup                  # default model base.en
corgi-voice --setup --model small.en
```

Setup checks for `whisper-server`, `ffmpeg` and the `corgi` command, downloads the Whisper model and the speech filter (Silero VAD) with progress, and prints what is ready and what is missing, with install hints.
For `corgi`, it also runs `corgi list --json` once (bounded at 3 seconds, no pane is touched) to check that this `corgi` can talk to the Corgi that runs.
A `corgi` of another build answers with an error, and setup reports `[mismatch]` with that error and the fix (see [Corgi unreachable](#corgi-unreachable)).
When Corgi is not running or does not answer in time, setup prints a `[note]` and goes on.
It exits with status 1 while something required is missing or the `corgi` command does not match.

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
| `--mute`, `--unmute`, `--toggle-mute`, `--status`, `--watch` | control the running corgi-voice; see [Mute from anywhere](#mute-from-anywhere) |

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

`r` opens a prompt with one field: the full path of the transcript file, such as `~/.local/share/corgi/transcripts/2026-11-21-.txt`, with the caret before `.txt`.
The path starts in the transcript folder, then in the folder the last recording of this run went to.
Edit it like any text: Backspace, Left and Right, Home and End, Ctrl+A, Ctrl+E, Ctrl+U, Ctrl+K, Ctrl+W.
Enter records, Esc cancels.

Paths under the home folder show as `~/`, others as absolute paths.
A relative path goes into the transcript folder; `..` parts are resolved, so any folder can be chosen.
Missing folders are made when the recording starts, private to you.
A line under the field appears only when the file exists (the recording appends after one blank line) or when the path is refused, such as one that ends in `/`, names a folder, or goes through a file; Enter then does nothing.
A long path scrolls in the field to keep the caret in view, with `…` where it is cut.

Tab opens a folder pop-down at the caret:

- With the caret in the file name, it lists the sub-folders of the file's folder, and the folder you take goes in front of the file name.
- With the caret inside a folder of the path, it lists the folders next to that one that match the text before the caret, and the folder you take replaces it.
- Typing filters the list (names starting with the text first, then names containing it, ignoring case), shown in the pop-down's frame, and Backspace edits the filter.
- Up and Down pick, Enter or Tab take the picked folder, Esc closes the pop-down without changes.

The pop-down shows up to 8 folders at a time and scrolls, saying how many more there are.
Folders starting with `.` are listed once the filter starts with a dot.
A folder that cannot be read, or has no sub-folders, shows a short note that goes away with the next key.

Backspace with the caret at the start of the file name removes the folder in front of it, so going up is one key per level, up to `/`.

Stopping (`R`) cuts what is being said at that moment: the part before `R` is written, and the rest goes on as ordinary dictation (typed when dictation is on, dropped when it is muted).
The file closes as soon as that last part is transcribed, whatever the background does.

The transcript has one line per passage and a blank line before each new contribution (a pause longer than `pause_break`).
Each passage is synced to disk as it is written.
Starting a recording mutes dictation; stopping it puts the mute back as it was.
When corgi-voice ends while passages are still being transcribed, by a second quit press or by a signal, the transcript is closed without them and the terminal says how many were left out.

## Mute from anywhere

The running corgi-voice listens on a local control socket, so other programs can mute it and read what it is doing without switching to its window.

```bash
corgi-voice --toggle-mute     # mute, or unmute when muted
corgi-voice --mute
corgi-voice --unmute
corgi-voice --status          # one short line
corgi-voice --status --json   # the full state
corgi-voice --watch           # a line now, then one per change, until corgi-voice quits
corgi-voice --watch --json
```

These commands need no terminal and start no voice window.
A mute from outside follows the same rules as `m`: unmuting is refused while voice cannot listen, and a recording still puts the mute back as it was when it stops.
The window shows a history row `muted from outside` or `unmuted from outside`.

Each command prints the state as one short line:

| Line | When |
|---|---|
| `listening · bat · corgi-voice` | the mode, then the target the window shows |
| `muted · marovo → api · logs` | muted, with a target on a remote machine |
| `listening · no viewer attached` | no target: the head of the reason, as the window's Target cell (`Corgi unreachable`, `marovo unreachable`) |
| `muted · cannot listen: microphone missing` | voice cannot listen (`microphone missing`, `microphone access denied`, `microphone busy`, `transcription server down`) |
| `listening · bat · corgi-voice · REC` | a recording runs (`· REC paused` while paused) |

With `--json` it prints the state as one JSON object:

```json
{"pid":4242,"muted":false,"mode":"listening","unavailable":null,"reason":null,"recording":"none","target":{"machine":"local","label":"bat · corgi-voice"},"updated_at":1795270000000}
```

| Field | Meaning |
|---|---|
| `pid` | the voice window's process |
| `muted` | the mute setting, which decides the mode whenever voice can listen |
| `mode` | what the window shows: `listening`, or `muted` (also while voice cannot listen) |
| `unavailable` | why voice cannot listen: `mic_missing`, `mic_denied`, `mic_busy`, `server_down`, or `null` |
| `reason` | why there is no target, in the window's words, or `null` |
| `recording` | `none`, `running` or `paused` |
| `target` | `{machine, label}`, the label being the window's Target text, or `null` |
| `updated_at` | when another field last changed, in ms since the epoch |

Exit codes:

| Code | Meaning |
|---|---|
| `0` | done |
| `1` | refused, such as unmuting while voice cannot listen; the reason goes to standard error, the state to standard output |
| `2` | usage error: two control flags, a control flag with a voice-window flag, or `--json` without `--status` or `--watch` |
| `3` | corgi-voice is not running, or did not answer within 1 second |

### A global hotkey

Corgi cannot bind a key to a command, so a global hotkey tool runs `corgi-voice --toggle-mute` instead.
Hotkey tools do not read your shell's `PATH`, so give them absolute paths.
Find corgi-voice's with:

```bash
command -v corgi-voice
```

The command starts with `#!/usr/bin/env bun`, so `bun`'s folder must be on the tool's `PATH` too.
Find it with:

```bash
dirname "$(command -v bun)"
```

The recipes below use `/Users/me/.bun/bin` for both, as the Bun installer and `bun link` set them up; with Homebrew's Bun the `bun` folder is `/opt/homebrew/bin` instead. Put your own paths in their place.

macOS Shortcuts: a new shortcut with one Run Shell Script action containing

```bash
PATH="/Users/me/.bun/bin:$PATH" /Users/me/.bun/bin/corgi-voice --toggle-mute
```

then, in the shortcut's details, Add Keyboard Shortcut.

[skhd](https://github.com/koekeishiya/skhd), in `~/.config/skhd/skhdrc`:

```text
ctrl + alt - m : PATH="/Users/me/.bun/bin:$PATH" /Users/me/.bun/bin/corgi-voice --toggle-mute
```

[Hammerspoon](https://www.hammerspoon.org), in `~/.hammerspoon/init.lua`, with the new state as an alert:

```lua
hs.hotkey.bind({ "ctrl", "alt" }, "m", function()
  local out, ok = hs.execute('PATH="/Users/me/.bun/bin:$PATH" /Users/me/.bun/bin/corgi-voice --toggle-mute')
  hs.alert.show(ok and out or "corgi-voice did not mute: is it running?")
end)
```

The exit code tells a script what happened: `0` the line it printed is the new state, `1` refused (voice cannot listen, so it stays muted), `3` no corgi-voice is running.

For a status bar (sketchybar, tmux), run `corgi-voice --watch` once and redraw on each line, or call `corgi-voice --status` on a timer.

## Voice icon in Corgi

corgi-voice ships a small Corgi trick that shows the voice state in Corgi's sidebar title row, left of `[ + ]`:

| Icon | When |
|---|---|
| `♫` in `accent` | listening |
| `♫` in `faint` | muted |
| `●` in `hot` (red) | a recording runs |
| `●` in `warm` (amber) | the recording is paused |
| nothing | voice cannot listen (microphone missing, denied or busy, transcription server down), or corgi-voice is not running |

The icon follows the mute state and the recording only, not the target: it shows also while no viewer is attached or Corgi is unreachable from corgi-voice.
Click the `♫` (or focus it with Corgi's trick-button keys and press Enter) to mute or unmute, exactly as `m` does; the window adds its `muted from outside` row.
The recording dots are not pressable, so a click during a recording never unmutes dictation; use the window or a hotkey then.
When corgi-voice quits the icon disappears, and it comes back within a few seconds of corgi-voice starting again.

It needs a Corgi with Tricks and title items: tals/corgi#74 and tals/corgi#198, or a custom build containing both.
An older Corgi refuses the item; the trick then logs the error once and shows nothing.

Install it, then let Corgi load it:

```bash
corgi-voice --install-trick
corgi tricks reload
corgi tricks list          # corgi-voice is listed and running
```

`corgi-voice --install-trick` writes `corgi-voice/trick.toml` into Corgi's tricks folder (`$CORGI_TRICKS_DIR`, else `${XDG_CONFIG_HOME:-~/.config}/corgi/tricks`), replacing only that file when run again; set `CORGI_TRICKS_DIR` only when the Corgi daemon has the same value.
Corgi starts tricks with a reduced environment, so the manifest carries absolute paths for `bun` and corgi-voice and the control socket's path.
For `bun` it takes a link on `PATH` to the running Bun when there is one (Homebrew's `/opt/homebrew/bin/bun`), so upgrading Bun keeps working.
Run the install again after moving corgi-voice or switching to another Bun: with a stale program path Corgi reports the trick as failed in `corgi tricks list`.
Run it again also after changing `XDG_RUNTIME_DIR`, `XDG_STATE_HOME` or `TMPDIR`: a stale socket path leaves the trick idle, showing nothing.
The installed manifest is specific to this machine, so do not sync it to remote machines; the icon only matters where the microphone is.
`tricks/voice/` in this repository holds a reference copy of the manifest.

To uninstall, remove the folder and reload:

```bash
rm -r "${CORGI_TRICKS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/corgi/tricks}/corgi-voice"
corgi tricks reload
```

## Troubleshooting

### Corgi unreachable

The window says `Corgi unreachable: …` and nothing is typed, although Corgi runs.
The usual cause is a `corgi` command of another build than the Corgi that runs: an older release on `PATH` while your shell alias points to a newer one, for example.
Its `list --json` then fails with an error such as `JSON Parse error: Unexpected identifier "HTTP"` or `unknown command`.
The status line adds `set "corgi" in voice.json to the corgi your Corgi runs`, and `corgi-voice --setup` reports:

```text
[mismatch] corgi /usr/local/bin/corgi cannot talk to the running Corgi: JSON Parse error: Unexpected identifier "HTTP"
         set "corgi" in voice.json, or pass --corgi, to the corgi your Corgi runs
```

Set `"corgi"` in `voice.json` to the path of the `corgi` your Corgi runs (see [Finding corgi](#finding-corgi)), or pass it with `--corgi`, and run `corgi-voice --setup` again until it reports `[ok] corgi`.

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
| `$XDG_RUNTIME_DIR/corgi-voice.sock` (else `control.sock` in the state folder) | control socket of the running corgi-voice, yours alone (mode 0600); where that path is too long for a socket, `$TMPDIR/corgi-voice-<uid>/control.sock`, which `--verbose` logs |
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

- No voice indicator in Corgi's sidebar, and no mute shortcut inside Corgi: the voice window shows the state, and `m` there is the mute; from anywhere else, `corgi-voice --toggle-mute` on a global hotkey and `corgi-voice --status` (see [Mute from anywhere](#mute-from-anywhere)).
- No `--ssh`: remote machines come through Corgi's own remote machines.
- Settings and models live in corgi-voice's own folders (taken over on first start).
- The recording prompt is one path field with a folder pop-down on Tab, not Corgi's folder browser; it does not list existing transcripts.

## Do not run both

Do not run `corgi-voice` and `corgi voice` at the same time.
Both would hear the same speech, and with copied settings they use the same Whisper port, so the one started second fails with "port in use".
Two corgi-voice instances are prevented: the second refuses to start.

## Development

```bash
bun test          # no microphone, Whisper or Corgi needed: a fake corgi stands in
bun run check     # tsc --noEmit
bun run bench:toggle   # by hand: --toggle-mute from spawn to exit, p95 under 200 ms
```

The code that runs `corgi` lives in `src/corgi/`; the commands it may use are listed in `specs/001-corgi-voice-extraction/contracts/corgi-cli.md`.
