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
recording.json   ← schema_version, recording_id, created_at_unix, segment_seconds, current_segment_id,
                   plus the wall-clock↔PTS pairs anchor_wall_us / anchor_pts_90khz (taken once, on the
                   first indexed frame) and recent_wall_us / recent_pts_90khz (re-sampled every 60 s
                   while the writer runs) that let DVR clip export date a mark to a PTS — absent on
                   recordings made before they existed, which the exporter then cuts from whole segments
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
| `configure_recording` | Set or clear (`"recording": null`) one flow's `recording` block without touching the rest of the flow — how the manager arms the recorder a [DVR clip export](#dvr-clip-export) is cut from. The `recording` key must be present (a command that forgot it is refused rather than read as "clear"). It merges: an omitted `pre_buffer_seconds` / `filmstrip_seconds` keeps its previous value, an explicit `null` clears it. It validates like a config push and persists only; the recorder binds at flow spawn, so the reply's `restart_required` (true only when a running flow's value actually changed) tells the caller to `restart_flow`. |
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
| `export_clip` / `export_recording` | Pull a clip or whole recording as TS or a progressive MP4 (see [Export to MP4](#export-to-mp4)). |

### `play_clip` parameters

All five fields are optional:

- `clip_id` — re-scope the reader to a stored clip. **Omit it** to play the reader's current scope (whatever `cue_clip`, a previous `play_clip` or the input's own `clip_id` left it on).
- `from_pts_90khz` / `to_pts_90khz` — play an ad-hoc range without a stored clip. An inverted range (`to < from`, or a `to` below the reader's current in-point) is refused, but the `play_clip` arm maps every failure to one code: `command_ack.error` reads `replay_invalid_range` while `command_ack.error_code` is `replay_clip_not_found`. (`update_clip` and the export commands do surface `replay_invalid_range` as the `error_code`.)
- `speed` — forward rate in `(0, 1.0]`, default `1.0`.
- `start_at_unix_ms` — future wall-clock start anchor. The input sleeps until that instant, so several `replay` inputs can be started in step for a multi-cam replay. A target more than **5000 ms** in the future is refused (reason text `replay_invalid_start_at` in `command_ack.error`, surfaced under `command_ack.error_code = "replay_clip_not_found"` like every other `play_clip` rejection), so a misconfigured sync group can't park the input task.

## Export to MP4

`export_clip` and `export_recording` take a `format` of `"ts"` (the default) or `"mp4"`. On `"mp4"` the edge builds a **progressive** MP4 from the on-disk MPEG-TS — one `moov` with real sample tables ahead of one `mdat`, so players can seek — not the fragmented shape the CMAF path publishes. Audio is copied as-is, never re-encoded; **video is not a remux** — on any build carrying an x264 encoder (all three release artefacts) the range is decoded and re-encoded all-intra H.264 (`gop_size = 1`, CRF 20, no B-frames; H.264 out whatever went in) so the clip steps cleanly in a player, and a build with no encoder — or a re-encode that fails for any other reason — falls back to the source's own GOP structure (written in display order with DTS == PTS) with a log line. One build runs at a time node-wide, on a blocking thread, sharing that slot with the DVR clip cutter. Any other `format` is refused up front with `replay_export_format_unsupported`.

MP4 export accepts **H.264 and HEVC** video with **AAC / AC-3 / E-AC-3 / MP2** audio. The video track written is **H.264 (`avc1`) whatever went in** on a build with an x264 encoder; the source codec (`avc1` / `hvc1`) reaches the file only on the fallback path above. MPEG-2 video, Opus audio and any other video `stream_type` return `replay_export_format_unsupported`; a recording with no video frames at all returns `replay_no_video_frames`, because the MP4 builder needs a video track. MP4 builds materialise the whole file in memory, so a pull over the 256 MiB cap returns `replay_export_too_large`. Download those as TS.

An MP4 range — a clip or a whole-recording window — that crosses a flagged join in the media's own timeline is refused with `replay_export_spans_restart`, checked before the size cap. The index stays continuous across such a join (the writer resumes its counter) but the TS underneath does not, so muxing across it produces a file that plays and declares a wildly wrong duration. The writer flags three kinds of join, on the next indexed frame: a recorder restart, an operator Stop → Start of the recording, and a source PCR step of more than five minutes (an upstream encoder restart or a live → file transition) — the error name says "restart" but all three are refused. The refusal is settled, not transient: retrying cannot move the join, so export each side separately or download TS. With neither `from_pts_90khz` nor `to_pts_90khz` the guard covers the whole recording, so an unbounded `format: "mp4"` pull of a recording holding any such join is refused; with only `from_pts_90khz` set, joins before it are ignored. TS export applies no such check.

**The manager offers TS only today.** Every clip row — Live tab and Recordings library alike — renders a single hard-coded `⬇ TS` link, served by a REST proxy that sends no `format` field and labels the response `application/mp2t`. It also applies **no** capability gate: `replay_export_mp4` is advertised by every `replay`-enabled edge but is not read anywhere in the manager, so the bit changes nothing in the browser. From the Replay surface, then, MP4 export is reachable over the WS commands only. It is not the edge's only MP4 producer, though: a [DVR clip export](#dvr-clip-export) — a viewer's mark posted to the relay origin's clip queue from the DVR player — is cut by the same builder by a poller the edge runs against every passthrough CMAF output, with no manager command issued per clip; the manager's part is arming the recorder (`configure_recording`) when it activates the session.

## DVR clip export

**Not the same thing as a replay clip.** A *replay clip* is a mark-in/mark-out range an operator creates in the manager UI, stored in `clips.json` and played back or pulled with `export_clip`. A *DVR clip export* starts in the browser DVR player (see [DVR Sessions](/manager/dvr/) and the [viewer portal](/relay/portal/)): a viewer marks a moment and asks for so many seconds either side of it, and the relay records the ask as a job. The relay refuses a request whose `pre_secs + post_secs` exceeds **60 s** (HTTP 400), and a zero-length one; it does not shorten an over-long ask.

The edge does the cutting, because the relay never parses media. Every **passthrough** CMAF output — one with no `video_encode` block, DVR session or not; the DVR proxy rendition is skipped — runs a poller that asks `<ingest_url>/clips` for pending marks every **5 s**, authenticating with the same ingest token it PUTs segments with, and cuts each one in turn. Two paths, in order:

1. **From this flow's recording.** The exporter finds the recording under the id the writer really used (`storage_id`, which is the flow id only by default — an operator-named one is followed), maps the mark's wall-clock date to a PTS through the anchor pair in `recording.json` (at the recording's own measured rate once the rolling `recent_*` sample spans long enough to trust, the nominal 90 kHz otherwise), widens the end to the next random-access point so the clip covers the window rather than stopping short of it, and hands the range to the same builder as [Export to MP4](#export-to-mp4): decoded, re-encoded all-intra H.264 and muxed as a progressive MP4, audio copied as-is. The cut is **GOP-aligned, not frame-exact** — the in-point rounds back to the random-access point at or before it and the out-point forward to the first one after. Builds share the single node-wide permit with `export_clip` / `export_recording`.
2. **From whole origin segments.** When the recording cannot serve the moment — no recording for the flow (including a build without the `replay` feature), no wall-clock anchor in `recording.json`, or a moment the recorder has since aged out of (any other failure of the MP4 build itself lands here too, logged; the restart and empty-window refusals below do not) — the clip is assembled from the init segment plus every segment overlapping the window, so it lands on segment boundaries: up to one segment early at the in-point and one late at the out-point. A coarser clip, not a broken one.

The finished file is PUT to `<ingest_url>/clips/<name>.mp4`, with an upload deadline of a minute plus the body at 2 Mbit/s (capped at 15 min) so a cellular or Starlink uplink is not timed out. If the origin refuses the exact cut as too large (HTTP 413 — the relay accepts up to 256 MiB per clip, sized against source bytes, and an all-intra re-encode of a high-bitrate window can exceed it), the segment cut is tried before the clip is called impossible.

Some failures are settled and are given up on the first attempt: a window that spans a **recorder restart** (the TS either side of the join is two timelines, and the relay's renditions restart with the same process, so the segment path cannot rescue it either), one that spans an **encoder change** on the origin (segments either side decode against different init segments), a window that has aged out of the origin's segments too, an empty window, a playlist with no dated segments, or a clip too large for the origin. Anything else — an origin restarting mid-fetch, a segment not yet uploaded — is retried on later polls, up to **3** attempts. When the edge gives up it tells the origin (`POST <ingest_url>/clips/<name>.mp4/failed`) so the viewer's page shows the clip as failed rather than "being cut" forever.

Failures surface as **Warning** events on the `cmaf` category, not `replay`, with `details.error_code`:

| `error_code` | Meaning |
|---|---|
| `clip_export_failed` | The edge gave up on one clip (`details.clip`, `details.attempts`, `details.error`). |
| `clip_export_blocked` | The clip queue cannot be read — for example a 403 from an ingest token the origin no longer accepts. Raised once per spell of failures; polling continues. |
| `clip_export_unsupported` | The origin answered 400 / 404 / 405 six polls running — a third-party packager, a CDN ingest that accepts PUT and nothing else, or a relay that predates clip export. No mark will be cut there; polling drops to once every 5 min so an upgraded relay is still noticed. |

**Where this sits against the capability gate below.** The exporter is compiled in unconditionally and advertises its own bit, `clip-export`, regardless of the `replay` feature: it promises "marks will be cut", not "cut from the recording". The manager refuses to activate a DVR session against an edge without `clip-export` (such an edge takes every command and never cuts), and only logs when `replay` is absent — clips then come from whole segments. That is also why activating a session **arms this recorder**: the manager asks `recording_status` and reads `replay_root_free_bytes`, `segments_written` and `bytes_written` to check the session window fits on the replay volume (refusing the activation with the shortfall named if not), then pushes `configure_recording` with `enabled: true`, `storage_id` = the flow id unless you already named one, and `retention_seconds` / `max_bytes` raised to no lower than the window needs — merged onto your existing block, so `pre_buffer_seconds` and `filmstrip_seconds` survive, and remembered so teardown can hand it back. Nothing is pushed if the recorder already covers the session (`max_bytes` within 10 % of the wanted cap counts as covering, because it follows a measured rate that never stops moving). When something is pushed and the flow is running, the edge answers `restart_required` only if the block actually changed, and the manager then sends `restart_flow` — a destroy-then-create that drops **every** output on the flow — and raises an event saying so.

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

- `name` — clip display name (≤ 256 bytes of UTF-8; newline, carriage return and NUL are refused — other control characters such as tab pass).
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

A build compiled with the `replay` feature advertises **four** replay capability strings in `HealthPayload.capabilities`; a build without it advertises none of those four and returns `unknown_action` for replay commands instead of throwing. A fifth string, `clip-export`, is advertised by **every** build and is listed here because its frame-exact path runs through the replay recorder.

| Capability | What the manager does with it |
|---|---|
| `replay` | Gates the node list on the `/replay` page and the Recording sub-section of the flow form (including the `filmstrip_seconds` field). |
| `replay-v2` | Gates the speed-preset row, which physically contains the two frame-step buttons. The `,` / `.` hotkeys stay live either way: with the bit they issue `step_frame`, without it they fall back to a ±33 ms `scrub_playback` seek. |
| `replay-filmstrip` | **Not read by the manager.** The filmstrip strip falls back on the edge's `unknown_action` reply instead, so the bit is informational today. |
| `replay_export_mp4` | **Not read by the manager.** See [Export to MP4](#export-to-mp4) — the browser only ever offers the TS download. |
| `clip-export` | **Not gated on `replay`** — advertised by every edge build, because the DVR clip poller (`engine::cmaf::clips`) is compiled in unconditionally. It says this binary polls the relay for a viewer's marks and will cut them; an edge that predates it accepts every DVR command and streams perfectly while every mark sits pending for the life of the session. The manager refuses to activate a DVR session against a node that does not advertise it. It promises a clip, not a frame-exact one: cutting from the flow's Replay recording additionally needs the `replay` recorder armed on the source flow — the manager arms it itself on activation when the node also advertises `replay` — plus the x264 encoder every release artefact carries (without one the cut keeps the source's own GOP structure). With no recording to cut from, the exporter assembles the clip from whole segments instead. See [DVR clip export](#dvr-clip-export). |

## Where to read next

- [Replay (operator UI)](/manager/replay/) — the JKL-scrub `/replay` page, push-to-air, custom tag profiles, sport presets, hotkeys.
- [Configuration reference](/edge/configuration/) — the recording flow attribute and `replay` input type schemas in context.
- [Edge events and alarms](/edge/events-and-alarms/) — the full event catalogue including the `replay` category.
