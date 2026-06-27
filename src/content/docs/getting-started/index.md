---
title: Getting Started
description: Overview of the bilbycast suite and how to get up and running.
sidebar:
  order: 1
---

Bilbycast is a suite of Rust projects for professional broadcast media transport. Edge nodes move live video and audio between locations; the manager is the web UI that controls them; the relay traverses NAT between sites that can't reach each other directly.

## Components

| Component | Role |
|-----------|------|
| **bilbycast-manager** | Web UI + API. Controls edge nodes and relays. Where you click to make things happen. |
| **bilbycast-edge** | Media transport gateway. Bridges SRT, RIST, RTP, UDP, RTMP, RTSP, HLS, CMAF, WebRTC, and SMPTE ST 2110. In-process transcoding and local-display playout. |
| **bilbycast-relay** | Stateless, opaque per-path relay for NAT traversal between edge sites (QUIC tunnels + a native-UDP carrier for SRT/RIST and bond legs). |
| **bilbycast-appear-x-api-gateway** | Sidecar that bridges Appear X devices into the manager. |

A few helper crates (`bilbycast-srt`, `bilbycast-rist`, `bilbycast-fdk-aac-rs`, `bilbycast-ffmpeg-video-rs`, `bilbycast-bonding`) ship inside the edge — you don't install them separately.

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

Edge nodes connect outbound to the manager — devices behind NAT or restrictive firewalls don't need any inbound port.

## What you'll do

A typical first deployment takes about 20 minutes and looks like this:

1. **[Install the manager](/manager/getting-started/)** — one command brings up Postgres + the binary as a systemd service, and you log in to the web UI.
2. **[Install the relay](/relay/getting-started/)** — only if your sites can't reach each other directly. Skip otherwise.
3. **[Install an edge node](/edge/getting-started/)** — download, run, then point a browser at the **setup wizard** to register it with the manager. No hand-edited config files.
4. **[Create your first flow](/getting-started/first-flow/)** — point-and-click in the manager UI: add an input, add an output, click Save.

For a high-level view of the deployment topology and firewall flows, see the [Deployment overview](/getting-started/deployment/).
