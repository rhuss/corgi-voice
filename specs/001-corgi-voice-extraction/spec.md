# Feature Specification: corgi-voice Extraction

**Feature Branch**: `001-corgi-voice-extraction`

**Created**: 2026-11-19

**Status**: Draft

**Input**: Brainstorm `16-corgi-voice-extraction` (corgi-specs). Voice dictation (Corgi branch `001-voice-dictation`, PR tals/corgi#36) and transcript recording (Corgi branch `005-voice-transcripts`) leave Corgi and become the standalone tool `corgi-voice` in this repository. The tool keeps the voice logic, gets its own screen layer, and talks to Corgi only through the `corgi` command-line interface. No change to Corgi is required.

## Context

Today voice mode is `corgi voice`, a mode of the Corgi binary. It listens on the machine with the microphone, cuts speech into utterances, transcribes each one with a local Whisper server, and types the text into the focused pane of the Corgi viewer the user worked in last. It can also record speech to a transcript file and show it in a reading view. To do this it talks to the Corgi daemon over Corgi's own protocol, shows a voice indicator in Corgi's sidebar, offers a mute shortcut inside Corgi, and uses an SSH bridge for remote Corgi runtimes.

`corgi-voice` keeps everything the user sees and hears in the voice window and replaces every tie to Corgi's internals with a few documented `corgi` commands:

- `corgi list --json` / `corgi list --all-machines --json`: each machine's attached viewers with `id`, focused `pane`, `workspace`, `active` (grows with each viewer's latest input; highest is the one used last) and `watched` (the viewer's terminal window has OS focus). A daemon reports a viewer's focused `pane` only while that viewer shows that daemon's machine.
- `corgi machine list`: the names of the remote machines Corgi knows.
- `corgi [--machine X] pane send ID --stdin`: types text into a pane without pressing Enter (`corgi pane send --help` shows whether `--stdin` exists).

Terms (unchanged from the source features):

- **Utterance / passage**: one stretch of speech cut out and transcribed.
- **Contribution**: one or more consecutive passages by the same speaker as far as pauses can tell; one block in the reading view.
- **Recording session**: from starting a recording to stopping it; writes to one transcript file.
- **Target**: the pane dictated text goes to, identified by machine and pane id.

## Clarifications

### Session 2026-11-19

- Q: How does the tool find the `corgi` command? → A: The `--corgi CMD` flag wins, then a `corgi` setting in `voice.json`, then `corgi` on `PATH`. The value is a command name looked up on `PATH` or a path to an executable. A shell alias (such as `corgi-custom`) cannot be run by another program, so setup and startup report a configured command that is not found and say to give the executable's path.
- Q: Where do settings and models live? → A: In `corgi-voice`'s own locations: settings in `$XDG_STATE_HOME/corgi-voice/voice.json` (else `~/.local/state/corgi-voice/voice.json`), models in `$XDG_CACHE_HOME/corgi-voice/` (else `~/.cache/corgi-voice/`). On first start, when its own settings file is missing and `$XDG_STATE_HOME/corgi/voice.json` (else `~/.local/state/corgi/voice.json`) exists, that file is copied over with a notice; a model missing from the own cache but present in `$XDG_CACHE_HOME/corgi/voice/` (else `~/.cache/corgi/voice/`) is taken from there (hard link, else copy) instead of downloaded. The old files are never changed or removed.
- Q: What are the command names? → A: `corgi-voice` starts the voice window; `corgi-voice --setup [--model NAME]` runs setup, mirroring `corgi voice` and `corgi voice --setup`; `--help` lists flags. All other flags keep their source names minus `--ssh`.
- Q: How is the tool installed? → A: It runs from source on Bun: the repository declares a `corgi-voice` executable, so `bun install` plus `bun link` (or `bun install -g` from the repository) puts `corgi-voice` on `PATH`. A compiled single-file binary is not part of this feature.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Dictate into the focused pane without Corgi changes (Priority: P1)

A developer has Corgi running with a Claude Code agent in the focused pane. In a separate terminal they start `corgi-voice`, speak a sentence, pause, and the sentence appears in the agent's input as if typed. Nothing is submitted. Corgi is a stock build; nothing in it knows about voice.

**Why this priority**: This is the reason the tool exists. If dictation does not work against an unmodified Corgi, the extraction failed.

**Independent Test**: With models installed and an unmodified Corgi running locally with one viewer attached, start `corgi-voice`, say "refactor the parser module", and confirm the text appears in the focused pane, not submitted, and the history shows it as delivered.

**Acceptance Scenarios**:

1. **Given** an unmodified Corgi with one viewer attached and `corgi-voice` running, **When** the user speaks a sentence and stops longer than the silence window, **Then** the transcribed text is typed into the viewer's focused pane without pressing Enter and the history shows it as delivered.
2. **Given** `corgi-voice` running, **When** the user switches focus to another pane in Corgi and speaks, **Then** the text goes to the newly focused pane.
3. **Given** two viewers attached to the same machine, **When** the user last typed in viewer B, **Then** dictated text goes to the focused pane of viewer B.
4. **Given** two dictated utterances delivered to the same pane with no other input to that viewer in between, **When** the second one is typed, **Then** it is preceded by one space.
5. **Given** the voice window is visible, **Then** it shows which machine and pane the next utterance would go to.
6. **Given** filler words, bracketed non-speech markers or control characters in the transcription, **Then** they are removed exactly as in the source feature before anything is typed.

---

### User Story 2 - Dictate into a pane on a Corgi remote machine (Priority: P1)

The developer's viewer shows a Corgi remote machine (for example `marovo`). They dictate from the laptop with the microphone, and the text lands in the focused pane on the remote machine. Audio never leaves the laptop. No SSH option and no Corgi installation beyond the one the viewer already uses is needed on the voice side.

**Why this priority**: Remote work is a first-class Corgi mode and was a hard requirement of the source feature. The old SSH bridge is dropped, so this path replaces it.

**Independent Test**: With a Corgi remote machine configured and a viewer showing it, start `corgi-voice` locally, speak, and confirm the text appears in the remote machine's focused pane without Enter.

**Acceptance Scenarios**:

1. **Given** a viewer showing remote machine X with a focused pane, **When** the user speaks, **Then** the text is typed into that pane on X and the voice window names X as the target machine.
2. **Given** viewers on two machines both report a focused pane, **When** exactly one of them is `watched`, **Then** the text goes to the watched one.
3. **Given** remote machine X becomes unreachable, **When** an utterance is ready, **Then** its history row is marked failed with a reason naming the machine, and the next utterance is attempted normally.
4. **Given** any remote delivery, **Then** only text crosses to the remote machine; no audio does.

---

### User Story 3 - Hold off when no viewer is attached (Priority: P1)

The user starts `corgi-voice` before opening a Corgi viewer, or closes the last viewer while the tool runs. The voice window says no viewer is attached and records nothing for dictation, instead of producing a column of failed deliveries. When a viewer attaches, dictation resumes on its own.

**Why this priority**: The source feature behaves this way; without it the tool would fill the history with failures and waste transcription work.

**Independent Test**: Start `corgi-voice` with Corgi running but no viewer attached; confirm the window says so and nothing is transcribed for dictation; attach a viewer and confirm the next utterance is delivered.

**Acceptance Scenarios**:

1. **Given** no viewer reports a focused pane on any machine, **Then** the voice window says no viewer is attached and dictation records and transcribes nothing.
2. **Given** that state, **When** a viewer attaches and focuses a pane, **Then** within 2 seconds the window shows the target and dictation resumes.
3. **Given** the `corgi` command runs but the daemon or a machine does not answer, **Then** the window shows that Corgi (or that machine) cannot be reached, with the reason, dictation holds off the same way, and the tool retries on every poll.

---

### User Story 4 - Mute in the tool (Priority: P1)

The user mutes dictation with `m` in the voice window while talking to a colleague. The voice window is the only place showing voice state; Corgi shows nothing.

**Why this priority**: Without mute users quit the tool. The sidebar indicator and Corgi shortcut are gone, so the tool's own mute must be dependable.

**Independent Test**: With `corgi-voice` running, press `m`, speak, and confirm nothing is transcribed or typed; press `m` again and confirm dictation resumes.

**Acceptance Scenarios**:

1. **Given** listening, **When** the user presses `m`, **Then** the window shows MUTED and speech is neither transcribed nor typed.
2. **Given** an utterance being recorded or transcribed, **When** the user mutes, **Then** nothing from it is typed and it leaves no history row, as in the source feature.
3. **Given** muted, **When** the user presses `m`, **Then** the window shows Listening and dictation resumes.

---

### User Story 5 - Record a transcript and follow it in the reading view (Priority: P1)

During a call the user presses `r`, accepts the suggested file name, and talks. Passages are appended to a plain text file as they are transcribed, separated into contributions by pauses. `r` pauses and resumes, `R` stops, `v` opens the reading view. Starting a recording mutes dictation and stopping it restores the earlier mute state.

**Why this priority**: Recording is half of the scope, and meeting-note workflows already read its files.

**Independent Test**: Press `r`, accept the name, say three sentences with long pauses between some of them, press `R`, and read the file: one line per passage, a blank line before each passage that followed a long pause, nothing typed into any pane.

**Acceptance Scenarios**:

1. **Given** no recording, **When** the user presses `r`, **Then** a file prompt opens with the suggested name `YYYY-MM-DD-.txt` (local date), the caret before `.txt`, and the folder it will be written to.
2. **Given** the prompt, **When** the user presses Enter, **Then** recording starts into that file, dictation is muted, and a red `REC` indicator appears; **When** the user presses Esc, **Then** nothing is created.
3. **Given** a recording runs, **When** a passage is transcribed, **Then** it is appended to the file as one line and synced to disk right away.
4. **Given** a recording runs, **When** `r` is pressed, **Then** it pauses (pause symbol) and passages are not written until `r` resumes it.
5. **Given** a recording, **When** the user presses `R` or quits, **Then** pending passages are written (waiting up to 10 seconds), the file is closed, the history names the file, and the earlier mute state returns.
6. **Given** a recording, **When** the user presses `v`, **Then** the reading view shows one block per contribution with its start time, alternating gutter colors, and following new speech as in the source feature.
7. **Given** a recording starts, **Then** it starts from `recording.threshold` (default 20; `null` follows the dictation threshold), uses the recording timings, and the threshold stays adjustable during the recording as in the source feature; stopping restores the dictation values.
8. **Given** passages whose transcription is only a sound-event marker such as `*clap*` or `(music)`, **Then** they are neither written nor shown.
9. **Given** the chosen file exists, **Then** the prompt says it will append, and the recording appends after one blank line.

---

### User Story 6 - Set up and run without Corgi's source or build (Priority: P2)

A user who has only the `corgi` binary installed clones `corgi-voice`, installs its runtime, runs its setup command, and starts it. No Corgi source tree, native build or Zig toolchain is needed.

**Why this priority**: The anti-goal is a fork in disguise. Proving the tool stands alone keeps it maintainable.

**Independent Test**: On a machine with Bun, `whisper-server`, an audio capture tool and the `corgi` binary but no Corgi source, install `corgi-voice`, run setup, and dictate.

**Acceptance Scenarios**:

1. **Given** no models installed, **When** the user runs setup, **Then** the default Whisper model and the speech filter model are downloaded with progress, and setup reports what is ready and what is missing with install hints.
2. **Given** the `corgi` command cannot be found or lacks `pane send --stdin` or viewer data in `list --json`, **When** setup or the tool starts, **Then** it reports which command or field is missing and exits with a failure status.
3. **Given** an existing installation of the in-Corgi voice mode, **When** `corgi-voice` runs the first time, **Then** it uses the user's existing voice settings and downloaded models without downloading them again.

---

### User Story 7 - Tune the microphone and see what happened (Priority: P2)

All tuning from the source feature stays: level meter with threshold marker, `+`/`-` and mouse wheel, options lines with click menus for silence, pre-roll, post-roll, minimum speech and burst length, the speech filter toggle, the device picker, the threshold gauge on `t`, the help overlay on `?`, and the scrollable history.

**Why this priority**: Defaults work for many users; tuning matters in noisy rooms and with music.

**Independent Test**: Start the tool, change the threshold with keys and wheel, open each options menu, switch the input device, run a gauge, and scroll the history, comparing behavior with the source feature.

**Acceptance Scenarios**:

1. **Given** the voice window, **When** the user presses `+`/`-` or turns the wheel, **Then** the threshold changes by 2 and the marker moves.
2. **Given** music playing, **When** the user presses `t` and stays quiet, **Then** the gauge runs about 10 seconds with its animation and sets the threshold as in the source feature.
3. **Given** the device picker, **When** another input is chosen, **Then** capture switches without restarting.
4. **Given** the window is resized down to its minimum size of 37 columns by 14 rows, **Then** the layout stays readable and nothing overlaps; below it the window says it is too small, as in the source feature.

---

### Edge Cases

- **Pane gone between resolution and delivery** (pane closed, exited or hibernated): when the latest viewer data already marks the pane exited or hibernated, delivery fails with "pane gone" without running `pane send`; otherwise `pane send` fails; the history row is marked failed with a reason derived from the `corgi` error ("pane gone" or the error's first line); nothing is typed elsewhere.
- **Machine unreachable**: its delivery row is marked failed naming the machine; a slow or unreachable machine never delays target resolution or delivery for other machines, and its data stops counting once it is older than 2 seconds.
- **Delivery hangs**: abandoned after the delivery bound and marked "no answer in time; may have been typed"; later utterances are not delayed.
- **Voice runs inside a Corgi pane** (its environment names a Corgi pane): when the target is that pane on the same machine, delivery fails with "focused pane is the voice pane" instead of typing into itself.
- **Several viewers on several machines report a focused pane and none or several are `watched`**: the tie-break of FR-006 applies, and the window shows the chosen target so the user can see where text will go.
- **`active` counters from different machines**: never compared with each other (they are per daemon).
- **Two `corgi-voice` instances on one machine**: the second refuses to start with a clear message, so the same speech is never typed twice.
- **`corgi-voice` next to the old in-Corgi `corgi voice`**: not prevented by the instance lock; with copied settings both use the same Whisper port, so the one started second fails with the existing "port taken" error. The README warns against running both.
- **Old Corgi without viewer data or `pane send --stdin`**: the tool names the missing command or field and exits with a failure status.
- **`corgi` output format changes** (unknown fields, missing optional fields): unknown fields are ignored; missing required fields are reported as "Corgi output not understood" and dictation holds off instead of guessing.
- **Text containing a newline**: transcribed text never contains line breaks or control characters after sanitization, so `pane send` can never submit a prompt.
- **Recording while no viewer is attached or Corgi is unreachable**: recording continues; passages are written and marked "recorded, not typed" with the reason.
- **All other edge cases of the source features** (microphone missing or denied, transcription server crash without restart, port taken, empty Whisper output, very long passages, file exists, folder missing, write failure mid-recording, stop while transcription pending, gauge cancel and failures, post-roll longer than silence) behave as in the source specifications.

## Requirements *(mandatory)*

### Functional Requirements

**Standalone tool**

- **FR-001**: `corgi-voice` MUST be a standalone program in this repository that runs without a Corgi source tree, without Corgi's native layer, and without compiling native code.
- **FR-002**: `corgi-voice` MUST interact with Corgi only by running these `corgi` commands: `machine list` (machine names, refreshed at most every 30 seconds and on each start), `[--machine X] list --json` (viewer data per machine, `list --all-machines --json` only as a fallback), `[--machine X] pane send ID --stdin`, and `pane send --help` (capability check); it MUST NOT read Corgi's state files, sockets or protocol, and MUST NOT require any change to Corgi.
- **FR-003**: `corgi-voice` MUST find the `corgi` command from the `--corgi CMD` flag, else the `corgi` setting in `voice.json`, else `corgi` on `PATH`; the value is a command name looked up on `PATH` or a path to an executable. When the chosen command cannot be found, setup and startup MUST name the value they tried and say that a shell alias needs to be replaced by the executable's path.
- **FR-003a**: `corgi-voice` with no arguments MUST start the voice window; `corgi-voice --setup [--model NAME]` MUST run setup; `--help` (also `-h`) MUST list the flags; `--setup` accepts only `--model` and `--corgi`. The program MUST be installable from the repository with Bun so that `corgi-voice` is on `PATH`.
- **FR-004**: At startup and in setup `corgi-voice` MUST check that the `corgi` command exists, that `corgi pane send --help` lists `--stdin`, and MUST name the missing command and exit with a failure status when either check fails. The `viewers` key is checked on the local daemon's first answer (an empty list is fine); when it is missing, the tool holds off and shows "Corgi output not understood" instead of exiting. When `corgi` runs but the daemon or a machine does not answer, the window MUST open, hold off (FR-009) and retry on every poll.
- **FR-005**: At most one `corgi-voice` MUST run per user on a machine; a second instance MUST refuse to start with a clear message. The lock is file based (no native OS lock, per SC-007); a theoretical window remains when a stale-lock cleanup dies and two starts race at the same instant, which is accepted.

**Target resolution**

- **FR-006**: The target MUST be resolved from the viewer data of all machines Corgi knows: candidates are viewers with a non-null focused pane; each machine's candidate is its viewer with the highest `active`; across machines a machine's candidate with `watched` true wins over one without (`watched` is judged on that candidate only); when that still leaves more than one machine, the machine of the previous successful delivery wins, then the local machine, then the first machine in Corgi's listing order. `active` values from different machines MUST NOT be compared.
- **FR-007**: Each machine's viewer data MUST be fetched and timed on its own (one slow or unreachable machine MUST NOT delay the others, and a local target MUST never wait on a remote machine), each fetch bounded below 2 seconds. A machine whose latest data is older than 2 seconds at delivery is not a candidate. When `corgi` reports some machines as failed (for example a non-zero exit from `list --all-machines` with valid JSON whose entries carry `ok: false`), only those machines count as unreachable. Exception: when `machine list` is unavailable and remote machines are read through the `list --all-machines` fallback (FR-002), the remote machines share that one call, so a slow remote machine can delay the other remote machines; the local machine is still polled on its own and never delayed.
- **FR-008**: The voice window MUST show the target machine (when not the local machine) and the pane its text would go to (its name when `corgi list` reports one, else its agent or command with the last folder of its working directory, else its id), or that no viewer is attached, or that Corgi cannot be reached with the reason.
- **FR-009**: While no candidate exists (no viewer attached, or Corgi unreachable), dictation MUST record and transcribe nothing, as in the source feature; recording sessions MUST continue unaffected.

**Delivery**

- **FR-010**: Each dictated utterance MUST be delivered by running `corgi [--machine X] pane send ID --stdin` with the text on standard input; `--enter` and any command that submits MUST never be used. Standard input carries exactly the delivered text with no trailing newline and is closed after it.
- **FR-011**: The delivered text MUST be the transcription after filler, marker and control-character removal, with no line breaks; one leading space MUST be added when the previous successful delivery went to the same pane of the same viewer and that viewer's `active` value is unchanged from the value seen in the resolution used for that delivery; failed and abandoned deliveries do not count as previous deliveries; nothing else is added.
- **FR-012**: Every delivery MUST complete or be abandoned within 2 seconds; an abandoned delivery is marked "no answer in time; may have been typed", and a stuck delivery MUST NOT delay detection or transcription of later utterances. An abandoned delivery's `corgi` process MUST be terminated before the next delivery starts; deliveries run one at a time in utterance order.
- **FR-013**: A failed `pane send` MUST mark the history row failed (`✗`) with a short reason: "pane gone" when the pane no longer exists, the machine name and "unreachable" when the machine cannot be reached, otherwise the first line of `corgi`'s error output. This mapping is best effort: the recognized error patterns MUST live in one place and be covered by tests, and unrecognized output falls back to its first line. Utterances MUST NOT be queued for later delivery.
- **FR-014**: When the target is the same machine and pane id as the Corgi pane named in `corgi-voice`'s environment, delivery MUST fail with "focused pane is the voice pane".
- **FR-015**: Audio MUST never leave the machine running `corgi-voice`; only text is passed to `corgi`.

**Mute and voice state**

- **FR-016**: Mute MUST live in `corgi-voice` only (`m` in the window); `corgi-voice` MUST NOT show anything in Corgi. Mute behavior (dropping in-flight utterances without a history row, MUTED while the tool cannot listen) MUST match the source feature.

**Dictation behavior carried over**

- **FR-017**: Capture, segmentation (threshold, silence window, burst length, pre-roll, post-roll, minimum speech, 30 second cap), the speech filter, the Whisper server lifecycle (start on launch, stop on exit, never restart after a crash), supported models (`tiny.en`, `base.en` default, `small.en`, `medium`, `large-v3-turbo`), filler and marker removal, sanitization, the threshold gauge, the options lines and menus, the device picker, the help overlay, the history and its scroll keys, and verbose diagnostics MUST behave as specified by Corgi's `001-voice-dictation` specification, except where this specification changes them.
- **FR-018**: The command-word, SSH-bridge (`--ssh`), runtime version check, one-voice-per-runtime, sidebar indicator and Corgi mute shortcut requirements of the source feature are removed.

**Recording behavior carried over**

- **FR-019**: Transcript recording (`r` start/pause/resume, `R` stop, `REC` and pause indicators, mute on start and restore on stop, passage assignment by end of speech, 10 second wait for pending passages, append with one blank line, sync after each passage, private file permissions, contributions by `pause_break` and leading dash, the reading view on `v`, the `recording` settings group with defaults `threshold` 20, `silence` 1.0 s, `max_chunk` 10 s, `pause_break` 2.0 s, and the `transcripts` setting and `--transcripts` flag) MUST behave as specified by Corgi's `005-voice-transcripts` specification, except where this specification changes them.
- **FR-020**: Passages that are only sound-event markers (for example `*clap*`, `(music)`, `[laughter]`) MUST be dropped before writing, display or typing.
- **FR-021**: The file prompt for a new recording MUST be the tool's own: a single file name field with the suggested name `YYYY-MM-DD-.txt` and the caret before `.txt`, showing the folder the file goes to; a relative name always resolves against the transcript folder and may contain sub-folders; a name that would leave the transcript folder via `..` MUST be refused at the prompt with a message; `~/` and absolute paths are used as given; the prompt says when it will append; Enter accepts, Esc cancels. Corgi's folder browser is not reproduced. Folders the tool creates MUST be 0700.
- **FR-022**: The default transcript folder MUST stay `$XDG_DATA_HOME/corgi/transcripts/`, else `~/.local/share/corgi/transcripts/`, so existing notes workflows keep finding transcripts.

**Setup, settings and storage**

- **FR-023**: A setup command MUST check for the transcription server, the audio capture tool and the `corgi` command, copy settings and take models from the old in-Corgi locations as in FR-024 before anything is downloaded, download the selected Whisper model and the speech filter model with progress, skip files already present, and report readiness with install hints; it MUST exit with a failure status when something required is missing.
- **FR-024**: Settings MUST live in `$XDG_STATE_HOME/corgi-voice/voice.json` (else `~/.local/state/corgi-voice/voice.json`) and models in `$XDG_CACHE_HOME/corgi-voice/` (else `~/.cache/corgi-voice/`). On start, when the own settings file is missing and the in-Corgi voice mode's `voice.json` (`$XDG_STATE_HOME/corgi/voice.json`, else `~/.local/state/corgi/voice.json`) exists, it MUST be copied with a notice. A model or filter file missing from the own cache but present in the old cache (`$XDG_CACHE_HOME/corgi/voice/`, else `~/.cache/corgi/voice/`) MUST be taken from there (hard link, else copy) instead of downloaded. Both happen on start and in `--setup`. Old files MUST NOT be changed or removed.
- **FR-025**: All settings, flags and their validation (invalid values fall back to defaults with a notice naming the field) MUST match the source features, minus `--ssh`, plus the `corgi` setting and `--corgi` flag (FR-003) and the `theme` setting (FR-027). The flags are `--model NAME`, `--threshold N`, `--silence S`, `--port N`, `--device NAME`, `--transcripts DIR`, `--no-filter`, `--verbose`, `--corgi CMD`, `--setup` and `--help`, with the meanings of the source branch's argument parser (`src/voice/main.ts`).

**Screen layer and look**

- **FR-026**: The voice window MUST be drawn by the tool's own screen code (no Corgi UI modules, no native diffing), writing to the terminal only the rows that changed (frames may be computed on a timer) and redrawing fully on resize, with mouse support for the wheel and clickable options.
- **FR-027**: The window MUST use a fixed set of color tokens modeled on Corgi's palette; every foreground token MUST reach a contrast ratio of at least 3:1 against the background variant it is used on, with a light and a dark variant chosen from the terminal's background, detected by an OSC 11 background color query with a timeout of at most 200 ms; without an answer the dark variant is used, and a `theme` setting (`auto`, `light`, `dark`, default `auto`) overrides detection; it MUST NOT read Corgi's theme files.
- **FR-028**: The layout (header with target, device and mode; level meter with threshold marker and silence line; options lines; history or reading view; footer with keys that drop off the end when they do not fit) MUST keep the source feature's row order and labels (`src/voice/ui.ts` on Corgi's `005-voice-transcripts` branch), so a user of `corgi voice` finds every control in the same place.

**Quality and documentation**

- **FR-029**: All behavior that does not need a real microphone, a real Whisper server or a real Corgi (segmentation, filters, sanitization, target resolution, delivery outcomes and bounds, recording file rules, reading view, gauge) MUST be covered by automated tests, using a stand-in for the `corgi` command.
- **FR-030**: The repository README MUST document installation, prerequisites (Bun, `whisper-server`, audio capture tool, `corgi` with the required commands), setup, usage, keys, settings, file locations, the differences from `corgi voice` (no sidebar indicator, no Corgi mute shortcut, no `--ssh`, remote machines via Corgi), and a warning not to run `corgi-voice` alongside `corgi voice`.
- **FR-031**: The tool MUST NOT read, write or depend on any cc-deck file, binary, configuration or model cache.

### Key Entities

- **Viewer candidate**: machine name, viewer id, focused pane, workspace, `active`, `watched`; read from `corgi list`.
- **Target**: machine and pane id chosen from the candidates, plus the viewer and its `active` value at the last delivery (for the space rule).
- **Delivery outcome**: delivered, failed with reason, or abandoned after the bound.
- **Voice session, utterance, gauge, voice settings**: as in the dictation source feature, without runtime connection state.
- **Recording session, passage, contribution, recording timing, transcript folder**: as in the recording source feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Dictation works against an unmodified, released Corgi: zero lines of Corgi change are needed for any acceptance scenario in this specification.
- **SC-002**: With the default model on a current Apple Silicon Mac, text appears in a local focused pane within 2 seconds after the silence window ends for utterances up to 10 seconds, as in the source feature.
- **SC-003**: Delivery to a pane on a Corgi remote machine with under 100 ms round trip adds at most 0.7 seconds compared to a local pane.
- **SC-004**: Across 50 dictated utterances, Enter is never pressed and no prompt is submitted by the tool.
- **SC-005**: In a setup with two viewers on two machines, 100% of utterances go to the pane the user is looking at when exactly one viewer window has OS focus and focus has not changed in the 2 seconds before the utterance ended.
- **SC-006**: A transcript file recorded by `corgi-voice` has the same shape as one from `005-voice-transcripts` (one line per passage, one blank line between contributions), so the existing notes workflow reads it unchanged.
- **SC-007**: The repository contains no Corgi UI modules and no native code; installing it needs only the Bun runtime and external command-line tools.
- **SC-008**: The automated test suite covers the behaviors listed in FR-029 and passes without a microphone, a Whisper server or Corgi.
- **SC-009**: A user of `corgi voice` starts `corgi-voice` for the first time and dictates without re-entering settings or downloading models again.

## Assumptions

- The voice logic ports from Corgi's `005-voice-transcripts` branch (which contains `001-voice-dictation`) nearly unchanged; the Corgi `001` and `005` specifications are the reference for carried-over behavior.
- The tool runs on the platforms the source feature supported: macOS on Apple Silicon and Linux amd64, with external `whisper-server` and an external audio capture tool, both installed by the user.
- A remote send costs about 500 ms (measured 2026-11-19) and is accepted for this version; calling the remote `corgi` over Corgi's SSH connection directly, or speaking Corgi's HTTP/WebSocket protocol (tals/corgi#144), are possible later optimizations, not part of this feature.
- `corgi list --all-machines --json` reports, per machine, the attached viewers with `id`, `pane`, `workspace`, `active` and `watched`, and `corgi pane send` accepts `--machine`; both exist in current Corgi. `pane send` does not change a viewer's `active` value (it counts user input only).
- The gauge animation preview through Corgi's animation tool is not carried over; the animation itself is.
- Glossary prompts (brainstorm 02) and speaker separation (brainstorm 04) are out of scope.
- Closing tals/corgi#36 with a pointer and opening an issue for a Trick hook that shows voice state in Corgi's sidebar are follow-ups outside this feature.
- The look drifting from Corgi over time is accepted.
