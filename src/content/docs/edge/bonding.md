---
title: Multi-Path Bonding
description: Peplink-class multi-path aggregation for professional broadcast — media-aware IDR duplication across heterogeneous IP links.
sidebar:
  order: 8
---

bilbycast-edge supports **multi-path packet bonding** across N
heterogeneous IP links — 5G + Starlink + fibre, two LTE SIMs, QUIC +
UDP, whatever you can reach over the public internet. A bonded hop
sits between two edges and carries any inner protocol (SRT, RTMP,
RTSP, ST 2110), aggregating the paths into a single reliable flow with
frame-accurate failover on IDR boundaries.

## When to use it

bilbycast-edge ships **three** bonding options. Pick by topology:

| Scenario | Use |
|---|---|
| Two **SRT** legs to the same SRT receiver | libsrt socket groups (Broadcast or Backup) — configured on the SRT output `redundancy` block |
| Two **RIST** legs to a RIST receiver | RIST native SMPTE 2022-7 bonding |
| **N ≥ 2 heterogeneous links** carrying any inner protocol, with IDR-frame duplication | Bonded input / output type (this page) |

The bonded type doesn't replace the native two — it covers the
heterogeneous case they don't. In particular, it lets you bond an SRT
flow, an RTMP flow, or an ST 2110 flow over any mix of UDP / QUIC /
RIST legs without the inner protocol having to know anything about
bonding.

## How it works

A bonded hop rides between two edges:

```
[Source]
  │ SRT / RTMP / RTSP / ST 2110 / …
  ▼
Edge A (flow: source_input → bonded_output)
  │
  │  N bond paths (UDP / QUIC / RIST, any mix)
  ▼
Edge B (flow: bonded_input → destination_output)
  │ SRT / RTMP / RTSP / ST 2110 / …
  ▼
[Destination]
```

Each packet is framed with a 12-byte bond header carrying a 32-bit
sequence number, a path ID, and a priority hint. The scheduler on the
sender decides which path(s) each packet rides; the receiver reorders
across paths using a sequence-keyed reassembly buffer and NACKs lost
packets back to the sender.

### Media-aware scheduling

The default `media_aware` scheduler reads inside the outbound MPEG-TS
stream, detects H.264 and HEVC NAL boundaries, and tags SPS / PPS /
IDR frames as `Critical` priority. Critical packets are **duplicated
across the two lowest-RTT paths**; everything else rides a single path
weighted by live RTT.

The result: even under severe asymmetry — say a 200 ms-RTT Starlink
leg sharing load with 30 ms-RTT 5G — every IDR frame arrives
unconditionally on the fastest path even if the slower leg drops
packets. Non-IDR frames go where they're cheapest, so you don't pay
2× bandwidth for the whole stream.

Alternative schedulers:

- **`weighted_rtt`** — same RTT weighting, but only duplicates packets
  already tagged `Critical` upstream (uncommon without media
  awareness). Fine for non-video data flows.
- **`round_robin`** — equal rotation, useful when paths are
  near-identical (two matched fibre legs).

## Path transports

Each bond leg uses one of three per-path transports:

| Transport | When | Features |
|---|---|---|
| **UDP** | Simplest, broadest device support | Bidirectional. Plaintext. Use when the NAT allows it and you don't need per-leg TLS |
| **QUIC** (RFC 9221 DATAGRAM) | Need per-leg TLS 1.3 | Bidirectional. ALPN `bilbycast-bond`. Self-signed mode for trusted LAN / loopback, PEM mode for production |
| **RIST** (VSF TR-06-1 Simple Profile) | Want per-leg ARQ + RTT that the bond layer can layer on top of | Unidirectional. Role (`sender` / `receiver`) matches the bonded input/output side |

Paths are independent — you can mix (e.g. one QUIC leg for the
trusted fibre path, one UDP leg for the LTE SIM).

## What you see

The manager UI shows per-bonded-flow status cards with:

- Aggregate state pill (`up` / `degraded` / `idle`)
- Sender-side counters: sent, retransmits, IDR duplications,
  `dropped_no_path` (hard-fail indicator)
- Receiver-side counters: received, delivered, gaps recovered, gaps
  lost, duplicates absorbed, reassembly overflow
- Per-path table: liveness, RTT, loss %, traffic share, packets and
  bytes, NACKs, retransmits, keepalives

Prometheus exposes all of the above as labelled counters
(`flow_id`, `output_id`, `leg_role`, `path_id`, `path_name`,
`transport`).

## Configuration

See the repo reference at
[`bilbycast-edge/docs/bonding.md`](https://github.com/Bilbycast/bilbycast-edge/blob/main/docs/bonding.md)
for the complete JSON config schema, worked end-to-end examples, stats
field reference, and tuning guidance.

For UI walkthroughs (creating a bonded input and output in the
manager, path list editor, status cards, troubleshooting) see the
[manager user guide](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/USER_GUIDE.md#bonded-flows-multi-path-aggregation).

## Limitations

- **SRT paths are deferred.** UDP / QUIC / RIST are supported today;
  SRT as a per-leg transport (with libsrt's own ARQ and encryption
  per-path) is planned but not yet shipped.
- **No congestion control at the bond layer.** Use scheduler `weight_hint`
  to shape a known bandwidth ceiling, or rely on path-layer congestion
  control where available (QUIC, RIST).
- **Confidentiality is per-path.** QUIC legs are TLS-encrypted; UDP and
  RIST legs are plaintext. Wrap an encrypted inner protocol
  (SRT-encrypted TS) if you can't run QUIC for every leg.
