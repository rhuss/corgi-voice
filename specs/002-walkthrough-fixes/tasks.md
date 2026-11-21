# Tasks: Walkthrough Fixes

**Input**: `specs/002-walkthrough-fixes/` (spec.md, plan.md, research.md, data-model.md, contracts/setup-output.md, quickstart.md)

**Tests**: Required (FR-012). Write each story's tests first and see them fail.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Confirm the baseline: `bun install --frozen-lockfile`, `bun run check` and `bun test` pass on the branch before any change; note the test count in the commit message of the first change

---

## Phase 2: User Story 1 - Stopping a recording closes it promptly (P1)

**Goal**: release the hold on the passage in progress once its speech reaches or passes the stop or pause moment (FR-001 to FR-003).

**Independent Test**: `bun test tests/voice/recorder.test.ts tests/voice/session.test.ts`.

- [X] T002 [US1] Tests in `tests/voice/recorder.test.ts`: (a) stop while the tracked `speechEnd()` stays before `stopped_at`, then the passage is claimed with `speech_end` before the stop: it is written and the close waits for it (unchanged); (b) stop, then `speechEnd()` reaches `stopped_at` exactly and `letGoIfContinued()` runs: the hold is released, `close()` resolves at once with `late=0`, the log line's `waited_ms` is the real wait; (c) same after a pause: hold released, and a later stop does not wait for it; (d) a passage still being transcribed (in `pending`, not the passage in progress) is not touched by `letGoIfContinued()` and the 10 s bound still applies
- [X] T003 [US1] Implement `letGoIfContinued()` in `src/voice/recorder.ts`: for the tracked passage in progress `u` with `u.record = r` and `r.state` `paused` or `stopping`, release when `end = speechEnd()` is not null and `end >= r.spans.at(-1).to` (the same boundary `ranAt` and `unreserve` use, so paused-then-stopped recordings behave the same); release with the existing pattern `this.release(u); u.record = null` (which settles `drained` when nothing is pending); update the `reserve`/`unreserve` comments
- [X] T004 [US1] In `src/voice/session.ts` `frame()`, call `this.deps.recorder?.letGoIfContinued()` at the end of the frame, after the `segmented()` loop and after `this.current` is refreshed, only while `this.current` exists (calling it right after `segmenter.push` would release a passage cut at the cap using its continuation's `speechEnd`); add a test where a passage is cut at the cap after a stop and its speech ended before the stop: it is still written; add a muted variant of the walkthrough case (recording started while muted, noise continues past `R`): the close resolves, `late=0`, and the passage ends as `muted`; add a session test in `tests/voice/session.test.ts` that drives generated frames: continuous loud frames above the recording threshold, `r`, a passage starts, `R` while loud frames continue: the recording closes within the recording silence window plus 100 ms of the stop (SC-001), `late=0`, nothing written for that passage; and the existing "passage in its silence window at a stop is written" test passes unchanged (SC-002)

---

## Phase 3: User Story 2 - Tab completes folders in the recording prompt (P2)

**Goal**: shell-style folder completion (FR-004 to FR-007).

**Independent Test**: `bun test tests/ui/complete.test.ts tests/ui/prompt.test.ts`.

- [X] T005 [P] [US2] Tests in `tests/ui/complete.test.ts` (also: the common prefix is computed on code points, tested with a non-BMP character such as an emoji in two folder names; folder names containing control characters are skipped, never offered) against a temporary folder tree (`meetings/`, `meetups/`, `notes/`, `.hidden/`, a file `old.txt`, a symlink `link -> notes`, an unreadable folder): single match completes to `name/`; several complete the common prefix and return matches in code point order; case-sensitive; files never offered; symlink to a folder offered; dot names only when the segment starts with `.`; empty segment returns every offered folder; `~/` resolves against an injected home; absolute paths; a relative parent escaping the transcript folder through `..` returns no completion; unreadable folder returns no matches without throwing
- [X] T006 [US2] Implement `src/ui/complete.ts`: `complete(before, ctx)` returns `{ text, parent, matches }` (`parent` = the typed text up to and including the last `/`); `ctx` = `{ folder, home, list(dir) }` with a file system default using `readdirSync(dir, { withFileTypes: true })` and `statSync` for symlinks; skip names with control characters. Advisory: macOS may return NFD names; compare as returned and note it in a comment
- [X] T007 [US2] Tests in `tests/ui/prompt.test.ts`: opening shows `2026-11-20-|.txt`; Ctrl+A, `no`, Tab gives `notes/|2026-11-20-.txt`; `me` + Tab gives `meet` and shows the match list under the field; second Tab gives `meetings/`, third `meetups/`, fourth `meetings/` again (wrap); any other key clears the list; Esc still cancels; no match leaves the field unchanged; more than 8 matches shows 8 and `+N more`; control characters in names are shown as spaces
- [X] T008 [US2] Implement Tab in `src/ui/prompt.ts` (add `home?: string` and `list?: (dir: string) => Dirent[]` to `Options` for tests; insert completed text through `[...text]` into `chars`): on `tab` complete the text before the caret, keep the text after it, hold `{ parent, matches, index }` for cycling, clear it on any other key; render the match list line in place of the note while matches are shown; update the module header and the prompt's key line (`tab folder`)

---

## Phase 4: User Story 3 - Setup catches a `corgi` that cannot reach the running Corgi (P2)

**Goal**: probe, classification, setup lines, window hint (FR-008 to FR-011).

**Independent Test**: `bun test tests/corgi tests/voice/setup.test.ts tests/ui/ui.test.ts`.

- [X] T009 [P] [US3] Tests in `tests/corgi/errors.test.ts`: `classify()` maps `NoRuntime`, `ConnectionRefused` to `not_running`; `RequestTimedOut` and a timed-out call to `no_answer`; `JSON Parse error: Unexpected identifier "HTTP"`, `unknown command machine; see corgi --help` to `mismatch`; an unmatched text to `mismatch` for setup; `isMismatch()` true only for the explicit patterns
- [X] T010 [US3] Implement the reachability table and `classify()` / `isMismatch()` in `src/corgi/errors.ts` next to the existing table; the result classes are type literals (`"not_running" | "no_answer" | "mismatch"`), and no new export may be named `no_answer` (that constant already exists for deliveries); move the private `refused()` helper (the `err` of an `{"ok":false}` reply) from `src/corgi/poller.ts` into `errors.ts` and export it, used by both
- [X] T011 [US3] Tests in `tests/corgi/command.test.ts` with the fake corgi: `checkReachable` returns `ok` for a reply with `viewers: []`; `not_running` for an `{"ok":false,"err":"NoRuntime"}` reply; `mismatch` with detail for the walkthrough's JSON parse error; `no_answer` when the fake delays past the bound (use a short injected bound); `mismatch` with detail `Corgi output not understood` for a reply without `viewers`; a spawn failure (command vanished) gives `mismatch` with the `notFound` text; the call is `list --json` and nothing else
- [X] T012 [US3] Implement `checkReachable(cmd, timeoutMs = 3000)` in `src/corgi/command.ts` (stdout `err` via `jsonFrom` and `refused`, else `firstLine(stderr)`; `parseReply` decides `ok`; a reply without `viewers` is `mismatch` with detail `Corgi output not understood`; a spawn error is `mismatch` with the `notFound` text)
- [X] T013 [US3] Tests in `tests/voice/setup.test.ts` for each line of `contracts/setup-output.md` and the exit status (mismatch exits 1; not running and no answer still ready). First give the setup tests' default fake-corgi scenario a local reply `machines: { local: { stdout: '{"viewers":[]}' } }` so the existing tests keep exit 0 (the fake answers an unlisted machine with `UnknownMachine`). Assert exactly one `corgi` line in the output, and that no probe runs when the capability check reports the command missing or too old
- [X] T014 [US3] Wire the probe into `src/voice/setup.ts` after the capability check: the probe result replaces today's `[ok] corgi <cmd>` line (printed only when the probe returns ok); add `deps.reachMs?: number` (default 3000) passed to `checkReachable`
- [X] T015 [US3] Tests in `tests/ui/ui.test.ts`: with the local machine as the source of a mismatch reason, the status line shows exactly `<reason>; set "corgi" in voice.json to the corgi your Corgi runs; retrying every second`; for `why: not_understood` from the local machine: `<reason>; set "corgi" in voice.json to the corgi your Corgi runs; nothing is typed until Corgi answers`; no hint for a remote machine's reason or for `no viewer attached`; the history notice is pushed once per distinct reason, not every poll
- [X] T016 [US3] Add `source: string | null` (the machine whose error forms the reason; null when there is a target or no machine failed) to `Resolution` in `src/corgi/viewers.ts` (`whyNone()` sets it) and to `Seen` (`src/voice/link.ts`, `src/corgi/link.ts` `seen()`), keep it on the session; with `source = "local"` when the local machine is not-understood, else the first not-understood machine's name; for `Corgi unreachable: <err>` the failed machine's name (or null); for `<name> unreachable` that name; declare it `source?: string | null` on `Seen` so existing literals still type-check; in `session.applyViewer()` add `source` to the unchanged check and store it; then implement the hint (inserted before the existing suffix) and the one-time notice in `src/ui/ui.ts` only when `source === "local"`; update viewers and link tests for `source`

---

## Phase 5: Polish

- [X] T017 [P] README: Tab completion in the recording prompt (with the Ctrl+A example) and a troubleshooting entry "Corgi unreachable" for a mismatched `corgi` command (`--setup` output, the `corgi` setting)
- [X] T018 Run `bun run check` and the full `bun test` twice; fix anything; check no em-dash or en-dash characters were added

## Dependencies

- T001 first. US1 (T002 to T004), US2 (T005 to T008) and US3 (T009 to T016) are independent of each other. Within each, tests before implementation. T017, T018 last.

## Parallel Opportunities

- T005 and T009 can start together after T001.
