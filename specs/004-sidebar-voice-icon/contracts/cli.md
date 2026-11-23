# Contract: new command-line modes

## `corgi-voice --trick`

- Takes no other flag; any other flag with it is a usage error (exit 2).
- Runs before the working-folder and terminal checks; needs no terminal, takes no lock, reads no `voice.json`, runs no migration.
- Exits 0 when standard input ends. Never exits because corgi-voice is missing.

## `corgi-voice --install-trick`

- Takes no other flag; any other flag with it is a usage error (exit 2).
- Runs before the terminal check (no terminal needed).
- Writes `<tricks dir>/corgi-voice/trick.toml` atomically (see data-model.md), creating folders as needed.
- Prints to standard output:

  ```text
  Installed the corgi-voice trick: <path>
  Next: corgi tricks reload, then corgi tricks list
  ```

- Exit 0 on success; 1 with `corgi-voice: cannot install the trick: <reason>` on standard error on failure (unwritable folder, `socketPath()` refused).

## Usage text

`--help` gains:

```text
corgi-voice --trick | --install-trick
--trick            run as Corgi's sidebar voice icon (started by Corgi)
--install-trick    install that trick into Corgi's tricks folder
```
