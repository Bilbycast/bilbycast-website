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

The two endpoints overlap, but they are not a field-for-field mirror. Use the structured endpoint for one-off scripts and the Prometheus endpoint for time-series storage — with three differences to know about:

- **`total_bandwidth_bps` is JSON-only.** No Prometheus family carries it. It is computed inside the stats handler as a sliding-window rate over the bytes-forwarded total, and it is not an atomic read: it takes a lock, divides the byte delta by the time since the *last* call, and then overwrites that sample. Its value therefore depends on when the endpoint was last polled, and two consecutive readers see different numbers. In Prometheus, derive it instead: `rate(bilbycast_relay_bytes_forwarded_total[1m]) * 8`.
- **`manager` is not mirrored as an object.** It surfaces as two separately named gauges, `bilbycast_relay_manager_connected` and `bilbycast_relay_manager_disconnected_seconds`.
- **The per-tunnel series are Prometheus-only.** The JSON equivalent is the separate `GET /api/v1/tunnels` response.

Every other field maps to a counter or gauge of the obvious name, and those do read the same atomics.

### Series catalogue

31 metric families, in the order `/metrics` emits them.

**Relay-level — always emitted**

| Metric | Type | Meaning |
|---|---|---|
| `bilbycast_relay_info` | gauge | Always 1; carries the build version on a `version` label |
| `bilbycast_relay_uptime_seconds` | gauge | Seconds since the relay process started |
| `bilbycast_relay_edges_connected` | gauge | Edges currently connected |
| `bilbycast_relay_tunnels_total` | gauge | Tunnels currently tracked (active + pending) |
| `bilbycast_relay_tunnels_active` | gauge | Tunnels currently bound on both legs |
| `bilbycast_relay_bytes_forwarded_total` | counter | Ingress + egress bytes across all tunnels |
| `bilbycast_relay_bytes_ingress_total` | counter | Bytes received from ingress edges |
| `bilbycast_relay_bytes_egress_total` | counter | Bytes sent to egress edges |
| `bilbycast_relay_tcp_streams_total` | counter | TCP streams forwarded since startup |
| `bilbycast_relay_tcp_streams_active` | gauge | TCP streams currently being forwarded |
| `bilbycast_relay_udp_datagrams_total` | counter | UDP datagrams forwarded over tunnels |
| `bilbycast_relay_connections_total` | counter | QUIC connections accepted since startup |
| `bilbycast_relay_peak_tunnels` | gauge | Peak simultaneous active tunnels |
| `bilbycast_relay_peak_edges` | gauge | Peak simultaneous connected edges |

**Native plain-UDP carrier** — the SRT/RIST and bond-leg plane that runs without QUIC. Always emitted; they read zero when nothing uses that plane.

| Metric | Type | Meaning |
|---|---|---|
| `bilbycast_relay_udp_sessions_total` | gauge | Native plain-UDP sessions (active + waiting) |
| `bilbycast_relay_udp_sessions_active` | gauge | Sessions with both sides latched |
| `bilbycast_relay_udp_bytes_forwarded_total` | counter | Bytes forwarded over the native plain-UDP relay |
| `bilbycast_relay_udp_datagrams_forwarded_total` | counter | Datagrams forwarded over the native plain-UDP relay |

**Viewer distribution** — `-distribution` builds only, and only once the subsystem has published a sample. A plain forwarder build exposes none of them, so treat their absence as "not running", not as zero.

| Metric | Type | Meaning |
|---|---|---|
| `bilbycast_relay_distribution_streams` | gauge | Streams currently published to the hub |
| `bilbycast_relay_distribution_viewers` | gauge | Connected WHEP viewers across all streams |
| `bilbycast_relay_distribution_bytes_out_total` | counter | Media bytes fanned out to viewers |
| `bilbycast_relay_distribution_origin_bytes` | gauge | Bytes currently held in the LL-HLS origin cache |
| `bilbycast_relay_distribution_offpath_sessions` | counter | WHEP sessions that had a datagram refused by the media source pin — a spoofed ICE reflection attempt, or a viewer whose IP changed mid-session. Counted once per session |

**Manager link** — emitted only when a manager is configured.

| Metric | Type | Meaning |
|---|---|---|
| `bilbycast_relay_manager_connected` | gauge | 1 while the manager WebSocket link is up, 0 while down or reconnecting |
| `bilbycast_relay_manager_disconnected_seconds` | gauge | Seconds since the link went down (0 while connected) |

**Per-tunnel** — emitted only while at least one tunnel exists, each labelled `tunnel_id` and `protocol`.

| Metric | Type | Meaning |
|---|---|---|
| `bilbycast_relay_tunnel_bytes_ingress` | counter | Bytes received for this tunnel |
| `bilbycast_relay_tunnel_bytes_egress` | counter | Bytes sent for this tunnel |
| `bilbycast_relay_tunnel_tcp_streams_total` | counter | TCP streams forwarded for this tunnel |
| `bilbycast_relay_tunnel_tcp_streams_active` | gauge | TCP streams currently active on this tunnel |
| `bilbycast_relay_tunnel_udp_datagrams_total` | counter | UDP datagrams forwarded for this tunnel |
| `bilbycast_relay_tunnel_uptime_seconds` | gauge | Seconds since this tunnel was created |
