---
title: Relay Overview
description: bilbycast-relay — stateless, opaque per-path relay for NAT traversal between edge nodes.
sidebar:
  order: 1
---

bilbycast-relay is a stateless relay server that enables NAT traversal between bilbycast-edge nodes behind NAT. It is a **generic, opaque per-path forwarder**: it pairs the two ends of each path by tunnel ID and forwards `[tunnel_id][ciphertext]` verbatim between them. It cannot read tunnel payloads (end-to-end ChaCha20-Poly1305 encryption between edges), and it never terminates or combines the streams it carries.

It forwards three logically distinct path types, all the same opaque way:

- **QUIC tunnels** — TCP streams + UDP datagrams over QUIC / TLS 1.3 (`:4433`).
- **Native SRT / RIST over relay** — plain UDP, no QUIC (`:4434`), so SRT/RIST keep their own ARQ + congestion control without QUIC's overhead.
- **Individual bond legs** — a relayed [multi-path bond](/edge/bonding/) leg is just a native plain-UDP tunnel. Bond aggregation, cross-leg ARQ, FEC, and reordering run **end-to-end edge↔edge**; the relay forwards each leg opaquely. There is **no "bond bridge"** — the relay does not terminate or combine bonds.

## Key Features

- **Zero-config startup** — Runs with no config file, self-signed TLS certificate auto-generated
- **QUIC/TLS 1.3** — QUIC-tunnel traffic encrypted in transit
- **Native-UDP carrier** — Plain-UDP data plane (`:4434`, on by default) for native SRT/RIST and bond legs over relay; both ends dial out, so a bond can work with both ends behind NAT
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
| `GET /api/v1/tunnels` | List active QUIC tunnels |
| `GET /api/v1/udp-sessions` | List active native-UDP relay sessions |
| `GET /api/v1/edges` | List connected edges |
| `GET /api/v1/stats` | Bandwidth, throughput, peaks, uptime |

Two administrative teardown routes exist for orphan cleanup when the manager is unavailable: `DELETE /api/v1/tunnels/{id}` and `DELETE /api/v1/udp-sessions/{id}`. Both are fail-closed — they return `403` unless `api_token` is configured.

## Quick Start

```bash
# Zero-config start
cargo build --release
./target/release/bilbycast-relay

# With config
./target/release/bilbycast-relay -c relay.json
```

Default ports: QUIC on `0.0.0.0:4433`, the native-UDP relay on `0.0.0.0:4434`, REST API on `0.0.0.0:4480`. When edges live outside the relay's host, also set `public_quic_addr` (and `public_udp_addr` if you use the native-UDP carrier) in the config — or pass `--public-quic-addr` / `--public-udp-addr` — to the hostname or public IP edges will dial. That's what gets advertised to the manager and pre-populates the tunnel-creation dropdown.

See [Architecture](/relay/architecture/) for the full design and connection lifecycle.
