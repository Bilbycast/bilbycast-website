---
title: Getting Started
description: Overview of the bilbycast suite and how to get up and running.
sidebar:
  order: 1
---

Bilbycast is a suite of Rust projects for professional broadcast media transport. The core components work together to move live video and audio between locations with broadcast-grade reliability, in-process transcoding, hot input switching, and configurable path synchronisation.

## Components

| Component | Role |
|-----------|------|
| **bilbycast-edge** | Media transport gateway — bridges SRT, RIST, RTP, UDP, RTMP, RTSP, HLS, WebRTC, and SMPTE ST 2110-20/-23/-30/-31/-40, with in-process transcoding and hot input switching |
| **bilbycast-manager** | Web UI + API for remote management, monitoring, and AI-assisted flow configuration |
| **bilbycast-relay** | QUIC relay for NAT traversal between edge nodes |
| **bilbycast-srt** | SRT protocol library (used by edge internally) |
| **bilbycast-rist** | RIST (VSF TR-06-1 Simple Profile) library (used by edge internally) |
| **bilbycast-fdk-aac-rs** | Fraunhofer FDK AAC wrapper — in-process AAC decode / encode |
| **bilbycast-ffmpeg-video-rs** | FFmpeg libavcodec / libswscale wrapper — in-process video decode, scaling, JPEG encode, and Opus / MP2 / AC-3 audio encode |
| **bilbycast-appear-x-api-gateway** | Bridge for Appear X broadcast devices |

## Architecture

```
                    ┌─────────────────────┐
                    │  bilbycast-manager   │
                    │  (Web UI + API)      │
                    └────────┬────────────┘
                             │ WebSocket (wss://)
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼───────┐  ┌──▼──────────┐  ┌▼────────────────┐
     │ bilbycast-edge  │  │ bilbycast-  │  │ bilbycast-edge   │
     │ (Site A)        │  │ relay       │  │ (Site B)         │
     └────────┬────────┘  └──┬──────────┘  └┬────────────────┘
              │              │              │
              └──────────────┘──────────────┘
                    QUIC tunnels (encrypted)
```

Edge nodes connect outbound to the manager via WebSocket, enabling management of devices behind firewalls and NAT. The relay provides QUIC-based tunneling between edge nodes that can't reach each other directly.

## Prerequisites

- [Rust toolchain](https://rustup.rs/) (stable, edition 2024)
- Postgres 18 (for bilbycast-manager — `docker compose -f docker-compose.dev.yml up -d` brings up a local cluster on port 5433 for development)

## Quick Start

The fastest way to see bilbycast in action is to run a standalone edge node:

```bash
# Build the edge node
cd bilbycast-edge
cargo build --release

# Create a minimal config (config v2 — independent inputs/outputs/flows)
cat > config.json << 'EOF'
{
  "version": 2,
  "server": { "listen_addr": "0.0.0.0", "listen_port": 8080 },
  "inputs": [
    {
      "id": "in-srt",
      "name": "SRT Input",
      "type": "srt",
      "mode": "listener",
      "local_addr": "0.0.0.0:9000",
      "latency_ms": 120
    }
  ],
  "outputs": [
    {
      "id": "out-rtp",
      "name": "RTP Output",
      "type": "rtp",
      "dest_addr": "192.168.1.100:5004"
    }
  ],
  "flows": [
    {
      "id": "srt-to-rtp",
      "name": "SRT Input to RTP Output",
      "enabled": true,
      "input_ids": ["in-srt"],
      "output_ids": ["out-rtp"]
    }
  ]
}
EOF

# Start the node
./target/release/bilbycast-edge --config config.json
```

See the [Deployment](/getting-started/deployment/) guide for full multi-component setup, or jump to [Your First Flow](/getting-started/first-flow/) for a step-by-step walkthrough.
