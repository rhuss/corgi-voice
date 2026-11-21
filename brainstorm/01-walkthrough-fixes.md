# Brainstorm: Walkthrough Fixes

**Date:** 2026-11-20
**Status:** active

## Problem Framing

The first live walkthrough of `corgi-voice` (spec `001-corgi-voice-extraction`, runbook in `rhuss/corgi-voice`) passed 8 of 9 steps, but it turned up three rough edges that a daily user hits:

1. Stopping a recording with `R` waited the full 10 seconds before closing the file, although nothing was pending.
2. The recording file prompt has no way to pick a folder. `corgi voice` reused Corgi's New workspace dialog with its folder browser; `corgi-voice` has a single name field (spec FR-021).
3. `corgi-voice --setup` reported `[ok] corgi` for a `corgi` that could not talk to the running Corgi, and the voice window then said only `Corgi unreachable: {"ok":false,"err":"JSON Parse error: Unexpected identifier …`.

Success: stopping a recording closes the file as soon as its passages are written, typing a folder in the prompt is quick, and a wrong `corgi` build is caught by setup with a message that says what to do.

Anti-goals: rebuilding Corgi's folder browser, guessing which `corgi` binary the user meant, or making setup fail when Corgi simply is not running yet.

## Findings

### 1. Stop waits on noise

- Walkthrough log: `recording: stopped …/2026-11-20-test.txt waited_ms=10001 late=0`, followed by `utterance 29: muted duration=17.3s`.
- Mechanism (`src/voice/recorder.ts`): `stop()` calls `reserve()`, which holds the utterance in progress for the stopping recording, because its speech may have ended while the recording ran (Corgi 005 FR-004a). The hold is settled only by `claim()` when that utterance ends, or by `unreserve()` when the close times out. Background noise above the recording threshold (20) kept the segmenter in speech for 17.3 s, so the utterance did not end within 10 s and `close()` hit its bound.
- The rule says a passage belongs to the recording state in effect when its speech ended. Speech that is still going after the stop ended after it, so it never belonged to the recording. The hold is only justified while the speech might have ended before the stop, that is, while the frames after the stop are quiet (the silence window has not closed yet).
- `late=0` was right (the held utterance was not this recording's passage), but the 10 s wait was not.

### 2. Folder choice in the prompt

- `src/ui/prompt.ts` (`FilePrompt`) already accepts relative names with sub-folders, `~/` and absolute paths, refuses `..` escapes, and has readline-style editing keys. `src/ui/keys.ts` already reports a `tab` key.
- The user prefers Tab completion over a folder browser (walkthrough, 2026-11-20).

### 3. Wrong `corgi` build passes setup

- The user's shell aliases `corgi` to `corgi-integration/dist/corgi-custom`; `PATH` holds `~/.local/bin/corgi`, an older release (`20261027T002826Z`). That release answers `list --json` with `{"ok":false,"err":"JSON Parse error: Unexpected identifier \"HTTP\""}` against the running custom build and does not know `machine list` (`unknown command machine`).
- Setup only checks `pane send --help` for `--stdin`, which the old release has, so it reported `[ok]`.
- Setting `"corgi"` in `~/.local/state/corgi-voice/voice.json` to the custom build fixed it (spec FR-003 works as designed); the user just had no hint to do so.
- The running Corgi reports `protocol: 5` in `list --json`; a custom build leaves `release_version` empty, so comparing versions is not reliable.

## Approaches Considered

### 1. Stop waiting

**A: Release the hold on new loud audio after the stop.** While a stopping recording holds the utterance in progress, the session checks the segmenter's provisional `speechEnd` on each frame; once it moves past `stopped_at`, the speech went on past the stop, so the hold is released and the recording closes when nothing else is pending. The same applies to a pause.
- Pros: exact application of FR-004a; the wait shrinks to "until the next loud frame or the end of the silence window"; small change in `recorder.ts` plus a hook from the session.
- Cons: one more call per frame while a recording is stopping (cheap).

**B: Shorter bound for a held utterance.** Keep the logic, but give the held utterance at most the silence window instead of 10 s.
- Pros: one-line change.
- Cons: still waits up to the silence window for nothing; a heuristic, not the rule.

**C: Stop holding at all.** Drop the hold at stop.
- Cons: loses the last passage when the user presses `R` right after speaking, which FR-004a exists to prevent.

### 2. Folder choice

**A: Tab completes the name field like a shell.** Tab completes the last path segment against folders (and existing `.txt` files) relative to the transcript folder, `~/` or `/`; a unique match completes with a trailing `/`; several matches complete the common prefix and list up to a few candidates under the field; a second Tab cycles.
- Pros: what the user asked for; fits the single-field prompt; no new screen.
- Cons: needs care with the caret position, the `.txt` suffix after the caret, and the `..` rule.

**B: A folder list under the field.** Rejected by the user in favor of A.

### 3. Wrong `corgi` build

**A: Setup tries `list --json` and classifies the answer.** `ok:true` with a `viewers` array: `[ok] corgi`. No daemon (connection refused, `NoRuntime`): `[note] Corgi is not running; could not check that this corgi talks to it`, setup still succeeds. Anything else (an `ok:false` JSON parse error, an unknown command, no `viewers`): `[mismatch] corgi … cannot talk to the running Corgi`, plus the hint to set `"corgi"` in `voice.json` (or `--corgi`) to the build Corgi runs; setup exits 1.
- Pros: catches the walkthrough case at the step where the user is still looking at setup output.
- Cons: classifying errors by text; keep the patterns in `src/corgi/errors.ts` with the other tested patterns.

**B: The window adds the same hint.** When the local machine's error matches the mismatch patterns, the reason line says so and names the setting, instead of only quoting the JSON.
- Pros: also helps when the build changes after setup.

**C: Compare versions.** Rejected: custom builds report an empty `release_version`.

## Decision

- 1A: release the hold as soon as the speech provably went on past the stop or pause.
- 2A: shell-style Tab completion in the file prompt.
- 3A and 3B together: setup classifies a real `list --json` answer, and the window gives the same hint.

## Key Requirements

- A stop or pause closes (or keeps writing) without waiting for speech that continues past it; the log's `waited_ms` reflects only real pending passages. A passage whose speech ended before the stop is still written (Corgi 005 FR-004a unchanged).
- Regression test: noise above the recording threshold that continues for longer than the 10 s bound after `R` closes the file within the silence window, with `late=0`.
- Tab in the file prompt completes folder names relative to the transcript folder, `~/` or an absolute path; never completes into a path the `..` rule would refuse; the caret stays before `.txt` when the suffix is kept.
- `corgi-voice --setup` reports `[ok]`, `[note]` (Corgi not running) or `[mismatch]` (exit 1) for the `corgi` command, with the hint naming `"corgi"` in `voice.json` and `--corgi`.
- The voice window's reason for a mismatched `corgi` carries the same hint.
- README: a short troubleshooting entry for "Corgi unreachable" with a mismatched `corgi`.

## Open Questions

- Should Tab also complete existing transcript file names, so appending to an earlier file is quicker, or folders only?
- Should a `[mismatch]` make setup exit 1, or only warn, given that dictation cannot work with that `corgi`? (Proposal: exit 1.)
- Does the recording threshold of 20 pick up too much room noise in practice? The walkthrough dropped several empty utterances while recording; worth watching, not part of this change.

## Follow-ups (out of scope)

- Publish `rhuss/corgi-voice`, close tals/corgi#36 with a pointer, open the Trick hook issue for a sidebar voice indicator.
- Test remote delivery once a remote machine is reachable from the laptop.
