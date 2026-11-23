# Quickstart: validate the sidebar voice icon

## Automated

```bash
bun test tests/trick tests/main.test.ts tests/contract.test.ts
bun run check
```

Expected: all pass; the trick tests drive `--trick` over in-memory streams against a real control server with a fake session (no microphone, Whisper or Corgi).

## Manual, without Corgi

```bash
corgi-voice                          # in one terminal
{ printf '{"event":"ready","version":2,"config":{},"kv":{}}\n'; cat; } | corgi-voice --trick
```

Expected: one `ui.set` line with `♫` and `accent` (or `faint` when muted); pressing `m` in the voice window prints a new `ui.set`; typing `{"event":"ui.press","action":"toggle-1"}` (the current action) toggles mute; Ctrl-D exits.

## Live in Corgi

Prerequisite: a Corgi build with tals/corgi#74 and tals/corgi#198 (custom build patch list).

```bash
corgi-voice --install-trick
corgi tricks reload
corgi tricks list                    # corgi-voice listed, running
```

Expected: with corgi-voice running, `♫` appears left of `[ + ]` in the sidebar title row; clicking it mutes/unmutes (the voice window shows "muted from outside"); starting a recording shows a red `●`, pausing an amber `●`; quitting corgi-voice removes the item; restarting it brings the item back within 3 s.

Uninstall: remove `${XDG_CONFIG_HOME:-~/.config}/corgi/tricks/corgi-voice` and run `corgi tricks reload`.
