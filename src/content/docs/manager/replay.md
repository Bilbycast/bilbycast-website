---
title: Replay (Operator UI)
description: Use the manager /replay page to scrub recordings, mark clips, and push them to air.
sidebar:
  order: 4
---

The manager's `/replay` page is the operator surface on top of the [edge replay server](/edge/replay/). It gives you a JKL-style scrub timeline, a clip library, sport-tagging profiles, and a one-click push-to-air. This page is for the people in the chair during a live event — what each button does, every keyboard shortcut, and how the custom tag profiles work.

## Prerequisites

- The edge node must advertise the `replay` capability — every release with the default feature set does.
- The flow must have `recording.enabled = true`. Add it on the flow create / edit modal (the **Recording** sub-block).
- Operators need at least the **Operator** role on the group that owns the node + flow.

To filter `/admin/nodes` to just the replay-capable edges, append `?capability=replay`.

## Opening the page

The `/replay` page is the per-flow scrub view:

```
/replay?node=<node-id>&flow=<flow-id>
```

Quickest way in: click any flow card with a `● REC` (Recording) or `● PRE-ROLL` chip on the dashboard — the chip is a deep-link to `/replay`.

## The scrub timeline

The timeline shows the rolling buffer for the currently-recording flow. The vertical play-head sits on the cursor; live frames stream from the right.

| Action | Mouse | Keyboard |
|---|---|---|
| Pause | click play-head | **K** |
| Play forward 1× | — | **L** |
| Reverse scrub | drag left | **J** |
| Frame step back | — | `,` |
| Frame step forward | — | `.` |
| Mark in | click marker | **I** |
| Mark out | click marker | **O** |
| Cancel marks | right-click | **Esc** |
| Lock to live | click LIVE button | **End** |

**Lock to live** keeps the play-head on the latest frame as new content arrives — useful when you want to stay in step with the broadcast and only break off to clip something on demand.

<!-- TODO screenshot: /replay page with timeline, play-head, mark in/out -->

## Quick-clip the last N seconds

Below the timeline are three single-button quick-clip pills — typically **5s**, **15s**, **30s**. Each one immediately creates a clip ending at the current play-head position with the corresponding lookback. Useful for the moment-of-action workflow where there's no time to mark in/out manually.

Each button uses the active **tag profile**'s default tag (see below).

## Bracket-trim — `[` and `]`

Once a clip exists, select it in the library and use:

- **`[`** to nudge the in-point earlier by 100 ms.
- **`]`** to nudge the out-point later by 100 ms.

Hold **Shift** for ±1 s steps. Trims fire `update_clip` against the edge — SMPTE timecode strings are cleared on PTS trim because the index doesn't store them.

## The clip library

The right-hand panel lists every clip in the current flow's recording. It's **group-scoped** — operators only see clips from flows their group owns.

| Action | How |
|---|---|
| Sort by | header dropdown — Newest, Oldest, Name, Duration |
| Search | the search box; case-insensitive substring across name + description + tags |
| Filter by tag | click a tag pill at the top of the panel; clicks toggle inclusion / exclusion |
| Rename / re-describe | row hover → pencil icon |
| Tag | row hover → tag icon, or use the active profile's hotkeys |
| Trim | select row, then `[` / `]` |
| Delete | row hover → trash, then confirm |

## Push-to-air

The **Push to air** button on each clip row opens a flow-selector modal. Pick:

- **Target node + flow** — any flow in the same group that the operator can edit.
- **Replace mode** — `Replace input` (swap the live input out, replace with this clip) or `Add as new input` (add the clip alongside, useful when running a multi-input flow).

The manager creates a `replay`-type input pointing at the clip on the source edge, attaches it to the target flow, and sets it active. From the operator's POV: one click and the clip is on PGM. Returning to live is the same flow in reverse — a **Return to live** button appears once a replay input is active.

<!-- TODO screenshot: Push-to-air modal -->

## Tag profiles + sport presets

Tagging clips with sport-specific markers (`GOAL`, `FOUL`, `OFFSIDE`, …) lets you find them later by tag-pill filter. Tag profiles let each group define its own taxonomy; sport presets seed those profiles with sensible defaults.

### Tag profiles

A **tag profile** is a list of up to **9 tags**, each `[A-Z0-9_-]{1,32}`. Each group can have up to **20 profiles**, stored on `groups.replay_tag_profiles` as JSON:

```jsonc
[
  { "id": "soccer", "name": "Soccer", "tags": ["GOAL", "FOUL", "OFFSIDE", "SAVE", "YELLOW", "RED", "VAR-CHECK", "SUB", "OG"] },
  { "id": "studio", "name": "Studio default", "tags": ["INTERVIEW", "CLIP", "FAIL", "GAG"] }
]
```

The group's `default_replay_tag_profile_id` selects which profile applies when an operator hasn't picked one yet.

### Per-operator selection

Each operator picks an active profile via the dropdown at the top of the `/replay` page; the choice is persisted into their own `ui_preferences.replay_tag_profile_id` (a JSON object keyed by `group_id`, so operators in multiple groups keep distinct preferences).

### Hotkeys 1-9

Number-row keys **1**-**9** apply the *currently-active profile's* tag at index 0-8 to the selected clip (or the clip created by the next quick-clip press). Switching profiles instantly rebinds the hotkeys — no extra step.

For Soccer, `1` = `GOAL`, `2` = `FOUL`, `3` = `OFFSIDE`, …. For Studio default, `1` = `INTERVIEW`, `2` = `CLIP`, ….

### Sport-preset catalogue

The system ships a built-in catalogue at `static/js/shared/replay_tag_presets.js` covering: **Soccer**, **Rugby Union**, **Rugby League**, **NFL**, **AFL**, **Cricket**, **Tennis**, **Basketball**, **Ice Hockey**, **Field Hockey**, **Volleyball**, **Badminton**, **Baseball**, **Netball**, **Handball**, **Combat Sports**, **Athletics**, and a fall-through **Generic** profile. Group admins can copy any preset into the group as a new profile from **Admin → Groups → \<group\> → Replay tag profiles → Import sport preset**, then edit it freely.

The system **Soccer** preset is the NULL fallback when neither the group nor the operator has selected a profile — clicks just work.

## Recording / Pre-roll / Idle status

The flow card on the dashboard shows one of three chips:

- **`● REC`** (red dot) — the writer is actively recording. `recording_status.mode = "armed"`.
- **`● PRE-ROLL`** (amber dot) — the writer is rolling under the `pre_buffer_seconds` retention window, ready for an operator Start. `recording_status.mode = "pre_buffer"`.
- **No chip** — the writer is idle. `recording_status.mode = "idle"`.

Older edges (Phase 1.0) only report a boolean `armed` — the manager falls back to a two-state `Recording / Idle` chip in that case.

## Where to read next

- [Edge replay](/edge/replay/) — the on-disk format, recording configuration, error catalogue.
- [Switcher](/manager/switcher/) — the live PGM/PVW director console. Replay clips can be loaded onto PVW for same-style takes.
- [Routines](/manager/routines/) — clips can be pushed to air on a cron schedule via the `play_clip` action type.
- [Multi-tenant Groups](/manager/multi-tenant-groups/) — clip libraries are group-scoped.
