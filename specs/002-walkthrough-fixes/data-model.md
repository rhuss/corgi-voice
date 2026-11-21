# Data Model: Walkthrough Fixes

## Held passage (recorder)

Existing: `Utterance.record` points at the recording that holds it, and the recording's `pending` set contains it. New rule: released when `speechEnd() >= hold moment`, where the hold moment is `stopped_at` (state `stopping`) or `paused_at` (state `paused`).

## Completion state (prompt)

| Field | Type | Notes |
|---|---|---|
| `matches` | `string[]` | folder names, code point order |
| `index` | `number` | next match to take on Tab; -1 before the first cycle |
| `parent` | `string` | the typed text up to and including the last `/` before the caret |

Cleared by any key other than Tab.

## Reachability result

`{ kind: "ok" } | { kind: "not_running" | "no_answer" | "mismatch", detail: string }`, where `detail` is the first line of the error (the `err` field of an `{"ok":false}` reply, else stderr).
