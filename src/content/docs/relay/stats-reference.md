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

This is a single flat JSON object. The `total_bytes_*`, `total_tcp_streams` and `total_udp_datagrams` totals count since the relay started, over the **QUIC tunnels** that are or have been up: native plain-UDP sessions are not in them, and only a restart resets them. Up to and including relay v0.20.0 they were sums over the tunnels held at the time, so they fell when a tunnel went. See [Totals](#totals).

| Field | Type | Meaning |
|---|---|---|
| `uptime_secs` | u64 | Seconds since the relay process started |
| `connected_edges` | usize | Number of edges currently connected to the relay |
| `total_tunnels` | usize | Number of tunnels currently tracked (active + pending) |
| `active_tunnels` | usize | Number of tunnels currently bound on both legs |
| `total_bytes_ingress` | u64 | QUIC tunnels, since the relay started: datagram payload bytes forwarded from the edge bound `ingress`, and TCP stream bytes forwarded from the edge that opened the stream |
| `total_bytes_egress` | u64 | The same the other way: from the edge bound `egress`, and back to the edge that opened the stream |
| `total_bytes_forwarded` | u64 | The sum of the two |
| `total_bandwidth_bps` | u64 | Forwarding rate of the QUIC tunnels now: the growth of `total_bytes_forwarded` since the last time the figure was taken. Native plain-UDP traffic is not in it |
| `total_tcp_streams` | u64 | TCP streams opened through to the peer since the relay started |
| `active_tcp_streams` | u64 | TCP streams open now on the tunnels held now |
| `total_udp_datagrams` | u64 | QUIC datagrams forwarded since the relay started |
| `peak_tunnels` | u64 | Maximum concurrent active tunnels observed |
| `peak_edges` | u64 | Maximum concurrent connected edges observed |
| `connections_total` | u64 | Total QUIC connections accepted since startup |
| `manager` | object | Manager-link state. Omitted entirely when no manager is configured |

### Totals

Up to and including relay v0.20.0 each total was a sum over the tunnels, or the native plain-UDP sessions, held when it was read. It fell when one went: unbound, lost with its edges, removed by the manager or over REST, or reaped. `rate()` and `increase()` read that as a counter reset, and `total_bandwidth_bps` read 0 or low for the sample in which a tunnel ended. Later releases keep what a tunnel counted, so the totals only grow; names, types and JSON keys are unchanged.

A panel or an alert that read a total as the traffic of the tunnels now up shows a total since the relay started after the upgrade. Take its `rate()`, or add up the per-tunnel series for what is held now. A tunnel's own figures go with it, and start at 0 when its id is bound again after it has gone.

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

- **`total_bandwidth_bps` is JSON-only.** No Prometheus family carries it. It is a rate over the bytes-forwarded total of the QUIC tunnels, and it is not an atomic read: it takes a lock, divides the byte delta by the time since the *last* call, and then overwrites that sample. The manager's 1 s stats message takes it from the same sample. Its value therefore depends on when it was last taken, and two consecutive readers see different numbers. In Prometheus, derive it instead: `rate(bilbycast_relay_bytes_forwarded_total[1m]) * 8`.
- **`manager` is not mirrored as an object.** It surfaces as two separately named gauges, `bilbycast_relay_manager_connected` and `bilbycast_relay_manager_disconnected_seconds`.
- **The per-tunnel series are Prometheus-only.** The JSON equivalent is the separate `GET /api/v1/tunnels` response.

Every other field maps to a counter or gauge of the obvious name, and reads the same figures.

### Series catalogue

33 metric families, in the order `/metrics` emits them.

**Relay-level — always emitted**

| Metric | Type | Meaning |
|---|---|---|
| `bilbycast_relay_info` | gauge | Always 1; carries the build version on a `version` label |
| `bilbycast_relay_uptime_seconds` | gauge | Seconds since the relay process started |
| `bilbycast_relay_edges_connected` | gauge | Edges currently connected |
| `bilbycast_relay_tunnels_total` | gauge | Tunnels currently tracked (active + pending) |
| `bilbycast_relay_tunnels_active` | gauge | Tunnels currently bound on both legs |
| `bilbycast_relay_bytes_forwarded_total` | counter | `total_bytes_forwarded`: QUIC tunnels, both directions, since the relay started. Up to v0.20.0 it, and the next four counters, fell when a tunnel went (see [Totals](#totals)) |
| `bilbycast_relay_bytes_ingress_total` | counter | `total_bytes_ingress` |
| `bilbycast_relay_bytes_egress_total` | counter | `total_bytes_egress` |
| `bilbycast_relay_tcp_streams_total` | counter | `total_tcp_streams` |
| `bilbycast_relay_tcp_streams_active` | gauge | `active_tcp_streams`: streams open now on the tunnels held now |
| `bilbycast_relay_udp_datagrams_total` | counter | `total_udp_datagrams`: QUIC datagrams only |
| `bilbycast_relay_connections_total` | counter | QUIC connections accepted since startup |
| `bilbycast_relay_peak_tunnels` | gauge | Peak simultaneous active tunnels |
| `bilbycast_relay_peak_edges` | gauge | Peak simultaneous connected edges |

**Native plain-UDP carrier** — the SRT/RIST and bond-leg plane that runs without QUIC. Always emitted: the two gauges read zero while nothing uses that plane, the two counters until something has.

| Metric | Type | Meaning |
|---|---|---|
| `bilbycast_relay_udp_sessions_total` | gauge | Native plain-UDP sessions (active + waiting) |
| `bilbycast_relay_udp_sessions_active` | gauge | Sessions with both sides latched |
| `bilbycast_relay_udp_bytes_forwarded_total` | counter | Bytes of the media datagrams that came from a registered side since the relay started, tunnel id included. Up to v0.20.0 it fell when a session went |
| `bilbycast_relay_udp_datagrams_forwarded_total` | counter | Media datagrams forwarded since the relay started. Up to v0.20.0 it fell when a session went |

**Viewer distribution** — `-distribution` builds only, and only once the subsystem has published a sample. A plain forwarder build exposes none of them, so treat their absence as "not running", not as zero.

| Metric | Type | Meaning |
|---|---|---|
| `bilbycast_relay_distribution_streams` | gauge | Streams currently published to the hub |
| `bilbycast_relay_distribution_viewers` | gauge | Connected WHEP viewers across all streams |
| `bilbycast_relay_distribution_bytes_out_total` | counter | Media bytes fanned out to viewers |
| `bilbycast_relay_distribution_origin_bytes` | gauge | Bytes currently held in the LL-HLS origin cache |
| `bilbycast_relay_distribution_offpath_sessions` | counter | WHEP sessions that had an **off-path** datagram dropped by the media source pin — a spoofed ICE reflection attempt, or a viewer whose IP changed mid-session. Counted once per session. A datagram from another of the peer's paths inside the grace is dropped too and counted in the row below instead, not here |
| `bilbycast_relay_distribution_other_path_datagrams_total` | counter | Datagrams the media source pin dropped from another of a peer's paths (an address named in its SDP, seen before DTLS completed, or advertised by the session) inside the grace after the pin armed, which raise no alarm. WHEP, WHIP and cascade sessions alike. Past the grace such a datagram is off-path |
| `bilbycast_relay_distribution_superseded_frames_total` | counter | Frames a live ingest published while a newer ingest held its stream, dropped. Non-zero while two publishers push one stream id |

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
