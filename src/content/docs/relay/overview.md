---
title: Relay Overview
description: bilbycast-relay — stateless QUIC relay for NAT traversal between edge nodes.
sidebar:
  order: 1
---

bilbycast-relay is a stateless QUIC relay server that enables IP tunneling between bilbycast-edge nodes behind NAT. It pairs ingress and egress edges by tunnel ID and forwards encrypted traffic between them — it cannot read tunnel payloads (end-to-end ChaCha20-Poly1305 encryption between edges).

## Key Features

- **Zero-config startup** — Runs with no config file, self-signed TLS certificate auto-generated
- **QUIC/TLS 1.3** — All traffic encrypted in transit
- **End-to-end encryption** — ChaCha20-Poly1305 between edges; relay sees only ciphertext
- **Optional API auth** — Bearer token authentication for REST API
- **Optional tunnel auth** — Per-tunnel HMAC-SHA256 bind tokens managed via manager
- **Manager integration** — Optional WebSocket connection for centralized monitoring
- **Lock-free design** — DashMap registries, AtomicU64 stats, zero Mutex usage

## Security Layers

| Layer | Mechanism |
|-------|-----------|
| Transport | TLS 1.3 via QUIC |
| End-to-end | ChaCha20-Poly1305 between edges |
| REST API | Optional Bearer token |
| Tunnel binding | Optional HMAC-SHA256 bind tokens |
| ALPN | `bilbycast-relay` protocol enforced |

## REST API

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check (always public) |
| `GET /metrics` | Prometheus metrics |
| `GET /api/v1/tunnels` | List active tunnels |
| `GET /api/v1/edges` | List connected edges |
| `GET /api/v1/stats` | Bandwidth, throughput, peaks, uptime |

## Quick Start

```bash
# Zero-config start
cargo build --release
./target/release/bilbycast-relay

# With config
./target/release/bilbycast-relay -c relay.json
```

Default ports: QUIC on `0.0.0.0:4433`, REST API on `0.0.0.0:4480`.

See [Architecture](/relay/architecture/) for the full design and connection lifecycle.
