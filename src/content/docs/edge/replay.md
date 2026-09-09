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

It is **not** a video editing surface. There is no reverse playback or multi-track timeline. Variable-speed slow-motion is supported — any forward rate the edge accepts is in `(0, 1.0]`, and the manager offers 0.1× / 0.25× / 0.5× / 1× as presets — and clips or whole recordings can be exported (see [Export to MP4](#export-to-mp4) below).

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
thumbs/          ← filmstrip JPEGs, one <pts_90khz>.jpg per capture (only when filmstrip_seconds is set)
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
| `enabled` | `true` | When `false`, no writer is spawned at all, and `start_recording` on that flow is refused with `replay_recording_not_active`. Cron-armed recording needs `enabled: true` plus `pre_buffer_seconds`, so the writer comes up in **PreBuffer** and a routine's `start_recording` promotes it. |
| `storage_id` | `null` (= flow id) | Subdirectory under the replay root. Alphanumeric + `._-`, ≤ 64 chars. |
| `segment_seconds` | `10` | Wall-clock segment roll cadence. Range `[2, 60]`. |
| `retention_seconds` | `86400` (24 h) | Oldest-first prune by mtime. `0` = unlimited. |
| `max_bytes` | `53687091200` (50 GiB) | Oldest-first prune by total size. `0` = unlimited (still subject to disk). |
| `pre_buffer_seconds` | `null` | When set, the writer auto-arms in **PreBuffer** mode and rolls segments to disk with retention pinned at this value, so an operator pressing Start later picks up the last `N` seconds of pre-roll. Range `[1, 300]` when set. |
| `filmstrip_seconds` | `null` (off) | When set, a sibling writer encodes one 160×90 JPEG every `N` seconds into `thumbs/`. Range `[1, 30]` when set. See [Filmstrip thumbnails](#filmstrip-thumbnails). |

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

Playback is **forward-only** but variable-speed (no reverse). The edge accepts any rate **greater than 0 and no more than 1.0** — the manager exposes 0.1× / 0.25× / 0.5× / 1× preset buttons, but the wire is not clamped to those. Set the rate with the `speed` param on `play_clip`, or live via the `set_speed` command; `step_frame` single-steps forward **or** backward while paused. An out-of-range rate is refused with `replay_invalid_speed` on `set_speed`; on `play_clip` the same rejection currently surfaces under `command_ack.error_code = "replay_clip_not_found"`, because that arm maps every failure to one code.

Playback and clip lifecycle are driven by WS commands:

| Command | Purpose |
|---|---|
| `start_recording` / `stop_recording` | Arm / disarm a flow's writer — **PreBuffer**/`idle` → **Armed**, and back to `idle`. The writer has to exist already: a flow whose `recording.enabled` is `false` has none, and both commands are refused with `replay_recording_not_active`. |
| `recording_status` | Report the writer's `mode` / `armed` state and its disk counters — see [Operating modes](#operating-modes). |
| `mark_in` / `mark_out` | Set the in/out points of a new clip. |
| `list_clips` | Enumerate a recording's clips. Takes either `flow_id` or `recording_id` — the latter re-syncs against an orphan recording whose flow is gone. |
| `get_clip` | Fetch one clip's metadata. |
| `delete_clip` | Remove a clip (searches every recording dir for the id). Emits `clip_deleted`. |
| `cue_clip` | Load a clip and hold on its first frame. |
| `play_clip` | Start playback — see [`play_clip` parameters](#play_clip-parameters). |
| `set_speed` | Change the playback rate live. Any rate in `(0, 1.0]`. |
| `step_frame` | Single-step one frame forward or backward while paused. |
| `scrub_playback` | Seek to an arbitrary PTS. |
| `stop_playback` | Stop / cancel playback. |
| `list_recordings` | Enumerate the on-disk Recordings library. |
| `delete_recording` | Remove a recording and its clips from disk. |
| `list_filmstrip` / `get_filmstrip_frame` | List filmstrip frame metadata for a scrub window, and pull one JPEG by its exact PTS. See [Filmstrip thumbnails](#filmstrip-thumbnails). |
| `export_clip` / `export_recording` | Pull a clip or whole recording as TS or fragmented MP4 (see [Export to MP4](#export-to-mp4)). |

### `play_clip` parameters

All five fields are optional:

- `clip_id` — re-scope the reader to a stored clip. **Omit it** to play the reader's current scope (whatever `cue_clip`, a previous `play_clip` or the input's own `clip_id` left it on).
- `from_pts_90khz` / `to_pts_90khz` — play an ad-hoc range without a stored clip. An inverted range (`to < from`) is refused with `replay_invalid_range`.
- `speed` — forward rate in `(0, 1.0]`, default `1.0`.
- `start_at_unix_ms` — future wall-clock start anchor. The input sleeps until that instant, so several `replay` inputs can be started in step for a multi-cam replay. A target more than **5000 ms** in the future is refused with `replay_invalid_start_at`, so a misconfigured sync group can't park the input task.

## Export to MP4

`export_clip` and `export_recording` take a `format` of `"ts"` (the default) or `"mp4"`. On `"mp4"` the edge remuxes the on-disk MPEG-TS to a fragmented MP4 via the TS→fMP4 remuxer; anything else is refused up front with `replay_export_format_unsupported`.

MP4 export covers **H.264 (`avc1`) and HEVC (`hvc1`)** video with **AAC / AC-3 / E-AC-3 / MP2** audio. MPEG-2 video, Opus audio and any other video `stream_type` return `replay_export_format_unsupported`; a recording with no video frames at all returns `replay_no_video_frames`, because the MP4 builder needs a video track. MP4 builds materialise the whole file in memory, so a pull over the 256 MiB cap returns `replay_export_too_large`. Download those as TS.

**The manager offers TS only today.** Every clip row — Live tab and Recordings library alike — renders a single hard-coded `⬇ TS` link, served by a REST proxy that sends no `format` field and labels the response `application/mp2t`. It also applies **no** capability gate: `replay_export_mp4` is advertised by every `replay`-enabled edge but is not read anywhere in the manager, so the bit changes nothing in the browser. MP4 export is reachable over the WS command surface only.

## Filmstrip thumbnails

Set `recording.filmstrip_seconds` to have a sibling writer decode one frame every `N` seconds and encode it as a **160×90 JPEG** into the recording's `thumbs/` directory, named by its 90 kHz PTS (`thumbs/<pts_90khz>.jpg`). Each frame is written to `thumbs/.tmp/` first and atomically renamed, so a SIGKILL mid-encode leaves no half-written JPEG. Like the segment writer it is a drop-on-lag broadcast subscriber and cannot block live outputs.

The manager's `/replay` scrubber strip reads these through the `list_filmstrip` (frame metadata for a window) and `get_filmstrip_frame` (one JPEG by exact PTS) commands, both surfaced as REST on the manager — see the [manager API reference](/manager/api-reference/). A build without the `replay` feature answers `unknown_action` and the manager falls back to the pre-filmstrip timeline.

Two Warning events ride the `replay` category: `filmstrip_setup_failed` (the `thumbs/` directory could not be created — the writer gives up) and `filmstrip_decode_failed` (no video PID in the buffered TS, or a decode error; rate-limited).

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
- Aligns `index.bin` down to the last 24-byte boundary if a SIGKILL truncated a partial entry. This realignment is **silent** — no event of any kind is raised, and `recovery_alert` does not report it.
- Emits a `recovery_alert` Warning event (`details.tmp_orphans_removed`, `details.meta_corrupt`, `details.next_segment_id`) so the operator can spot the recovered state in the manager events feed. It fires only when an orphan was cleaned, `recording.json` was corrupt, or the on-disk segment id ran ahead of the metadata.

Retention never deletes the just-finalized segment id — a too-tight `max_bytes` fires `replay_max_bytes_below_segment` instead of corrupting the live edge.

## Events

| Event | Severity | Notes |
|---|---|---|
| `recording_started` | Info | A flow with `recording.enabled = true` and no `pre_buffer_seconds` brought up its writer, or `start_recording` promoted a **PreBuffer** writer to **Armed**. A `start_recording` on an `idle` writer arms it silently. |
| `recording_pre_buffer_started` | Info | A flow with `pre_buffer_seconds` set came up in **PreBuffer** mode — recording begins on the operator's Start. |
| `recording_start_failed` | Critical | Disk I/O error before the first segment landed. |
| `recording_deleted` | Info | `delete_recording` removed a recording and its clips (`details.bytes_freed`). |
| `clip_created` | Info | `mark_in` + `mark_out` produced a new clip. |
| `clip_deleted` | Info | Operator removed a clip. |
| `playback_started` | Info | A `replay` input started serving a clip. |
| `playback_stopped` | Info | Playback paused or cancelled. |
| `playback_eof` | Info | Reached the end of the clip / recording with `loop_playback: false`. |
| `writer_lagged` | Critical | The writer's bounded mpsc filled — packets dropped to keep the broadcast channel non-blocking. Rate-limited to 1 per 5 s. |
| `disk_pressure` | Warning | Recording disk usage crossed 80 % of the configured `max_bytes` cap — or of the replay-root filesystem's used/total when `max_bytes` is `0` (unlimited). Sticky until usage falls back below 70 % so the events feed isn't spammed. |
| `disk_full` | Critical | Out of disk space on the replay root. |
| `filmstrip_setup_failed` | Warning | The filmstrip writer could not create the recording's `thumbs/` directory and gave up. |
| `filmstrip_decode_failed` | Warning | No video PID in the buffered TS, or a decode error, while capturing a filmstrip frame. Rate-limited. |
| `recovery_alert` | Warning | Crash-recovery scan ran on writer init. See above. |
| `metadata_stale` | Warning | `recording.json` write failed on segment roll; resume id is derived from disk on next start. |
| `max_bytes_below_segment` | Warning | `max_bytes` smaller than one segment — retention can't satisfy the cap without unlinking the live edge. |

There is **no** stop event. `stop_recording` acks with an empty payload and emits nothing, so a stop is observable only as `recording_status.mode` going to `idle` (and `armed` going false) — don't build an alarm rule around a `recording_stopped` event, and don't expect one for a truncated `index.bin` either.

## Capability gate

A build compiled with the `replay` feature advertises **four** capability strings in `HealthPayload.capabilities`; a build without it advertises none of them and returns `unknown_action` for replay commands instead of throwing.

| Capability | What the manager does with it |
|---|---|
| `replay` | Gates the node list on the `/replay` page and the Recording sub-section of the flow form (including the `filmstrip_seconds` field). |
| `replay-v2` | Gates the speed-preset row, which physically contains the two frame-step buttons. The `,` / `.` hotkeys stay live either way: with the bit they issue `step_frame`, without it they fall back to a ±33 ms `scrub_playback` seek. |
| `replay-filmstrip` | **Not read by the manager.** The filmstrip strip falls back on the edge's `unknown_action` reply instead, so the bit is informational today. |
| `replay_export_mp4` | **Not read by the manager.** See [Export to MP4](#export-to-mp4) — the browser only ever offers the TS download. |

## Where to read next

- [Replay (operator UI)](/manager/replay/) — the JKL-scrub `/replay` page, push-to-air, custom tag profiles, sport presets, hotkeys.
- [Configuration reference](/edge/configuration/) — the recording flow attribute and `replay` input type schemas in context.
- [Edge events and alarms](/edge/events-and-alarms/) — the full event catalogue including the `replay` category.
