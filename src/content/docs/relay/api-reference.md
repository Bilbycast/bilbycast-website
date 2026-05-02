---
title: API Reference
description: REST endpoints exposed by bilbycast-relay for health, stats, and tunnel inspection.
sidebar:
  order: 4
---

bilbycast-relay exposes a small REST API on port 4480 (default) for health checks, Prometheus scraping, and tunnel introspection. The API is read-only — operational changes (`authorize_tunnel`, `revoke_tunnel`, `disconnect_edge`) flow through the manager's WebSocket protocol, not REST.

## Authentication

Set `api_token` in `relay.json` to require Bearer auth. The token must be 32–128 characters:

```json
{
  "quic_addr": "0.0.0.0:4433",
  "api_addr": "0.0.0.0:4480",
  "api_token": "<32-128 chars>"
}
```

When `api_token` is configured, every endpoint **except `/health`** requires:

```
Authorization: Bearer <token>
```

When unset, every endpoint is open. The relay does constant-time comparison so an invalid token can't be discovered by timing the `401` response.

## Endpoints

### `GET /health` (public)

Always reachable, even when `api_token` is set. Used by load balancers, the manager's reachability probe, and your own monitoring.

```bash
curl http://relay-host:4480/health
```

```json
{
  "status": "ok",
  "version": "0.x.y",
  "uptime_secs": 12345,
  "connected_edges": 4,
  "total_tunnels": 7,
  "active_tunnels": 5
}
```

A tunnel is **active** when both legs (ingress + egress) are bound. **Total** counts include tunnels in the half-bound `TunnelWaiting` state.

### `GET /metrics`

Prometheus exposition format. Auth-gated when `api_token` is set.

```bash
curl -H "Authorization: Bearer <token>" \
  http://relay-host:4480/metrics
```

Useful series:

- `bilbycast_relay_uptime_seconds`
- `bilbycast_relay_connected_edges`
- `bilbycast_relay_active_tunnels` / `bilbycast_relay_total_tunnels`
- `bilbycast_relay_bytes_ingress_total` / `bilbycast_relay_bytes_egress_total`
- `bilbycast_relay_bandwidth_bps`
- `bilbycast_relay_peak_tunnels` / `bilbycast_relay_peak_edges`

Pair with the [Stats reference](/relay/stats-reference/) for the full series catalogue.

### `GET /api/v1/stats`

Aggregate relay-wide stats. Auth-gated.

```bash
curl -H "Authorization: Bearer <token>" \
  http://relay-host:4480/api/v1/stats
```

```json
{
  "uptime_secs": 12345,
  "connected_edges": 4,
  "total_tunnels": 7,
  "active_tunnels": 5,
  "total_bytes_ingress": 1234567890,
  "total_bytes_egress": 1234567890,
  "total_bytes_forwarded": 2469135780,
  "total_bandwidth_bps": 50000000,
  "total_tcp_streams": 14,
  "active_tcp_streams": 6,
  "total_udp_datagrams": 9876543,
  "peak_tunnels": 12,
  "peak_edges": 9,
  "connections_total": 87
}
```

`total_bandwidth_bps` is computed across the most recent reporting window — it's the live throughput, not a lifetime average.

### `GET /api/v1/tunnels`

Per-tunnel state. Auth-gated.

```bash
curl -H "Authorization: Bearer <token>" \
  http://relay-host:4480/api/v1/tunnels
```

```json
{
  "tunnels": [
    {
      "tunnel_id": "550e8400-e29b-41d4-a716-446655440000",
      "state": "active",
      "ingress_edge_id": "edge-syd-1",
      "egress_edge_id": "edge-perth-1",
      "bytes_ingress": 1234567,
      "bytes_egress": 1234567,
      "tcp_streams_total": 4,
      "tcp_streams_active": 2,
      "udp_datagrams_total": 5678
    }
  ]
}
```

`state` is one of `waiting` (only one leg bound), `active` (both legs bound), or `unbinding` (transition state).

### `GET /api/v1/edges`

Connected edge nodes. Auth-gated.

```bash
curl -H "Authorization: Bearer <token>" \
  http://relay-host:4480/api/v1/edges
```

```json
{
  "edges": [
    {
      "edge_id": "edge-syd-1",
      "remote_addr": "203.0.113.10:53219"
    }
  ]
}
```

`edge_id` is whatever the edge sent in its optional `Identify { edge_id }` message — typically the manager `node_id` so the manager can correlate topology. If the edge never sent `Identify`, the relay synthesises a `connection_id` from the remote address plus a counter.

## Tunnel authorisation (manager-driven)

Per-tunnel HMAC-SHA256 bind authentication is managed by **bilbycast-manager** through its WebSocket protocol — not via REST. The manager pre-registers expected ingress + egress bind tokens on the relay using `authorize_tunnel`, and revokes them with `revoke_tunnel`. When `relay.json` sets `require_bind_auth: true`, every `TunnelBind` from an edge must include a matching `bind_token` or the relay rejects the bind with `TunnelDown { reason: "bind authentication failed" }`.

This is the mechanism the manager uses to ensure that only the two edges it pairs end up sharing a tunnel. The relay holds no operator-supplied state for this — it just maintains a `DashMap` of pre-registered tokens that the manager refreshes.

For the operator-visible side of this — how the manager authors tunnels and which UI surfaces the per-tunnel auth state — see [IP tunneling](/manager/ip-tunneling/).

## Limits

- Bearer tokens: 32–128 characters.
- QUIC control messages: max 1 MB per message.
- Per-connection: 1024 bidirectional QUIC streams, 256 unidirectional, 15 s keep-alive.
- UDP datagram buffers: 2 MB send + 2 MB receive (sized for SRT at 10 Mbps in flight).

## Where to read next

- [Install the relay](/relay/getting-started/) — download, configure, and run.
- [Architecture](/relay/architecture/) — internal design and stateless forwarding.
- [Security & authentication](/relay/security/) — bind tokens, ChaCha20-Poly1305 end-to-end encryption.
- [Stats reference](/relay/stats-reference/) — Prometheus metrics catalogue.
- [Events & alarms](/relay/events-and-alarms/) — operational events the relay emits to the manager.
