---
title: Edge Overview
description: bilbycast-edge — media transport gateway for professional broadcast workflows.
sidebar:
  order: 1
---

bilbycast-edge is a media transport gateway that bridges multiple protocols for professional broadcast workflows. Each node runs one or more flows, where a flow connects one or more inputs (one active at a time) to any number of outputs by reference. Inputs, outputs, and flows are independently managed entities — outputs can be reused across flows, and a flow with multiple inputs supports zero-gap hot switching between them.

## Supported Protocols

| Protocol | Input | Output | Notes |
|----------|:-----:|:------:|-------|
| **SRT** | Yes | Yes | Caller, listener, rendezvous; AES encryption; Stream ID; 2022-7 redundancy; optional `audio_encode` + `video_encode` on TS; optional output `delay` |
| **RIST** | Yes | Yes | VSF TR-06-1 Simple Profile — NACK-driven retransmit, 2022-7 bonding, optional `audio_encode` + `video_encode` on TS, optional output `delay` |
| **RTP** | Yes | Yes | SMPTE 2022-1 FEC; unicast/multicast; DSCP QoS; optional `audio_encode` + `video_encode` on TS; optional output `delay` |
| **UDP** | Yes | Yes | Raw MPEG-TS; unicast/multicast; SMPTE 302M audio mode; optional `audio_encode` + `video_encode` on TS; optional output `delay` |
| **RTMP/RTMPS** | Yes | Yes | H.264 (FLV) and Enhanced-RTMP HEVC, AAC audio; publish to Twitch/YouTube/Facebook or ingest from OBS/ffmpeg; TLS; optional `audio_encode` + `video_encode` |
| **RTSP** | Yes | — | Pull H.264/H.265 from IP cameras; TCP/UDP transport |
| **HLS** | — | Yes | Segment-based egress; HEVC/HDR; MPTS filtering; optional `audio_encode` (AAC / HE-AAC v1/v2 / MP2 / AC-3) |
| **WebRTC** | Yes | Yes | WHIP/WHEP via `str0m`; H.264 + Opus (H.264-only on egress — HEVC sources auto-transcoded); AAC→Opus via `audio_encode` |
| **SMPTE ST 2110-20** | Yes | Yes | Uncompressed video, RFC 4175 YCbCr 4:2:2 8/10-bit, PTP, 2022-7 Red/Blue. Inputs need a compiled-in video encoder feature; outputs need only the default `video-thumbnail` feature |
| **SMPTE ST 2110-23** | Yes | Yes | ST 2110-20 with 2SI and sample-row partition modes for higher resolutions/framerates |
| **SMPTE ST 2110-30** | Yes | Yes | Linear PCM (L16/L24), 48k/96k, 1–16 channels, PM/AM packet times, SMPTE 2022-7 Red/Blue |
| **SMPTE ST 2110-31** | Yes | Yes | AES3 transparent (Dolby E, etc.) — same wire framing as -30, preserves user/status/parity bits |
| **SMPTE ST 2110-40** | Yes | Yes | RFC 8331 ancillary data (SCTE-104, SMPTE 12M timecode, CEA-608/708 captions) |
| **`rtp_audio`** | Yes | Yes | Generic RFC 3551 PCM over RTP — wire-identical to ST 2110-30 but no PTP requirement; `transport_mode: "audio_302m"` option on output for RTP/MP2T delivery |

All transport and FEC implementations are native Rust. The default build includes the `fdk-aac` feature (Fraunhofer FDK AAC — AAC-LC, HE-AAC v1/v2, multichannel up to 7.1) and the `video-thumbnail` feature (FFmpeg libavcodec/libswscale for thumbnails, video decode, Opus/MP2/AC-3 in-process audio encode, and uncompressed ST 2110-20/-23 video decode). H.264/HEVC software encoding requires opting into `video-encoder-x264` / `video-encoder-x265` (GPL) or `video-encoder-nvenc` — the `*-full` release channel bundles all three.

## Key Features

- **Independent inputs / outputs / flows (config v2)** — Each is a first-class entity with its own ID. Flows reference inputs and outputs by ID (`input_ids`, `output_ids`). Outputs can be reused across flows; inputs can be pre-staged and attached on demand
- **Seamless input switching** — Flows with multiple `input_ids` support zero-gap cutover via `POST /api/v1/flows/{id}/activate-input`. A shared `TsContinuityFixer` (per flow) with per-input PSI caching creates a clean CC jump for receiver resync, injects the new input's cached PAT/PMT with a bumped `version_number`, and forwards immediately. Fully format-agnostic — inputs can use different codecs, containers, and transports (e.g., H.264 on one input, HEVC on another, JPEG XS on a third, uncompressed ST 2110 on a fourth)
- **Video transcoding** — SRT, RIST, UDP, RTP, RTMP, and WebRTC outputs accept an optional `video_encode` block. TS-carrying outputs run a streaming `TsVideoReplacer` (source → `VideoDecoder` → `VideoEncoder` → re-muxed into TS, non-video PIDs untouched). RTMP H.264 uses classic FLV; RTMP HEVC uses Enhanced RTMP v2 (hvc1). WebRTC is H.264-only (browsers don't decode HEVC) — HEVC sources are auto-transcoded. Encoders: libx264, libx265, or NVIDIA NVENC, opt-in via Cargo features. Full matrix, per-codec defaults, and licence implications are documented in `bilbycast-edge/docs/transcoding.md` in the repo
- **Output delay / path sync** — SRT, RIST, RTP, and UDP outputs accept an optional `delay` block for synchronising parallel paths with different processing latencies. Three modes: `fixed` (constant ms delay), `target_ms` (target end-to-end latency — self-adjusting), `target_frames` (target latency in video frames using auto-detected frame rate, with optional ms fallback)
- **Audio gateway** — Per-output PCM transcode (sample-rate / bit-depth / channel routing via pure-Rust rubato), IS-08 channel-map hot reload without restarting flows (matrix routing, 5.1→stereo BS.775 downmix, stereo→mono sum, mono→stereo split presets), SMPTE 302M LPCM-in-MPEG-TS on SRT / UDP / `rtp_audio` outputs for byte-identical interop with `ffmpeg -c:a s302m` and broadcast hardware decoders — see [Audio Gateway](/edge/audio-gateway/)
- **Compressed-audio bridge** — In-process AAC decoder (Fraunhofer FDK AAC by default — AAC-LC, HE-AAC v1/v2, multichannel up to 7.1; pure-Rust `symphonia` fallback for AAC-LC mono/stereo) lands AAC contribution from RTMP / RTSP / SRT / UDP / RTP-TS as PCM on the ST 2110-30/-31, `rtp_audio`, and SMPTE 302M outputs (Phase A). Optional `audio_encode` block re-encodes audio to AAC-LC, HE-AAC v1/v2 (in-process FDK AAC), or Opus, MP2, AC-3 (in-process libavcodec on the default `video-thumbnail` build; ffmpeg subprocess fallback) on RTMP, HLS, WebRTC, SRT, UDP, RTP, and RIST outputs. Marquee chain: AAC RTMP contribution → Opus WebRTC distribution in one edge process
- **SMPTE ST 2110** — Phase 1: audio essences (-30 PCM, -31 AES3) and ancillary data (-40). Phase 2: uncompressed video (-20 RFC 4175, -23 with 2SI and sample-row partition modes). Best-effort PTP integration via external `ptp4l` management socket. SMPTE 2022-7 Red/Blue dual-network support everywhere
- **SMPTE 2022-1 FEC** — Forward Error Correction for RTP (encode + decode) and SRT (wire-compatible with libsrt 1.5.5 row/staircase/2D modes)
- **SMPTE 2022-7 hitless redundancy** — Dual-leg input merging for seamless failover; also available inside the RIST protocol layer as native bonding
- **Flow groups** — `start_flow_group` / `stop_flow_group` manager commands bring up multi-essence broadcast bundles (audio + ANC + video) all-or-nothing in parallel; failures roll back every started member
- **NMOS IS-04 / IS-05 / IS-08 + BCP-004** — Broadcast control system integration with multi-essence audio/data/video resources, audio channel mapping, and BCP-004 receiver capability constraint sets
- **mDNS-SD discovery** — Best-effort `_nmos-node._tcp` registration for automatic NMOS controller discovery
- **TR-101290 analysis** — Transport stream quality monitoring
- **RP 2129 trust boundary** — Inter-arrival time, PDV, source filtering metrics
- **WebRTC via str0m** — Pure Rust WebRTC stack, WHIP/WHEP support, HEVC→H.264 auto-transcode on egress
- **Media analysis** — Per-program PID breakdown for MPTS inputs (codec, resolution, frame rate, audio format) surfaced in the manager UI
- **MPTS ↔ SPTS** — Full multi-program transport stream passthrough on UDP/RTP/SRT/RIST/HLS, with per-output `program_number` down-selection to extract any single program as a rewritten SPTS. RTMP/WebRTC outputs and thumbnails lock onto a chosen program deterministically
- **Thumbnail generation** — Per-flow 320×180 JPEG thumbnails generated in-process via libavcodec on the default `video-thumbnail` build. Flow-level `thumbnail_program_number` picks which MPTS program the preview shows

## Deployment Options

1. **Standalone** — No external dependencies, run with a local config file
2. **With API auth** — OAuth 2.0 client credentials for Prometheus and external monitoring
3. **Managed** — Connected to bilbycast-manager for remote configuration and monitoring
4. **Browser setup** — Field deployment via web-based setup wizard at `/setup`

## Architecture

The system is organized into three planes:

| Plane | Purpose |
|-------|---------|
| **Control** | REST API, authentication, configuration, manager commands |
| **Data** | Packet processing, protocol I/O, FEC, redundancy, tunnels |
| **Monitor** | Lock-free metrics, dashboard, Prometheus endpoint |

Each flow has an input task connected to N output tasks via a `broadcast::channel`. Outputs are independent — a slow output drops packets rather than blocking the input or other outputs.

## Quick Start

```bash
cargo build --release
./target/release/bilbycast-edge --config config.json
```

See [Configuration](/edge/configuration/) for the full config reference and [Your First Flow](/getting-started/first-flow/) for a walkthrough.
