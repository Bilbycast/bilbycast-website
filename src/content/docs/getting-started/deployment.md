---
title: Deployment Guide
description: Step-by-step deployment of the full bilbycast stack.
sidebar:
  order: 2
---

This guide covers deploying the full bilbycast stack: manager, relay, and edge nodes.

## Build Order

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
