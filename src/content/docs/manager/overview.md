---
title: Manager Overview
description: bilbycast-manager — centralized monitoring and management for distributed media transport.
sidebar:
  order: 1
---

bilbycast-manager is the centralized control plane for bilbycast. It provides a web dashboard, REST API, and WebSocket connectivity for real-time status, configuration, and control of distributed media transport nodes.

## Key Features

- **Web dashboard** — Real-time overview of all managed devices with status, flows, and bitrate
- **Network topology** — Live visual map with graph and signal flow views
- **Node management** — Register, configure, and monitor edge nodes and relay servers remotely
- **AI assistant** — AI-assisted flow configuration with support for multiple LLM providers
- **Device driver pattern** — Extensible architecture supporting edge nodes, relays, and third-party devices
- **Role-based access control** — Four-level hierarchy: Viewer, Operator, Admin, SuperAdmin
- **Encryption at rest** — All secrets encrypted with AES-256-GCM

## Architecture

The manager is a full-stack Rust application:

- **Backend** — Axum REST/WebSocket server with SQLite database
- **Frontend** — Embedded static HTML + vanilla JavaScript (Tailwind CSS dark theme)
- **Communication** — All nodes connect outbound to the manager via WebSocket, enabling management behind firewalls and NAT

### Device Driver Pattern

The manager uses a driver-aware architecture where each device type has a registered driver:

| Driver | Device Type | Description |
|--------|------------|-------------|
| **EdgeDriver** | `edge` | bilbycast-edge transport nodes |
| **RelayDriver** | `relay` | bilbycast-relay servers |
| **AppearXDriver** | `appear_x` | Appear X encoder/gateway units (via API gateway sidecar) |

New device types are added by implementing the `DeviceDriver` trait — the hub, database, API routes, and AI assistant work automatically for any registered driver.

## Deployment

```bash
# Build
cargo build --release

# Initialize database and create first admin
./target/release/bilbycast-manager setup --config config/default.toml

# Start the server
./target/release/bilbycast-manager serve --config config/default.toml
```

Required environment variables:
- `BILBYCAST_JWT_SECRET` — 64-char hex string for JWT signing
- `BILBYCAST_MASTER_KEY` — 64-char hex string for AES-256-GCM encryption

See the [Deployment Guide](/getting-started/deployment/) for full setup instructions and TLS configuration.
