---
title: IP Tunneling
description: Tunnel configuration and end-to-end encryption via bilbycast-manager.
sidebar:
  order: 4
---

## Overview

Bilbycast provides IP tunneling to transport UDP and TCP data between edge nodes at different locations when they cannot communicate directly (e.g., both behind NAT firewalls). This is essential for remote broadcast production where venue equipment needs to send/receive data to/from a production hub.

A tunnel rides one of two carriers, chosen per tunnel:

- **QUIC carrier** (default) — TCP traffic over QUIC streams, UDP traffic over QUIC datagrams, all under TLS 1.3.
- **Native-UDP carrier** (`transport: "udp"`, UDP tunnels only) — a plain-UDP path with no QUIC. Use it for native SRT / RIST over a relay, and for individual **bond legs** carried over a relay: SRT/RIST/bonding already run their own ARQ and congestion control, so wrapping them in QUIC just adds per-packet overhead and a second congestion controller that fights theirs.

Either way, data is additionally encrypted end-to-end between edge nodes with authenticated encryption, using per-tunnel keys generated and distributed by the manager. Relay servers are **generic, opaque per-path forwarders** — they pair the two ends of each path by tunnel ID and forward `[tunnel_id][ciphertext]` verbatim. They never see plaintext, never terminate or combine the streams they carry, never hold long-lived credentials, and security does not depend on their integrity.

## Architecture

```
┌──────────────────────┐          ┌─────────────────┐          ┌──────────────────────┐
│   Venue (NAT)        │          │  bilbycast-relay │          │   Hub (NAT)          │
│                      │          │  (public server) │          │                      │
│  Camera/Encoder      │          │                  │          │  Decoder/Playout     │
│    ↓ SRT/UDP         │   QUIC   │                  │   QUIC   │    ↑ SRT/UDP         │
│  bilbycast-edge  ────┼─────────→│   Tunnel Router  │←─────────┼── bilbycast-edge     │
│  (ingress tunnel)    │   TLS    │                  │   TLS    │  (egress tunnel)     │
│                      │   1.3    │                  │   1.3    │                      │
└──────────────────────┘          └─────────────────┘          └──────────────────────┘
```

## Tunnel Modes

### Relay Mode (both nodes behind NAT)

Use when **both** edge nodes are behind NAT firewalls and cannot accept inbound connections. Traffic flows through a `bilbycast-relay` server deployed on a public cloud instance.

- Both edges connect outbound to the relay.
- The relay pairs tunnel endpoints by tunnel ID and forwards data bidirectionally.
- TCP traffic is carried reliably; UDP traffic is carried as unreliable datagrams for low latency.
- All traffic is encrypted end-to-end between the edges.

**When to use:** Most remote production scenarios where both venue and hub networks use NAT.

### Direct Mode (one node has public IP)

Use when **one** edge node has a public IP address or an open firewall port. The other edge connects directly without needing a relay.

- One edge listens; the other connects.
- Same forwarding and encryption model as relay mode, without the relay hop.
- Lower latency.

**When to use:** When the hub (or venue) has a public IP or the network admin can open a firewall port.

## Configuring Tunnels

### Via the Manager UI

#### Creating a tunnel with an SRT flow

1. Navigate to the **Node Configuration** page for your source (ingress) node.
2. Click **New Flow** to create an SRT flow.
3. In the **Output** section, select **SRT** as the output type.
4. Under **NAT Tunnel**, select:
   - **Via Relay Tunnel** if both nodes are behind NAT
   - **Via Direct Tunnel** if one node has a public IP
5. Fill in the tunnel configuration:
   - **Tunnel Name**: A descriptive name (e.g., "venue-to-hub-srt")
   - **Destination Node**: Select the receiving edge node
   - **Ingress Port**: Local port on the source edge that the encoder connects to
   - **Egress Forward Address**: Local address on the destination edge to forward to (e.g., `127.0.0.1:9000`)
   - **Relay Server Address** (relay mode only): The bilbycast-relay server address (e.g., `relay.example.com:4433`)
   - (Optional) **Backup Relay Server**: A second relay address for automatic failover
6. The SRT output remote address will automatically be set to the tunnel's local endpoint.

#### Viewing tunnel status

- Flow cards on the **Node Detail** page show an amber **Tunnel** badge when a tunnel is in use.
- The outputs table shows **[Tunnel: relay]** or **[Tunnel: direct]** next to tunneled outputs.
- The SMPTE 2022-7 redundancy badge (blue **2022-7**) is shown independently of tunnel status.

### Via the REST API

Tunnels can also be managed programmatically under `/api/v1/tunnels` and `/api/v1/nodes/{node_id}/tunnels`. Request and response schemas are provided to commercial licensees and integration partners under NDA.

## SRT over Tunnel — Quick Start

This is the most common use case: transporting an SRT stream between two edge nodes that are both behind NAT.

1. **Deploy `bilbycast-relay`** on a cloud server with a public IP. The relay is stateless and requires no configuration:

   ```bash
   bilbycast-relay
   ```

   Optionally specify listen addresses:

   ```bash
   bilbycast-relay --quic-addr 0.0.0.0:4433 --api-addr 0.0.0.0:4480
   ```

2. **Create the tunnel** via the Manager UI (recommended) or REST API, pointing at the relay address.

3. **Configure SRT flows:**
   - **Venue edge (ingress):** SRT Output → Mode: Caller, Remote Address: `127.0.0.1:9000`. The edge's tunnel subsystem picks up the traffic and sends it through the relay.
   - **Hub edge (egress):** SRT Input → Mode: Listener, Local Address: `127.0.0.1:9000`. The edge's tunnel subsystem delivers traffic locally.

4. **Verify:** look for the amber **Tunnel** badge on the flow card in the Manager UI.

## Per-tunnel uplink (NIC) pinning

A native-UDP tunnel can be pinned to a specific uplink so it leaves a chosen interface regardless of the host routing table — the same mechanism the [multi-path bond](/edge/bonding/) uses for its legs. This is what lets several tunnels (or bond legs) sharing one destination each go out their own modem instead of collapsing onto the default route. Three optional fields on the tunnel (UDP carrier only — ignored on the QUIC carrier):

| Field | Meaning |
|---|---|
| `interface` | NIC name (e.g. `wwan0`, `eth0`). Pins egress via `SO_BINDTODEVICE`, with an automatic unprivileged `IP_UNICAST_IF` fallback when the edge lacks `CAP_NET_RAW`. **Interface-mode** path selection — the simplest, for a host with one NIC per uplink. |
| `source` | Source IP (or `ip/prefix`) the tunnel socket binds to. On its own it pins the egress source IP; in gateway mode it also keys the policy route. |
| `gateway` | **Gateway-mode** next-hop (router) this tunnel egresses through. Requires `source` (and `interface`). The edge programs a dedicated `from <source>` policy route via the gateway, so several tunnels on one NIC each leave through their own router (the dumb-switch / single-NIC topology). Best-effort. |

For the full NIC-pinning rationale (capability grants, the unprivileged fallback, and the policy-routing alternative), see [Bonding Network Setup](/edge/bonding-network-setup/) and [Cellular Modem Bonding Path](/edge/bonding-cellular-modem/).

## Carrying bond legs over a relay

A [multi-path bond](/edge/bonding/) leg can run direct or over a relay, independently per leg. A relayed leg is just a native-UDP tunnel loopback-bridged onto the leg, so the bond's ARQ / FEC / reordering / capacity scheduling all run end-to-end edge↔edge and the relay forwards it opaquely — there is no "bond bridge". Because each relayed leg is its own outbound tunnel, a bond can work with **both ends behind NAT** (a direct bonded leg is asymmetric — the destination must be reachable). Provision per-leg relay routing from the **Bonded-Link wizard** or the **Tunnels** page; see [Bonding over a relay](/edge/bonding/#bonding-over-a-relay-per-leg).

## Node Network Type

Each node can be tagged with a network type to help the Manager UI suggest tunnels:

| Network Type | Description | Tunnel Needed? |
|---|---|---|
| `nat` (default) | Node is behind a NAT firewall | Yes, if communicating with another NAT node |
| `public` | Node has a public IP address | Direct mode possible, or no tunnel needed |
| `unknown` | Network type not determined | UI will suggest checking |

## Redundant Relay Failover

A relay-mode tunnel can carry a primary and a backup relay. When the primary becomes unreachable, each edge independently detects the loss and reconnects via the backup; when the primary recovers and its measured path quality is acceptable, traffic fails back automatically. Events are emitted on every failover and failback so the Manager UI can surface the active leg.

This is not a *hitless* switchover — there is a short gap on the tunneled flow during failover. For hitless redundancy within a flow, use SMPTE 2022-7 dual-leg or SRT bonding end-to-end; tunnel-level redundancy only protects against relay-server failure, not network-path jitter.

Detection windows, failover budgets, and failback thresholds are tuned for mobile/Starlink links and are documented in full in the commercial operator guide.

Single-relay tunnels (no backup) will simply reconnect to the same relay until it returns — there is no alternate path.

## Security

- **End-to-end encryption** between edge nodes using authenticated encryption with per-tunnel keys generated by the manager and stored encrypted at rest.
- **Stateless relay**: no authentication, no shared secrets, no access control on the relay. The relay forwards encrypted traffic by tunnel UUID; it cannot decrypt traffic or inject valid packets.
- **Tunnel ID security**: tunnel IDs are random 128-bit UUIDs. Knowledge of a UUID alone does not grant access.
- **Transport-level TLS 1.3** between each edge and the relay on the **QUIC carrier**. The **native-UDP carrier** has no transport TLS — its confidentiality rests entirely on the edge-to-edge authenticated encryption above (the relay still only ever sees ciphertext).
- **Defense-in-depth**: when using SRT over a tunnel, SRT's own encryption provides an additional layer.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Tunnel stays "pending" | Edges not connected to relay | Check relay address and firewall rules for QUIC (UDP port 4433) |
| High latency through relay | Relay server geographically distant | Deploy relay closer to the midpoint between venue and hub |
| Intermittent drops | Network stability | Check underlying link quality; QUIC sends regular keepalives |
| Decryption errors | Mismatched tunnel key | Ensure both edges received the same key from the manager |
| "peer doesn't support any known protocol" | Version mismatch | Ensure edge and relay are on compatible versions |
