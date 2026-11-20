---
runbook_version: 1
feature: 001-corgi-voice-extraction
status: passed
mode: light
steps_total: 9
step_results: passed,passed,passed,passed,passed,passed,passed,passed,skipped
drafted_at: fa5181f
drafted_fingerprint: 824e0f5e9dc8bbc5aac2b6019c4788eae8d1053b3d878f0723d0cf2f35dc144f
tested_at: bf102e8
tested_fingerprint: 50fff9d5b7f612c9e7ff7e03cf55fda64462f668131a81ff95274e1b18b22ba6
updated: 2026-11-20
---

# Try it: corgi-voice Extraction

<!-- runbook-status -->
> **Status:** passed · 9 of 9 steps (8 passed, 1 skipped) · Mode: light · Tested at bf102e8 · 2026-11-20
<!-- /runbook-status -->










## What you're testing

`corgi-voice` is the voice mode that used to live inside Corgi, now a standalone tool that talks to Corgi only through the `corgi` command. The journey installs it, runs its own tests, sets it up (reusing the models of `corgi voice`), then dictates into a throwaway `cat` pane of your normal Corgi, mutes, records a short transcript, and finally (optional) dictates into a pane on a remote machine.

Order: install, tests, setup, open a safe target pane, start the voice window, dictate, mute, record, remote.

## Test environment

No fixtures are started by the walkthrough. It uses what you already have: your running Corgi with a viewer attached, `whisper-server` and `ffmpeg` from Homebrew, and a microphone. A `cat` pane is the dictation target so nothing ever lands in an agent prompt.

## Steps

### Step 1 of 9: Install the tool (US6)

**Why this step:** proves the tool installs from the repository with only Bun, no Corgi source or native build.

**Run:**

```
bun install && bun link
```

**What you should see:** dependencies installed without errors and a message that `corgi-voice` was linked; `which corgi-voice` then prints a path under `~/.bun/bin`.

**If you see something else:** "command not found: bun" means Bun is missing; a link error usually means `~/.bun/bin` is not on `PATH`.

**Result:** passed (agent, 2026-11-20). `bun install` checked 5 installs, no changes; `bun link` registered corgi-voice and created `~/.bun/bin/corgi-voice`, which runs (`--help` prints the usage). Mismatch: `which corgi-voice` found nothing because `~/.bun/bin` is not on this PATH. Fixed by `ln -s ~/.bun/bin/corgi-voice ~/.local/bin/corgi-voice`; the README now says where `bun link` puts the command and how to link it onto PATH.

### Step 2 of 9: Run the automated checks (US1, US2, US3, US5)

**Why this step:** the behaviour that needs no microphone or Corgi (target resolution, delivery, never pressing Enter, recording files) is covered by tests against a stand-in `corgi`.

**Needs:** Step 1

**Run:**

```
bun run check && bun test
```

**What you should see:** the type check prints nothing, and `bun test` ends with about 500 pass and 0 fail.

**If you see something else:** a failing test names the file and case; failures under `tests/corgi/` point at the CLI contract.

**Result:** passed (agent). `tsc --noEmit` clean; `bun test`: 502 pass, 0 fail, 38 files, 87 s. Log: `specs/001-corgi-voice-extraction/.walkthrough/step-2.log`.

### Step 3 of 9: Set up models and check tools (US6)

**Why this step:** setup checks `whisper-server`, `ffmpeg` and `corgi`, and takes over the settings and models of the old `corgi voice` instead of downloading them again.

**Needs:** Step 1

**Run:**

```
corgi-voice --setup
```

**What you should see:** `[ok]` lines for `whisper-server`, `ffmpeg`, `corgi`, the `base.en` model and the speech filter, a notice that settings were copied from the old location (first run only), notices that the model files were taken from the old cache after their SHA-256 matched (a few seconds of hashing, no download progress), and exit status 0.

**If you see something else:** `[missing] corgi` with an alias hint means your `corgi` is a shell alias; pass `--corgi` with the executable's path. A download bar means the old cache did not have that model; a "checksum does not match" notice means the old file was not taken and a fresh copy is downloaded.

**Result:** passed (agent). `[taken]` base.en, large-v3-turbo and the Silero filter from `~/.cache/corgi/voice` after their SHA-256 matched (hard links, 2 links each), `[ok]` for whisper-server, ffmpeg, corgi, the model and the filter, `Voice is ready`, exit 0 in 2.6 s. No settings notice: there was no old `voice.json` to copy. Note: setup accepted `~/.local/bin/corgi`, an old release that cannot talk to the running Corgi (see step 5).

### Step 4 of 9: Open a safe target pane (US1)

**Why this step:** dictation types into the focused pane, so the target must be harmless.

**Do:**

1. In your Corgi viewer, open a new shell pane in any workspace.
2. Run `cat` in it and leave it focused.

**What you should see:** an empty `cat` pane with the cursor waiting for input.

**If you see something else:** nothing to worry about yet; any pane that only echoes input will do.

**Result:** passed (user, checked by agent). Viewer 4 (watched) reported focused pane 822 in the corgi-voice folder, not exited or hibernated. Its command shows as `bat` (the shell aliases cat to bat), which reads the terminal like cat.

### Step 5 of 9: Start the voice window (US1, US3)

**Why this step:** the header must name the pane the text will go to, found through `corgi list`.

**Needs:** Steps 3 and 4

**Do:**

1. In a separate terminal (not a Corgi pane), run `corgi-voice`.
2. Look at the header and the mode row.

**What you should see:** the window with the level meter moving as you speak, mode `Listening`, and the target shown as the `cat` pane's label (for example `cat · <folder>`). Switching focus in Corgi to another pane changes the label within about 2 seconds.

**If you see something else:** "no viewer attached" means no viewer reports a focused pane; "Corgi unreachable" shows the reason from `corgi`.

**Result:** passed (user) on the second try. First start: Target `Corgi unreachable: {"ok":false,"err":"JSON Parse error: Unexpected identifier \"HTTP\"}`. Cause: corgi-voice ran `~/.local/bin/corgi` (release 20261027T002826Z), which cannot talk to the running custom-build Corgi and lacks `machine list`; the user's shell `corgi` is an alias for `corgi-integration/dist/corgi-custom`. Fixed by setting `corgi` to that path in `~/.local/state/corgi-voice/voice.json` (FR-003). Second start: Target `bat · corgi-voice`, Mode Listening.

### Step 6 of 9: Dictate two sentences (US1)

**Why this step:** the core promise: speech becomes typed text in the focused pane, never submitted.

**Needs:** Step 5, the `cat` pane focused again

**Do:**

1. Say "hello from corgi voice", pause about 3 seconds.
2. Say "second sentence", pause.

**What you should see:** `hello from corgi voice second sentence` (Whisper casing and punctuation) appears on one line in the `cat` pane, joined by one space, with no newline; the history shows both as delivered.

**If you see something else:** a `✗` row shows why delivery failed (for example "pane gone"); text appearing elsewhere would be a bug in target resolution.

**Result:** passed (user, log checked by agent). The pane shows `Hello from QuokYuoys. Second sentence.` on one line, joined by one space, no newline. Log: utterances 7 and 8 `delivered machine=local pane=822`, 100 and 97 ms; transcription 56 to 201 ms. Whisper base.en heard "corgi voice" as "QuokYuoys" (recognition, not delivery). An earlier utterance (6) went to pane 817 while focus was elsewhere during step 5.

### Step 7 of 9: Mute in the tool (US4)

**Why this step:** mute now lives only in the voice window.

**Needs:** Step 6

**Do:**

1. Press `m` in the voice window.
2. Say a sentence, pause.
3. Press `m` again.

**What you should see:** mode `MUTED`, nothing typed in the `cat` pane and no history row for the muted sentence; after the second `m` the mode returns to `Listening`. Corgi's sidebar shows nothing about voice.

**If you see something else:** text typed while muted is a bug.

**Result:** passed (user, log checked by agent). MUTED shown, nothing typed, Listening again after the second `m`; no `delivery:` line and no row for the muted sentence.

### Step 8 of 9: Record a short transcript (US5)

**Why this step:** recording writes a plain text file the notes workflow reads, separate from dictation.

**Needs:** Step 5

**Do:**

1. Press `r`, then Enter on the suggested `YYYY-MM-DD-.txt` name (type a word before `.txt` if you like).
2. Say two sentences with a short pause, wait 3 seconds, then say a third.
3. Press `v` to see the reading view, then `R` to stop.
4. Run the command below in another terminal.

**Run:**

```
ls -t ~/.local/share/corgi/transcripts | head -1 | xargs -I{} cat ~/.local/share/corgi/transcripts/{}
```

**What you should see:** a red `REC` while recording and mute switched on; the reading view showed blocks with start times; the file holds one line per passage with one blank line before the passage after the long pause; nothing was typed into the `cat` pane; after `R` the mute is back to its earlier state.

**If you see something else:** an error row naming the file means it could not be written; text in the `cat` pane means the recording did not mute dictation.

**Result:** passed (user, file and log checked by agent), with a bug to fix later. `2026-11-20-test.txt`, mode 0600: three passages, one per line, one blank line between contributions, none at the top; utterances 20, 22, 26 `recorded (muted)`, nothing typed. The first two sentences were one passage (pause under the 1 s recording silence). Bug: `recording: stopped ... waited_ms=10001 late=0`: stop waited the full 10 s for background noise the segmenter took for speech still going (utterance 29, 17.3 s), although by 005 FR-004a speech that goes on past a stop does not belong to the recording. Also noted: the file prompt has no folder browser (FR-021); the user wants Tab completion of folder names as a follow-up.

### Step 9 of 9: Dictate into a remote machine (US2)

**Why this step:** remote panes are reached through Corgi's own machines, without the old SSH bridge.

**Needs:** Step 5, a reachable Corgi remote machine

**Do:**

1. Switch your viewer to a remote machine (for example `marovo`) and focus a `cat` pane there.
2. Say a sentence, pause.

**What you should see:** the header names the remote machine and pane; the text appears in the remote `cat` pane without a newline, within about a second of local speed.

**If you see something else:** "<machine> unreachable" in the header means the machine does not answer `corgi --machine <name> list`; check `corgi machine status <name>`.

**Result:** skipped: no remote machine reachable from this laptop (SSH to marovo is refused, publickey). Remote delivery is covered only by the fake-corgi tests.

## Not covered here

- Delivery latency targets (SC-002, SC-003) are only judged by feel here; exact numbers need `--verbose` and the log at `~/.local/state/corgi-voice/voice.log`.
- The threshold gauge and option menus (US7) are covered by the automated UI tests; try `t`, `?` and the options lines by hand if you like.

## Coverage

The journey covers US1 (steps 4 to 6), US2 (step 9), US3 (step 5), US4 (step 7), US5 (step 8) and US6 (steps 1 and 3). US7 (tuning) is covered by automated tests only.

## Results

Run on 2026-11-20 with the user at the microphone: 9 steps, 8 passed, 0 failed, 1 skipped (remote). corgi-voice installs with Bun alone, takes over the old models without downloading, types dictation into the focused Corgi pane of an unmodified Corgi in about 100 ms per delivery without ever pressing Enter, mutes on its own, and records transcripts in the shape the notes workflow reads.

Found on the way:
- `bun link` does not put the command on PATH when `~/.bun/bin` is missing from it (README fixed).
- `--setup` accepts a `corgi` that cannot reach the running Corgi, and the window's error does not hint that the command may be the wrong build.
- Stopping a recording waits the full 10 s when background noise keeps the segmenter in speech.
- The recording prompt should complete folder names with Tab.
