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

All protocol implementations are native Rust — no C library dependencies.

## Key Features

- **SMPTE 2022-1 FEC** — Forward Error Correction for RTP and SRT
- **SMPTE 2022-7 hitless redundancy** — Dual-leg input merging for seamless failover
- **NMOS IS-04/IS-05** — Broadcast control system integration
- **TR-101290 analysis** — Transport stream quality monitoring
- **RP 2129 trust boundary** — Inter-arrival time, PDV, source filtering metrics
- **WebRTC via str0m** — Pure Rust WebRTC stack, WHIP/WHEP support
- **Media analysis** — Codec, resolution, frame rate, audio format detection
- **Thumbnail generation** — Optional per-flow JPEG thumbnails (requires ffmpeg)

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
