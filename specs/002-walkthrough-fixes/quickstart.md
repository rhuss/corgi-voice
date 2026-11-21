# Quickstart Validation: Walkthrough Fixes

1. `bun run check && bun test`: all pass, including the new tests named per scenario.
2. Stop wait: start `corgi-voice --verbose`, start a recording with `r`, keep a fan or music above the recording threshold, press `R`. Expected: the log line `recording: stopped ... waited_ms=` shows at most the recording silence window (about 1000 ms) plus a frame, `late=0`.
3. Tab completion: `mkdir -p ~/.local/share/corgi/transcripts/meetings/2026`, press `r`, Ctrl+A, type `me`, Tab, `2`, Tab. Expected: `meetings/2026/2026-11-20-.txt`, caret before the suggested name.
4. Mismatch: `corgi-voice --setup --corgi ~/.local/bin/corgi` (the old release). Expected: `[mismatch] ... JSON Parse error ...` plus the hint, exit 1. With the custom build: `[ok] corgi ...`.
