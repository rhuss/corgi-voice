# Research: Walkthrough Fixes

## R1. Why stop waited 10 s

- Decision: release the held passage from the recorder when the speech detector's provisional `speechEnd` reaches or passes the stop or pause moment, checked once per frame.
- Evidence: walkthrough log `recording: stopped ... waited_ms=10001 late=0` then `utterance 29: muted duration=17.3s`. `stop()` reserves the passage in progress; only `claim()` (when the utterance ends) or `unreserve()` (in `closed()`, after the bound) settled it.
- Alternatives: a shorter bound for held passages (heuristic, still waits); no hold at all (loses a passage spoken just before `R`, against Corgi 005 FR-004a).

## R2. Completion model

- Decision: shell-like completion of the segment before the caret against folders only, case-sensitive, code point order, cycling on repeated Tab, first 8 matches shown.
- Rationale: the prompt is one field with readline keys; shells are the user's model. Folders only because the suggested name already names the file; completing files (to append) is a later option.
- The suggested name sits after the caret (`2026-11-20-|.txt`), so the user completes a folder in front of it after Ctrl+A or Home.

## R3. Classifying `corgi list --json` failures

- Observed: an older `corgi` against a newer running Corgi answers `{"ok":false,"err":"JSON Parse error: Unexpected identifier \"HTTP\""}`; `corgi machine list` on it answers `unknown command machine; see corgi --help`.
- Not running: `NoRuntime`, `ConnectionRefused` (as the existing error table already treats them as unreachable).
- Slow: our 3 s bound or `RequestTimedOut`.
- Decision: setup treats anything else as a mismatch (exit 1); the window hints only on explicit mismatch patterns and on a local reply without `viewers`, to avoid wrong hints for transient errors.
