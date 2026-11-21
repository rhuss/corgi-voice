# Idea Inbox

Ideas captured from code reviews for future brainstorming.

### delivery-queue-wedge

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 001-corgi-voice-extraction
- **Summary**: A delivery queue chained without a rejection handler would stop every later delivery after one unexpected exception.

> No current path throws there, but a future change could silently stop dictation.

### single-delivery-bound

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 001-corgi-voice-extraction
- **Summary**: One delivery is bounded three times (link timer, subprocess timeout, session safety net).

> Only the link's bound abandons the process; the others obscure which timer decides.

### one-ui-update-model

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 001-corgi-voice-extraction
- **Summary**: The session keeps change listeners nobody subscribes to while the window repaints on a 20 Hz timer.

> Two update models; pick one (events plus a meter tick, or the timer alone).

### whisper-server-no-auth

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 001-corgi-voice-extraction
- **Summary**: whisper-server listens on 127.0.0.1 without authentication; a fixed port removes the only protection.

> Inherited from the source design; document it or move to a socket or key when whisper-server supports one.

### kill-subprocess-group

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 001-corgi-voice-extraction
- **Summary**: Timed-out helper calls signal only the direct child, not grandchildren such as ssh.

> If corgi does not take its ssh child down on SIGTERM, abandoned polls could pile up for unreachable machines.

### os-level-instance-lock

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 001-corgi-voice-extraction
- **Summary**: The path-based single-instance lock keeps a narrow window when a reaper dies mid-reap; flock would close it but bun:ffi is banned.

> Decide whether a native lock primitive is worth relaxing the no-FFI rule.

### lock-reaper-windows

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 001-corgi-voice-extraction
- **Summary**: Each path-based reaper design (rename aside, reaper turn) leaves a narrow multi-process race.

> Track alongside os-level-instance-lock; any path protocol needs an OS primitive to be airtight.

### recording-stop-waits-on-noise

- **Source**: walkthrough
- **Date**: 2026-11-20
- **Reference**: 001-corgi-voice-extraction (RUNBOOK step 8)
- **Summary**: Stopping a recording waited the full 10 s (`waited_ms=10001 late=0`) because background noise above the recording threshold kept the segmenter in speech; speech still going at stop does not belong to the recording (005 FR-004a), so stop should not wait for it.

> Bug. Reproduce with noise above threshold 20 at the moment `R` is pressed.

### prompt-folder-tab-completion

- **Source**: walkthrough (user request)
- **Date**: 2026-11-20
- **Reference**: 001-corgi-voice-extraction FR-021
- **Summary**: The recording file prompt lost Corgi's folder browser; the user wants Tab completion of folder names in the name field instead of a browser.

> Small feature in src/ui/prompt.ts.

### setup-checks-corgi-reaches-runtime

- **Source**: walkthrough
- **Date**: 2026-11-20
- **Reference**: 001-corgi-voice-extraction FR-003, FR-004 (RUNBOOK steps 3 and 5)
- **Summary**: `--setup` reported `[ok] corgi` for an old release that could not talk to the running Corgi (`JSON Parse error: Unexpected identifier "HTTP"`); setup should try `list --json` and warn, and the window's error should hint that the `corgi` command may not match the running Corgi (set `corgi` in voice.json).

> Two small changes: a reachability check in setup, a hint for protocol-looking errors.

### reach-classify-first-line

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 002-walkthrough-fixes
- **Summary**: Setup's probe classifies all of corgi's standard error while FR-008 says the first line, so setup and the window can disagree on one failure.

> Either update the FR-008 wording (all of the text is more robust for Bun errors) or classify the first line only.

### tab-cycle-accept-descend

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 002-walkthrough-fixes
- **Summary**: While Tab cycles through matches there is no way to accept one and go a level deeper; another key has to end cycling first.

> Matches FR-005; zsh menu users may expect `/` to accept the match.

### completion-lexical-containment

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 002-walkthrough-fixes
- **Summary**: Completion and resolve keep names inside the transcript folder as written, not on disk: a link inside it to a folder outside is offered and accepted.

> As the spec asks; compare real paths if a guarantee on disk is ever wanted.

### bidi-characters-on-screen

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 002-walkthrough-fixes
- **Summary**: `spaced()` keeps bidi and format characters, and folder completion is a new way for them to reach the screen.

> No escape injection, but a name can look like another; extend `controls` if spoofing matters.

### probe-kill-process-group

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 002-walkthrough-fixes
- **Summary**: A timed-out subprocess is killed, but not its process group, so a `corgi` wrapper script that does not `exec` leaves the real process running.

> Spawn detached and kill the group if it ever matters.

### fr011-end-to-end-test

- **Source**: deep-review
- **Date**: 2026-11-20
- **Reference**: 002-walkthrough-fixes
- **Summary**: No single test drives a mismatch reply from the fake corgi through poller, link, session and window to the hinted status line.

> Each layer is tested on its own; one end-to-end test would pin the walkthrough scenario.

### slim-control-entry

- **Source**: deep-review
- **Date**: 2026-11-21
- **Reference**: 003-control-channel
- **Summary**: A control command (`--toggle-mute`, `--status`) loads every window module before it reaches the control branch in main.ts.

> Import cost is the largest controllable part of FR-009's 200 ms spawn-to-exit budget and grows with each window feature; lazy imports or a slim control entry would keep it flat.

### control-current-is-broadcast

- **Source**: deep-review
- **Date**: 2026-11-21
- **Reference**: 003-control-channel
- **Summary**: `current()` in the control server reads like a getter but is the broadcast to watchers; toggle calls it twice.

> A later harmless-looking call would emit watcher lines from unexpected places; a name like `refresh()` would say what it does.

### tmp-fallback-squatting

- **Source**: deep-review
- **Date**: 2026-11-21
- **Reference**: 003-control-channel
- **Summary**: On a shared /tmp another user can create `corgi-voice-<uid>` first; the checks refuse it, which denies the control channel.

> Fails closed and is safe; a README note or a less predictable name derived the same way by server and client would help.
