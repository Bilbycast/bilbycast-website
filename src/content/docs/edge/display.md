---
title: Display Output
description: Drive a locally-attached HDMI / DisplayPort connector for confidence-monitor playout.
sidebar:
  order: 8
---

A **display output** plays a flow's video to a locally-attached HDMI or DisplayPort connector and (optionally) routes its audio to an ALSA device. It's the broadcast equivalent of a confidence monitor — the operator standing next to the edge box can see and hear what's leaving the gateway, without having to spin up a software decoder somewhere else.

The output is Linux-only and gated on the `display` Cargo feature, which is **on by default** in every release tarball.

## When to use it

- **Confidence monitor at site** — the on-site engineer sees PGM on the HDMI out next to the edge box.
- **OB / live-event control room** — drive a wall-mounted screen direct from the edge, no PC running ffplay or VLC.
- **Studio rack** — drive a 1U preview monitor without an extra appliance in the chain.

This is **not** a low-latency director surface — it does not lock to PTP or to the PCR clock. For those workflows, use the [Switcher](/manager/switcher/) PGM/PVW console with a real video router downstream.

## Prerequisites

The runtime apt packages are part of every modern Linux base install:

```bash
sudo apt update
sudo apt install libdrm2 libasound2t64 libudev1
```

On Ubuntu 22.04 / Debian 12 use plain `libasound2`; on Ubuntu 24.04+ it was renamed to `libasound2t64` (Ubuntu's `t64` time_t transition). Same `libasound.so.2` either way.

These cover KMS (Linux DRM mode-setting) and ALSA. On a strictly headless box they cause no side effects — the edge simply doesn't advertise the `display` capability and any flow with a display output stays passive.

If you build the edge from source, the matching dev packages are `libdrm-dev libasound2-dev libudev-dev` and the feature is enabled by default:

```bash
cargo build --release            # display feature is on by default
cargo build --release --no-default-features --features tls,webrtc   # explicit opt-out
```

## Adding a display output via the manager UI

1. Open **Admin → Nodes**, click the edge, **Configure**, then the **Outputs** tab.
2. **+ Add Output**, pick **Display (HDMI / DisplayPort)** as the type.
3. Pick a connector from the **Device** dropdown — the manager populates it from the `HealthPayload.display_devices` enumeration the edge advertised at startup.
4. Pick an **Audio device** (an ALSA id like `hw:0,3`, `plughw:0,3`, or `default`). Leave blank for video-only.
5. Optional: set **Program** (for MPTS sources), **Audio track**, **Audio channel pair**, **Resolution**, **Refresh Hz**.
6. **Save**, then attach the output to a flow on the **Flows** tab.

If the dropdown is empty, the host has no display advertised — either the edge was built without the `display` feature, or it's running on a headless box with no connectors plugged in. HDMI hotplug is **discovered at startup only** in v1 — adding a cable later requires restarting the edge.

## Config fields

Outputs are JSON top-level entities in `config.json`. The minimum:

```json
{
  "id": "out-confidence",
  "name": "Green-room HDMI",
  "type": "display",
  "device": "HDMI-A-1"
}
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `id` | string | — | Unique within the config. |
| `name` | string | — | Free-form label. |
| `type` | string | — | Always `"display"`. |
| `device` | string | — | KMS connector name from the edge's display enumeration: `"HDMI-A-1"`, `"DP-2"`, `"DVI-D-1"`, …. Validated against `^[A-Z][A-Z0-9-]{0,63}$`. |
| `audio_device` | string | `null` | ALSA device id (`"hw:0,3"`, `"plughw:0,3"`, `"default"`, `"sysdefault"`, `"pulse"`). Omit for video-only. |
| `program_number` | u16 | `null` | MPTS program filter (1-based; `0` is reserved). `null` selects the lowest program in the active input's PAT. |
| `audio_track_index` | u8 | `null` | Audio elementary-stream index within the chosen program. `null` selects the first audio track. Must be < 16. |
| `audio_channel_pair` | `[u8; 2]` | `[0, 1]` | Stereo pair to render from decoded multichannel audio. Both indices must be < 8 and not equal. |
| `resolution` | string | `null` | `"auto"` (use the connector's preferred mode) or `"WIDTHxHEIGHT"` (e.g. `"1920x1080"`). |
| `refresh_hz` | u32 | `null` | Refresh rate in Hz. Range 1–240. `null` uses the connector's preferred mode. |
| `sync_mode` | string | `"vsync_to_display"` | v1 only accepts `"vsync_to_display"`. PTP-genlocked and PCR-master modes land in v2. |

## How A/V sync works

The audio task is the master clock. The display task vsync-paces to the connector and dup/drops video frames to track the audio clock:

- Frames more than one frame-period behind the audio clock are **dropped** (`frames_dropped_late`).
- Frames more than one frame-period ahead are **held** for an extra vsync (`frames_repeated`).
- An ALSA xrun (`EPIPE`) recovers via `snd_pcm_prepare()` and is counted in `audio_underruns` — the audio clock keeps moving but the renderer doesn't nudge it, so the dup/drop algorithm naturally re-aligns.

The video-vs-audio offset is published as a signed EMA on the per-output `display_stats.av_sync_offset_ms`. Sustained drift > 100 ms for 3 s emits a `display_av_drift` Warning event.

## Supported codecs

- **Video**: H.264 + H.265. Software decode via libavcodec is the always-available baseline; **NVDEC** (`display-nvdec` Cargo feature) and **Intel QSV** (`display-qsv`, x86_64 only) are user-selectable per output via `hw_decode: "auto" | "cpu" | "nvdec" | "qsv"`. Both HW backends ride in the `*-linux-full` release artefact and the runtime probe auto-detects which the host can open. VA-API stays as a v2 placeholder behind `display-vaapi`.
- **Audio**: AAC family via fdk-aac, plus MP2 / AC-3 / E-AC-3 / Opus via libavcodec. **No re-encode** — every codec decodes to LPCM for ALSA.

Multichannel audio (5.1 / 7.1) is downmixed to the configured stereo pair (`audio_channel_pair`) — passthrough of compressed audio over HDMI is not supported in v1.

## Capacity

Each running display output consumes resource-budget units on the edge:

- **1080p30 software decode** → 275 units (250 video + 5 audio + 20 KMS).
- **4K60 software decode** → ~1025 units. Without HW decode that's likely to fall behind on most CPUs — the manager surfaces a `display_decoder_overload_predicted` hint in the validation pane when you save the flow.

The edge also enforces **per-connector uniqueness** — only one active display output per `(device, audio_device)` pair. A second one is rejected with `display_device_busy`.

## Events and error codes

| Event | Severity | Trigger |
|---|---|---|
| `display_started` | Info | Modeset succeeded, ALSA opened (or muted), first frame queued. |
| `display_stopped` | Info | Cancellation token fired. Includes lifetime `frames_displayed`, `frames_dropped_late`, `audio_underruns`. |
| `display_device_unavailable` | Critical | KMS connector vanished mid-flow (cable unplug observed via udev or `drmModeGetConnector`). |
| `display_mode_set_failed` | Critical | `drmModeSetCrtc` returned `EINVAL` / `ENOSPC` for the chosen resolution / refresh. |
| `display_audio_open_failed` | Critical | `snd_pcm_open` returned non-zero, or ALSA `writei` returned `ENODEV` mid-stream. |
| `display_decoder_overload` | Warning | `frames_dropped_late` > 5 % over a 5-s rolling window. |
| `display_av_drift` | Warning | `|av_sync_offset_ms|` > 100 ms sustained ≥ 3 s. |
| `display_subscriber_lagged` | Warning | broadcast `Lagged(n)`; rate-limited to one event / second. The decoders flush and resync on the next IDR. |

Save-time errors that surface as `command_ack.error_code` on `add_output` / `update_config`:

| `error_code` | Meaning |
|---|---|
| `display_device_invalid` | `device` regex failed at config-load OR connector not present in `enumerate_displays()` at runtime OR build was compiled without the `display` Cargo feature. |
| `display_audio_device_invalid` | `audio_device` regex failed OR ALSA refused to open it. |
| `display_resolution_unsupported` | Configured `resolution` / `refresh_hz` does not match any mode the connector advertises. |
| `display_program_not_found` | After 5 s, the demuxer hasn't seen the configured `program_number` in the PAT. |
| `display_audio_track_not_found` | Configured `audio_track_index` exceeds the PMT's audio-stream count. |
| `display_device_busy` | Another active output already claimed this `(device, audio_device)` pair. |
| `display_decoder_overload_predicted` | Validation-time hint when 4K60 is requested without HW decode. Does **not** block save — informational only. |

## Per-output stats

`OutputStats.display_stats` carries the live numbers for the manager UI:

| Field | Meaning |
|---|---|
| `frames_displayed` | Total frames page-flipped since the output started. |
| `frames_dropped_late` | Frames dropped because they fell more than one frame-period behind the audio clock. |
| `frames_repeated` | Frames held for an extra vsync because the next decoded frame's PTS was too far ahead of the audio clock. |
| `audio_underruns` | ALSA `EPIPE` recoveries observed by the audio task. |
| `av_sync_offset_ms` | Signed EMA of the video-vs-audio offset (positive = video late). |
| `current_resolution` | Negotiated KMS resolution (e.g. `"1920x1080"`). |
| `current_refresh_hz` | Negotiated refresh rate. |
| `pixel_format` | Pixel format on the wire (v1: always `"XRGB8888"`). |
| `decoder_kind` | `"sw"` in v1; `"vaapi"` / `"nvdec"` arrive in v2. |
| `video_codec` | `"h264"` / `"hevc"`. |
| `audio_codec` | `"aac"` / `"mp2"` / `"ac3"` / `"eac3"` / `"opus"` / `"none"`. |

The manager renders the resolution annotation as `display (1920x1080@60Hz)` in the per-output table on the flow detail page, plus a green `DISPLAY` badge in the name column.

## Limitations (v1)

- Linux only.
- NVDEC and Intel QSV hardware decode are available behind the `display-nvdec` / `display-qsv` Cargo features (both bundled in the `*-linux-full` release). VA-API decode is still scheduled for v2 behind the `display-vaapi` placeholder.
- HDMI hotplug is discovered at startup only — adding a cable later requires restarting the edge before it shows up in `display_devices`.
- Multichannel passthrough over HDMI is not supported — multichannel sources are downmixed to stereo on the configured `audio_channel_pair`.
- One active display output per connector — cross-output uniqueness is enforced.
- HDR / wide-gamut metadata, closed captions, and SCTE-104 cue display are not rendered. The decoded raw video is what reaches the screen.

## Where to read next

- [Configuration reference](/edge/configuration/) — the full output schema, including the display fields above.
- [Edge events and alarms](/edge/events-and-alarms/) — the full event catalogue including the `display` category.
- [Install an edge node](/edge/getting-started/) — base install, including the runtime apt packages.
