# Data Model: corgi-voice Extraction

Entities carried over unchanged from the source branch (`Utterance`, `VoiceSettings`, `RecordingTiming`, `Gauge`, `Passage`, `Contribution`, recording state) keep their shapes in `src/voice/`. This document covers the new and changed entities.

## Machine

| Field | Type | Notes |
|---|---|---|
| `name` | string | `local` or a name from `corgi machine list` |
| `state` | `"ok" \| "unreachable" \| "not-understood"` | from the latest poll |
| `error` | string \| null | short reason when not ok |
| `fetchedAt` | number (ms) | time the latest successful poll finished |
| `viewers` | `Viewer[]` | from the latest successful poll |
| `panes` | `Map<number, PaneInfo>` | from the latest successful poll |

Rule: a machine is a candidate source only when `state = ok` and `now - fetchedAt <= 2000` (FR-007).

## Viewer

| Field | Type | Notes |
|---|---|---|
| `id` | number | per machine |
| `pane` | number \| null | focused pane; null when the viewer does not show this machine |
| `workspace` | number \| null | |
| `active` | number | per-machine counter, never compared across machines |
| `watched` | boolean | terminal window has OS focus |

Parsing: unknown fields ignored; a viewer missing `id` or `active` (not a number) is dropped; a reply without a `viewers` array sets the machine to `not-understood`.

## PaneInfo

| Field | Type | Notes |
|---|---|---|
| `id` | number | |
| `label` | string | `name`, else `agent`/`command` plus `cwd` basename, else `pane <id>` |
| `exited` | boolean | |
| `dormant` | boolean | hibernated |

## Target

| Field | Type | Notes |
|---|---|---|
| `machine` | string | |
| `viewer` | number | |
| `pane` | number | |
| `active` | number | the viewer's `active` in the poll that chose it |
| `label` | string | shown in the header |

Resolution (FR-006), pure function `resolve(machines, previous, now)`:

1. For each fresh machine, candidate = viewer with non-null `pane` and highest `active` (ties: lower `id`).
2. No candidates: result `none` with reason (no viewer attached, or Corgi unreachable when no machine is fresh).
3. One candidate: it.
4. Several: those whose candidate is `watched`; if exactly one, it.
5. Still several (all or none watched): the machine of `previous` (last successful delivery) if among them, else `local` if among them, else the first in machine-list order.

## Delivery

| Field | Type | Notes |
|---|---|---|
| `utterance` | number | utterance id |
| `target` | Target | |
| `text` | string | sanitized, no newline, optional leading space |
| `outcome` | `"delivered" \| "failed" \| "abandoned"` | |
| `reason` | string \| null | "pane gone", "pane hibernated", "<machine> unreachable", "focused pane is the voice pane", "no answer in time; may have been typed", or corgi's first error line |

State transitions: `pending -> delivered | failed | abandoned`. Deliveries form a FIFO queue; at most one `corgi pane send` process runs at a time; an abandoned one is killed before the next starts.

## LastDelivery (space rule)

`{machine, viewer, pane, active}` of the latest `delivered` outcome only. Leading space when the new target matches all four against the newest poll.

## Settings additions

| Key | Type | Default | Validation |
|---|---|---|---|
| `corgi` | string \| null | null (`corgi` on PATH) | non-empty string |
| `theme` | `"auto" \| "light" \| "dark"` | `"auto"` | one of the three |

All other keys as in the source `voice.json` minus nothing (the source never stored `ssh`).

## Instance lock

File with the owning PID; stale when the PID is not alive.
