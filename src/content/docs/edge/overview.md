---
title: Edge Overview
description: bilbycast-edge — media transport gateway for professional broadcast workflows.
sidebar:
  order: 1
---

bilbycast-edge is a media transport gateway that bridges multiple protocols for professional broadcast workflows. Each node runs one or more flows, where a flow consists of a single input fanning out to multiple outputs, with support for SMPTE 2022-1 FEC and SMPTE 2022-7 hitless redundancy.

## Supported Protocols

| Protocol | Input | Output | Notes |
|----------|:-----:|:------:|-------|
| **SRT** | Yes | Yes | Caller, listener, rendezvous; AES encryption; Stream ID; 2022-7 redundancy |
| **RTP** | Yes | Yes | SMPTE 2022-1 FEC; unicast/multicast; DSCP QoS |
| **UDP** | Yes | Yes | Raw MPEG-TS; unicast/multicast |
| **RTMP/RTMPS** | Yes | Yes | H.264/AAC; publish from OBS/ffmpeg; TLS support |
| **RTSP** | Yes | — | Pull H.264/H.265 from IP cameras; TCP/UDP transport |
| **HLS** | — | Yes | Segment-based ingest; HEVC/HDR support |
| **WebRTC** | Yes | Yes | WHIP/WHEP; H.264 + Opus; browser compatible |
| **SMPTE ST 2110-30** | Yes | Yes | Linear PCM (L16/L24), 48k/96k, 1–16 channels, PM/AM packet times, SMPTE 2022-7 Red/Blue |
| **SMPTE ST 2110-31** | Yes | Yes | AES3 transparent (Dolby E, etc.) — same wire framing as -30, preserves user/status/parity bits |
| **SMPTE ST 2110-40** | Yes | Yes | RFC 8331 ancillary data (SCTE-104, SMPTE 12M timecode, CEA-608/708 captions) |
| **`rtp_audio`** | Yes | Yes | Generic RFC 3551 PCM over RTP — wire-identical to ST 2110-30 but no PTP requirement; `transport_mode: "audio_302m"` option on output for RTP/MP2T delivery |

All protocol implementations are native Rust — no C library dependencies. The optional `audio_encode` block on RTMP / HLS / WebRTC outputs is the one exception: it invokes `ffmpeg` at runtime via a subprocess, never linked.

## Key Features

- **SMPTE 2022-1 FEC** — Forward Error Correction for RTP and SRT
- **SMPTE 2022-7 hitless redundancy** — Dual-leg input merging for seamless failover
- **SMPTE ST 2110 (Phase 1)** — Broadcast-audio essences (-30 PCM, -31 AES3) and broadcast-data ancillary (-40), with PTP integration via external `ptp4l` and SMPTE 2022-7 Red/Blue dual-network support
- **Audio gateway** — Per-output PCM transcode (sample-rate / bit-depth / channel routing via pure-Rust rubato), IS-08 channel-map hot reload, SMPTE 302M LPCM-in-MPEG-TS on SRT / UDP / `rtp_audio` outputs for byte-identical interop with `ffmpeg -c:a s302m` and broadcast hardware decoders — see [Audio Gateway](/edge/audio-gateway/)
- **Compressed-audio bridge** — In-process pure-Rust AAC-LC decoder (`symphonia-codec-aac`) lands AAC contribution from RTMP / RTSP / SRT / UDP / RTP-TS as PCM on the ST 2110-30/-31, `rtp_audio`, and SMPTE 302M outputs (Phase A). Optional `audio_encode` block re-encodes audio to AAC-LC, HE-AAC v1/v2, Opus, MP2, or AC-3 on RTMP / HLS / WebRTC outputs via an ffmpeg sidecar (Phase B). Marquee chain: AAC RTMP contribution → Opus WebRTC distribution in one edge process
- **Flow groups** — `start_flow_group` / `stop_flow_group` manager commands bring up multi-essence broadcast bundles (audio + ANC + future video) all-or-nothing in parallel; failures roll back every started member
- **NMOS IS-04 / IS-05 / IS-08 + BCP-004** — Broadcast control system integration with multi-essence audio/data resources, audio channel mapping, and BCP-004 receiver capability constraint sets
- **mDNS-SD discovery** — Best-effort `_nmos-node._tcp` registration for automatic NMOS controller discovery
- **TR-101290 analysis** — Transport stream quality monitoring
- **RP 2129 trust boundary** — Inter-arrival time, PDV, source filtering metrics
- **WebRTC via str0m** — Pure Rust WebRTC stack, WHIP/WHEP support
- **Media analysis** — Per-program PID breakdown for MPTS inputs (codec, resolution, frame rate, audio format) surfaced in the manager UI
- **MPTS ↔ SPTS** — Full multi-program transport stream passthrough on UDP/RTP/SRT/HLS, with per-output `program_number` down-selection to extract any single program as a rewritten SPTS. RTMP/WebRTC outputs and thumbnails lock onto a chosen program deterministically
- **Thumbnail generation** — Optional per-flow JPEG thumbnails (requires ffmpeg). Flow-level `thumbnail_program_number` picks which MPTS program the preview shows

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
