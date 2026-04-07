---
title: Deployment Guide
description: Step-by-step deployment of the full bilbycast stack.
sidebar:
  order: 2
---

This guide covers deploying the full bilbycast stack: manager, relay, and edge nodes.

## Download Pre-built Binaries

Pre-built Linux binaries are available for x86_64 and aarch64 (ARM64). These commands always download the latest release.

### Edge (Media Gateway)

```bash
curl -fsSL -o bilbycast-edge \
  https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux
chmod +x bilbycast-edge
```

Verify checksum:
```bash
curl -fsSL -o bilbycast-edge.sha256 \
  https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux.sha256
sha256sum -c bilbycast-edge.sha256
```

### Relay (NAT Traversal)

```bash
curl -fsSL -o bilbycast-relay \
  https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/bilbycast-relay-$(uname -m)-linux
chmod +x bilbycast-relay
```

Verify checksum:
```bash
curl -fsSL -o bilbycast-relay.sha256 \
  https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/bilbycast-relay-$(uname -m)-linux.sha256
sha256sum -c bilbycast-relay.sha256
```

### Manager (Control Plane)

The manager is distributed as a tarball containing the binary, database migrations, and default configuration. Currently available for x86_64 only.

```bash
curl -fsSL -o bilbycast-manager.tar.gz \
  https://github.com/Bilbycast/bilbycast-manager-releases/releases/latest/download/bilbycast-manager-x86_64-linux.tar.gz
tar xzf bilbycast-manager.tar.gz
```

Verify checksum:
```bash
curl -fsSL -o bilbycast-manager.tar.gz.sha256 \
  https://github.com/Bilbycast/bilbycast-manager-releases/releases/latest/download/bilbycast-manager-x86_64-linux.tar.gz.sha256
sha256sum -c bilbycast-manager.tar.gz.sha256
```

### Appear X API Gateway

```bash
curl -fsSL -o bilbycast-appear-x-api-gateway \
  https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/releases/latest/download/bilbycast-appear-x-api-gateway-$(uname -m)-linux
chmod +x bilbycast-appear-x-api-gateway
```

Verify checksum:
```bash
curl -fsSL -o bilbycast-appear-x-api-gateway.sha256 \
  https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/releases/latest/download/bilbycast-appear-x-api-gateway-$(uname -m)-linux.sha256
sha256sum -c bilbycast-appear-x-api-gateway.sha256
```

:::note
`$(uname -m)` automatically detects your architecture (`x86_64` or `aarch64`). All binaries are statically linked (musl) with no runtime dependencies.
:::

## Build from Source (Alternative)

Build in this order — bilbycast-srt must be present before bilbycast-edge can compile:

```bash
# 1. SRT library (dependency of edge)
cd bilbycast-srt && cargo build --release

# 2. Edge node
cd bilbycast-edge && cargo build --release

# 3. Manager
cd bilbycast-manager && cargo build --release

# 4. Relay
cd bilbycast-relay && cargo build --release
```

## 1. Deploy the Manager

The manager is the central control plane. Deploy it first.

```bash
cd bilbycast-manager

# Create .env with required secrets
cp .env.example .env
echo "BILBYCAST_JWT_SECRET=$(openssl rand -hex 32)" >> .env
echo "BILBYCAST_MASTER_KEY=$(openssl rand -hex 32)" >> .env
chmod 600 .env

# Initialize database and create first admin user
./target/release/bilbycast-manager setup --config config/default.toml

# Start the server
./target/release/bilbycast-manager serve --config config/default.toml
```

### TLS Configuration

Choose one TLS mode:

**ACME / Let's Encrypt (recommended for production):**
```bash
BILBYCAST_ACME_ENABLED=true
BILBYCAST_ACME_DOMAIN=manager.example.com
BILBYCAST_ACME_EMAIL=admin@example.com
```

**File-based certificates:**
```bash
BILBYCAST_TLS_CERT=certs/server.crt
BILBYCAST_TLS_KEY=certs/server.key
```

**Behind a load balancer:**
```bash
BILBYCAST_TLS_MODE=behind_proxy
```

## 2. Deploy the Relay

The relay requires no configuration for basic operation:

```bash
# Zero-config start
./target/release/bilbycast-relay
```

To connect to the manager, create a node entry in the manager UI (device type: relay), then:

```json
{
  "quic_addr": "0.0.0.0:4433",
  "api_addr": "0.0.0.0:4480",
  "manager": {
    "enabled": true,
    "url": "wss://manager.example.com:8443/ws/node",
    "registration_token": "<token-from-manager>"
  }
}
```

## 3. Deploy Edge Nodes

### Optional system dependencies

The edge binary itself is statically linked (musl) and has no runtime library dependencies, but two **optional** features depend on external system tools. Install them only if you need the feature:

| Tool | Required for | What happens without it |
|---|---|---|
| `ffmpeg` | Per-flow thumbnail generation (`thumbnail: true` on a flow). The edge spawns `ffmpeg` as a subprocess every ~10 s, pipes ~3 s of buffered TS into it, and reads back a 320×180 JPEG which it forwards to the manager via the `thumbnail` WebSocket message. | Thumbnails are detected as unavailable at startup; flows with `thumbnail: true` still run normally, but no preview images appear in the manager UI. |
| `linuxptp` (`ptp4l`) | SMPTE ST 2110-30 / -31 / -40 essence flows that need PTP timing. The edge polls `ptp4l`'s management socket (default `/var/run/ptp4l`) to read lock state — it does **not** run a PTP slave in-process. See [PTP Integration](/edge/ptp/) for the operational details. | Any flow with `clock_domain` set still starts and runs, but reports `ptp_state: "unavailable"` in stats and the NMOS IS-04 `/self` clock resource shows `locked: false`. Receivers that require PTP lock will reject connections. Skip this entirely if you're not running ST 2110 essence flows — `rtp_audio`, SRT, RTP/MP2T, RTMP, RTSP, HLS, WebRTC, and the `audio_302m` transport mode have no PTP requirement. |

Install on Debian / Ubuntu:

```bash
sudo apt install ffmpeg          # only if you want thumbnails
sudo apt install linuxptp        # only if you run ST 2110 essence flows
```

Install on RHEL / Fedora:

```bash
sudo dnf install ffmpeg          # via RPM Fusion
sudo dnf install linuxptp
```

If you're running ST 2110, also configure `ptp4l` with your domain and NIC, then start it as a systemd service. A worked example is in [PTP Integration](/edge/ptp/#wiring-it-up).

Both dependencies are detected at edge startup and logged. If you add `ffmpeg` later, restart the edge to pick it up.

### Configure the edge

Create a node entry in the manager, then configure the edge:

**config.json:**
```json
{
  "version": 1,
  "server": { "listen_addr": "0.0.0.0", "listen_port": 8080 },
  "manager": {
    "enabled": true,
    "url": "wss://manager.example.com:8443/ws/node"
  },
  "flows": []
}
```

**secrets.json (chmod 600):**
```json
{
  "version": 1,
  "manager_registration_token": "<token-from-manager>"
}
```

After first connection, the edge registers automatically and receives permanent credentials.

### Browser-Based Setup (Field Deployment)

For hardware deployed at venues:

1. Start the edge with a minimal config
2. Open `http://<edge-ip>:8080/setup` in a browser
3. Fill in the device name, manager URL, and registration token
4. Save and restart the service

## Default Ports

| Service | Port | Protocol |
|---------|------|----------|
| Manager Web UI / API | 8443 | HTTPS |
| Edge REST API | 8080 | HTTP/HTTPS |
| Edge Monitor Dashboard | 9090 | HTTP |
| Relay QUIC | 4433 | QUIC/TLS 1.3 |
| Relay REST API | 4480 | HTTP |
