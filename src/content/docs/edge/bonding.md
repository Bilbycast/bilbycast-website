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

Each packet is framed with a bond header — 12 bytes, or 16 bytes on a
leg whose far end has advertised per-leg equalization (the default, so
a steady-state bond between two modern edges runs the 16-byte form) —
carrying a 32-bit sequence number, a path ID, and a priority hint. The
sender falls back to the 12-byte header at cold start and permanently
against an equalization-off or older peer. The scheduler on
the sender decides which path(s) each packet rides; the receiver
reorders across paths using a sequence-keyed reassembly buffer and
NACKs lost packets back to the sender.

### Media-aware scheduling

The default `adaptive` scheduler reads inside the outbound
MPEG-TS stream, detects H.264 and HEVC NAL boundaries, and tags
SPS / PPS / IDR frames as `Critical` priority. Critical packets are
**duplicated across the two best paths**; everything else rides a
single path chosen by each leg's *measured* capacity (see
[Adaptive capacity scheduling](#adaptive-capacity-scheduling)). The
older `media_aware` scheduler does the same NAL tagging but splits
purely by live RTT with no capacity discovery — `adaptive` supersedes
it and is the edge default.

The result: even under severe asymmetry — say a 200 ms-RTT Starlink
leg sharing load with 30 ms-RTT 5G — every IDR frame arrives
unconditionally on the best paths even if the slower leg drops
packets. Non-IDR frames go where they're cheapest, so you don't pay
2× bandwidth for the whole stream.

## Path transports

Each bond leg uses one of four per-path transports:

| Transport | When | Features |
|---|---|---|
| **UDP** | Simplest, broadest device support | Bidirectional. Plaintext. Use when the NAT allows it and you don't need per-leg TLS |
| **Relay** | Both ends behind NAT, or you want a fixed rendezvous | Bidirectional. The leg rides a native plain-UDP relay tunnel **in-process** — see [Bonding over a relay](#bonding-over-a-relay-per-leg) |
| **QUIC** (RFC 9221 DATAGRAM) | Need per-leg TLS 1.3 | Bidirectional. ALPN `bilbycast-bond`. Self-signed mode for trusted LAN / loopback, PEM mode for production |
| **RIST** (VSF TR-06-1 Simple Profile) | Config-file only — see note | Unidirectional. Role (`sender` / `receiver`) matches the bonded input/output side |

Paths are independent — you can mix (e.g. one QUIC leg for the
trusted fibre path, one UDP leg for the LTE SIM).

:::note[RIST legs are config-only]
A RIST path is a valid enum variant in the JSON config, but the
manager UI deliberately offers only **UDP** and **QUIC** when you add
a bond leg. RIST is unidirectional at the bond layer — it can't carry
the keepalive/NACK back-channel that the aggregation and cross-leg ARQ
depend on — so it isn't a true aggregation leg. Use UDP or QUIC for
bonded legs; reach for RIST bonding via [RIST native SMPTE 2022-7
bonding](#when-to-use-it) instead.
:::

## Bonding over a relay (per-leg)

Each bond leg can run **direct** (edge-to-edge over its uplink) or
**through a relay** — independently, in any combination. A relayed leg
carries its own relay tunnel **in-process**: the leg's `transport` block
is `{"type": "relay", ...}` (see [Relay path](#path-transport-blocks)),
and the edge owns the relay socket itself — the same Register/keepalive
rendezvous, bind-token auth and primary→backup failover a native
SRT/RIST [IP tunnel](/manager/ip-tunneling/) uses, and the same 16-byte
`tunnel_id` prefix on the wire, so the relay is unchanged and still
forwards `[tunnel_id][encrypted payload]` opaquely. There is no
`127.0.0.1` hop and no separate carrier Tunnel object to provision. The
leg's direction is auto-derived from the side — a bonded output leg
registers `egress`, a bonded input leg `ingress`. The bond's ARQ, FEC,
reordering, and capacity scheduling all run **end-to-end edge↔edge** —
the relay never sees, terminates, or combines bond traffic (there is no
"bond bridge"; the relay is a generic per-path forwarder).

This is what lets a bond work when **both ends are behind NAT**: each
relayed leg dials out to the relay from both edges, so neither end needs
to accept inbound connections. A *direct* leg, by contrast, is
asymmetric — the receiving (destination) edge must be reachable. Mix
freely: some legs direct, others via a relay, each leg able to use a
different relay with a primary + backup for failover.

A relay leg is minted by the manager's **Bonded-Link wizard** or the
**Tunnels** page, which stamps the shared `tunnel_id` — and, on an
unencrypted bond, the shared per-leg tunnel key — onto both ends. In
the bonded input / output form the leg then renders under a *"Relay
leg — dials the relay in-process"* note with its **relay address**,
optional **backup relay** and (sender side) **source uplink NIC**
editable in place; only the transport type, the `tunnel_id` and the
leg key are locked, because changing either of the last two unpairs
the two ends.

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
| `hold_ms` | u32 | 500 | Reassembly hold time — how long a gap is held before declaring loss. When `hold_max_ms` is set, this is the floor the adaptive servo grows up from |
| `hold_max_ms` | u32 | — | Optional adaptive hold-time **ceiling**. When set above `hold_ms`, the receiver grows the reorder/recovery budget toward the realized recovery latency (×1.5) within `[hold_ms, hold_max_ms]` and decays back as the links calm — latency tracks the links instead of a fixed guess. Unset = fixed `hold_ms` |
| `nack_delay_ms` | u32 | 30 | Base NACK delay after detecting a gap. Gives natural out-of-order arrivals a chance to fill before an ARQ round-trip |
| `max_nack_retries` | u32 | 8 | Max NACK retries per gap before giving up |
| `keepalive_ms` | u32 | 200 | Keepalive interval — drives per-path RTT / liveness |
| `equalization` | enum | `auto` | Per-leg latency/jitter equalization (`auto` / `on` / `off`). In `auto`/`on` the receiver measures each leg's relative one-way delay and time-aligns the legs so heterogeneous high-latency/jitter legs (5G + Starlink + ISP) *aggregate* their bandwidth in-order instead of head-of-line blocking. Should match the sender's setting |
| `max_bonding_latency_ms` | u32 | 1000 | Equalization latency budget — the ceiling for how far a fast leg is held to align a slow one, and the loss-recovery deadline while aligned. The single bonding-latency knob; should match the sender's value. Derived from `hold_max_ms` when unset |
| `ingress_dejitter_ms` | u32 | — | **Ignored on a bonded input.** The rate-paced de-jitter servo has only ±5 % rate authority, so it cannot drain the reassembler's head-of-line-gated clumps (potentially seconds deep) — the buffer backs up and the residence cap *sheds* 15–30 % of the bond's media. The bond already delivers in order, and the egress wire-emit servo (UDP/RTP) and the display A/V clock (HDMI) re-time the bursty stream losslessly downstream. Setting it above 0 logs a warning and raises a Warning `bond_ingress_dejitter_ignored` event. Use `hold_ms` / `hold_max_ms` / `max_bonding_latency_ms` to control bond latency instead |
| `encryption_key` | string (64 hex) | — | Optional 32-byte ChaCha20-Poly1305 AEAD key opening the encrypted (UDP) legs — must match the sender's key |
| `fec` | object | — | Optional proactive FEC — must match the sender's geometry. See [Proactive FEC](#proactive-fec) |

### Bonded output (sender)

```json
{
  "id": "bond-out-0",
  "name": "To headend",
  "type": "bonded",
  "active": true,
  "bond_flow_id": 42,
  "paths": [ { ... }, ... ],
  "scheduler": "adaptive",
  "keepalive_ms": 200,
  "program_number": null
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `bond_flow_id` | u32 | *required* | Must match the receiver end |
| `paths` | array | *required, ≥1* | Paths to transmit across |
| `scheduler` | enum | `adaptive` | `round_robin`, `weighted_rtt`, `media_aware`, or `adaptive` (see [Scheduler options](#scheduler-options)) |
| `congestion` | object | — | Optional tuning for the `adaptive` scheduler's per-leg capacity controller (see [Adaptive capacity scheduling](#adaptive-capacity-scheduling)) |
| `encryption_key` | string (64 hex) | — | Optional 32-byte ChaCha20-Poly1305 AEAD key applied per-datagram on the UDP legs (QUIC legs are already TLS). Both ends must share it |
| `retransmit_capacity` | usize | *auto-derived* | Sender retransmit buffer capacity (packets). Unset, the edge sizes the ring itself: aggregate leg ceiling (each leg's `max_bitrate_bps`, or 20 Mbps assumed for a leg with no ceiling) × `max_bonding_latency_ms` ÷ the typical datagram size (which shrinks with `path_mtu`), clamped to `[8192, 262144]`. Set it only to override that derivation |
| `keepalive_ms` | u32 | 200 | Keepalive interval |
| `equalization` | enum | `auto` | Per-leg latency/jitter equalization (`auto` / `on` / `off`). In `auto`/`on` the sender stamps each data packet with a 16-byte v2 header timestamp so the receiver can measure relative one-way delay and time-align heterogeneous legs (5G + Starlink + ISP) into one in-order aggregate instead of head-of-line blocking. Should match the bonded input's setting |
| `max_bonding_latency_ms` | u32 | 1000 | Equalization latency budget — the ceiling for how far a fast leg is held to align a slow one, and the loss-recovery deadline while aligned. The single bonding-latency knob; should match the bonded input's value |
| `path_mtu` | u32 | 1500 | Smallest IP-layer path MTU across the bond's legs, `[576, 9000]`. The sender re-chunks outbound MPEG-TS at 188-byte boundaries into datagrams that fit this MTU *after* every per-datagram overhead, so no leg emits an IP-fragmented datagram. Lower it for constrained cellular / satellite bearers — see [Fitting datagrams to the path MTU](#fitting-datagrams-to-the-path-mtu). Sender-side only |
| `priority` | enum | `best_effort` | QoS tier for the shared-leg capacity broker (`critical` / `normal` / `best_effort`). When several bonded outputs share one physical uplink, the guaranteed tiers reserve their measured demand ahead of best-effort flows. See [Sharing an uplink between bonds](#sharing-an-uplink-between-bonds) |
| `fec` | object | — | Optional bond-wide proactive FEC over the striped stream (XOR only). Mutually exclusive with any per-leg `path.fec`. See [Proactive FEC](#proactive-fec) |
| `redundancy` | object | — | Optional packet replication across the N best legs. See [Packet redundancy](#packet-redundancy) |
| `program_number` | u16 | — | Optional MPTS → SPTS filter applied before bonding |

Of the resilience blocks, only the three repair models are off by
default: the bond-wide `fec`, the per-path `fec`, and `redundancy`.
`equalization` defaults to `auto` and `max_bonding_latency_ms` to
1000 ms, so a stock bonded output already stamps the 16-byte v2 header
and lets the receiver time-align heterogeneous legs — set
`"equalization": "off"` to opt out. All of them are surfaced in the
manager UI's bonded-output editor.

#### Proactive FEC

Both the bond-wide `fec` and a per-path `fec` take the same object.
They are **mutually exclusive**: a bond runs one model or the other,
and configuring both is rejected at config load.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `algorithm` | enum | `xor` | `xor` (interleaved XOR, SMPTE 2022-1 column model) or `reed_solomon`. **`reed_solomon` is per-leg only** — it is rejected on the bond-wide `fec` |
| `columns` | u16 | *required* | XOR: interleave depth (burst tolerance), `[1, 64]`. Reed-Solomon: data shards *k*, `[1, 64]` |
| `rows` | u16 | *required* | XOR: packets per column, `[2, 64]` — overhead is `1/rows`. Reed-Solomon: parity shards *m*, `[1, 64]` — recovers up to *m* losses per `k+m` block at `m/k` overhead |
| `parity_max` | u16 | — | Reed-Solomon **adaptive** parity ceiling. Set above `rows` (the parity floor) and the leg scales parity within `[rows, parity_max]` with its measured loss; equal or unset means fixed parity. `[1, 64]`, with `columns + parity_max ≤ 256` |

XOR additionally requires `columns × rows ≤ 4096`; Reed-Solomon
requires `columns + rows ≤ 256`. Note the asymmetry on `parity_max`:
it is **rejected** on the bond-wide XOR `fec`, but on a per-leg XOR
path it is accepted and simply ignored. Both ends must configure the
same geometry.

#### Packet redundancy

`redundancy` replicates packets across the N best legs — the strongest
loss-resilience, at N× the bandwidth for the replicated traffic. The
bonded input dedups; nothing is configured on the receiver.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mode` | enum | `off` | `off` (only Critical/IDR keyframes still duplicate), `all` (every packet across the N best legs, N× bandwidth), or `threshold` (only packets at or above `min_priority`) |
| `min_priority` | enum | `high` | `threshold` mode only: `normal`, `high` or `critical` |
| `replicas` | u8 | 2 | Legs to replicate across, `[2, 8]`. Clamped at runtime to the live leg count |

`mode: "all"` is *ride-fastest*, so it automatically suppresses
equalization on the receiver — holding the fast copy to align a slow
duplicate the receiver would deliver immediately defeats the point.
`threshold` mode keeps alignment on. Setting `"equalization": "on"` on
the bonded **input** overrides the suppression if you want alignment
alongside duplicate-all.

### Path transport blocks

Each entry in `paths` has a common shell plus a `transport` block:

```json
{
  "id": 0,
  "name": "lte-0",
  "weight_hint": 1,
  "transport": { "type": "udp|relay|rist|quic", ... }
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | u8 | *required* | Path identifier. Unique within `paths`. Echoed in NACKs so the sender knows which path to fault |
| `name` | string | *required* | Operator-visible label (`"lte-0"`, `"starlink"`, …) |
| `weight_hint` | u32 | 1 | Scheduler weight hint. Higher = more traffic at steady state. `weighted_rtt` / `media_aware` combine this with live RTT |
| `max_bitrate_bps` | u64 | — | Hard bits/sec ceiling the adaptive scheduler never drives this leg above, `[100000, 10000000000]`. Unset = auto-discover with no ceiling. This is the cost cap for a metered cellular SIM, and it also sizes the auto-derived `retransmit_capacity` |
| `fec` | object | — | This leg's own per-leg FEC (XOR or Reed-Solomon). Recovers a leg burst locally instead of clustering it in the combined stream. Mutually exclusive with the bond-wide `fec`; both ends must list the same geometry for this leg. See [Proactive FEC](#proactive-fec) |
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
prefers `SO_BINDTODEVICE` (a hard TX + RX device bind), which needs
`CAP_NET_RAW` (grant with `sudo setcap cap_net_raw+ep
/path/to/bilbycast-edge` or a systemd `AmbientCapabilities=CAP_NET_RAW`
line; the edge itself does not need root). **Without `CAP_NET_RAW` the
edge automatically falls back to the unprivileged `IP_UNICAST_IF`
egress hint** — the leg still leaves the right NIC, but the hint is
TX-only (it doesn't device-bind the receive side), so on a multi-homed
host with overlapping subnets the strict `SO_BINDTODEVICE` path is
still preferred. macOS / FreeBSD use `IP_BOUND_IF` and are
unprivileged. Omit the field to let the kernel decide (or to use
source-IP binding plus `ip rule` policy routing instead).

**Relay path** (bidirectional; the leg's own relay tunnel, in-process):

```json
{
  "type": "relay",
  "tunnel_id": "3f2a9c40-1d7e-4a2b-9f11-0c7d5e8b6a34",
  "relay_addrs": ["relay-lon.example.com:4434", "relay-fra.example.com:4434"],
  "tunnel_encryption_key": "…64 hex chars…",
  "interface": "wwan0"
}
```

| Subfield | Meaning |
|---|---|
| `tunnel_id` | Required UUID. Both ends must carry the same value — it is what the relay pairs the ingress and egress halves by |
| `relay_addrs` | Required, ≥ 1 dialable `host:port` — the relay's **native-UDP carrier** port (`4434` by default), not its QUIC port. No duplicates. Extra entries are an ordered failover list the bridge rotates through when a relay goes dead |
| `tunnel_bind_secret` | Optional 64-hex (32-byte) secret → HMAC-SHA256 bind token in the `Register`, the same auth a native SRT/RIST relay tunnel uses |
| `tunnel_encryption_key` | Optional 64-hex (32-byte) per-leg tunnel AEAD key — see the encryption rule below |
| `interface` | Optional NIC pin (1–15 chars) for the leg's outbound relay socket. Same `SO_BINDTODEVICE` → `IP_UNICAST_IF` mechanism as the UDP leg |
| `source` | Optional source address (`ip` or `ip/prefix`). Only meaningful with `gateway` |
| `gateway` | Optional gateway-mode next-hop. Requires `source` **and** `interface`, same IP family, gateway inside the source subnet |

Unlike a plain UDP leg — where `gateway` is rejected on the receiver —
gateway mode is legal on **both** sides of a relay leg, because both
ends dial out to the relay and each can pin its own egress uplink.

:::caution[Exactly one encryption layer]
A relayed leg is **fail-closed** on encryption: it must carry either
the bond's own `encryption_key` **or** the leg's
`tunnel_encryption_key`, never both and never neither. Config
validation rejects "neither" (media would cross the public relay in
the clear) and "both" (a wasted ChaCha20 pass and a layer-mismatch
blackout risk).
:::

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
  "addr": "203.0.113.5:7000",
  "server_name": "edge-b.example.com",
  "tls": { "mode": "self_signed" }
}
```

| Subfield | Meaning |
|---|---|
| `role` | Optional and ignored — auto-derived from the side (a bonded **output** leg is always the `client`, a bonded **input** leg always the `server`). Kept only for back-compat with configs that still carry it |
| `addr` | Client: remote `host:port`. Server: local bind `ip:port` |
| `server_name` | Client SNI / ALPN. Ignored on server role |
| `tls.mode` | `"self_signed"` (dev / loopback / trusted LAN) or `"pem"` |
| `bind` | Client-only local source `ip:port` (port usually 0) pinning egress on a multi-homed sender. Omitted, the client binds `0.0.0.0:0` (`[::]:0` for an IPv6 remote), the kernel routing table picks the NIC, and every QUIC leg collapses onto the default route — the same cosmetic-bond failure the UDP section warns about. Ignored on the server role, which binds `addr` |
| `interface` | NIC pin (1–15 chars), honoured on **both** roles. Same `SO_BINDTODEVICE` → unprivileged `IP_UNICAST_IF` fallback as the UDP leg, with the same `CAP_NET_RAW` note |

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
| `media_aware` | `weighted_rtt` plus NAL walking: detects H.264 and HEVC IDR frames (H.264 types 5/7/8; HEVC 19/20/21/32/33/34) inside the outbound TS and duplicates them across the two best paths. Non-IDR frames go single-path. **Legacy** — superseded by `adaptive` |
| **`adaptive`** (default) | The same NAL walking + IDR duplication as `media_aware`, plus a per-leg **capacity-aware congestion controller**. Each leg discovers its usable bitrate from delivered-rate / loss / RTT-inflation feedback and is filled to (but not past) that capacity, so the split is proportional to *measured* capacity and a saturated leg spills to one with headroom. The right policy for a heterogeneous cellular + satellite bond. See [Adaptive capacity scheduling](#adaptive-capacity-scheduling) |

On an 84/16 traffic split (5G vs Starlink in testing), the
`adaptive` scheduler delivers zero lost gaps under 200 ms RTT
and 3% loss on the Starlink leg because every IDR rides the best
paths.

## Adaptive capacity scheduling

`adaptive` (the default) runs a closed-loop congestion controller per
leg. The receiver echoes per-path byte counters + measured jitter in
its keepalive ack (~5 Hz); the sender differences successive acks into
a *windowed* delivered bitrate + loss fraction and feeds the
controller. Each leg probes its capacity estimate **up** while clean,
backs **off** toward the delivered rate the moment loss or
queue-building delay appears, and the per-leg token buckets split
traffic proportionally to the discovered capacities. RTT alone no
longer drives the split — the old `weighted_rtt` behaviour over-drove a
low-RTT cellular link past its capacity while starving a high-RTT
satellite link.

### Clean jittery cellular legs are no longer pinned

A clean but RTT-jittery radio leg (5G or Starlink, whose smoothed RTT
sits tens of milliseconds above its own windowed minimum even at zero
loss) used to read as permanently congested and stayed parked at
`min_rate_kbps` while the bond dropped packets for want of its
capacity. The controller now discovers capacity from **delivered rate
versus estimate, not RTT**: when a leg delivers ≥ 85 % of its current
estimate *and* loss is below `loss_low_pct`, it is treated as
capacity-limited and the estimate probes up (slow-start style, so a
starved leg reaches its real capacity in about a second instead of
crawling). RTT inflation from normal radio jitter no longer
masquerades as congestion. **Loss is the safety bound** — the instant
probing up induces real loss the leg backs off, so discovery cannot
run away. ARQ retransmits are charged their real size against the token
bucket, so a NACK storm can't self-amplify on a leg that is already
dropping.

### Congestion tuning (`congestion` block)

Every field is optional; unset falls back to the broadcast-tuned
default. Set them under the bonded **output**'s `congestion` object.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `min_rate_kbps` | u32 | 250 | Floor a leg's capacity estimate never drops below |
| `start_rate_kbps` | u32 | — | Starting estimate before measurement for a unit-weight leg |
| `loss_low_pct` | f32 | 0.5 | Loss below which a leg is "clean" and probes up |
| `loss_high_pct` | f32 | — | Loss at/above which a leg backs off hard |
| `delay_inflation_ms` | u32 | — | RTT inflation over a leg's own minimum treated as queue-building congestion. With `delay_inflation_auto` set, this is the *floor* of the auto-derived threshold |
| `delay_inflation_auto` | bool | **`true` on edge bonded outputs** | Derive the queue-build delay threshold per leg from its own windowed baseline RTT (a bufferbloated cellular leg gets a proportionally looser threshold; a terrestrial leg keeps the tight `delay_inflation_ms` floor). The library default is off; the edge enables it because its headline bond is heterogeneous cellular + satellite. Set `false` to force a fixed threshold |
| `burst_ms` | u32 | — | Token-bucket burst depth, in milliseconds of capacity |
| `probe_cap_mult` | f64 | 2.0 | Evidence bound — a leg's estimate never exceeds `delivered × probe_cap_mult` (suspended while the leg is the clean bottleneck so the bound can't re-pin the leg the bond must grow into) |
| `rtt_min_window_ms` | u64 | 10000 | Window over which each leg's minimum-RTT baseline is tracked (BBR-style); a route change that shifts the floor ages out instead of reading as permanent congestion |
| `jitter_demote_ms` | u32 | 150 | Smoothed interarrival jitter above which a leg is demoted from carrying *unique* media (it keeps carrying redundancy / FEC copies). Re-admits when jitter recovers. `0` disables demotion |

## Sharing an uplink between bonds

When two or more bonded outputs on the same edge share a physical
uplink (two field feeds on one 5G modem, a programme bond and a
return bond over the same Starlink dish), their adaptive schedulers
each measure the *shared* link and, left uncoordinated, both probe up
into the same capacity — colliding and inducing loss on the very leg
they share. The edge ships a **shared-leg capacity broker**
(`engine::bond_leg_broker`) that arbitrates this contention.

The broker is **on by default** — no configuration required. It
auto-discovers each shared NIC's capacity and reserves it across the
co-located bonds by each bond's **priority tier**, tracking live
(VBR) demand rather than a static bandwidth number:

| `priority` | Tier | Behaviour under contention |
|---|---|---|
| `critical` | Highest | Demand reserved first — the main programme feed |
| `normal` | Guaranteed | Reserved after `critical`, before best-effort |
| **`best_effort`** (default) | Spare-only | Takes whatever capacity the guaranteed tiers leave |

Priority is *between* tiers; within a tier the split is weighted-fair.
Set it per bonded output with the `priority` field. A lone bond on a
leg is never throttled regardless of tier.

Two host-level knobs on the edge config tune the broker:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `shared_leg_broker` | bool | `true` (on) | Explicit on/off. Unset → on. `false` reverts to uncoordinated per-bond contention |
| `bond_uplinks` | array | `[]` | Optional per-NIC **hard ceilings** for metered / rate-limited links whose capacity the broker can't infer from loss. On a normal link leave it empty — the broker self-discovers. Listing an uplink does **not** enable the broker (it's already on) |

Each `bond_uplinks` entry takes:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `interface` | string | *required* | NIC name the bonded legs pin to (`"eno4"`, `"wlo5"`, …). Matched against each bonded leg's `interface` |
| `capacity_bps` | u64 | *required* | Physical uplink capacity, bits/sec — the amount divided across every bonded flow sharing this NIC |
| `min_viable_bps` | u64 | 200 000 | Per-flow minimum-viable rate on this leg. When the sum across the flows on the leg exceeds `capacity_bps`, the broker flags admission pressure |
| `demand_active_bps` | u64 | 50 000 | Activity-grace threshold — a flow delivering at least this on the leg keeps its min-viable reservation; below it (once the grace window lapses) it releases its share to a co-flow that actually wants the leg. Raise it when sporadic keyframe-duplication traffic holds an unused reservation |

Contention is **not** an event. The edge advertises the `bond-broker`
capability and publishes a `bond_leg_contention` block on each health
tick (and on `/api/v1/stats`) carrying per-leg `capacity_bps` /
`member_count` / `oversubscribed` / `unmet_bps` /
`guaranteed_unmet_bps`, plus per-member `demand_bps` /
`allocation_bps` / `protected` — which the manager renders as the
node-detail Shared Uplink Contention card. The broker's *events* are
`bond_leg_oversubscribed` (the guaranteed tiers alone exceed capacity
— a real shortfall, not just best-effort yielding), its
`bond_leg_oversubscribed_cleared` counterpart, and
`bond_leg_admission_pressure`, raised once when a bonded output starts
on a leg whose combined min-viable rates already exceed its capacity.
All three are filed under category `bonding`, not `bond`.

## Fitting datagrams to the path MTU

By default the bond emits **1316-byte (7 × 188) TS datagrams** — the classic
SRT / standard-ethernet size derived from `path_mtu`'s 1500 default. On a
constrained path that is a problem: a datagram larger than a leg's real
IP-layer MTU gets **IP-fragmented**, and cellular CGNAT bearers routinely
**drop IP fragments and black-hole PMTU discovery** (no ICMP *fragmentation
needed* comes back). The leg then reports `state=alive` with a healthy RTT yet
delivers only ~10–15 % of its bytes — video absent or heavily pixelated —
because every oversized datagram (e.g. a whole I-frame) is lost wholesale and
unrecoverably.

Set **`path_mtu`** on the bonded output to the smallest IP-layer MTU across the
legs. The sender re-chunks outbound MPEG-TS at 188-byte packet boundaries into
datagrams that fit `path_mtu` **after every per-datagram overhead** — IP/UDP
(28 B v4, or 48 B when a leg dials an IPv6 literal or a hostname), relay /
native-UDP tunnel framing (16 or 44 B), the RIST/RTP carrier (12 B), the bond
header (12 B, or 16 B with equalization), the AEAD envelope (29 B when
`encryption_key` is set), plus FEC repair headroom when `fec` or per-leg FEC is
on. No leg emits a fragmented datagram, so any residual loss is per-small-datagram
and recoverable by the bond's ARQ + FEC.

- Default `1500` → 1316-byte (7 × 188) datagrams.
- A measured ~1000-byte cellular bearer → 752-byte (4 × 188) datagrams.

Measure the constrained leg with a **DF (don't-fragment) ping sweep** — the
largest size that still gets a reply, plus 28 bytes for the IP + ICMP header, is
that path's MTU:

```bash
ping -M do -s 1472 <peer>     # 1472 + 28 = 1500; shrink -s until replies stop fragmenting
```

`path_mtu` is **sender-side only** — the bonded input reassembles in
bond-sequence order regardless of datagram size, so nothing changes on the
receiver. Payloads that are not 188-aligned (non-TS essence) cannot be re-chunked
and are sent whole, flagged via the `oversize_payloads` stat and a
`bond_payload_exceeds_mtu` warning event. See
[Cellular Modem Bonding Path → Fit the datagram size to the cellular MTU](/edge/bonding-cellular-modem/#fit-the-datagram-size-to-the-cellular-mtu)
for the field-measurement recipe on a live SIM.

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
    "scheduler": "adaptive",
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
      "type": "quic",
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

This is the case `adaptive` (the default) exists for. IDR frames ride
the two best paths; non-IDR traffic rides a single path chosen by each
leg's *measured* capacity, so the 5G and Starlink legs each carry what
they can actually sustain rather than what their RTT implies. The
`weight_hint` values below only seed the initial capacity priors.

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
   - **Type:** *Bonded (multi-path aggregation — UDP / QUIC)*.
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
   - **Transport** is `UDP` or `QUIC` — the only two the UI offers for
     bond legs. Choose `UDP` unless you need per-leg TLS (use QUIC).
     (RIST legs are config-file only; see the note under
     [Path transports](#path-transports).)
   - For **UDP receiver**: fill **Bind** (e.g. `0.0.0.0:5000`).
   - For **QUIC server**: fill **Bind** + choose TLS mode.
     Self-signed is fine for trusted LANs / loopback; PEM mode for
     production.
4. **Save**.

### Create the bonded sender (output) on Edge A

1. **Edge A → Config → Outputs → Add Output**.
2. Set:
   - **Type:** *Bonded*.
   - **Bond Flow ID:** must equal the receiver's.
   - **Scheduler:** `Adaptive` is the default — walks H.264 / HEVC
     NAL units and duplicates IDR frames across the two best paths,
     *and* discovers each leg's usable capacity so the split tracks
     measured bandwidth (right for heterogeneous cellular + satellite
     bonds). Use `Media-aware` for the legacy RTT-only split,
     `Weighted RTT` for non-video data where IDR detection is a no-op,
     or `Round Robin` when all paths are near-identical.
   - **Retransmit buffer (packets):** leave blank — the edge
     auto-sizes it from the latency budget × the aggregate leg
     bitrate. Fill it in only to override that.
   - **Keepalive (ms):** 200.
   - **Program number (optional):** set to down-select a single
     program from an MPTS input before bonding.
3. **Paths:** mirror the receiver's paths with matching `id`
   numbers.
   - For **UDP sender**: fill **Remote** (`203.0.113.5:5000`).
   - For **QUIC client**: fill **Remote**, **Server name** (for
     SNI), **TLS mode** (match what the receiver accepts).
   - The UI offers only **UDP** and **QUIC** legs; RIST legs are
     config-file only.
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
  `late_stale_drops`.
- **Per-path table** — one row per leg with a liveness pill
  (`alive` / `dead`), RTT, loss percentage, traffic-share bar,
  packets / bytes, NACKs, retransmits, keepalives.

The topology view shows only the aggregate state
(`up` / `degraded` / `idle`). Deep per-path inspection lives on
the Node Detail page.

### Test a leg before you go on air

Each leg row in the bonded input / output editor carries a **Test leg**
button, and a sender leg additionally carries **Measure capacity**.
They answer the two questions the running bond can't: *is this leg
wired the way I think it is*, and *how much can it actually carry
right now*.

**Test leg** — the pre-flight, and the one to reach for first. It puts
**zero packets on the wire**, so it is safe while the bond is carrying
a live feed. It introspects the host and uses a `connect()` route
lookup (which transmits nothing) to report, per check, `pass` / `warn`
/ `fail` / `skipped`:

| Check | What it proves |
|---|---|
| `interface_link` | The pinned NIC exists and carrier is up; reports MTU + link speed |
| `source_ip` | A gateway-mode `source` address is actually present on a NIC |
| `bind` | Interface-mode / default-route legs: a socket binds exactly as the leg will, and the report says whether the strict `SO_BINDTODEVICE` pin was available. Not emitted for a gateway-mode or listener leg |
| `egress_route` | Interface-mode / default-route legs: the leg egresses the intended NIC and hasn't collapsed onto the kernel default route — the classic cosmetic-bond trap |
| `first_hop` | Gateway-mode legs: the next-hop router is in the kernel neighbour table |

Two caveats. Strict `SO_BINDTODEVICE` needs `CAP_NET_RAW`; without it
the `bind` check `warn`s and notes the unprivileged `IP_UNICAST_IF`
fallback the bond itself uses. And `egress_route` is deliberately
`skipped` for a gateway-mode leg while idle — the per-leg policy route
is only programmed at flow start, so a lookup now would follow the
default route and mislead; `source_ip` + `first_hop` prove that leg
instead. The reported MTU is the **local NIC** MTU, not the
end-to-end path MTU — see
[Fitting datagrams to the path MTU](#fitting-datagrams-to-the-path-mtu).

**Measure capacity** — the active probe, sender legs only. It drives
synthetic traffic over the leg to a cooperating peer and reads back
delivered rate, ramping until the loss / RTT-inflation knee. It needs
an ephemeral responder started on the far node first (a stateless echo
on its own socket and port, never the leg's media port, which
auto-expires after `duration_secs` — default 30 s, clamped 1–120 s).
The probe itself defaults to 8 s, clamps to 1–60 s, and honours an
optional `max_bitrate_bps` ceiling so a metered SIM is never
over-driven.

:::caution[The capacity probe is idle-only]
A capacity ramp is **refused** — `error_code:
bond_leg_test_unsafe_link_busy` — when the leg under test, or any
other bonded I/O sharing its interface / source / gateway, is carrying
a live flow. Saturating a shared physical link is the one thing that
would affect the feed. For a live leg, read the scheduler's own
`capacity_bps` / `delivered_bps` on the flow card instead.
:::

The WS actions behind the buttons are `test_bond_leg` (modes
`usability` / `reachability` / `capacity`), `start_bond_probe_responder`
and `stop_bond_probe_responder`, gated on the edge capabilities
`bond-leg-test`, `bond-leg-capacity` and `bond-probe-responder`. Note
the manager renders both buttons on **every** node with no capability
check, so against an edge predating those bits the command returns
`unknown_action` and the panel shows *"No report — this edge may
predate the bond-leg-test capability."*

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
  `loss_fraction`, and if you suspect a leg is smaller than you
  provisioned for, take the bond off air and
  [measure its capacity](#test-a-leg-before-you-go-on-air).
- **One path stays `dead` but others work** — keepalive isn't
  making it through. Check the bind / remote addresses and firewall;
  a dead path is excluded from the scheduler without affecting the
  bond as a whole. Run [Test leg](#test-a-leg-before-you-go-on-air)
  on it — it is safe to do while the rest of the bond is on air, and
  it catches the wiring faults (wrong NIC, missing source address,
  leg collapsed onto the default route) that produce exactly this.

## Stats, events, Prometheus

Every bonded input or output carries a `bond_stats` field with
aggregate and per-path metrics.

**Aggregate fields:**

| Field | Side | Meaning |
|---|---|---|
| `state` | both | `"up"`, `"degraded"`, or `"idle"` |
| `flow_id` | both | Matches `bond_flow_id` |
| `role` | both | `"sender"` or `"receiver"` |
| `scheduler` | sender | `"round_robin"`, `"weighted_rtt"`, `"media_aware"`, or `"adaptive"` |
| `packets_sent` / `bytes_sent` | sender | |
| `packets_retransmitted` | sender | Count of ARQ retransmits |
| `packets_duplicated` | sender | Packets intentionally duplicated (IDR frames on two paths) |
| `packets_dropped_no_path` | sender | Scheduler couldn't dispatch — bond is hard-failed |
| `aggregate_capacity_bps` | sender | The adaptive scheduler's discovered usable bonded bitrate — the sum of the per-leg capacity estimates across alive legs. Provision a fixed external encoder the edge can't throttle at or below this. `0` on the receiver, for the non-adaptive policies, and on older edges |
| `packets_received` / `bytes_received` | receiver | |
| `packets_delivered` | receiver | Packets delivered to the application after reassembly |
| `gaps_recovered` | receiver | Gaps filled by ARQ or a second path |
| `gaps_lost` | receiver | Gaps that exceeded `hold_ms` — packet loss |
| `duplicates_received` | receiver | Duplicates absorbed by reassembly |
| `hold_ms` | receiver | The adaptive hold servo's **current** reorder/recovery budget in ms, between the `hold_ms` config floor and the `hold_max_ms` ceiling (fixed at `hold_ms` when no ceiling is set). Absent on the sender. Note the name collision with the config field — this one is the live value, not the setpoint |
| `late_stale_drops` | receiver | Datagrams that arrived too late to use — they aged out of the reordering ring before delivery. Climbing counts mean a path's latency exceeds `hold_ms`; raise `hold_ms` or fix the slow path. (Formerly `reassembly_overflow`, still accepted as a serde ingest alias) |

**Per-path fields** (one entry per leg):

`id`, `name`, `transport`, `state` (`"alive"` or `"dead"`),
`rtt_ms`, `jitter_us`, `loss_fraction`, `throughput_bps`,
`delivered_bps` (what the receiver reports actually *arriving* on this
leg — the gap against `throughput_bps` is loss / saturation),
`capacity_bps` (the congestion controller's discovered usable capacity
for this leg, which it fills toward — **not** the `bond_uplinks`
`capacity_bps` config field, which is a hard per-NIC ceiling you set),
`fec_throughput_bps` (proactive-FEC repair rate on this leg),
`fec_recovered` (packets recovered by *this leg's* per-leg FEC —
distinct from the bond-aggregate `gaps_recovered`),
`wire_throughput_bps` (honest total wire load on this leg, media +
FEC + AEAD — decomposes the send-direction load alongside
`throughput_bps`), `relative_owd_us` (the equalizer's measured
inter-leg skew: how much later this leg's packets land than the
fastest eligible leg), `binding` (`"gateway"` / `"so_bindtodevice"` /
`"ip_unicast_if"` / `"ip_bound_if"` / `"none"` — how this leg's egress
is actually pinned), `interface` (the kernel netdev, interface-mode
UDP legs only), `tunnel_id` (relay legs only — joins the leg to the
relay's `udp_sessions[]` row forwarding it), `queue_depth`,
`packets_sent`, `bytes_sent`, `packets_received`, `bytes_received`,
`nacks_sent`, `nacks_received`, `retransmits_sent`,
`retransmits_received`, `keepalives_sent`, `keepalives_received`,
`rebuilds`.

**Prometheus series.** The aggregate series carry the owner labels
(`flow_id`, `leg_role`, plus `output_id` on an output-side bond); the
per-path series add `path_id`, `path_name` and `transport`.

```
# aggregate
bilbycast_edge_bond_gaps_recovered
bilbycast_edge_bond_gaps_lost
bilbycast_edge_bond_packets_duplicated
bilbycast_edge_bond_throughput_bps          (gauge)

# per-path
bilbycast_edge_bond_rtt_ms                  (gauge)
bilbycast_edge_bond_loss_fraction           (gauge)
bilbycast_edge_bond_path_dead               (gauge)
bilbycast_edge_bond_path_throughput_bps     (gauge)
bilbycast_edge_bond_path_packets_sent
bilbycast_edge_bond_path_packets_received
bilbycast_edge_bond_path_retransmits_sent
bilbycast_edge_bond_path_nacks_sent
bilbycast_edge_bond_path_nacks_received
bilbycast_edge_bond_path_keepalives_sent
```

Everything not marked a gauge is a counter.

**Events** — most bonding events ride category `bond`, severity `info`
/ `warning` / `critical`: path-up / path-down transitions fire as
`info` / `warning`, and bond-idle (no alive paths) fires as
`critical`. The full catalogue is
[Events and alarms → Bonding](/edge/events-and-alarms/#bonding-bond).
Two exceptions worth knowing before you build a filter:
`bond_leg_admission_pressure`, `bond_leg_oversubscribed` and
`bond_leg_oversubscribed_cleared` ride category `bonding`, and
`bond_legs_unencrypted` rides `media` — so filtering on
`category:bond` alone will not surface them.

## Tuning

- **`hold_ms`** — tune to the *worst* path's expected RTT × 2 plus
  a margin for jitter. Too low and `gaps_lost` climbs from late
  arrivals; too high and end-to-end latency grows.
- **`nack_delay_ms`** — comparable to the *median* path RTT. Lower
  retries faster; higher gives natural reordering a chance.
- **`retransmit_capacity`** — leave it unset. The edge derives the
  ring from the aggregate leg ceiling × `max_bonding_latency_ms` ÷ the
  typical datagram size, clamped to `[8192, 262144]`, which is the
  `send_rate_pps × max_nack_round_trip_seconds` rule applied with the
  numbers it actually has. Set it only to override that — and if you
  do, it must still exceed that product (at 10 kpps and a worst-case
  500 ms NACK round-trip, ≥ 5000).
- **`keepalive_ms`** — faster keepalives detect dead paths sooner
  but consume more bandwidth. 200 ms is a reasonable default.
- **Scheduler choice** — `adaptive` is the right default for video
  flows carried over MPEG-TS, especially heterogeneous cellular +
  satellite bonds. Use `round_robin` for bonded non-video data
  (e.g. bulk file transfers) where IDR detection is a no-op. With
  `adaptive`, `weight_hint` only seeds each leg's initial capacity
  prior — the controller then discovers the real capacity, so you no
  longer hand-shape the split.

## Limitations

- **SRT is deliberately not a bond leg.** Its TSBPD latency-window
  delivery and TLPKTDROP fight the bond's own cross-leg reassembly and
  ARQ, and it buys no third-party interop because the bond wire is
  proprietary at both ends. This is a settled non-goal, not a deferred
  item. For SRT bonding to a third-party receiver, use libsrt
  socket-group bonding (Broadcast / Backup) on the SRT output. The leg
  transports are UDP, QUIC and relayed (see
  [Bonding over a relay](#bonding-over-a-relay-per-leg)); RIST is a
  valid leg variant but is unidirectional at the bond layer, so it is
  not a true aggregation leg.
- **Confidentiality is per-path.** QUIC legs are TLS-encrypted; RIST
  legs are plaintext; UDP legs are plaintext **unless** you set
  `encryption_key` (per-datagram ChaCha20-Poly1305 AEAD, shared by
  both ends). A relayed leg is the exception: it is fail-closed and
  can never be plaintext — validation requires exactly one of the
  bond's `encryption_key` or the leg's `tunnel_encryption_key`.
  Otherwise wrap an already-encrypted inner protocol (SRT-encrypted
  TS).
- **Topology view shows aggregate state only.** The Node Detail
  page has full per-path tables; the topology view only shows
  `up` / `degraded` / `idle`.
