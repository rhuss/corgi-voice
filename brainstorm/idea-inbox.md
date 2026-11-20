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
