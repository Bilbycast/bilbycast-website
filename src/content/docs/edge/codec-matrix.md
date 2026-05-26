---
title: Codec Matrix
description: Pick a video encoder, understand the h264_auto / hevc_auto resolver, and verify your host activates the right backend.
sidebar:
  order: 14
---

The release binary bundles every video encoder + decoder backend the edge knows about — libx264, libx265, NVIDIA NVENC + NVDEC, Intel QSV (x86_64 only), and VAAPI. At startup the hardware probe walks the active set, opens a minimal session against each, and advertises capability bits on `HealthPayload.capabilities` for the ones that actually work on this host. The manager UI keys per-output codec dropdowns off those bits.

This page covers the **static support matrix**, the **`*_auto` resolver** that does the right thing without operator hand-holding, and the **verification commands** for confirming what activated on a given host.

## Pick `*_auto` unless you have a reason not to

For most operators the right answer on `video_encode.codec` is **`h264_auto`** or **`hevc_auto`**. The edge resolves Auto on flow start against the host's probed capabilities and the requested chroma + bit-depth, picking the cheapest backend that handles the combination:

| Family + chroma + bit-depth | Resolver chain (head → tail) |
|---|---|
| H.264 + 4:2:0 + 8-bit (the dominant distribution path) | NVENC ≻ QSV ≻ VAAPI ≻ libx264 |
| H.264 + anything else | libx264 (no HW H.264 backend supports 4:2:2 / 10-bit / 4:4:4) |
| HEVC + 4:2:0 + 8-bit | NVENC ≻ QSV ≻ VAAPI ≻ libx265 |
| HEVC + 4:2:0 + 10-bit | NVENC ≻ VAAPI ≻ QSV ≻ libx265 |
| HEVC + 4:2:2 + 8-bit | VAAPI (Intel iHD) ≻ libx265 |
| HEVC + 4:2:2 + 10-bit | VAAPI (Intel iHD) ≻ libx265 |
| HEVC + 4:4:4 (any) | libx265 (HW backends reject NV24 today) |

Operators who need wire-level reproducibility (compliance deployments, vendor-specific bitstream behaviour) pick an explicit backend — the manager UI cross-validates the chroma + bit-depth combo before flow start, so an invalid combination fails at save time, not at flow bring-up.

## Video encode — pixel-format / bit-depth matrix

| Backend | 4:2:0 / 8 | 4:2:2 / 8 | 4:2:0 / 10 | 4:2:2 / 10 | 4:4:4 |
|---|:-:|:-:|:-:|:-:|:-:|
| **libx264** (CPU, `video-encoder-x264`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| **libx265** (CPU, `video-encoder-x265`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| **h264_nvenc** (NVIDIA, `video-encoder-nvenc`) | ✓ | ✗ | ✗ | ✗ | ✗ |
| **hevc_nvenc** (NVIDIA, `video-encoder-nvenc`) | ✓ | ✗ | ✓ | ✗ | ✗ |
| **h264_qsv** (Intel, `video-encoder-qsv`) | ✓ | ✗ | ✗ | ✗ | ✗ |
| **hevc_qsv** (Intel, `video-encoder-qsv`) | ✓ | ✗ | ✓ | ✗ | ✗ |
| **h264_vaapi** (Linux, `video-encoder-vaapi`) | ✓ | ✗ | ✗ | ✗ | ✗ |
| **hevc_vaapi** (Intel iHD Tiger Lake+) | ✓ | ✓ | ✓ | ✓ | ✗ (NV24 deferred) |
| **hevc_vaapi** (AMD radeonsi) | ✓ | usually ✗ | ✓ | usually ✗ | ✗ |

**Implication for broadcast 4:2:2 contribution:** on NVIDIA-only and AMD-only hosts there is **no GPU path** for 4:2:2 10-bit; libx265 is the only option. Intel Tiger Lake+ iGPUs have the full broadcast HEVC matrix through VAAPI.

Static rejection happens at config validation **and** at encoder open, so an operator who bypasses the manager UI still gets a precise error before any frame is encoded.

## Video decode — coverage by path

| Backend | Display output (KMS) | TS → TS transcode | Notes |
|---|:-:|:-:|---|
| **libavcodec** (CPU) | ✓ (fallback) | ✓ (universal) | Every format, every bit-depth. |
| **NVDEC** (`video-decoder-nvdec`) | ✓ zero-copy scanout | ✓ | x86_64; 4:2:0 only. |
| **QSV decode** (`video-decoder-qsv`) | ✓ | ✓ | x86_64; 4:2:0 only. |
| **VAAPI decode** (`video-decoder-vaapi`) | ✓ zero-copy DMA-BUF | ✓ | Linux; Intel iHD does 4:2:2 + Main10. |

**Auto resolution priority** — both the display path and the transcode input-decode path share the same priority:

```
VAAPI ≻ NVDEC ≻ QSV ≻ CPU
```

The display path also relies on KMS atomic-commit zero-copy via DRM PRIME (see [Display Output](/edge/display/)); the transcode path doesn't get the same fast scanout but still benefits from offloading decode to dedicated silicon.

## Audio codec matrix

| Codec | Encode | Decode | Sample rates | Channels | Notes |
|---|---|---|---|---|---|
| **AAC-LC** | FDK-AAC in-process (`fdk-aac`) | FDK-AAC | 8 k – 48 k | 1 – 8 | Production AAC, lowest latency. |
| **HE-AAC v1** | FDK-AAC | FDK-AAC | 8 k – 48 k | 1 – 2 | SBR adds chroma-bandwidth dependency. |
| **HE-AAC v2** | FDK-AAC | FDK-AAC | 8 k – 48 k | 2 (stereo only) | Parametric Stereo — manager UI hard-filters mono. |
| **Opus** | libopus via libavcodec | libopus via libavcodec | 48 k | 1 – 2 | Decode wired; transcode-from-Opus-on-TS works. |
| **MP2** | libavcodec | libavcodec | 32 k / 48 k | 1 – 2 | DVB-T / SD broadcast. |
| **AC-3** | libavcodec | libavcodec | 32 / 44.1 / 48 k | 1 – 6 (5.1) | ATSC / Blu-ray. |
| **E-AC-3** | (passthrough only) | libavcodec | — | 1 – 7.1 | UHD ATSC 3.0. |
| **PCM (ST 2110-30 / -31)** | passthrough | passthrough | 48 k / 96 k | 1 – 16 | Hardcoded sample-rate in config. |
| **SMPTE 302M** | inline mux | inline demux | matches input | matches input | `transport_mode: audio_302m` on SRT / UDP / `rtp_audio`. |

## Capability strings on `HealthPayload.capabilities`

Edges advertise the following when the matching feature is compiled in **and** the runtime probe finds the underlying driver / GPU usable. Anything missing is disabled in the manager UI dropdowns with a tooltip.

| Capability | Source | Meaning |
|---|---|---|
| `video-encode` | any of x264 / x265 / nvenc / qsv / vaapi | Edge can re-encode video at all. |
| `video-encoder-x264` | `video-encoder-x264` | libx264 available. |
| `video-encoder-x265` | `video-encoder-x265` | libx265 available. |
| `video-encoder-nvenc` | `video-encoder-nvenc` + probe | h264_nvenc / hevc_nvenc available. |
| `video-encoder-qsv` | `video-encoder-qsv` + probe | h264_qsv / hevc_qsv available. |
| `video-encoder-vaapi` | `video-encoder-vaapi` + probe | h264_vaapi / hevc_vaapi available. |
| `video-decoder-nvdec` | `video-decoder-nvdec` + probe | NVDEC available (transcode + display). |
| `video-decoder-qsv` | `video-decoder-qsv` + probe | QSV decode available. |
| `video-decoder-vaapi` | `video-decoder-vaapi` + probe | VAAPI decode available. |
| `display` | `display` + ≥ 1 KMS connector enumerated | Local-display output usable. |
| `fdk-aac` | `fdk-aac` | In-process AAC family. |
| `media-codecs` | `media-codecs` (default on) | libavcodec video decode + Opus / MP2 / AC-3. |
| `webrtc` | `webrtc` (default on) | WHIP / WHEP supported. |
| `tls` | `tls` (default on) | HTTPS + RTMPS. |
| `replay` | `replay` (default on) | Recording + clip playback. |

The `resource_budget.hw_encoder_chroma` block on the same payload carries the per-(codec, chroma, bit-depth) matrix with one boolean per cell — that's the source of truth the manager UI reads when graying out 4:2:2 chroma against NVENC.

## What `*_auto` activates on each host class

Static support is one thing; what your host actually opens at runtime is another. Common combinations:

| Host class | Auto resolves to (H.264 4:2:0 8-bit) | Auto resolves to (HEVC 4:2:2 10-bit) |
|---|---|---|
| x86_64 NVIDIA | NVENC | libx265 (NVENC rejects 4:2:2) |
| x86_64 Intel Tiger Lake+ iGPU | QSV (or VAAPI if explicitly preferred) | VAAPI (iHD does 4:2:2 + Main10) |
| x86_64 AMD | VAAPI | libx265 (AMD radeonsi rejects 4:2:2) |
| aarch64 NVIDIA Jetson | NVENC | libx265 |
| aarch64 AMD APU SBC | VAAPI | libx265 |
| Headless / no GPU | libx264 | libx265 |

## Verification — confirm Auto activates the right backend

1. **Inspect the host capability matrix.** Start the edge and `curl /api/v1/stats/health` (or open the manager Node detail → Resources card):

   ```bash
   curl https://edge:8443/api/v1/stats/health \
        -H "Authorization: Bearer $TOKEN" | \
     jq '.resource_budget.hw_encoder_chroma'
   ```

   On Tiger Lake+ Intel iHD: `hevc_vaapi_yuv422_10bit = true`.
   On AMD radeonsi: `hevc_vaapi_yuv422_10bit = false`.
   On any host with NVENC: every `hevc_nvenc_yuv422_*` cell is `false`.

2. **Confirm Auto resolution lands on the expected backend.** Create a flow with `video_encode.codec = "h264_auto"`, chroma `yuv420p`, 8-bit. Watch the edge logs for:

   ```
   video_encode auto-resolved 'h264_auto' → <backend>
   ```

   On an NVIDIA host this prints `→ nvenc_h264`; on Intel Tiger Lake+ `→ qsv_h264` (or `→ vaapi_h264` with explicit preference); on AMD `→ vaapi_h264`; on a host without any compiled-in HW backend that the probe could open `→ libx264`.

3. **Confirm an invalid combination is rejected up front.** Create a flow with `video_encode.codec = "h264_nvenc"`, chroma `yuv422p`. The manager preflight returns HTTP 422 + `error_code: encoder_chroma_not_supported` before the WS round-trip — the flow never reaches the edge.

4. **Confirm HW transcode decode activates.** Set `video_encode.hw_decode = "auto"` (the default) on a flow that decodes a source video. Edge logs:

   ```
   ts_video_replace: opened HW decoder (backend=Vaapi)
   ```

   (or `Nvdec` / `Qsv`). Running `perf top` against the edge process should show `av_hwframe_transfer_data` in the hot path (sysmem download) but no `libavcodec_decode_h264` — the decode itself ran on the GPU.

## Cost model — pixel-rate aware

Per-flow cost units scale with pixel rate. The HW vs SW base is the dominant axis: HW backends start at base 100, software at base 500.

```
units = base × (width × height × fps) / (1920 × 1080 × 30)
        × 1.5    if bit_depth == 10
        × 1.33   if chroma == yuv422p
        × 2.0    if chroma == yuv444p
```

Examples:

| Profile | Approximate units |
|---|---|
| 1080p25 H.264 4:2:0 8-bit on NVENC | ~83 |
| 1080p50 H.264 4:2:0 8-bit on NVENC (3G-SDI tier-1) | 167 |
| 1080p59.94 H.264 4:2:0 8-bit on NVENC | 200 |
| 1080p50 HEVC 4:2:2 10-bit on NVENC (broadcast contribution) | 313 |
| 4K30 H.264 4:2:0 8-bit on NVENC | 400 |
| 1080p50 H.264 4:2:0 8-bit on libx264 | 833 |
| 4K50 HEVC 4:2:2 10-bit on libx265 (broadcast contribution) | ~6 650 |
| 4K59.94 HEVC 4:2:2 10-bit on libx265 (broadcast contribution) | ~7 980 |
| 4K59.94 HEVC 4:2:0 8-bit on libx265 | ~4 800 |

The per-host budget is `1000 + 200 × physical_cores`, so a 4-core edge gets 1 800 units, a 32-core EPYC gets 7 400. See [Resources & Capacity](/edge/resources/) for the per-family HW session caps and how oversubscription is surfaced.

## See also

- [Resources & Capacity](/edge/resources/) — per-flow cost units, HW session limits, oversubscription events.
- [Display Output](/edge/display/) — KMS atomic-commit + zero-copy DMA-BUF scanout uses these same decode backends.
- [Edge repo `docs/codec-matrix.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/codec-matrix.md) — the source-of-truth canonical matrix.
- [Edge repo `docs/transcoding.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/transcoding.md) — operator reference for `video_encode` + `audio_encode` configuration.
