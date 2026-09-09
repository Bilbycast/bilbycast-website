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
2. **Opens a real encoder + decoder against each compiled-in HW backend** — NVENC, NVDEC, QSV (encode + decode), VAAPI (encode + decode), AMF (encode only — AMD decode rides VAAPI), RKMPP (encode + decode, Rockchip) and VideoToolbox on macOS. Distinguishes "compiled in but no driver / no GPU / no permissions" from "actually usable". NVENC retries once on `EAGAIN`; QSV warns loud on `EACCES` (operator's running user isn't in the `video` / `render` group).
3. **Probes per-family HW session capacity** — opens encoder sessions in a loop against each backend until one fails, capped at 32 on the 1080p tier (`SESSION_PROBE_UPPER_BOUND`) and at 8 on the optional 4K second pass (`FOUR_K_UPPER_BOUND`, gated by `tuning.probe_4k`). Exposes `hw_encoder_session_limits` on the budget. Disable by setting `tuning.probe_session_limits` to `false` in the node's config (Manager → node → Configure → Tuning) if startup latency matters more than knowing the limit (the cap then falls back to the documented vendor minimums).
4. **Polls NVML for live GPU utilisation** when the `hardware-monitor-nvml` Cargo feature is on and an NVIDIA GPU is present (Linux + Windows only). Live NVENC / NVDEC utilisation % and active session count update every 5 s. No published release artefact is built with that feature — see [NVML live polling](#nvml-live-polling) below.

The probe **never blocks flow start** — the cost model uses the static support shape, and live oversubscription warnings ride alongside.

## The resource budget shape

```jsonc
{
  "resource_budget": {
    "units_total": 7400,
    "units_used": 480,
    "hw_encoders": {
      // h264/hevc × nvenc / qsv / videotoolbox / amf / vaapi / rkmpp —
      // twelve booleans, every one always on the wire. NVENC only here.
      "h264_nvenc": true,
      "hevc_nvenc": true,
      "h264_qsv": false,
      "hevc_qsv": false
      // … the other eight false
    },
    "hw_decoders": {
      // Same twelve keys, from the decoder probe — NVDEC only here.
      "h264_nvenc": true,
      "hevc_nvenc": true
      // … the other ten false
    },
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
      "hevc_nvenc_yuv420_10bit": true,
      "hevc_qsv_yuv422_8bit": false,
      "hevc_qsv_yuv422_10bit": false,
      "hevc_vaapi_yuv422_10bit": false
    },
    // "vaapi": { "h264_encode", "h264_decode", "hevc_encode", "hevc_decode" }
    // — omitted entirely when all four are false, as on this NVIDIA-only host.
    "hw_encoder_diagnostics": [
      {
        "family": "qsv",
        "status": "no_driver",
        "detail": "no Intel /dev/dri/renderD* node — no Intel GPU, or the i915 / xe driver is not loaded (a discrete NVIDIA/AMD render node does not provide QSV)"
      }
    ],
    "cpu": {
      "brand": "AMD EPYC 7543P 32-Core",
      "physical_cores": 32,
      "logical_cores": 64,
      "avx_class": "avx2"
    },
    "sw_capacity": {
      "x264_720p30_streams": 16,
      "x265_720p30_streams": 8,
      "aac_encode_streams": 6400
    },
    "threads": {
      "codec_pool_count": 6
    }
  }
}
```

| Field | Meaning |
|---|---|
| `units_total` | Per-host budget. `1000 + 200 × physical_cores`. |
| `units_used` | Live sum across all running flows. |
| `hw_encoders` / `hw_decoders` | Always present. Per-(codec, backend) booleans — `h264_` / `hevc_` × `nvenc` / `qsv` / `videotoolbox` / `amf` / `vaapi` / `rkmpp`, each set by a real open at boot, not by a compile-time flag (VAAPI decode probes an `av_hwdevice_ctx_create` instead — FFmpeg exposes VAAPI decode as a hwaccel, not a named decoder; the AMF decode pair is hard-coded `false`, because AMD decode rides VAAPI). This is "can this host open that backend at all", distinct from the *capacity* caps in the `*_session_limits` blocks below. |
| `hw_session_usage` | Flat map of live session counts — one `*_in_use` counter per HW family (`nvenc_in_use`, `qsv_in_use`, `vaapi_in_use`, `amf_in_use`, `rkmpp_in_use`) plus the decoder counters (`nvdec_in_use`, `qsv_decode_in_use`, `vaapi_decode_in_use`, `rkmpp_decode_in_use`). Each also carries a `*_in_use_4k` sub-count for the 4K-resolution subset. The four base encoder counters (`nvenc_in_use`, `qsv_in_use`, `videotoolbox_in_use`, `amf_in_use`) always serialize — even at zero; the additive counters (`vaapi_in_use`, every `*_in_use_4k`, `rkmpp_in_use`, and the decoder counters) are omitted from the wire when zero. There is no per-family object and no embedded limit — the caps live in the separate `*_session_limits` blocks below. |
| `hw_encoder_session_limits` | Probed **encoder** cap per family — `nvenc` / `qsv` / `amf` / `vaapi` / `rkmpp` `_max_sessions` plus a matching `_max_sessions_4k`. Only families that were actually probed appear; a missing or `null` field means "not probed" (family not compiled in, probe disabled, or the 4K tier was skipped). The manager UI compares `*_in_use + flow's planned sessions` against the cap before save. |
| `hw_decoder_session_limits` | Probed **decoder** cap per family — `nvdec` / `qsv` / `vaapi` / `rkmpp` `_max_sessions` (+ `_max_sessions_4k`). Same "only-when-probed" rule; emitted as its own object alongside the encoder limits, not nested inside them. |
| `hw_encoder_chroma` | Per-(codec, chroma, bit-depth) cell — `true` if the backend opened that combination at probe time. The codec dropdown in the manager UI keys off these. |
| `vaapi` | VAAPI capability split by direction — `h264_encode` / `h264_decode` / `hevc_encode` / `hevc_decode`. Omitted from the wire entirely when all four are false. Newer managers prefer it over the legacy `hw_encoders.{h264,hevc}_vaapi` mirror, which stays populated for older ones. |
| `hw_encoder_diagnostics` | Array of `{ family, status, detail }` — one entry per encoder family (`nvenc` / `qsv` / `vaapi`) that does **not** work on this host; absent entirely on a healthy one. `status` is `blocked` (device node present, can't be opened — driver, permissions or sandbox), `busy` (session slots exhausted), `no_driver` (no such GPU on this box) or `not_built` (the GPU is present and healthy, this binary simply has no encoder for it). `not_built` is the answer to "my GPU is idle and every encode runs on CPU": the fix is a rebuild with the `video-encoder-*` feature named in `detail`, or a `*-full` release artefact — nothing on the host changes. See [Codec matrix](/edge/codec-matrix/). |
| `cpu` | CPU brand + `physical_cores` + `logical_cores` + `avx_class`. |
| `sw_capacity` | Software-encode capacity estimates (rough, ±50 %): `x264_720p30_streams` / `x265_720p30_streams` = concurrent 720p30 software encodes before saturating; `aac_encode_streams` = concurrent AAC encodes. Pure arithmetic on the `cpu` block above — `x264_720p30_streams` = `floor(physical_cores / 2 × avx_mult)`, where `avx_mult` is 1.3 for AVX-512, 1.0 for AVX2 (and aarch64 / anything non-x86), 0.6 for SSE4.2 and 0.4 for none; `x265_720p30_streams` = `x264 / 2` (integer division, so it reads 0 on a 2-core box); `aac_encode_streams` = `200 × physical_cores`. |
| `threads` | Always present. Live hot-path thread inventory — `{ "codec_pool_count": N }` and nothing else today. |

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
| display output, any resolution (SW decode) | 275 |
| display output, any resolution (HW decode — NVDEC / QSV / VAAPI / RKMPP) | 100 |
| … plus `show_audio_bars` on either | +15 |

A display output is charged as a **flat per-output constant** — the pixel-rate formula above applies only to outputs carrying a `video_encode` block. (ST 2110-20/-23 outputs run an internal encoder too, but are charged the flat 500-unit SW baseline whatever their raster — the cost model calls the same helper with no resolution overrides.) A 4K60 display output costs exactly what a 1080p30 one costs; what moves the number is whether the decode landed on hardware, and whether the audio-bars overlay is on.

Cost-unit weights are mid-tier reference numbers; the exact figures live in `engine::flow::derive_cost_plan` and may drift between releases.

### Per-host budget reference

| Hardware class | Budget | Comfortably fits |
|---|---|---|
| 4-core SBC (Pi 4, ARM box) | 1 800 | One 1080p50 NVENC + headroom (no 4K transcode). |
| 8-core workstation | 2 600 | Two 1080p59.94 NVENC + a 1080p HLS package. |
| 16-core EPYC / Xeon | 4 200 | One 4K60 NVENC + assorted 1080p contribution. |
| 32-core EPYC / Xeon | 7 400 | One 4K60 4:2:2 NVENC contribution + several 1080p paths, or one 4K60 libx265 broadcast contribution by itself. |

## Oversubscription — soft warnings, never blocking

Two error codes fire when the budget gets tight, across three emit paths:

| Event | Origin | When it fires |
|---|---|---|
| `hw_encoder_oversubscribed` | edge (`FlowManager::create_flow`) | A new flow's planned HW sessions would push the per-family count above the probed cap. Fires once at flow start. |
| `hw_encoder_oversubscribed` | manager watchdog | A debounced second alarm path catches **mid-run** capacity changes — e.g. an external process holding NVENC sessions outside the edge's control. |
| `hw_decoder_oversubscribed` | edge (`FlowManager::create_flow`) | A new flow's planned HW-**decode** sessions (`nvdec` / `qsv` / `vaapi` / `rkmpp` — transcode input decode, or a HW-decoded display output) would push the per-family count above the probed `hw_decoder_session_limits`. There is no manager-watchdog counterpart: the watchdog walks encoder families only. |

All three ride as Warning events on the `system_resources` category, carrying `{ error_code, family, role, in_use, max_sessions, flow_id }` — `role` is `"encoder"` or `"decoder"`, so one chip shape covers both. The manager-watchdog copy substitutes `node_id` + `origin: "manager_watchdog"` for `flow_id`. The flow still starts — the cap is advisory, and the underlying driver returns its own runtime error if it really can't open another session. Operators see the warning in the manager events feed and either resize the host, switch one flow to a different backend (e.g. NVENC → libx264 for the lowest-priority flow), or reduce concurrent flow count.

## Manager UI surface

Edges advertise `"resources"` on `HealthPayload.capabilities`. When that bit is present the manager renders:

- **Per-node Resources card** (Node detail → Resources tab) showing `units_used / units_total`, per-family HW session chips, CPU brand + cores + AVX class, NVML live utilisation when available.
- **Per-flow "Resource impact" preview** on the create / edit modal — shows the flow's planned cost units, planned HW sessions per family, and a coloured chip if either would push the per-node totals into oversubscribe territory.

Edges without the capability bit (older releases, builds with no encoders) show neither — the manager UI degrades gracefully.

## Disabling the session-capacity probe

The probe walks each HW backend opening throwaway sessions in a loop. On most hosts it adds < 1 second to boot; on some (heavily-loaded NVENC hosts, particularly), it can spike to several seconds. Disable for tight startup-latency budgets from Manager → node → Configure → **Tuning**, or in the node's `config.json` directly:

```jsonc
{
  "tuning": {
    "probe_session_limits": false
  }
}
```

Setting `tuning.probe_4k` to `false` instead is the narrower version — it skips only the second-tier 4K pass and keeps the 1080p tier, where `probe_session_limits` disables both. Either is read once at node start, so a pushed change takes effect at the node's next restart.

With the probe disabled, `hw_encoder_session_limits.*` reports `null` and the manager UI falls back to the documented vendor minimums (3 NVENC sessions on consumer cards; unbounded for QSV / VAAPI / AMF). Operators trade probe time for slightly weaker oversubscription detection.

This was `BILBYCAST_PROBE_SESSION_LIMITS` (and `BILBYCAST_PROBE_4K`) before the tuning block existed. Both environment variables are still read as a fallback **below** the config field, and a node that sets one raises a Warning `deprecated_env_var` event naming the replacement — see [Environment Variables](/reference/environment-variables/).

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

**No published release artefact is built with `hardware-monitor-nvml`.** All three (`x86_64-linux-full`, `aarch64-linux-full`, `aarch64-linux-rockchip`) omit it, so on a downloaded binary `resource_budget.live` is `null` and the manager's live GPU tile stays empty even on an NVIDIA host. It populates only on a binary you build yourself with `--features hardware-monitor-nvml`.

## See also

- [Codec matrix](/edge/codec-matrix/) — what backend `*_auto` resolves to per host class, plus the static support matrix.
- [Display Output](/edge/display/) — display outputs consume budget just like transcoding outputs.
- [Events & Alarms — `system_resources` category](/edge/events-and-alarms/) — the full event reference for `hw_encoder_oversubscribed` and `hw_decoder_oversubscribed`.
