# Quickstart Validation: Control Channel

1. `bun run check && bun test`: all pass.
2. Start `corgi-voice` in one terminal. In another: `corgi-voice --status` prints `listening · <target>`; `corgi-voice --toggle-mute; echo $?` prints `muted · <target>` and `0`, and the window shows MUTED with a `muted from outside` row.
3. `corgi-voice --watch` prints the current state, then a line per change (press `m`, `r`, `R` in the window).
4. Quit the window: `corgi-voice --status; echo $?` prints `corgi-voice is not running` and `3`.
5. `bun run bench:toggle`: p95 under 200 ms.
6. Bind `command -v corgi-voice` plus `--toggle-mute` to a key with one README recipe and press it from another app.

## Results

`bun run bench:toggle` (T018), 2026-11-21, Apple M4 Pro, Bun 1.4.4, load average about 5 from other work, two runs of 20:

- Run 1: p50 57 ms, p95 88 ms, max 106 ms
- Run 2: p50 35 ms, p95 43 ms, max 44 ms

p95 stays under the 200 ms budget (FR-009, SC-001) in both runs.
