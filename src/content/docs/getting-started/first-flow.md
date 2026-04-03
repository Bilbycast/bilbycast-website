---
title: Your First Flow
description: Create your first media transport flow with bilbycast-edge.
sidebar:
  order: 3
---

This guide walks you through creating a simple SRT-to-RTP media flow.

## What is a Flow?

A flow in bilbycast is a single input fanning out to one or more outputs. The input receives media (e.g., from an SRT source) and each output independently delivers it to a destination.

```
Input (SRT) ──► broadcast channel ──► Output 1 (RTP)
                                  ──► Output 2 (UDP)
                                  ──► Output 3 (RTMP)
```

Slow outputs drop packets rather than causing backpressure — they never affect the input or other outputs.

## Step 1: Create the Config

Create a `config.json` with an SRT listener input and an RTP output:

```json
{
  "version": 1,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "monitor": {
    "listen_addr": "0.0.0.0",
    "listen_port": 9090
  },
  "flows": [
    {
      "id": "my-first-flow",
      "name": "SRT to RTP",
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
          "id": "rtp-out",
          "name": "RTP Output",
          "dest_addr": "127.0.0.1:5004"
        }
      ]
    }
  ]
}
```

## Step 2: Start the Edge

```bash
./target/release/bilbycast-edge --config config.json
```

The edge starts listening for SRT connections on port 9000.

## Step 3: Send Media

Use any SRT-capable tool to send media to the edge:

```bash
# Using srt-live-transmit
srt-live-transmit udp://source:1234 srt://edge-ip:9000

# Using ffmpeg (if SRT support is compiled in)
ffmpeg -re -i input.mp4 -c copy -f mpegts srt://edge-ip:9000
```

## Step 4: Receive the Output

The RTP output is sent to `127.0.0.1:5004`. View it with:

```bash
# Using ffplay
ffplay -i rtp://127.0.0.1:5004

# Using VLC
vlc rtp://127.0.0.1:5004
```

## Step 5: Monitor

- **REST API**: `http://localhost:8080/api/v1/stats`
- **Monitor Dashboard**: `http://localhost:9090`
- **Prometheus Metrics**: `http://localhost:9090/metrics`

## Adding More Outputs

Add multiple outputs to the same flow. Each subscribes independently to the broadcast channel:

```json
{
  "outputs": [
    {
      "type": "rtp",
      "id": "rtp-out",
      "name": "RTP Multicast",
      "dest_addr": "239.1.1.1:5004"
    },
    {
      "type": "srt",
      "id": "srt-out",
      "name": "SRT Forward",
      "mode": "caller",
      "remote_addr": "destination:9001",
      "latency_ms": 120
    },
    {
      "type": "rtmp",
      "id": "rtmp-out",
      "name": "YouTube Live",
      "url": "rtmp://a.rtmp.youtube.com/live2",
      "stream_key": "your-stream-key"
    }
  ]
}
```

## Next Steps

- [Supported Protocols](/edge/supported-protocols/) — full protocol reference
- [Configuration](/edge/configuration/) — complete config file documentation
- [API Reference](/edge/api-reference/) — REST API endpoints
