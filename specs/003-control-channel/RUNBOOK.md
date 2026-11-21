---
runbook_version: 1
feature: 003-control-channel
status: passed
mode: light
steps_total: 7
step_results: passed,passed,passed,passed,passed,passed,passed
drafted_at: 8ebfd3a
drafted_fingerprint: 8a0bb365673f45e7dd6773e515fb02101e97149a2d2bc8bc6094b8f233dd08a6
tested_at: 8180459
tested_fingerprint: 42eb0c33b62935963c3cb0b5794c04aaaa5b4bc4311fb16e669cf3486515b9c7
updated: 2026-11-21
---

# Try it: Control Channel and Hotkey Mute

<!-- runbook-status -->
> **Status:** passed · 7 of 7 steps (7 passed) · Mode: light · Tested at 8180459 · 2026-11-21
<!-- /runbook-status -->








## What you're testing

The running corgi-voice now listens on a local control socket. From any other terminal or a hotkey tool you can mute, unmute and read its state, without switching to the voice window.

Order: tests, the not-running answer, start the window, read the state, toggle mute, watch changes, the speed benchmark, and finally a real global hotkey.

## Test environment

No fixtures. Everything runs from this worktree (`bun src/main.ts`), so the installed `corgi-voice` on `main` is not used. Your running Corgi and microphone are used by the voice window in step 3.

## Steps

### Step 1 of 7: Run the automated checks (US1, US2, US3)

**Why this step:** the channel, the commands and every scenario have tests that need no microphone, Whisper or Corgi.

**Run:**

```
bun run check && bun test
```

**What you should see:** the type check prints nothing and `bun test` ends with about 625 pass and 0 fail.

**If you see something else:** a single failing timing test in `tests/corgi/` or `tests/util/` under heavy load can be a flake; rerun that file alone.

**Result:** passed (agent, 2026-11-21). `bun run check` clean; `bun test` 625 pass, 0 fail (42 files, 113 s). Log: `specs/003-control-channel/.walkthrough/step-1.log`.

### Step 2 of 7: Ask while nothing runs (US1)

**Why this step:** a hotkey pressed while corgi-voice is not running must say so and exit 3, not hang.

**Needs:** no corgi-voice window running (quit any open one first).

**Run:**

```
bun src/main.ts --status; echo "exit=$?"
```

**What you should see:** `corgi-voice is not running` and `exit=3`.

**If you see something else:** a state line means a corgi-voice window is still running somewhere.

**Result:** passed (agent). `corgi-voice is not running`, `exit=3`.

### Step 3 of 7: Start the voice window (US1)

**Why this step:** the channel lives inside the running window.

**Do:**

1. In a separate terminal: `cd` into this worktree and run `bun src/main.ts --verbose`.
2. Focus a harmless pane in Corgi (the `cat`/`bat` pane from earlier walkthroughs).

**What you should see:** the usual voice window, Listening, with the target shown.

**If you see something else:** a notice that the control commands cannot reach it means the socket could not be created; the verbose log says why.

**Result:** passed (user). The window started from the worktree; the verbose log shows `control: listening on /Users/rhuss/.local/state/corgi-voice/control.sock`; no notice about the control channel.

### Step 4 of 7: Read the state (US2)

**Why this step:** scripts and status bars need one short line and the full JSON.

**Needs:** step 3.

**Run:**

```
bun src/main.ts --status; bun src/main.ts --status --json
```

**What you should see:** a line like `listening · bat · corgi-voice`, then one JSON object with `pid`, `muted`, `mode`, `unavailable`, `reason`, `recording`, `target` and `updated_at`.

**If you see something else:** `corgi-voice did not answer` means the window is stuck; `not running` means step 3 did not start it from this worktree.

**Result:** passed (agent). `listening · claude · corgi-voice` (exit 0) and the JSON state with every field (`pid` 95086, `mode` listening, `target` local / `claude · corgi-voice`).

### Step 5 of 7: Toggle mute from outside (US1)

**Why this step:** the core of the feature: mute without switching windows.

**Needs:** step 3.

**Run:**

```
bun src/main.ts --toggle-mute; echo "exit=$?"; bun src/main.ts --toggle-mute; echo "exit=$?"
```

**What you should see:** first `muted · bat · corgi-voice` and `exit=0`, then the listening line and `exit=0`; the voice window shows MUTED and then Listening again, with history rows `muted from outside` and `unmuted from outside`.

**If you see something else:** `exit=1` with `cannot unmute` means voice cannot listen (microphone or server); the window's status line says which.

**Result:** passed (agent, user confirmed in the log). `muted · bat · corgi-voice` exit 0 in 50 ms, then `listening · bat · corgi-voice` exit 0; log rows `control: muted from outside`, `control: unmuted from outside`.

### Step 6 of 7: Watch changes (US2)

**Why this step:** status bars follow changes without polling.

**Needs:** step 3.

**Do:**

1. In another terminal run `bun src/main.ts --watch` (from this worktree).
2. In the voice window press `m`, then `m` again, then `r` and Enter, then `R`.
3. Quit the voice window with `q`.

**What you should see:** a first line with the current state, then one line per change (muted, listening, `· REC`, back without REC), no duplicates; the watch ends by itself when the window quits.

**If you see something else:** no lines after the first means changes are not pushed; repeated identical lines mean duplicates.

**Result:** passed (user keys, agent read the watch). Lines: listening, muted (`m`), listening (`m`), `muted · ... · REC` (`r`: a recording mutes dictation), listening (`R`: mute restored); one line per change, no duplicates; the watch exited 0 when the window quit. Log: `specs/003-control-channel/.walkthrough/step-6.log`.

### Step 7 of 7: Speed and a real global hotkey (US1, US3)

**Why this step:** the command must be fast enough for a hotkey, and the README recipe must work.

**Do:**

1. Run `bun run bench:toggle` and note p95 (target under 200 ms).
2. Restart the voice window (step 3).
3. Follow one recipe from the README section "Mute from anywhere" (macOS Shortcuts, skhd or Hammerspoon), using this worktree's `bun src/main.ts --toggle-mute` or, after merging, the installed `corgi-voice`.
4. Switch to another app and press the hotkey twice.

**What you should see:** p95 well under 200 ms; each press flips the voice window between MUTED and Listening with an `… from outside` row.

**If you see something else:** nothing happening usually means the hotkey tool cannot find `bun`; the README recipe puts Bun's folder on `PATH` for that reason.

**Result:** passed. Benchmark: 20 runs, p50 31 ms, p95 63 ms, max 66 ms (load about 4). Hotkey (user): a macOS Shortcuts Run Shell Script action calling the worktree's `src/main.ts --toggle-mute` with `/opt/homebrew/bin/bun`, bound to a key; both presses toggled the window. Found: the README assumed `bun` lives in `~/.bun/bin`; here it is `/opt/homebrew/bin` (README fixed to derive it from `command -v bun`).

## Coverage

US1 (steps 2, 3, 5, 7), US2 (steps 4, 6), US3 (step 7). The Corgi trick that would show the state inside Corgi is out of scope (waits for tals/corgi#74).

## Results

Run on 2026-11-21 with the user: 7 steps, 7 passed. A running corgi-voice now answers on its control socket: `--status` and `--status --json` describe it, `--toggle-mute` flips mute in about 50 ms (benchmark p95 63 ms) with a history row in the window, `--watch` follows every change and ends with the window, and a macOS Shortcuts hotkey mutes and unmutes from another app. One README fix: the hotkey recipes now take `bun`'s folder from `command -v bun` instead of assuming `~/.bun/bin`.
