---
title: Multi-Path Bonding
description: Carrier-grade multi-path aggregation for professional broadcast — media-aware IDR duplication across heterogeneous IP links.
sidebar:
  order: 8
---

bilbycast-edge supports **multi-path packet bonding** across N
heterogeneous IP links — 5G + Starlink + fibre, two LTE SIMs, QUIC +
UDP, whatever you can reach over the public internet. A bonded hop
sits between two edges and carries any inner protocol (SRT, RTMP,
RTSP, ST 2110), aggregating the paths into a single reliable flow
with frame-accurate failover on IDR boundaries.

## When to use it

bilbycast-edge ships **three** bonding options. Pick by topology:

| Scenario | Use |
|---|---|
| Two **SRT** legs to the same SRT receiver | libsrt socket groups (Broadcast or Backup) — configured on the SRT output `redundancy` block |
| Two **RIST** legs to a RIST receiver | RIST native SMPTE 2022-7 bonding |
| **N ≥ 2 heterogeneous links** carrying any inner protocol, with IDR-frame duplication | Bonded input / output type (this page) |

The bonded type doesn't replace the native two — it covers the
heterogeneous case they don't. In particular, it lets you bond an
SRT flow, an RTMP flow, or an ST 2110 flow over any mix of UDP /
QUIC / RIST legs without the inner protocol having to know anything
about bonding.

## How it works

A bonded hop rides between two edges:

```
[Source device] ── SRT / RTMP / RTSP / ST 2110 / … ──►
                                                        Edge A
                                                          │ flow: source_input → bonded_output
                                                          ▼
                                     [bond paths: UDP / QUIC / RIST × N]
                                                          │
                                                          ▼
                                                        Edge B
                                                          │ flow: bonded_input → destination_output
                                                        ── SRT / RTMP / RTSP / ST 2110 / … ──►
                                                                                              [Destination]
```

Each edge runs **one flow**. The `bonded_output` on edge A and the
`bonded_input` on edge B are peered by matching `bond_flow_id`.

Each packet is framed with a 12-byte bond header carrying a 32-bit
sequence number, a path ID, and a priority hint. The scheduler on
the sender decides which path(s) each packet rides; the receiver
reorders across paths using a sequence-keyed reassembly buffer and
NACKs lost packets back to the sender.

### Media-aware scheduling

The default `media_aware` scheduler reads inside the outbound
MPEG-TS stream, detects H.264 and HEVC NAL boundaries, and tags
SPS / PPS / IDR frames as `Critical` priority. Critical packets are
**duplicated across the two lowest-RTT paths**; everything else
rides a single path weighted by live RTT.

The result: even under severe asymmetry — say a 200 ms-RTT Starlink
leg sharing load with 30 ms-RTT 5G — every IDR frame arrives
unconditionally on the fastest path even if the slower leg drops
packets. Non-IDR frames go where they're cheapest, so you don't pay
2× bandwidth for the whole stream.

## Path transports

Each bond leg uses one of three per-path transports:

| Transport | When | Features |
|---|---|---|
| **UDP** | Simplest, broadest device support | Bidirectional. Plaintext. Use when the NAT allows it and you don't need per-leg TLS |
| **QUIC** (RFC 9221 DATAGRAM) | Need per-leg TLS 1.3 | Bidirectional. ALPN `bilbycast-bond`. Self-signed mode for trusted LAN / loopback, PEM mode for production |
| **RIST** (VSF TR-06-1 Simple Profile) | Want per-leg ARQ + RTT that the bond layer can layer on top of | Unidirectional. Role (`sender` / `receiver`) matches the bonded input/output side |

Paths are independent — you can mix (e.g. one QUIC leg for the
trusted fibre path, one UDP leg for the LTE SIM).

## Config reference

### Bonded input (receiver)

```json
{
  "id": "bond-in-0",
  "name": "From field unit",
  "type": "bonded",
  "bond_flow_id": 42,
  "paths": [ { ... }, ... ],
  "hold_ms": 500,
  "nack_delay_ms": 30,
  "max_nack_retries": 8,
  "keepalive_ms": 200
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `bond_flow_id` | u32 | *required* | Bond-layer flow ID. Must match the sender end |
| `paths` | array | *required, ≥1* | Paths to bind on (see [Path transport blocks](#path-transport-blocks)) |
| `hold_ms` | u32 | 500 | Reassembly hold time — how long a gap is held before declaring loss |
| `nack_delay_ms` | u32 | 30 | Base NACK delay after detecting a gap. Gives natural out-of-order arrivals a chance to fill before an ARQ round-trip |
| `max_nack_retries` | u32 | 8 | Max NACK retries per gap before giving up |
| `keepalive_ms` | u32 | 200 | Keepalive interval — drives per-path RTT / liveness |

### Bonded output (sender)

```json
{
  "id": "bond-out-0",
  "name": "To headend",
  "type": "bonded",
  "active": true,
  "bond_flow_id": 42,
  "paths": [ { ... }, ... ],
  "scheduler": "media_aware",
  "retransmit_capacity": 8192,
  "keepalive_ms": 200,
  "program_number": null
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `bond_flow_id` | u32 | *required* | Must match the receiver end |
| `paths` | array | *required, ≥1* | Paths to transmit across |
| `scheduler` | enum | `media_aware` | `round_robin`, `weighted_rtt`, or `media_aware` |
| `retransmit_capacity` | usize | 8192 | Sender retransmit buffer capacity (packets). Must exceed `send_rate_pps × max_nack_round_trip_seconds` |
| `keepalive_ms` | u32 | 200 | Keepalive interval |
| `program_number` | u16 | — | Optional MPTS → SPTS filter applied before bonding |

### Path transport blocks

Each entry in `paths` has a common shell plus a `transport` block:

```json
{
  "id": 0,
  "name": "lte-0",
  "weight_hint": 1,
  "transport": { "type": "udp|rist|quic", ... }
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | u8 | *required* | Path identifier. Unique within `paths`. Echoed in NACKs so the sender knows which path to fault |
| `name` | string | *required* | Operator-visible label (`"lte-0"`, `"starlink"`, …) |
| `weight_hint` | u32 | 1 | Scheduler weight hint. Higher = more traffic at steady state. `weighted_rtt` / `media_aware` combine this with live RTT |
| `transport` | object | *required* | Per-leg protocol (below) |

**UDP path** (bidirectional, simplest):

```json
{ "type": "udp", "bind": "10.0.0.1:5000", "remote": "203.0.113.5:6000", "interface": "wwan0" }
```

Sender: `remote` required, `bind` optional (ephemeral if omitted).
Receiver: `bind` required, `remote` ignored.

`interface` (optional, 1–15 chars) pins egress to a specific NIC
(e.g. `"wwan0"`, `"eth0"`). Critical when multiple paths share a
destination IP — without pinning, the kernel routing table collapses
them onto the same default route and the bond is cosmetic. Linux
uses `SO_BINDTODEVICE` and requires `CAP_NET_RAW` (grant with
`sudo setcap cap_net_raw+ep /path/to/bilbycast-edge` or a systemd
`AmbientCapabilities=CAP_NET_RAW` line; the edge itself does not
need root). macOS / FreeBSD use `IP_BOUND_IF` and are
unprivileged. Omit the field to let the kernel decide (or to use
source-IP binding plus `ip rule` policy routing instead).

**RIST path** (unidirectional at the bond layer; per-leg ARQ from
the RIST protocol itself):

```json
{
  "type": "rist",
  "role": "sender",
  "remote": "203.0.113.5:8000",
  "local_bind": null,
  "buffer_ms": 1000
}
```

`role` must be `sender` or `receiver` and should match the bonded
input/output side. `buffer_ms` is the RIST jitter/retransmit buffer
(default 1000 ms). RIST uses `port P` for RTP and `P+1` for RTCP —
both must be reachable.

**QUIC path** (TLS 1.3 + DATAGRAM extension, full-duplex):

```json
{
  "type": "quic",
  "role": "client",
  "addr": "203.0.113.5:7000",
  "server_name": "edge-b.example.com",
  "tls": { "mode": "self_signed" }
}
```

| Subfield | Meaning |
|---|---|
| `role` | `"client"` (dial) or `"server"` (accept) |
| `addr` | Client: remote `host:port`. Server: local bind `ip:port` |
| `server_name` | Client SNI / ALPN. Ignored on server role |
| `tls.mode` | `"self_signed"` (dev / loopback / trusted LAN) or `"pem"` |

PEM mode:

```json
{
  "mode": "pem",
  "cert_chain_path": "/etc/bilbycast/bond.crt",
  "private_key_path": "/etc/bilbycast/bond.key",
  "client_trust_root_path": null
}
```

ALPN `bilbycast-bond` is negotiated automatically; other protocols
on the same UDP port (HTTP/3, bilbycast-relay tunnels) stay
isolated.

### Scheduler options

| Value | Behaviour |
|---|---|
| `round_robin` | Equal-weight rotation. Fine when path health is near-identical (two matched fibre legs) |
| `weighted_rtt` | RTT-weighted rotation — sends more traffic to lower-RTT paths. `Critical`-priority packets (set by upstream tagging, rare without media awareness) are duplicated across the two lowest-RTT paths |
| **`media_aware`** (default) | `weighted_rtt` plus NAL walking: detects H.264 and HEVC IDR frames (H.264 types 5/7/8; HEVC 19/20/21/32/33/34) inside the outbound TS and duplicates them across the two best paths. Non-IDR frames go single-path. Recommended default for video flows |

On an 84/16 traffic split (5G vs Starlink in testing), the
`media_aware` scheduler delivers zero lost gaps under 200 ms RTT
and 3% loss on the Starlink leg because every IDR rides both
paths.

## Worked examples

### Edge-to-edge SRT over two UDP paths

Source: SRT listener on edge A. Destination: SRT caller pulling
from edge B. Bond over two UDP paths (e.g. two SIMs on a mobile
router).

**Edge A (sender side):**

```json
{
  "inputs": [{
    "id": "cam-in",
    "name": "Camera SRT",
    "type": "srt",
    "mode": "listener",
    "local_addr": "0.0.0.0:9000"
  }],
  "outputs": [{
    "id": "bond-out",
    "name": "Bond to Edge B",
    "type": "bonded",
    "bond_flow_id": 42,
    "scheduler": "media_aware",
    "paths": [
      { "id": 0, "name": "sim-a", "transport": { "type": "udp", "remote": "203.0.113.5:5000" }},
      { "id": 1, "name": "sim-b", "transport": { "type": "udp", "remote": "203.0.113.5:5001" }}
    ]
  }],
  "flows": [{
    "id": "feed",
    "name": "Camera feed",
    "input_ids": ["cam-in"],
    "output_ids": ["bond-out"]
  }]
}
```

**Edge B (receiver side):**

```json
{
  "inputs": [{
    "id": "bond-in",
    "name": "Bond from Edge A",
    "type": "bonded",
    "bond_flow_id": 42,
    "paths": [
      { "id": 0, "name": "sim-a", "transport": { "type": "udp", "bind": "0.0.0.0:5000" }},
      { "id": 1, "name": "sim-b", "transport": { "type": "udp", "bind": "0.0.0.0:5001" }}
    ]
  }],
  "outputs": [{
    "id": "srt-out",
    "name": "To studio",
    "type": "srt",
    "mode": "listener",
    "local_addr": "0.0.0.0:9999"
  }],
  "flows": [{
    "id": "feed",
    "name": "Camera feed",
    "input_ids": ["bond-in"],
    "output_ids": ["srt-out"]
  }]
}
```

`bond_flow_id` must match on both sides. Path `id` values within
each `paths` array must also match (path 0 on the sender is path 0
on the receiver — NACKs use this identifier to target the right
leg).

### QUIC + UDP hybrid (trusted primary + LTE secondary)

One QUIC leg for the trusted primary path (with TLS), one raw UDP
leg for the LTE secondary:

```json
"paths": [
  {
    "id": 0, "name": "fibre",
    "transport": {
      "type": "quic", "role": "client",
      "addr": "203.0.113.5:7000",
      "server_name": "edge-b.example.com",
      "tls": { "mode": "pem",
               "cert_chain_path": "/etc/bilbycast/bond.crt",
               "private_key_path": "/etc/bilbycast/bond.key" }
    }
  },
  {
    "id": 1, "name": "lte",
    "transport": { "type": "udp", "remote": "203.0.113.5:5000" }
  }
]
```

The QUIC leg gets TLS end-to-end; the UDP leg is plaintext — wrap
an encrypted inner protocol (SRT-encrypted TS) if confidentiality
is required on the LTE leg.

### Three-path heterogeneous bonding (5G + Starlink + fibre)

With `media_aware` scheduling and very different RTTs, IDR frames
ride the two fastest paths; non-IDR traffic rides a single path
weighted by live RTT.

```json
"paths": [
  { "id": 0, "name": "fibre",    "weight_hint": 4, "transport": { "type": "udp", "remote": "host:5000" }},
  { "id": 1, "name": "5g",       "weight_hint": 2, "transport": { "type": "udp", "remote": "host:5001" }},
  { "id": 2, "name": "starlink", "weight_hint": 1, "transport": { "type": "udp", "remote": "host:5002" }}
]
```

## Manager UI walkthrough

The manager UI covers the same config surface as the JSON schema
above. Use the UI for operational day-to-day work; use JSON for
version-controlled deployments.

### Create the bonded receiver (input) on Edge B

1. Navigate to **Edge B → Config → Inputs**.
2. Click **Add Input** and set:
   - **Type:** *Bonded (multi-path aggregation — UDP / QUIC / RIST)*.
   - **Bond Flow ID:** a number you choose. Must match the sender.
     Any positive u32 is fine — pick something memorable per flow
     (e.g. `42` for the camera feed, `43` for audio).
   - **Hold (ms):** 500 is the default. Raise it for high-RTT paths,
     lower to reduce end-to-end latency.
   - **NACK delay (ms):** 30 is a sensible default.
   - **Max NACK retries:** 8 is fine; a gap that fails 8 retransmits
     is declared lost.
   - **Keepalive (ms):** 200 (drives per-path RTT and liveness).
3. In the **Paths** list, add one row per leg:
   - **Name** is operator-visible (`lte-0`, `starlink`, `fibre`).
   - **Transport** is `UDP`, `QUIC`, or `RIST`. Choose `UDP` unless
     you need TLS (use QUIC) or per-leg ARQ / jitter tolerance
     (use RIST).
   - For **UDP receiver**: fill **Bind** (e.g. `0.0.0.0:5000`).
   - For **QUIC server**: fill **Bind** + choose TLS mode.
     Self-signed is fine for trusted LANs / loopback; PEM mode for
     production.
   - For **RIST receiver**: set **Role** to *Receiver* and fill
     **Local bind**. RIST uses the port you configure for RTP and
     `port+1` for RTCP — both must be reachable.
4. **Save**.

### Create the bonded sender (output) on Edge A

1. **Edge A → Config → Outputs → Add Output**.
2. Set:
   - **Type:** *Bonded*.
   - **Bond Flow ID:** must equal the receiver's.
   - **Scheduler:** `Media-aware` is the default — walks H.264 /
     HEVC NAL units and duplicates IDR frames across the two
     lowest-RTT paths. Use `Weighted RTT` for non-video data where
     IDR detection is a no-op, or `Round Robin` when all paths are
     near-identical.
   - **Retransmit buffer (packets):** 8192 default. Must exceed
     `send_rate_pps × worst_NACK_round_trip_seconds`.
   - **Keepalive (ms):** 200.
   - **Program number (optional):** set to down-select a single
     program from an MPTS input before bonding.
3. **Paths:** mirror the receiver's paths with matching `id`
   numbers.
   - For **UDP sender**: fill **Remote** (`203.0.113.5:5000`).
   - For **QUIC client**: fill **Remote**, **Server name** (for
     SNI), **TLS mode** (match what the receiver accepts).
   - For **RIST sender**: set **Role** to *Sender* and fill
     **Remote**.
4. **Save**, then in **Flows** create a flow with your source input
   and this bonded output as `output_ids`.

### Monitor from the Node Detail page

A bonded input or output renders an expanded status card with:

- **Aggregate header** — `up` / `degraded` / `idle` pill, role,
  scheduler, flow ID, path count.
- **Sender aggregate row** — `packets_sent`, `retransmits`,
  `duplicated` (IDR frames that rode two paths),
  `dropped_no_path` (bond hard-fail indicator).
- **Receiver aggregate row** — `packets_received`, `delivered`,
  `gaps_recovered`, `gaps_lost`, `duplicates`,
  `reassembly_overflow`.
- **Per-path table** — one row per leg with a liveness pill
  (`alive` / `dead`), RTT, loss percentage, traffic-share bar,
  packets / bytes, NACKs, retransmits, keepalives.

The topology view shows only the aggregate state
(`up` / `degraded` / `idle`). Deep per-path inspection lives on
the Node Detail page.

### Troubleshooting

- **"bond UI helper missing — reload the page"** in a config form
  means the bonding helper script failed to load. Hard-refresh
  (`Cmd/Ctrl+Shift+R`). If it persists, the manager is serving an
  older build.
- **Receiver shows `idle`, sender shows `packets_dropped_no_path`** —
  no path has handshaken. Check firewall / NAT on every leg; the
  first packet on a UDP path triggers peer discovery on the
  receiver, so if nothing ever reaches the receiver you're stuck in
  idle.
- **`gaps_lost` climbing steadily** — either `hold_ms` is too low
  for the worst path's RTT, or a path has saturated and is dropping
  packets faster than ARQ can repair. Check per-path
  `loss_fraction`.
- **One path stays `dead` but others work** — keepalive isn't
  making it through. Check the bind / remote addresses and firewall;
  a dead path is excluded from the scheduler without affecting the
  bond as a whole.

## Stats, events, Prometheus

Every bonded input or output carries a `bond_stats` field with
aggregate and per-path metrics.

**Aggregate fields:**

| Field | Side | Meaning |
|---|---|---|
| `state` | both | `"up"`, `"degraded"`, or `"idle"` |
| `flow_id` | both | Matches `bond_flow_id` |
| `role` | both | `"sender"` or `"receiver"` |
| `scheduler` | sender | `"round_robin"`, `"weighted_rtt"`, or `"media_aware"` |
| `packets_sent` / `bytes_sent` | sender | |
| `packets_retransmitted` | sender | Count of ARQ retransmits |
| `packets_duplicated` | sender | Packets intentionally duplicated (IDR frames on two paths) |
| `packets_dropped_no_path` | sender | Scheduler couldn't dispatch — bond is hard-failed |
| `packets_received` / `bytes_received` | receiver | |
| `packets_delivered` | receiver | Packets delivered to the application after reassembly |
| `gaps_recovered` | receiver | Gaps filled by ARQ or a second path |
| `gaps_lost` | receiver | Gaps that exceeded `hold_ms` — packet loss |
| `duplicates_received` | receiver | Duplicates absorbed by reassembly |
| `reassembly_overflow` | receiver | Sequence space exceeded buffer — tune `hold_ms` down or fix a path |

**Per-path fields** (one entry per leg):

`id`, `name`, `transport`, `state` (`"alive"` or `"dead"`),
`rtt_ms`, `jitter_us`, `loss_fraction`, `throughput_bps`,
`queue_depth`, `packets_sent`, `bytes_sent`, `packets_received`,
`bytes_received`, `nacks_sent`, `nacks_received`,
`retransmits_sent`, `retransmits_received`, `keepalives_sent`,
`keepalives_received`.

**Prometheus counters** (labels: `flow_id`, `output_id`, `leg_role`,
`path_id`, `path_name`, `transport`):

```
bilbycast_edge_bond_rtt_ms
bilbycast_edge_bond_loss_fraction
bilbycast_edge_bond_path_packets_sent
bilbycast_edge_bond_path_packets_received
bilbycast_edge_bond_path_retransmits_sent
bilbycast_edge_bond_path_nacks_sent
bilbycast_edge_bond_path_nacks_received
bilbycast_edge_bond_path_keepalives_sent
bilbycast_edge_bond_path_dead
bilbycast_edge_bond_gaps_recovered
bilbycast_edge_bond_gaps_lost
bilbycast_edge_bond_packets_duplicated
```

**Events** — category `bond`, severity `info` / `warning` /
`critical`. Path-up / path-down transitions fire as `info` /
`warning`; bond-idle (no alive paths) fires as `critical`.

## Tuning

- **`hold_ms`** — tune to the *worst* path's expected RTT × 2 plus
  a margin for jitter. Too low and `gaps_lost` climbs from late
  arrivals; too high and end-to-end latency grows.
- **`nack_delay_ms`** — comparable to the *median* path RTT. Lower
  retries faster; higher gives natural reordering a chance.
- **`retransmit_capacity`** — must exceed
  `send_rate_pps × max_nack_round_trip_seconds`. At 10 kpps and a
  worst-case 500 ms NACK round-trip that's ≥ 5000. The 8192 default
  is fine for typical broadcast bitrates.
- **`keepalive_ms`** — faster keepalives detect dead paths sooner
  but consume more bandwidth. 200 ms is a reasonable default.
- **Scheduler choice** — `media_aware` is the right default for
  video flows carried over MPEG-TS. Use `round_robin` for bonded
  non-video data (e.g. bulk file transfers) where IDR detection is
  a no-op.

## Limitations

- **SRT paths are deferred.** UDP / QUIC / RIST are supported today;
  SRT as a per-leg transport (with libsrt's own ARQ and encryption
  per-path) is planned but not yet shipped.
- **No congestion control at the bond layer.** The bond layer does
  not probe or back off on path saturation. Use scheduler
  `weight_hint` to shape a known bandwidth ceiling, or rely on
  path-layer congestion control where available (QUIC, RIST).
- **Confidentiality is per-path.** QUIC legs are TLS-encrypted;
  UDP and RIST legs are plaintext. Wrap an already-encrypted inner
  protocol (SRT-encrypted TS) if you can't run QUIC for every leg.
- **Topology view shows aggregate state only.** The Node Detail
  page has full per-path tables; the topology view only shows
  `up` / `degraded` / `idle`.
