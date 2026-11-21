# Research: Control Channel

## R1. Transport

- Decision: Unix domain socket via `Bun.listen({ unix })` and `Bun.connect({ unix })`, JSON lines, one request per connection.
- Rationale: answers (the hotkey can print the new state), push for watchers, file permissions as access control, no port. Signals give no answer and only a toggle; a state file needs polling (brainstorm approaches B and C).

## R2. Socket path

- `$XDG_RUNTIME_DIR/corgi-voice.sock` when set, else `<state folder>/control.sock`. macOS limits `sun_path` to 104 bytes (103 plus NUL); when the path is longer, both sides use `$TMPDIR/corgi-voice-<uid>/control.sock`, the folder created 0700 and used only when owned by the user and not group or world writable.

## R3. Start-up cost of the commands

- The commands must finish in 200 ms. `bun src/main.ts --help` takes 30 to 50 ms with all of main.ts's static imports (bare Bun 20 to 30 ms), so the budget holds without restructuring; the hand-run benchmark checks it.

## R4. Change detection

- The session has an unused `on("change")`; the recorder has none. Add `recorder.on("change")` fired after start, pause, resume, stop and close. The server compares the computed state with the last sent one (ignoring `updated_at`) so watchers see each change once.
