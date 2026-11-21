# Implementation Plan: Walkthrough Fixes

**Branch**: `002-walkthrough-fixes` | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-walkthrough-fixes/spec.md`

## Summary

Three small, independent changes to corgi-voice: release a recording's hold on the passage in progress as soon as its speech provably went on past a stop or pause (recorder plus one call from the session per frame); Tab completion of folders in the recording file prompt (a pure completion module plus prompt state); and a `list --json` reachability probe in setup with a classification table and a hint in the voice window. Decisions are in [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript (strict) on Bun 1.4+

**Primary Dependencies**: none at runtime; dev: `typescript`, `@types/bun`

**Storage**: none new

**Testing**: `bun test`, fake `corgi` (`tests/fixtures/fake-corgi.ts`), temporary folders, generated PCM frames

**Target Platform**: macOS on Apple Silicon, Linux amd64

**Project Type**: single-project CLI / terminal UI

**Performance Goals**: release of a hold within one frame (20 ms) of the evidence; Tab completion answers within one redraw (reads one folder)

**Constraints**: no native code; Corgi only through the commands in spec 001's contract (this adds no new command, `list --json` is already allowed); the probe never touches panes

**Scale/Scope**: about 300 lines of code plus tests across 6 files

## Constitution Check

The constitution is still the unfilled template; no gates. Spec 001's rules hold: `src/corgi/` is the only code that spawns `corgi`, no `--enter`, no native code. Post-design re-check: passes.

## Project Structure

### Documentation (this feature)

```text
specs/002-walkthrough-fixes/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/setup-output.md
└── tasks.md
```

### Source Code (changes)

```text
src/voice/recorder.ts     # letGoIfContinued(): release a held passage whose speech reached/passed the stop or pause time
src/voice/session.ts      # call recorder.letGoIfContinued() at the end of frame(), after the segmented() loop, while a passage is in progress
src/ui/complete.ts        # NEW: pure folder completion (segment split, base folder, matches, common prefix)
src/ui/prompt.ts          # Tab handling, cycling state, match list line under the field
src/corgi/errors.ts       # reachability table: not_running, no_answer, mismatch patterns; isMismatch(reason)
src/corgi/command.ts      # checkReachable(cmd): list --json probe, 3 s bound, classified result
src/voice/setup.ts        # [ok] / [note] / [mismatch] line, exit 1 on mismatch
src/corgi/viewers.ts      # Resolution.source: the machine whose error forms the reason
src/voice/link.ts, src/corgi/link.ts  # Seen.source passed through
src/corgi/poller.ts       # refused() moved to errors.ts
src/ui/ui.ts              # hint after the local reason in the status line; one history notice
README.md                 # Tab completion, troubleshooting entry
tests/voice/recorder.test.ts, tests/voice/session.test.ts, tests/ui/complete.test.ts (NEW),
tests/ui/prompt.test.ts, tests/corgi/errors.test.ts, tests/corgi/command.test.ts,
tests/voice/setup.test.ts, tests/ui/ui.test.ts
```

**Structure Decision**: Single project; completion logic in its own pure module so it is testable against temporary folders without the prompt.

## Key Design Points

1. **Hold release (FR-001 to FR-003).** The recorder already holds the session's passage in progress at a stop (`stop()` → `reserve(r)`) and a pause (`pause()` → `reserve(r)`), and knows `speechEnd()` through `track()`. New `letGoIfContinued()` releases the held passage in progress of a paused or stopping recording. The release boundary is `speechEnd() >= r.spans.at(-1).to`, the same rule `ranAt` uses, and release goes through the existing `release(u)`. The session calls it once at the end of each frame, after the `segmented()` loop, while `this.current` exists (not right after `push`: a cap cut leaves the segmenter active for the continuation). `ranAt` (`at < to`) stays the assignment rule, so a passage whose speech ended exactly at the stop is not written, consistent with "reaches or passes".
2. **Completion (FR-004 to FR-007).** `complete(before: string, ctx: {folder, home, list(dir) → entries})` splits `before` at the last `/` into parent and segment; resolves the parent (`~/…` → home, `/…` → absolute, else relative to the transcript folder, refused when it escapes it through `..`); lists folders (directories and symlinks to directories), hides dot names unless the segment starts with `.`, filters by case-sensitive prefix, sorts by code point. Returns `{ text, parent, matches }`: one match → `parent + name + "/"`; several → `parent + common prefix`. `FilePrompt` keeps `{ parent, matches, index }` after a Tab that found several; the next Tab replaces the segment with `matches[index] + "/"` and advances (wrapping); any other key clears the state. The match list (first 8, then `+N more`) renders on the line under the field, in place of the note while it is shown. Read errors give no matches.
3. **Reachability (FR-008 to FR-011).** `errors.ts` gets one table: `not_running` (`NoRuntime`, `ConnectionRefused`, `ECONNREFUSED`), `no_answer` (`RequestTimedOut`, our own bound), `mismatch` (`JSON Parse error`, `unknown command`, `Unexpected`), and `classify(text, timedOut)`. `command.ts` gets `checkReachable(cmd)`: runs `cmd list --json` (3 s bound), reads the `err` of an `{"ok":false}` stdout reply else the first stderr line (same helpers as the poller: `jsonFrom`, `firstLine`), and returns `ok` when `parseReply` accepts the reply (empty `viewers` included), else the class (unmatched → mismatch). Setup prints `[ok] corgi <path>`, `[note] corgi: Corgi is not running; could not check that <path> talks to it`, `[note] corgi: no answer in time`, or `[mismatch] corgi <path> cannot talk to the running Corgi: <first line>` plus the hint line, and exits 1 on mismatch. The window: when the reason's `source` is `local` and either `why` is `not_understood` or `isMismatch(reason)`, the status line appends `; set "corgi" in voice.json to the corgi your Corgi runs`, and the UI pushes one notice per distinct reason (not repeated every second).

## Phasing

1. Hold release with tests (US1).
2. Completion module and prompt (US2).
3. Reachability table, probe, setup and window hint (US3).
4. README and full suite.

## Complexity Tracking

None.
