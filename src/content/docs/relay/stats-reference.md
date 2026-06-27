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
  "connected_edges": 16,
  "total_tunnels": 9,
  "active_tunnels": 8,
  "total_bytes_ingress": 1234567890,
  "total_bytes_egress": 1234567890,
  "total_bytes_forwarded": 2469135780,
  "total_bandwidth_bps": 490000000,
  "total_tcp_streams": 4200,
  "active_tcp_streams": 12,
  "total_udp_datagrams": 1500000,
  "peak_tunnels": 12,
  "peak_edges": 20,
  "connections_total": 24
}
```

The per-tunnel breakdown is served separately on `GET /api/v1/tunnels`.

## Field reference

This is a single flat JSON object. All counters are lock-free atomics, cumulative since process start unless noted otherwise.

| Field | Type | Meaning |
|---|---|---|
| `uptime_secs` | u64 | Seconds since the relay process started |
| `connected_edges` | usize | Number of edges currently connected to the relay |
| `total_tunnels` | usize | Number of tunnels currently tracked (active + pending) |
| `active_tunnels` | usize | Number of tunnels currently bound on both legs |
| `total_bytes_ingress` | u64 | Total bytes received from ingress edges across all tunnels |
| `total_bytes_egress` | u64 | Total bytes sent to egress edges across all tunnels |
| `total_bytes_forwarded` | u64 | Sum of ingress + egress bytes |
| `total_bandwidth_bps` | u64 | Current forwarding bandwidth, derived from the byte counters over a sliding window |
| `total_tcp_streams` | u64 | Total TCP streams forwarded since startup |
| `active_tcp_streams` | u64 | TCP streams currently being forwarded |
| `total_udp_datagrams` | u64 | Total UDP datagrams forwarded |
| `peak_tunnels` | u64 | Maximum concurrent active tunnels observed |
| `peak_edges` | u64 | Maximum concurrent connected edges observed |
| `connections_total` | u64 | Total QUIC connections accepted since startup |
| `manager` | object | Manager-link state. Omitted entirely when no manager is configured |

## Quick examples

### Check active tunnel count from a script

```bash
curl -s -H "Authorization: Bearer $RELAY_TOKEN" \
  http://relay.example.com:4480/api/v1/stats \
  | jq '.active_tunnels'
```

### Pull per-tunnel byte counters

```bash
curl -s -H "Authorization: Bearer $RELAY_TOKEN" \
  http://relay.example.com:4480/api/v1/tunnels \
  | jq '.tunnels[] | {tunnel_id, ingress: .stats.bytes_ingress, egress: .stats.bytes_egress}'
```

### Calculate average bytes per datagram

```bash
curl -s -H "Authorization: Bearer $RELAY_TOKEN" \
  http://relay.example.com:4480/api/v1/stats \
  | jq '(.total_bytes_forwarded / .total_udp_datagrams)'
```

## Prometheus equivalent

Every field on this endpoint has a Prometheus counter or gauge on `GET /metrics`. Use the structured endpoint for one-off scripts and the Prometheus endpoint for time-series storage. Both read from the same atomics, so the numbers always agree.
