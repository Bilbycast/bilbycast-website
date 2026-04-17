---
title: IP Tunneling
description: Tunnel configuration and end-to-end encryption via bilbycast-manager.
sidebar:
  order: 4
---

## Overview

Bilbycast provides IP tunneling to transport UDP and TCP data between edge nodes at different locations when they cannot communicate directly (e.g., both behind NAT firewalls). This is essential for remote broadcast production where venue equipment needs to send/receive data to/from a production hub.

The tunneling system uses QUIC (via the `quinn` crate) for transport with mandatory TLS 1.3. Data is encrypted end-to-end between edge nodes using ChaCha20-Poly1305 (AEAD) with a 32-byte shared key. The relay server is stateless -- it forwards encrypted traffic without any authentication, shared secrets, or access control lists. Security relies entirely on the edge-to-edge encryption: even if an attacker connects to the relay and guesses a tunnel UUID, they cannot decrypt traffic or inject valid packets (AEAD tag verification fails).

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

- Both edges connect outbound to the relay via QUIC
- The relay pairs tunnel endpoints by tunnel ID and forwards data bidirectionally
- TCP traffic uses QUIC reliable bi-streams (one QUIC stream per TCP connection)
- UDP traffic uses QUIC unreliable datagrams (low latency, no head-of-line blocking)
- All traffic is encrypted with TLS 1.3

**When to use:** Most remote production scenarios where both venue and hub networks use NAT.

### Direct Mode (one node has public IP)

Use when **one** edge node has a public IP address or an open firewall port. The other edge connects directly without needing a relay.

- One edge acts as a QUIC server (listens on a public port)
- The other edge connects as a QUIC client
- Same data forwarding as relay mode, but without the relay hop
- Lower latency (no relay overhead)

**When to use:** When the hub (or venue) has a public IP or the network admin can open a firewall port.

## Configuring Tunnels

### Via the Manager UI

#### Creating a tunnel with an SRT flow

1. Navigate to the **Node Configuration** page for your source (ingress) node
2. Click **New Flow** to create an SRT flow
3. In the **Output** section, select **SRT** as the output type
4. Under **NAT Tunnel**, select:
   - **Via Relay Tunnel** if both nodes are behind NAT
   - **Via Direct Tunnel** if one node has a public IP
5. Fill in the tunnel configuration:
   - **Tunnel Name**: A descriptive name (e.g., "venue-to-hub-srt")
   - **Destination Node**: Select the receiving edge node
   - **Ingress Port**: Local port on the source edge that the encoder connects to
   - **Egress Forward Address**: Local address on the destination edge to forward to (e.g., `127.0.0.1:9000`)
   - **Relay Server Address** (relay mode only): The bilbycast-relay server address (e.g., `relay.example.com:4433`)
6. The SRT output remote address will automatically be set to the tunnel's local endpoint

#### Viewing tunnel status

- Flow cards on the **Node Detail** page show an amber **Tunnel** badge when a tunnel is in use
- The outputs table shows **[Tunnel: relay]** or **[Tunnel: direct]** next to tunneled outputs
- The SMPTE 2022-7 redundancy badge (blue **2022-7**) is shown independently of tunnel status

### Via the REST API

#### Create a tunnel

```bash
POST /api/v1/tunnels
Content-Type: application/json

{
  "name": "venue-to-hub-srt",
  "protocol": "udp",
  "mode": "relay",
  "ingress_node_id": "node-venue-01",
  "ingress_listen_port": 9000,
  "egress_node_id": "node-hub-01",
  "egress_forward_addr": "127.0.0.1:9000",
  "relay_addr": "relay-primary.example.com:4433",
  "secondary_relay_addr": "relay-backup.example.com:4433",
  "secondary_relay_node_id": "relay-backup-node-id",
  "associated_flow_ids": ["flow-srt-main"]
}
```

`secondary_relay_addr` + `secondary_relay_node_id` are optional — omit both for a single-relay tunnel, include both for a redundant tunnel. The manager pushes the pair to each edge as an ordered `relay_addrs` array (primary first) so edges can fail over automatically. See [Redundant Relay Failover](#redundant-relay-failover) below.

#### List all tunnels

```bash
GET /api/v1/tunnels
```

Response includes node names for easy identification:
```json
{
  "tunnels": [
    {
      "id": "abc-123",
      "name": "venue-to-hub-srt",
      "protocol": "udp",
      "mode": "relay",
      "ingress_node_id": "node-venue-01",
      "ingress_node_name": "Venue Edge",
      "ingress_listen_port": 9000,
      "egress_node_id": "node-hub-01",
      "egress_node_name": "Hub Edge",
      "egress_forward_addr": "127.0.0.1:9000",
      "relay_addr": "relay-primary.example.com:4433",
      "secondary_relay_addr": "relay-backup.example.com:4433",
      "secondary_relay_node_id": "relay-backup-node-id",
      "status": "active",
      "associated_flow_ids": ["flow-srt-main"]
    }
  ]
}
```

#### List tunnels for a specific node

```bash
GET /api/v1/nodes/{node_id}/tunnels
```

#### Update a tunnel

```bash
PUT /api/v1/tunnels/{id}
Content-Type: application/json

{
  "status": "disabled"
}
```

#### Delete a tunnel

```bash
DELETE /api/v1/tunnels/{id}
```

## SRT over Tunnel - Step by Step

This is the most common use case: transporting an SRT stream between two edge nodes that are both behind NAT.

### Step 1: Deploy bilbycast-relay

Deploy `bilbycast-relay` on a cloud server with a public IP. The relay is stateless and requires no configuration:

```bash
# Run (no config needed -- relay is a stateless forwarder)
bilbycast-relay
```

Optionally specify listen addresses:

```bash
bilbycast-relay --quic-addr 0.0.0.0:4433 --api-addr 0.0.0.0:4480
```

### Step 2: Create the tunnel via Manager

Use the Manager UI or API to create a UDP tunnel:

```json
{
  "name": "venue-srt-main",
  "protocol": "udp",
  "mode": "relay",
  "ingress_node_id": "edge-venue-01",
  "ingress_listen_port": 9000,
  "egress_node_id": "edge-hub-01",
  "egress_forward_addr": "127.0.0.1:9000",
  "relay_addr": "relay-primary.example.com:4433",
  "secondary_relay_addr": "relay-backup.example.com:4433",
  "secondary_relay_node_id": "relay-backup-node-id"
}
```

(Omit `secondary_relay_addr` + `secondary_relay_node_id` for a single-relay deployment.)

### Step 4: Configure SRT flows

**On the venue edge (ingress):**
- SRT Output → Mode: Caller, Remote Address: `127.0.0.1:9000`
- The edge's tunnel subsystem picks up the traffic and sends it through the relay

**On the hub edge (egress):**
- SRT Input → Mode: Listener, Local Address: `127.0.0.1:9000`
- The edge's tunnel subsystem receives traffic from the relay and delivers it locally

### Step 5: Verify

- Check the relay health endpoint: `GET http://relay.example.com:4480/health`
- Check tunnel status: `GET http://relay.example.com:4480/api/v1/tunnels`
- Check flow status in the Manager UI - look for the amber Tunnel badge

## Node Network Type

Each node can be tagged with a network type to help the Manager UI suggest tunnels:

| Network Type | Description | Tunnel Needed? |
|---|---|---|
| `nat` (default) | Node is behind a NAT firewall | Yes, if communicating with another NAT node |
| `public` | Node has a public IP address | Direct mode possible, or no tunnel needed |
| `unknown` | Network type not determined | UI will suggest checking |

Set via the Manager API:
```bash
PUT /api/v1/nodes/{id}
{ "metadata": { "network_type": "nat" } }
```

## Redundant Relay Failover

A relay-mode tunnel can carry two relay addresses — a primary and a backup. The manager stores these as `relay_addr` (primary) and `secondary_relay_addr` (backup, with matching `secondary_relay_node_id` for topology tracking) and pushes them to both edges as an ordered `relay_addrs` array.

When the primary relay becomes unreachable, **each edge independently** detects the loss and reconnects via the backup:

- **Detection:** ~25 s of QUIC silence before the transport declares the primary dead (5 s keep-alive × 5 missed pings). This window is sized to tolerate Starlink satellite handovers and 4G/5G cell handoffs without flapping.
- **Failover:** after detection, the edge reconnects and walks to the next relay in the list. Each reconnect attempt is bounded to 6 s so a dead primary cannot stall the loop. **End-to-end failover budget is ~30–40 s** (the slower of the two edges sets total latency; they act independently).
- **Convergence:** if the two edges land on different relays initially, the first-to-bind sits in a `Waiting` state for up to 10 s, then steps forward — so the pair converges on whichever relay both can reach.
- **Failback:** a background probe measures the primary's RTT every 60 s. When the primary is healthy and its RTT is within 50 ms of the active backup, traffic fails back to the primary automatically. This RTT gate prevents returning to a reachable-but-degraded primary.
- **Events:** each failover emits a Warning event with `from_relay_addr`, `to_relay_addr`, `from_idx`, `to_idx` so the UI can surface the active leg.

This is not a *hitless* switchover — expect a ~30 s gap on the tunneled flow during failover. For hitless redundancy within a flow, use SMPTE 2022-7 dual-leg or SRT bonding end-to-end; tunnel-level redundancy only protects against relay-server failure, not network-path jitter.

Single-relay tunnels (no `secondary_relay_addr`) will simply reconnect to the same relay until it returns — there is no backup path.

## Security

- **End-to-end encryption**: All tunnel traffic is encrypted between edge nodes using ChaCha20-Poly1305 (AEAD) with a 32-byte shared key (`tunnel_encryption_key`). The manager generates a random key per tunnel and distributes it to both edges, encrypted at rest with AES-256-GCM
- **Stateless relay**: The relay has no authentication, no shared secrets, and no access control. It simply forwards encrypted traffic by tunnel UUID. This simplifies deployment and eliminates relay-side credential management
- **Tunnel ID security**: Tunnel IDs are 128-bit random UUIDs. Even if an attacker guesses a UUID, they cannot decrypt traffic (no key) or inject packets (AEAD tag verification fails)
- **QUIC with TLS 1.3**: Transport-level encryption between each edge and the relay
- **28 bytes overhead per packet**: 12-byte nonce + 16-byte authentication tag. TCP uses framing: [4-byte BE length][nonce+ciphertext+tag]. UDP encrypts payload before tunnel_id prefix encoding
- **SRT encryption**: When using SRT over a tunnel, SRT's own AES encryption provides an additional layer (defense-in-depth)
- **ALPN protocol separation**: Relay connections use `bilbycast-relay` ALPN; direct connections use `bilbycast-direct` ALPN

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Tunnel stays "pending" | Edges not connected to relay | Check relay address and firewall rules for QUIC (UDP port 4433) |
| High latency through relay | Relay server geographically distant | Deploy relay closer to the midpoint between venue and hub |
| Intermittent drops | QUIC keepalive timeout | Check network stability; relay sends keepalives every 15s |
| Decryption errors | Mismatched tunnel_encryption_key | Ensure both edges received the same key from the manager |
| "peer doesn't support any known protocol" | ALPN mismatch | Ensure edge and relay are using compatible versions |
