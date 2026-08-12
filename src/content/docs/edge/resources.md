---
title: Resources & Capacity
description: How the edge probes hardware at startup, how per-flow cost units are computed, and how HW oversubscription is surfaced to operators.
sidebar:
  order: 15
---

Every edge probes its hardware once at startup, computes a per-host **resource budget**, and surfaces both the budget and the per-flow consumption on `HealthPayload.resource_budget`. The manager renders a Resources card per node and a "Resource impact" preview on the flow create modal. The whole thing is **soft-warning** — oversubscription emits events but never blocks operator action.

This page covers what the probe measures, how cost units scale, and how to read the manager UI's Resources surface.

## What the probe does at startup

`engine::hardware_probe` runs once on boot:

1. **Detects the CPU** — brand string + physical core count + AVX class via `sysinfo` + `is_x86_feature_detected!`. Maps `(cores × avx_mult)` to a heuristic "720p30 x264 streams" baseline.
2. **Opens a real encoder + decoder against each compiled-in HW backend** — NVENC, NVDEC, QSV (encode + decode), VAAPI (encode + decode), and VideoToolbox on macOS. Distinguishes "compiled in but no driver / no GPU / no permissions" from "actually usable". NVENC retries once on `EAGAIN`; QSV warns loud on `EACCES` (operator's running user isn't in the `video` / `render` group).
3. **Probes per-family HW session capacity** — opens encoder sessions in a loop against each backend until one fails, capped at 8. Exposes `hw_encoder_session_limits` on the budget. Disable with `tuning.probe_session_limits=false` if startup latency matters more than knowing the limit (the cap then falls back to the documented vendor minimums).
4. **Polls NVML for live GPU utilisation** when the `hardware-monitor-nvml` Cargo feature is on and an NVIDIA GPU is present (Linux + Windows only). Live NVENC / NVDEC utilisation % and active session count update every 5 s.

The probe **never blocks flow start** — the cost model uses the static support shape, and live oversubscription warnings ride alongside.

## The resource budget shape

```jsonc
{
  "resource_budget": {
    "units_total": 7400,
    "units_used": 480,
    "hw_session_usage": {
      "nvenc_in_use": 2,
      "qsv_in_use": 0,
      "videotoolbox_in_use": 0,
      "amf_in_use": 0,
      "nvenc_in_use_4k": 1,
      "nvdec_in_use": 1
    },
    "hw_encoder_session_limits": {
      "nvenc_max_sessions": 4,
      "qsv_max_sessions": null,
      "vaapi_max_sessions": null,
      "amf_max_sessions": null,
      "nvenc_max_sessions_4k": 2,
      "rkmpp_max_sessions": null
    },
    "hw_decoder_session_limits": {
      "nvdec_max_sessions": 4,
      "qsv_max_sessions": null,
      "vaapi_max_sessions": null,
      "nvdec_max_sessions_4k": 2
    },
    "hw_encoder_chroma": {
      "hevc_nvenc_yuv420_8bit": true,
      "hevc_nvenc_yuv420_10bit": true,
      "hevc_nvenc_yuv422_8bit": false,
      "hevc_nvenc_yuv422_10bit": false,
      "hevc_vaapi_yuv422_10bit": true
    },
    "cpu": {
      "brand": "AMD EPYC 7543P 32-Core",
      "physical_cores": 32,
      "logical_cores": 64,
      "avx_class": "avx2"
    },
    "sw_capacity": {
      "x264_720p30_streams": 64,
      "x265_720p30_streams": 24,
      "aac_encode_streams": 128
    }
  }
}
```

| Field | Meaning |
|---|---|
| `units_total` | Per-host budget. `1000 + 200 × physical_cores`. |
| `units_used` | Live sum across all running flows. |
| `hw_session_usage` | Flat map of live session counts — one `*_in_use` counter per HW family (`nvenc_in_use`, `qsv_in_use`, `vaapi_in_use`, `amf_in_use`, `rkmpp_in_use`) plus the decoder counters (`nvdec_in_use`, `qsv_decode_in_use`, `vaapi_decode_in_use`, `rkmpp_decode_in_use`). Each also carries a `*_in_use_4k` sub-count for the 4K-resolution subset. The four base encoder counters (`nvenc_in_use`, `qsv_in_use`, `videotoolbox_in_use`, `amf_in_use`) always serialize — even at zero; the additive counters (`vaapi_in_use`, every `*_in_use_4k`, `rkmpp_in_use`, and the decoder counters) are omitted from the wire when zero. There is no per-family object and no embedded limit — the caps live in the separate `*_session_limits` blocks below. |
| `hw_encoder_session_limits` | Probed **encoder** cap per family — `nvenc` / `qsv` / `amf` / `vaapi` / `rkmpp` `_max_sessions` plus a matching `_max_sessions_4k`. Only families that were actually probed appear; a missing or `null` field means "not probed" (family not compiled in, probe disabled, or the 4K tier was skipped). The manager UI compares `*_in_use + flow's planned sessions` against the cap before save. |
| `hw_decoder_session_limits` | Probed **decoder** cap per family — `nvdec` / `qsv` / `vaapi` / `rkmpp` `_max_sessions` (+ `_max_sessions_4k`). Same "only-when-probed" rule; emitted as its own object alongside the encoder limits, not nested inside them. |
| `hw_encoder_chroma` | Per-(codec, chroma, bit-depth) cell — `true` if the backend opened that combination at probe time. The codec dropdown in the manager UI keys off these. |
| `cpu` | CPU brand + `physical_cores` + `logical_cores` + `avx_class`. |
| `sw_capacity` | Software-encode capacity estimates (rough, ±50 %): `x264_720p30_streams` / `x265_720p30_streams` = concurrent 720p30 software encodes before saturating; `aac_encode_streams` = concurrent AAC encodes. |

## Cost units — how flows are priced

Each running flow carries a `FlowCostPlan` (computed at flow start by `engine::flow::derive_cost_plan`) that sums:

- **Per-input** weight — protocol-specific baseline (SRT / RTP / UDP / RIST / RTMP / RTSP / etc.) plus FEC / hitless / TR-101290 / content-analysis adders if enabled.
- **Per-output** weight — protocol baseline plus any active `video_encode` / `audio_encode` cost.
- **Pixel-rate-aware encode weight** for any output with `video_encode`:

  ```
  units = base × (width × height × fps) / (1920 × 1080 × 30)
          × 1.5    if bit_depth == 10
          × 1.33   if chroma == yuv422p
          × 2.0    if chroma == yuv444p
  ```

  `base` is 100 for HW backends and 500 for SW. Floored at the per-output baseline so a 240p test pattern stays at the per-output weight; ceilinged at 100 000 so a misconfigured 16K120 flow can't overflow the running total.

### Reference profiles

| Profile | Approximate units |
|---|---|
| 1080p25 H.264 4:2:0 8-bit on NVENC | ~83 |
| 1080p50 H.264 4:2:0 8-bit on NVENC | 167 |
| 1080p59.94 H.264 4:2:0 8-bit on NVENC | 200 |
| 1080p50 HEVC 4:2:2 10-bit on NVENC | 313 |
| 4K30 H.264 4:2:0 8-bit on NVENC | 400 |
| 1080p50 H.264 4:2:0 8-bit on libx264 | 833 |
| 4K30 H.264 4:2:0 8-bit on libx265 | ~2 400 |
| 4K59.94 HEVC 4:2:0 8-bit on libx265 | ~4 800 |
| 4K50 HEVC 4:2:2 10-bit on libx265 | ~6 650 |
| 4K59.94 HEVC 4:2:2 10-bit on libx265 | ~7 980 |
| 1080p30 display output (SW decode) | 275 |
| 4K60 display output (SW decode) | ~1 025 |

Cost-unit weights are mid-tier reference numbers; the exact figures live in `engine::flow::derive_cost_plan` and may drift between releases.

### Per-host budget reference

| Hardware class | Budget | Comfortably fits |
|---|---|---|
| 4-core SBC (Pi 4, ARM box) | 1 800 | One 1080p50 NVENC + headroom (no 4K transcode). |
| 8-core workstation | 2 600 | Two 1080p59.94 NVENC + a 1080p HLS package. |
| 16-core EPYC / Xeon | 4 200 | One 4K60 NVENC + assorted 1080p contribution. |
| 32-core EPYC / Xeon | 7 400 | One 4K60 4:2:2 NVENC contribution + several 1080p paths, or one 4K60 libx265 broadcast contribution by itself. |

## Oversubscription — soft warnings, never blocking

Two distinct codes fire when the budget gets tight:

| Event | Origin | When it fires |
|---|---|---|
| `hw_encoder_oversubscribed` | edge (`FlowManager::create_flow`) | A new flow's planned HW sessions would push the per-family count above the probed cap. Fires once at flow start. |
| `hw_encoder_oversubscribed` | manager watchdog | A debounced second alarm path catches **mid-run** capacity changes — e.g. an external process holding NVENC sessions outside the edge's control. |

Both ride as Warning events on the `system_resources` category. The flow still starts — the cap is advisory, and the underlying driver returns its own runtime error if it really can't open another session. Operators see the warning in the manager events feed and either resize the host, switch one flow to a different backend (e.g. NVENC → libx264 for the lowest-priority flow), or reduce concurrent flow count.

## Manager UI surface

Edges advertise `"resources"` on `HealthPayload.capabilities`. When that bit is present the manager renders:

- **Per-node Resources card** (Node detail → Resources tab) showing `units_used / units_total`, per-family HW session chips, CPU brand + cores + AVX class, NVML live utilisation when available.
- **Per-flow "Resource impact" preview** on the create / edit modal — shows the flow's planned cost units, planned HW sessions per family, and a coloured chip if either would push the per-node totals into oversubscribe territory.

Edges without the capability bit (older releases, builds with no encoders) show neither — the manager UI degrades gracefully.

## Disabling the session-capacity probe

The probe walks each HW backend opening throwaway sessions in a loop. On most hosts it adds < 1 second to boot; on some (heavily-loaded NVENC hosts, particularly), it can spike to several seconds. Disable for tight startup-latency budgets:

```bash
export tuning.probe_session_limits=false
./bilbycast-edge --config config.json
```

With the probe disabled, `hw_encoder_session_limits.*` reports `null` and the manager UI falls back to the documented vendor minimums (3 NVENC sessions on consumer cards; unbounded for QSV / VAAPI / AMF). Operators trade probe time for slightly weaker oversubscription detection.

## NVML live polling

When the edge is built with the `hardware-monitor-nvml` Cargo feature **and** an NVIDIA GPU is present (Linux + Windows only), the budget block carries live GPU stats updated every 5 s:

```jsonc
"live": {
  "nvenc_encoder_percent": 42,
  "nvdec_decoder_percent": 7,
  "nvenc_session_count": 2,
  "last_poll_unix": 1737600000
}
```

The block rides under the `live` key on the budget (not `nvml`), carries no GPU name, and populates only on NVIDIA hosts with the feature compiled in. The manager UI uses this for the live activity tile next to the static HW session chips. macOS builds (VideoToolbox) and non-NVIDIA hosts have no equivalent today.

## See also

- [Codec matrix](/edge/codec-matrix/) — what backend `*_auto` resolves to per host class, plus the static support matrix.
- [Display Output](/edge/display/) — display outputs consume budget just like transcoding outputs.
- [Events & Alarms — `system_resources` category](/edge/events-and-alarms/) — the full event reference for `hw_encoder_oversubscribed`.
