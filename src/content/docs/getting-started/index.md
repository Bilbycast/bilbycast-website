---
title: Getting Started
description: Overview of the bilbycast suite and how to get up and running.
sidebar:
  order: 1
---

Bilbycast is a suite of Rust projects for professional broadcast media transport. The core components work together to move live video and audio between locations with broadcast-grade reliability.

## Components

| Component | Role |
|-----------|------|
| **bilbycast-edge** | Media transport gateway — bridges SRT, RTP, UDP, RTMP, RTSP, HLS, WebRTC |
| **bilbycast-manager** | Web UI + API for remote management and monitoring |
| **bilbycast-relay** | QUIC relay for NAT traversal between edge nodes |
| **bilbycast-srt** | Pure Rust SRT protocol library (used by edge internally) |
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
- SQLite3 (for bilbycast-manager)

## Quick Start

The fastest way to see bilbycast in action is to run a standalone edge node:

```bash
# Build the edge node
cd bilbycast-edge
cargo build --release

# Create a minimal config
cat > config.json << 'EOF'
{
  "version": 1,
  "server": { "listen_addr": "0.0.0.0", "listen_port": 8080 },
  "flows": [
    {
      "id": "srt-to-rtp",
      "name": "SRT Input to RTP Output",
      "enabled": true,
      "input": {
        "type": "srt",
        "mode": "listener",
        "local_addr": "0.0.0.0:9000",
        "latency_ms": 120
      },
      "outputs": [
        {
          "type": "rtp",
          "id": "out-1",
          "name": "RTP Output",
          "dest_addr": "192.168.1.100:5004"
        }
      ]
    }
  ]
}
EOF

# Start the node
./target/release/bilbycast-edge --config config.json
```

See the [Deployment](/getting-started/deployment/) guide for full multi-component setup, or jump to [Your First Flow](/getting-started/first-flow/) for a step-by-step walkthrough.
