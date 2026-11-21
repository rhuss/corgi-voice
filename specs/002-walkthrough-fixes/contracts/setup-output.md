# Contract: setup lines for the corgi command

After the existing capability check (`pane send --help` lists `--stdin`), setup prints exactly one of:

| Result | Line | Setup status |
|---|---|---|
| ok | `[ok] corgi <path>` | counts as ready |
| not running | `[note] corgi: Corgi is not running; could not check that <path> talks to it` | counts as ready |
| no answer | `[note] corgi: no answer in time` | counts as ready |
| mismatch | `[mismatch] corgi <path> cannot talk to the running Corgi: <first error line>` then `         set "corgi" in voice.json, or pass --corgi, to the corgi your Corgi runs` | exit 1 |

Voice window hint (local machine only, explicit mismatch patterns or a local reply without `viewers`): the status line shows `<reason>; set "corgi" in voice.json to the corgi your Corgi runs`; one history notice per distinct reason.
