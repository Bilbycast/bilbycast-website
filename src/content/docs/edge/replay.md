---
title: Replay (Recording + Clips)
description: Continuous flow recording to disk and clip playback as a fresh input.
sidebar:
  order: 9
---

The replay server captures a flow's broadcast channel to disk and replays named clips back onto a flow's broadcast channel. It's pure-Rust, on by default, and gated on the `replay` Cargo feature.

For the operator-facing `/replay` UI in the manager — JKL scrubbing, push-to-air, custom tag profiles, sport presets — see [Replay (operator UI)](/manager/replay/). This page is the **edge** side: how recording is configured, where clips live on disk, and how playback works as a fresh input.

## When to use it

- **In-broadcast replay** — clip the play that just happened, send it to the keyer, return to live.
- **Compliance recording** — continuous capture of an outgoing feed with a 24 h retention default. The recorder is a sibling subscriber on the broadcast channel and never feeds back into the data path, so enabling recording cannot affect live egress.
- **Time-shift workflows** — record the rehearsal and play it out as a fresh input on a different flow, paced by PCR.

It is **not** a video editing surface. There is no reverse playback or multi-track timeline. Variable-speed slow-motion (0.1×–1.0× forward) is supported, and clips or whole recordings can be exported to MP4 (see [Export to MP4](#export-to-mp4) below).

## Storage root

Resolved at runtime, in this order:

1. `BILBYCAST_REPLAY_DIR` env var (operator override).
2. `$XDG_DATA_HOME/bilbycast/replay/`.
3. `$HOME/.bilbycast/replay/`.
4. `./replay/`.

Each recording lives at `<replay_root>/<recording_id>/`:

```
000000.ts  000001.ts  ...  NNNNNN.ts
recording.json   ← created_at, segment_seconds, schema_version
index.bin        ← timecode → byte-offset (24 B / IDR)
clips.json       ← named (in_pts, out_pts) ranges
.tmp/            ← in-flight segment writes; atomic rename on roll
```

Recordings are written 188 B-aligned MPEG-TS, segment-rolled on a wall-clock cadence (default 10 s), and pruned oldest-first by both age (`retention_seconds`) and total size (`max_bytes`).

## Recording — flow attribute

Add a `recording` block to a flow:

```json
{
  "id": "record-flow",
  "name": "Record live SRT to disk",
  "enabled": true,
  "input_ids": ["live-srt-in"],
  "output_ids": [],
  "recording": {
    "enabled": true,
    "storage_id": "record-flow",
    "segment_seconds": 10,
    "retention_seconds": 86400,
    "max_bytes": 53687091200,
    "pre_buffer_seconds": null
  }
}
```

| Field | Default | Notes |
|---|---|---|
| `enabled` | `true` | When `false`, the writer is built but doesn't subscribe — useful for cron-armed recording via routines. |
| `storage_id` | `null` (= flow id) | Subdirectory under the replay root. Alphanumeric + `._-`, ≤ 64 chars. |
| `segment_seconds` | `10` | Wall-clock segment roll cadence. Range `[2, 60]`. |
| `retention_seconds` | `86400` (24 h) | Oldest-first prune by mtime. `0` = unlimited. |
| `max_bytes` | `53687091200` (50 GiB) | Oldest-first prune by total size. `0` = unlimited (still subject to disk). |
| `pre_buffer_seconds` | `null` | When set, the writer auto-arms in **PreBuffer** mode and rolls segments to disk with retention pinned at this value, so an operator pressing Start later picks up the last `N` seconds of pre-roll. Range `[1, 300]` when set. |

A flow with `output_ids: []` and `recording.enabled: true` is a **monitor-only** recorder — recommended for compliance.

The recorder runs as a sibling subscriber on the broadcast channel, drop-on-lag, with a bounded mpsc to a dedicated writer task. It can never block live outputs.

## Playback — `replay` input type

Add a new input with `type: "replay"`:

```json
{
  "id": "replay-in",
  "name": "Replay (clip playback)",
  "type": "replay",
  "recording_id": "record-flow",
  "clip_id": null,
  "start_paused": true,
  "loop_playback": false
}
```

| Field | Default | Notes |
|---|---|---|
| `recording_id` | required | The on-disk recording to read from. |
| `clip_id` | `null` | When set, only that clip's `[in_pts, out_pts]` range plays. Otherwise the whole recording is available. |
| `start_paused` | `true` | When `true`, the input idles on flow start until a `play_clip` / `cue_clip` command activates playback. |
| `loop_playback` | `false` | When `true`, restart at the beginning on EOF. |

Playback is **forward-only** but variable-speed: **0.1×–1.0×** (no reverse). Set the rate with the `speed` param on `play_clip`, or live via the `set_speed` command; `step_frame` single-steps forward **or** backward while paused.

Playback and clip lifecycle are driven by WS commands:

| Command | Purpose |
|---|---|
| `mark_in` / `mark_out` | Set the in/out points of a new clip. |
| `cue_clip` | Load a clip and hold on its first frame. |
| `play_clip` | Start playback (optional `speed` param, `0.1`–`1.0`). |
| `set_speed` | Change the playback rate live (`0.1`–`1.0`). |
| `step_frame` | Single-step one frame forward or backward while paused. |
| `scrub_playback` | Seek to an arbitrary PTS. |
| `stop_playback` | Stop / cancel playback. |
| `list_recordings` | Enumerate the on-disk Recordings library. |
| `delete_recording` | Remove a recording and its clips from disk. |
| `export_clip` / `export_recording` | Render a clip or whole recording to MP4 (see [Export to MP4](#export-to-mp4)). |

## Export to MP4

`export_clip` and `export_recording` remux the on-disk MPEG-TS to a fragmented MP4 (`format: "mp4"`) via the TS→fMP4 remuxer, with a plain TS download also available. The edge advertises the `replay_export_mp4` capability, and the manager UI gates its export controls on this bit — older edges without the capability simply don't offer export.

## Operating modes

`recording_status.mode` carries one of:

| Mode | Meaning |
|------|---------|
| `armed` | Live recording — every TS packet on the broadcast channel is being written to disk. |
| `pre_buffer` | Pre-roll mode — the writer is rolling segments under the `pre_buffer_seconds` retention window, ready for an operator Start. The manager UI shows a `● PRE-ROLL` chip. |
| `idle` | Writer is up but not capturing (post-stop or routine-disarmed). |

Older edges (Phase 1.0) omit the `mode` field — the manager falls back to deriving `Recording / Idle` from the boolean `armed` flag.

## Clip mutation — `update_clip`

`update_clip` (Phase 2 / 1.5) is the unified clip-mutation command — a superset of the legacy `rename_clip`. Optional fields, at least one required:

- `name` — clip display name (≤ 256 chars, no control chars).
- `description` — free-form notes (≤ 4096 chars).
- `tags` — up to 16 tags per clip, each `[A-Z0-9_-]{1,32}`.
- `in_pts_90khz` / `out_pts_90khz` — bracket-trim ±100 ms style edits. SMPTE timecode strings are cleared on PTS trim because the IDR index doesn't carry them.

Validation errors lift onto `command_ack.error_code`: `replay_invalid_tag`, `replay_invalid_field`, `replay_invalid_range`.

## Crash recovery

On writer init the edge:

- Unlinks any `.tmp/<NNNNNN>.ts` orphans from a SIGKILL.
- Derives the resume segment id from the directory listing — a stale or corrupt `recording.json` never causes id reuse.
- Aligns `index.bin` down to the last 24-byte boundary if a SIGKILL truncated a partial entry.
- Emits a `recovery_alert` Warning event (`details.tmp_orphans_removed`, `details.meta_corrupt`, `details.next_segment_id`) so the operator can spot the recovered state in the manager events feed.

Retention never deletes the just-finalized segment id — a too-tight `max_bytes` fires `replay_max_bytes_below_segment` instead of corrupting the live edge.

## Events

| Event | Severity | Notes |
|---|---|---|
| `recording_started` | Info | A flow with `recording.enabled = true` brought up its writer. |
| `recording_stopped` | Info | Writer cancelled. |
| `recording_start_failed` | Critical | Disk I/O error before the first segment landed. |
| `clip_created` | Info | `mark_in` + `mark_out` produced a new clip. |
| `clip_deleted` | Info | Operator removed a clip. |
| `playback_started` | Info | A `replay` input started serving a clip. |
| `playback_stopped` | Info | Playback paused or cancelled. |
| `playback_eof` | Info | Reached the end of the clip / recording with `loop_playback: false`. |
| `writer_lagged` | Critical | The writer's bounded mpsc filled — packets dropped to keep the broadcast channel non-blocking. Rate-limited to 1 per 5 s. |
| `disk_pressure` | Warning | Recording disk usage crossed 80 % of the configured `max_bytes` cap. Sticky until usage falls back below 70 % so the events feed isn't spammed. |
| `disk_full` | Critical | Out of disk space on the replay root. |
| `index_corrupt` | Warning | `index.bin` failed parse on writer init; recovery scan re-aligned to the last valid 24-byte boundary. |
| `recovery_alert` | Warning | Crash-recovery scan ran on writer init. See above. |
| `metadata_stale` | Warning | `recording.json` write failed on segment roll; resume id is derived from disk on next start. |
| `max_bytes_below_segment` | Warning | `max_bytes` smaller than one segment — retention can't satisfy the cap without unlinking the live edge. |

## Capability gate

The edge advertises `"replay"` in `HealthPayload.capabilities` only on builds compiled with the `replay` feature. The manager UI gates the `/replay` page and the recording fields in the flow form off this capability — older edges return `unknown_action` for replay commands instead of throwing.

## Where to read next

- [Replay (operator UI)](/manager/replay/) — the JKL-scrub `/replay` page, push-to-air, custom tag profiles, sport presets, hotkeys.
- [Configuration reference](/edge/configuration/) — the recording flow attribute and `replay` input type schemas in context.
- [Edge events and alarms](/edge/events-and-alarms/) — the full event catalogue including the `replay` category.
