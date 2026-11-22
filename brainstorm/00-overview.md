# Brainstorm Overview

Last updated: 2026-11-22

Earlier voice brainstorms (dictation, transcript recording, glossary, speaker separation, the extraction itself) live in `corgi-specs/brainstorm/` as #01 to #04 and #16.

## Sessions

| # | Date | Topic | Status | Spec | Issue |
|---|------|-------|--------|------|-------|
| 01 | 2026-11-20 | walkthrough-fixes | done | `002-walkthrough-fixes` | - |
| 02 | 2026-11-20 | control-channel | done (phase 1; phase 2 replaced by #03) | `003-control-channel` | - |
| 03 | 2026-11-22 | sidebar-voice-icon | active | - | - |

## Open Threads
- Whether Tab in the recording prompt also completes existing transcript files, or folders only (from #01)
- Whether a mismatched `corgi` makes `corgi-voice --setup` exit 1 or only warn (from #01)
- Whether the recording threshold of 20 picks up too much room noise (from #01)
- Whether an outside mute's history row names its source (hotkey, trick, CLI) (from #02)
- Shape of the Tricks title-row API: new raw kind or new surface (from #03)
- Several tricks in the title row: order, width cap, which drops first (from #03)
- Title-row item placement with the scope selector and in the framed sidebar (from #03)
- Which daemon's title-row items a viewer shows for a remote machine (from #03)
- Whether a raw command trick resolves `corgi-voice` through `PATH` or needs an absolute path (from #03)
- Where the Corgi-side spec lives, and whether an upstream issue comes before the PR (from #03)
- Feedback for a refused click during recording (from #03)

## Parked Ideas
