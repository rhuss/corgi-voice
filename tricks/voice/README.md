# corgi-voice trick

A Corgi trick that shows corgi-voice's state in the sidebar title row, left of `[ + ]`, and mutes or unmutes dictation on a click:

- `♫` in the accent color: listening
- `♫` faint: muted
- `●` red (`hot`): a recording runs; `●` amber (`warm`): it is paused. The dots are not pressable.
- nothing: corgi-voice is not running, or voice cannot listen

Install it with one command instead of copying this folder:

```bash
corgi-voice --install-trick
corgi tricks reload
corgi tricks list
```

The install writes `corgi-voice/trick.toml` into Corgi's tricks folder with absolute paths and the control channel's path. `trick.toml` here is a reference copy that relies on `PATH`.

It needs a Corgi with Tricks and title items: tals/corgi#74 and tals/corgi#198, or a custom build containing both. See the main README's "Voice icon in Corgi" section for details and uninstalling.
