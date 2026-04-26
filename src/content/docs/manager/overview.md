---
title: Manager Overview
description: bilbycast-manager — centralized monitoring and management for distributed media transport.
sidebar:
  order: 1
---

bilbycast-manager is the centralized control plane for bilbycast. It provides a web dashboard, REST API, and WebSocket connectivity for real-time status, configuration, and control of distributed media transport nodes.

## Key Features

- **Web dashboard** — Real-time overview of all managed devices with status, flows, and bitrate.
- **Network topology** — Live visual map with graph and signal flow views.
- **Node management** — Register, configure, and monitor edge nodes and relay servers remotely.
- **[Live Switcher](/manager/switcher/)** — In-browser PGM/PVW director console with Take semantics, presets, and per-tenant pages.
- **[Routines](/manager/routines/)** — Cron-scheduled named target state across flows, DST-correct via IANA timezones, with manual activation, skip-next-fire, and partial/failed/missed events.
- **[Multi-tenant Groups](/manager/multi-tenant-groups/)** — Per-tenant users, nodes, tunnels, switcher pages, routines, audit trail, quotas, and per-tenant logo + brand-colour theming. Access-control boundary only.
- **[On-edge Media Library](/manager/media-library/)** — Browser upload + delete of slates, loops, and emergency-fallback content for the edge `media_player` input, with quota enforcement.
- **AI assistant** — AI-assisted flow configuration with support for multiple LLM providers (OpenAI, Anthropic, Gemini).
- **Device driver pattern** — Extensible architecture supporting edge nodes, relays, and third-party devices via vendor sidecars.
- **Hybrid RBAC** — Platform role (`user` / `super_admin`) plus per-group `viewer` / `operator` / `admin` membership, with shared resources via `resource_shares`.
- **MFA + SSO** — TOTP second factor for local accounts; OIDC Single Sign-On (Authorization Code + PKCE) with optional group-sync — see [Security](/manager/security/).
- **Encryption at rest** — Envelope encryption (AES-256-GCM with per-domain HKDF-SHA256 KEKs) for every secret; one-shot master-key rotation via `rotate-master-key`.
- **[Encrypted backup & restore](/manager/backup/)** — Two passphrase-sealed paths: portable application-level export/import, and DR-grade `pg_dump` archive coordinated via Postgres advisory lock.
- **[Active/Active HA](/manager/active-active-ha/)** — Two manager instances against a shared Postgres cluster, with cross-instance pubsub via LISTEN/NOTIFY and per-region observability on Prometheus metrics.

## Architecture

The manager is a full-stack Rust application:

- **Backend** — Axum REST/WebSocket server backed by **Postgres 18**.
- **Frontend** — Embedded static HTML + vanilla JavaScript (Tailwind CSS dark theme).
- **Communication** — All nodes connect outbound to the manager via WebSocket, enabling management of devices behind firewalls and NAT.

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
