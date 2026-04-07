---
title: Stats Reference
description: Structured stats from the bilbycast-relay /api/v1/stats endpoint — bandwidth, throughput, peaks, uptime, and tunnel-level counters.
sidebar:
  order: 4
---

bilbycast-relay exposes structured statistics on `GET /api/v1/stats` (in addition to the Prometheus metrics on `GET /metrics`). The structured endpoint is the right one to consume from a custom dashboard or monitoring script — it gives you the same numbers in a single JSON response without the overhead of scraping a Prometheus exposition.

This page documents every field in that response.

## `GET /api/v1/stats`

**Auth:** Required when `api_token` is configured (Bearer token).

**Response:** A single JSON object.

```json
{
  "uptime_secs": 86400,
  "software_version": "0.7.1",
  "totals": {
    "bytes_in": 1234567890,
    "bytes_out": 1234567890,
    "datagrams_in": 1500000,
    "datagrams_out": 1500000,
    "streams_opened": 4200,
    "active_connections": 12,
    "active_tunnels": 8,
    "active_edges": 16
  },
  "bandwidth": {
    "current_in_bps": 245000000,
    "current_out_bps": 245000000,
    "current_total_bps": 490000000
  },
  "peaks": {
    "peak_connections": 24,
    "peak_tunnels": 12,
    "peak_edges": 20,
    "peak_bps": 980000000,
    "peak_bps_at": "2026-04-06T18:42:11Z"
  },
  "tunnels": [
    {
      "tunnel_id": "550e8400-e29b-41d4-a716-446655440000",
      "ingress_edge": "edge-syd-1",
      "egress_edge": "edge-perth-1",
      "bytes_in": 50000000,
      "bytes_out": 50000000,
      "datagrams_in": 60000,
      "datagrams_out": 60000,
      "current_bps": 122500000,
      "bound_at": "2026-04-07T00:00:00Z"
    }
  ]
}
```

## Field reference

### Top-level

| Field | Type | Meaning |
|---|---|---|
| `uptime_secs` | u64 | Seconds since the relay process started |
| `software_version` | string | Build version (`0.7.1`, etc.) |

### `totals`

Cumulative since process start. All counters are lock-free atomics.

| Field | Type | Meaning |
|---|---|---|
| `bytes_in` | u64 | Total bytes received from any edge across all tunnels |
| `bytes_out` | u64 | Total bytes sent to any edge across all tunnels |
| `datagrams_in` | u64 | Total UDP datagrams received |
| `datagrams_out` | u64 | Total UDP datagrams sent |
| `streams_opened` | u64 | Total bidirectional QUIC streams opened by edges |
| `active_connections` | u64 | Number of edges currently connected to the relay |
| `active_tunnels` | u64 | Number of tunnels currently bound on both legs |
| `active_edges` | u64 | Number of distinct edge identities currently connected (different from `active_connections` if an edge has multiple connections) |

### `bandwidth`

Current bandwidth derived from the difference of byte counters over a sliding window (default ~1 s).

| Field | Type | Meaning |
|---|---|---|
| `current_in_bps` | u64 | Current ingress bitrate to the relay |
| `current_out_bps` | u64 | Current egress bitrate from the relay |
| `current_total_bps` | u64 | Sum of in + out (the relay-side throughput observers care about) |

### `peaks`

Peak watermarks since process start, with timestamps.

| Field | Type | Meaning |
|---|---|---|
| `peak_connections` | u64 | Maximum concurrent edge connections |
| `peak_tunnels` | u64 | Maximum concurrent tunnels |
| `peak_edges` | u64 | Maximum distinct edges |
| `peak_bps` | u64 | Maximum total bandwidth observed |
| `peak_bps_at` | string (ISO 8601) | When the bandwidth peak occurred |

### `tunnels[]`

One entry per currently-active tunnel.

| Field | Type | Meaning |
|---|---|---|
| `tunnel_id` | UUID | Tunnel identifier (matches the manager's tunnel ID) |
| `ingress_edge` | string | Edge ID of the ingress side (or `null` if not yet identified) |
| `egress_edge` | string | Edge ID of the egress side |
| `bytes_in` | u64 | Bytes received on the ingress leg |
| `bytes_out` | u64 | Bytes sent on the egress leg |
| `datagrams_in` | u64 | UDP datagrams on the ingress leg |
| `datagrams_out` | u64 | UDP datagrams on the egress leg |
| `current_bps` | u64 | Current per-tunnel bitrate |
| `bound_at` | string (ISO 8601) | When the tunnel was first bound (oldest leg) |

## Quick examples

### Check active tunnel count from a script

```bash
curl -s -H "Authorization: Bearer $RELAY_TOKEN" \
  http://relay.example.com:4434/api/v1/stats \
  | jq '.totals.active_tunnels'
```

### Pull current per-tunnel bitrates

```bash
curl -s -H "Authorization: Bearer $RELAY_TOKEN" \
  http://relay.example.com:4434/api/v1/stats \
  | jq '.tunnels[] | {tunnel_id, current_bps}'
```

### Calculate average bytes per datagram

```bash
curl -s -H "Authorization: Bearer $RELAY_TOKEN" \
  http://relay.example.com:4434/api/v1/stats \
  | jq '.totals | (.bytes_in / .datagrams_in)'
```

## Prometheus equivalent

Every field on this endpoint has a Prometheus counter or gauge on `GET /metrics`. Use the structured endpoint for one-off scripts and the Prometheus endpoint for time-series storage. Both read from the same atomics, so the numbers always agree.
