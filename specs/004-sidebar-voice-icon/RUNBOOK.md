---
runbook_version: 1
feature: 004-sidebar-voice-icon
status: passed
mode: light
steps_total: 11
step_results: skipped,skipped,skipped,skipped,skipped,skipped,skipped,skipped,skipped,skipped,skipped
drafted_at: 38d3de1
drafted_fingerprint: 3c61ea8a095c38cb922cf67baee9db41744699494ab5b7cf1884b79a73ee1473
tested_at: 2ea565e
tested_fingerprint: 3c61ea8a095c38cb922cf67baee9db41744699494ab5b7cf1884b79a73ee1473
updated: 2026-11-23
---

# Try it: Sidebar Voice Icon

<!-- runbook-status -->
> **Status:** passed · 11 of 11 steps (11 skipped) · Mode: light · Tested at 2ea565e · 2026-11-23
<!-- /runbook-status -->












## What you're testing

corgi-voice can now run as a Corgi trick (`--trick`) that keeps one item in Corgi's sidebar title row, left of `[ + ]`: `♫` in the accent color while listening, `♫` faint while muted, a red `●` while recording and an amber `●` while a recording is paused. Clicking `♫` toggles mute. `--install-trick` installs the trick into Corgi's tricks folder.

The journey: run the automated checks, start a voice window from this worktree, drive the trick by hand on the terminal (no Corgi involved) to see its JSON lines follow mute changes and presses, then install it into Corgi, reload Corgi's tricks and watch the real icon.

## Test environment

No fixtures started by the agent. Everything runs from this worktree (`bun src/main.ts`), so the installed `corgi-voice` on `main` is not used. Steps 2 to 6 use a voice window you start yourself (step 2). Steps 8 to 11 need the running Corgi to be a build that contains tals/corgi#74 and tals/corgi#198; the user's `corgi` is `/Users/rhuss/Development/context-engineering/corgi-integration/dist/corgi-custom`.

## Steps

### Step 1 of 11: Run the automated checks (US1, US2, US3)

**Why this step:** the trick, the install and the flag handling are covered by tests that need no microphone or Corgi; they should pass before anything is tried by hand.

**Run:**

```
bun test tests/trick tests/control tests/main.test.ts tests/contract.test.ts && bun run check
```

**What you should see:** all tests pass (`0 fail`) and `tsc --noEmit` prints no errors.

**If you see something else:** a failing timing test under load may be a flake; rerun that one file before treating it as a regression.

**Result:**

### Step 2 of 11: Start the voice window from this worktree (US1)

**Why this step:** the trick shows the state of a running corgi-voice; without one it shows nothing.

**Needs:** no other corgi-voice running (quit any open one first).

**Do:**

1. In a separate terminal, `cd` into this worktree and run `bun src/main.ts`.
2. Leave it listening (not muted) and keep it visible.

**What you should see:** the voice window starts and shows Listening.

**If you see something else:** "already running" means another corgi-voice holds the lock; quit it first.

**Result:**

### Step 3 of 11: Run the trick by hand (US1)

**Why this step:** shows the exact line the trick sends to Corgi for the current state, without Corgi in the loop.

**Needs:** step 2.

**Run:**

```
{ printf '{"event":"ready","version":2,"config":{},"kv":{}}\n'; sleep 1; } | bun src/main.ts --trick; echo "exit=$?"
```

**What you should see:** one line `{"op":"ui.set","key":"voice","view":{"kind":"title","spans":[{"text":"♫"}],"color":"accent","action":"toggle-1","slot":"voice"}}`, then (input ended) a `ui.remove` line for the drawn item or nothing more, and `exit=0` within about a second.

**If you see something else:** no `ui.set` and a `corgi-voice trick: ... not reachable` line on stderr means the window from step 2 is not running from this worktree or uses another socket path.

**Result:**

### Step 4 of 11: Mute changes the item (US1)

**Why this step:** the item must follow mute changes made anywhere (here: the 003 hotkey command).

**Needs:** step 2, voice listening.

**Run:**

```
{ printf '{"event":"ready","version":2,"config":{},"kv":{}}\n'; sleep 1; bun src/main.ts --toggle-mute >/dev/null; sleep 1; bun src/main.ts --toggle-mute >/dev/null; sleep 1; } | bun src/main.ts --trick
```

**What you should see:** three `ui.set` lines in this order: `♫` `accent`, `♫` `faint`, `♫` `accent` (each with a new `toggle-N` action); the voice window shows MUTED and then Listening again, with history rows `muted from outside` and `unmuted from outside`.

**If you see something else:** only one line means the trick did not receive watch updates.

**Result:**

### Step 5 of 11: A press toggles mute (US2)

**Why this step:** a click on the icon arrives at the trick as a `ui.press` event; it must send exactly one toggle.

**Needs:** step 2, voice listening.

**Run:**

```
{ printf '{"event":"ready","version":2,"config":{},"kv":{}}\n'; sleep 1; printf '{"event":"ui.press","action":"toggle-1","viewer":1}\n'; printf '{"event":"ui.press","action":"toggle-1","viewer":1}\n'; sleep 1; } | bun src/main.ts --trick; bun src/main.ts --status
```

**What you should see:** a `♫` `accent` line with `toggle-1`, then exactly one more `ui.set` with `♫` `faint` and `toggle-2` (the second press on `toggle-1` is ignored); `--status` prints `muted · ...`; the window shows MUTED with `muted from outside`.

**If you see something else:** two further lines, or the status back at listening, means the duplicate press toggled again.

**Result:**

### Step 6 of 11: Unmute again and check the recording dot (US1, US2)

**Why this step:** while a recording runs the item turns into a dot that cannot be pressed.

**Needs:** step 2.

**Do:**

1. Run `bun src/main.ts --unmute` in this worktree.
2. In a second terminal in this worktree, run `{ printf '{"event":"ready","version":2,"config":{},"kv":{}}\n'; sleep 30; } | bun src/main.ts --trick`.
3. Within those 30 seconds, start a recording in the voice window (`r`, accept the file prompt), pause it, resume it, and stop it.

**What you should see:** `♫` `accent` first; on start a `●` `hot` line without `action` and `slot`; on pause `●` `warm`; on resume `●` `hot`; after stop back to `♫` with a new action, in the color of the mute state.

**If you see something else:** a `♫` line while the recording runs means the recording state is not taking precedence.

**Result:**

### Step 7 of 11: Install the trick into Corgi's tricks folder (US3)

**Why this step:** one command must write a working manifest with absolute paths and the socket path, since Corgi starts tricks with a reduced environment.

**Run:**

```
bun src/main.ts --install-trick; echo "exit=$?"; command cat "${XDG_CONFIG_HOME:-$HOME/.config}/corgi/tricks/corgi-voice/trick.toml"
```

**What you should see:** `Installed the corgi-voice trick: <path>/corgi-voice/trick.toml`, `Next: corgi tricks reload, then corgi tricks list`, `exit=0`; the manifest has `version = 1`, `id = "corgi-voice"`, a `command` starting with a stable bun path (such as `/opt/homebrew/bin/bun`, not a versioned Cellar path) followed by this worktree's `src/main.ts` and `--trick`, and `[config]` with `socket = "/Users/rhuss/.local/state/corgi-voice/control.sock"`.

**If you see something else:** `exit=1` with a reason means the folder is not writable.

**Result:**

### Step 8 of 11: Check the running Corgi has title items (US1)

**Why this step:** the icon needs a Corgi with Tricks (tals/corgi#74) and title items (tals/corgi#198); without #198 Corgi refuses the item.

**Run:**

```
cd /Users/rhuss/Development/context-engineering/corgi-integration && scripts/custom-build list | grep -E 'tals/corgi#(74|198)'
```

**What you should see:** two lines, one for `tals/corgi#74` and one for `tals/corgi#198`, and the running Corgi was rebuilt and restarted after #198 was added.

**If you see something else:** no `#198` line means the custom build lacks title items: add it (`scripts/custom-build add tals/corgi#198`, `rebuild`), restart Corgi, or skip steps 9 to 11.

**Result:**

### Step 9 of 11: Reload Corgi's tricks (US3)

**Why this step:** Corgi picks up a newly installed trick folder on reload.

**Needs:** steps 7 and 8.

**Run:**

```
/Users/rhuss/Development/context-engineering/corgi-integration/dist/corgi-custom tricks reload && /Users/rhuss/Development/context-engineering/corgi-integration/dist/corgi-custom tricks list
```

**What you should see:** `corgi-voice` listed as enabled and running, with no error.

**If you see something else:** a failed status with a reason (for example a missing program path) points at the manifest from step 7.

**Result:**

### Step 10 of 11: See and click the icon in Corgi (US1, US2)

**Why this step:** the real goal: the voice state in the sidebar title row, clickable like #36's indicator.

**Needs:** steps 2 and 9, voice listening.

**Do:**

1. Look at Corgi's sidebar title row, left of `[ + ]`.
2. Click the `♫`, then click it again.
3. Press `m` in the voice window twice.
4. Start a recording in the voice window, click the dot, then stop the recording.

**What you should see:** `♫` in the accent color; the first click turns it faint and the window shows MUTED (`muted from outside`), the second click brings back listening; `m` changes the icon within a second; during the recording a red `●` that does nothing when clicked; after stopping, `♫` again.

**If you see something else:** no item at all: check `corgi tricks list` and Corgi's `server.log` for a `corgi-voice` error.

**Result:**

### Step 11 of 11: Quit and restart corgi-voice (US1)

**Why this step:** the icon must disappear when no corgi-voice runs and come back on its own.

**Needs:** step 10.

**Do:**

1. Quit the voice window (`q`).
2. Start it again with `bun src/main.ts` in this worktree.

**What you should see:** the icon disappears within a second of quitting and returns within 3 seconds of the window being ready, without reloading Corgi's tricks.

**If you see something else:** an icon that stays after quitting means the trick did not notice the closed watch.

**Result:**

## Not covered here

- Remote machines: Corgi shows title items only from the viewer's first daemon, and no remote machine is reachable from this laptop; the trick's "stay quiet without a socket" behavior is covered by automated tests.
- The installed manifest from step 7 points at this worktree's `src/main.ts`. After the branch is merged and the worktree removed, run `corgi-voice --install-trick` once from the installed corgi-voice and `corgi tricks reload`, or the trick shows as failed.

## Coverage

- US1 (see the state): steps 1, 3, 4, 6, 8, 10, 11.
- US2 (click to toggle): steps 1, 5, 6, 10.
- US3 (install): steps 1, 7, 9.

## Results
