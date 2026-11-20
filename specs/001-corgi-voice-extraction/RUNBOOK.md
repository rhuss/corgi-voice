---
runbook_version: 1
feature: 001-corgi-voice-extraction
status: drafted
mode: light
steps_total: 9
step_results: pending,pending,pending,pending,pending,pending,pending,pending,pending
drafted_at: fa5181f
drafted_fingerprint: 824e0f5e9dc8bbc5aac2b6019c4788eae8d1053b3d878f0723d0cf2f35dc144f
tested_at:
tested_fingerprint:
updated: 2026-11-20
---

# Try it: corgi-voice Extraction

<!-- runbook-status -->
> **Status:** drafted · 0 of 9 steps · Mode: light · Drafted at fa5181f · 2026-11-20
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

**Result:**

### Step 2 of 9: Run the automated checks (US1, US2, US3, US5)

**Why this step:** the behaviour that needs no microphone or Corgi (target resolution, delivery, never pressing Enter, recording files) is covered by tests against a stand-in `corgi`.

**Needs:** Step 1

**Run:**

```
bun run check && bun test
```

**What you should see:** the type check prints nothing, and `bun test` ends with about 470 pass and 0 fail.

**If you see something else:** a failing test names the file and case; failures under `tests/corgi/` point at the CLI contract.

**Result:**

### Step 3 of 9: Set up models and check tools (US6)

**Why this step:** setup checks `whisper-server`, `ffmpeg` and `corgi`, and takes over the settings and models of the old `corgi voice` instead of downloading them again.

**Needs:** Step 1

**Run:**

```
corgi-voice --setup
```

**What you should see:** `[ok]` lines for `whisper-server`, `ffmpeg`, `corgi`, the `base.en` model and the speech filter, a notice that settings were copied from the old location (first run only), no download progress when the old cache had the models, and exit status 0.

**If you see something else:** `[missing] corgi` with an alias hint means your `corgi` is a shell alias; pass `--corgi` with the executable's path. A download bar means the old cache did not have that model.

**Result:**

### Step 4 of 9: Open a safe target pane (US1)

**Why this step:** dictation types into the focused pane, so the target must be harmless.

**Do:**

1. In your Corgi viewer, open a new shell pane in any workspace.
2. Run `cat` in it and leave it focused.

**What you should see:** an empty `cat` pane with the cursor waiting for input.

**If you see something else:** nothing to worry about yet; any pane that only echoes input will do.

**Result:**

### Step 5 of 9: Start the voice window (US1, US3)

**Why this step:** the header must name the pane the text will go to, found through `corgi list`.

**Needs:** Steps 3 and 4

**Do:**

1. In a separate terminal (not a Corgi pane), run `corgi-voice`.
2. Look at the header and the mode row.

**What you should see:** the window with the level meter moving as you speak, mode `Listening`, and the target shown as the `cat` pane's label (for example `cat · <folder>`). Switching focus in Corgi to another pane changes the label within about 2 seconds.

**If you see something else:** "no viewer attached" means no viewer reports a focused pane; "Corgi unreachable" shows the reason from `corgi`.

**Result:**

### Step 6 of 9: Dictate two sentences (US1)

**Why this step:** the core promise: speech becomes typed text in the focused pane, never submitted.

**Needs:** Step 5, the `cat` pane focused again

**Do:**

1. Say "hello from corgi voice", pause about 3 seconds.
2. Say "second sentence", pause.

**What you should see:** `hello from corgi voice second sentence` (Whisper casing and punctuation) appears on one line in the `cat` pane, joined by one space, with no newline; the history shows both as delivered.

**If you see something else:** a `✗` row shows why delivery failed (for example "pane gone"); text appearing elsewhere would be a bug in target resolution.

**Result:**

### Step 7 of 9: Mute in the tool (US4)

**Why this step:** mute now lives only in the voice window.

**Needs:** Step 6

**Do:**

1. Press `m` in the voice window.
2. Say a sentence, pause.
3. Press `m` again.

**What you should see:** mode `MUTED`, nothing typed in the `cat` pane and no history row for the muted sentence; after the second `m` the mode returns to `Listening`. Corgi's sidebar shows nothing about voice.

**If you see something else:** text typed while muted is a bug.

**Result:**

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

**Result:**

### Step 9 of 9: Dictate into a remote machine (US2)

**Why this step:** remote panes are reached through Corgi's own machines, without the old SSH bridge.

**Needs:** Step 5, a reachable Corgi remote machine

**Do:**

1. Switch your viewer to a remote machine (for example `marovo`) and focus a `cat` pane there.
2. Say a sentence, pause.

**What you should see:** the header names the remote machine and pane; the text appears in the remote `cat` pane without a newline, within about a second of local speed.

**If you see something else:** "<machine> unreachable" in the header means the machine does not answer `corgi --machine <name> list`; check `corgi machine status <name>`.

**Result:**

## Not covered here

- Delivery latency targets (SC-002, SC-003) are only judged by feel here; exact numbers need `--verbose` and the log at `~/.local/state/corgi-voice/voice.log`.
- The threshold gauge and option menus (US7) are covered by the automated UI tests; try `t`, `?` and the options lines by hand if you like.

## Coverage

The journey covers US1 (steps 4 to 6), US2 (step 9), US3 (step 5), US4 (step 7), US5 (step 8) and US6 (steps 1 and 3). US7 (tuning) is covered by automated tests only.

## Results
