---
title: Ports & Firewall
description: Every port a bilbycast-edge node binds or dials, which config field creates it, and how to write host firewall rules that don't break media ingest.
sidebar:
  order: 4
---

The installer does **not** configure a host firewall, and that is deliberate. An
edge is a media-transport box: nearly every inbound port it opens is an
*operator-defined* listener created and torn down as flows change. A blanket
`ufw default deny incoming` shipped by the installer would silently break ingest
the first time someone adds a listener-mode input, and there is no single port
policy that is right for every deployment.

One thing *is* universal, though, and it is the fact that shapes every rule you
write: **the edge's control plane is entirely outbound.** The node dials the
manager over `wss://` and dials the relay over UDP. The manager never connects
in. Management, telemetry, thumbnails, config push and remote upgrade all work
behind NAT with **zero inbound rules**. Inbound rules only ever concern media you
have chosen to receive.

## Ports with a fixed default

These are the node's own listeners and the services it dials on its own
initiative. They are the same on every edge.

| Port | Proto | Direction | What it carries | Present when |
|------|-------|-----------|-----------------|--------------|
| `8080` | TCP | Inbound | Local HTTP API, `/health`, `/metrics`, `/setup`, WHIP/WHEP signalling, `/x-nmos/**` | Always. Binds **loopback only** on a fresh node — see below |
| *(no default)* | TCP | Inbound | Monitor dashboard — a **second** HTTP server, separate from the API | Only when a `monitor` block is present. `monitor.listen_port` is required, not defaulted; examples use `9090` |
| `5353` | UDP (multicast) | In/out | mDNS-SD `_nmos-node._tcp`, advertising the API port above | Always — registered unconditionally at startup, not gated on any NMOS config |
| From the `wss://` URL — `443` if none is given | TCP | **Outbound** | Manager control plane (WebSocket) | Only with `manager.enabled: true`. The client dials `manager.urls[0]` and rotates through the rest on every close. A manager installed with defaults listens on `8443` |
| From `relay_addrs` — the relay's own default is `4433` | UDP | **Outbound** | QUIC or native-UDP tunnel to `bilbycast-relay` | Per tunnel with `mode: relay`, and per bond leg with `type: relay` |
| From `peer_addr` — whatever the far edge pinned as its `direct_listen_addr` | UDP | **Outbound** | Tunnel straight to the peer edge, no relay in the path | Per tunnel with `mode: direct` **and** `direction: egress` (the dialling side) |
| `443` | TCP | **Outbound** | Remote upgrade — manifest, cosign bundle and tarball. Manifest URLs are allowlisted to `github.com`, `release-assets.githubusercontent.com` and `objects.githubusercontent.com`; redirects are then followed to any `*.githubusercontent.com` host | Only while an `upgrade_binary` command is running |
| `319`, `320` | UDP | In/out | PTP (IEEE 1588). **Bound by `ptp4l`, not by the edge** — the edge reads PTP state from linuxptp's Unix socket at `/var/run/ptp4l` | ST 2110 / MXL hosts. See [Time (PTP)](/edge/ptp/) |
| `9200` | TCP | **Outbound** | Starlink dish gRPC (`get_status`), default host `192.168.100.1` | Only with `starlink_uplinks` configured |
| From `registry_url` | TCP | **Outbound** | NMOS IS-04 registration + 5 s heartbeat | Only with `nmos_registration.enabled: true` |
| From the router's base URL | TCP | **Outbound** | RutOS cellular telemetry (`POST /ubus` or the REST API) | Only with `cellular_uplinks` configured |

:::caution[8080 is loopback-only out of the box, and that is the intended posture]
A node with no config file — and any config built from the defaults — binds
`server.listen_addrs` to `["127.0.0.1", "[::1]"]`, and the API ships with auth
disabled. It is not reachable off-box at all. The edge is *managed* over the
outbound manager WebSocket, so nothing about normal operation needs this port
open.

Expose it only when you have a reason to, and enable `server.auth` at the same
time: `--bind-addrs 0.0.0.0,[::]` on the command line, or `server.listen_addrs`
in `config.json`. Otherwise reach it over an SSH port-forward.

The one deployment that genuinely must expose it is **NMOS**: IS-04, IS-05 and
IS-08 are nested on this same listener under `/x-nmos/**`, so a registry and a
controller both need to reach it. Port 5353 only carries discovery.
:::

## Media ports — operator-chosen, one per input or output

Every port in this table is whatever you put in the config field named. None of
them has a built-in default; the values shown are conventions, not fallbacks.

| Type | Config field | Proto | Direction | Notes |
|------|--------------|-------|-----------|-------|
| SRT input / output, `mode: listener` or `rendezvous` | `local_addr` | UDP | **Inbound** | Required in these two modes |
| SRT input / output, `mode: caller` | `local_addr` | UDP | Outbound | Optional; this is the **source** socket, not the destination. Defaults to `0.0.0.0:0` (ephemeral) |
| SRT socket-group bonding | `bonding.endpoints[].addr` | UDP | Both | Inbound on a listener group (each endpoint is a local bind), outbound on a caller group (each is a peer) |
| RTP input | `bind_addr` | UDP | **Inbound** | Unicast or multicast. `source_addr` selects SSM |
| UDP input | `bind_addr` | UDP | **Inbound** | Same shape as RTP |
| `rtp_audio`, ST 2110-30 / -31 / -40 / -20 input | `bind_addr` | UDP (usually multicast) | **Inbound** | ST 2110-23 binds one port per entry in `sub_streams[]` |
| SMPTE 2022-7 second leg (any of the above) | `redundancy.bind_addr` (RTP, RIST), `redundancy.addr` (ST 2110, `rtp_audio`), `redundancy.local_addr` (SRT) | UDP | **Inbound** | A separate rule; the Blue leg is usually a different subnet |
| RIST input | `bind_addr` | UDP | **Inbound** | **Two ports.** The port must be even — RTP lands on it and RTCP on **that port + 1**, derived, not configurable |
| RTMP input | `listen_addr` | TCP | **Inbound** | Conventionally `0.0.0.0:1935`. The field is required and has no default |
| WebRTC WHIP input (media) | `bind_addr` | UDP | **Inbound** | Optional. Unset means a kernel-chosen port — `0.0.0.0:0`, or `public_ip:0` when `public_ip` is set — which a static firewall rule cannot cover. Pin it when the publisher crosses a firewall |
| WebRTC WHIP input (signalling) | — | TCP | **Inbound** | Rides the API listener: `POST /api/v1/flows/{flow_id}/whip` |
| UDP / RTP / ST 2110 / `rtp_audio` output | `dest_addr`, optional `bind_addr` | UDP | **Outbound** | `bind_addr` pins the source socket only; it defaults to `0.0.0.0:0` |
| RIST output | `remote_addr`, optional `local_addr` | UDP | **Outbound** + return | Both ports must be even. The receiver's RTCP NACKs come **back** to `local_addr + 1`, so a stateful firewall must keep that flow open |
| RTSP input | `rtsp_url` | TCP (`transport: "tcp"`, the default) or UDP | **Outbound** | The edge is the RTSP **client**. `transport: "udp"` additionally receives RTP on kernel-chosen ephemeral ports |
| WHEP input, WHIP-client output, RTMP output | `whep_url` / `whip_url` / `dest_url` | TCP + UDP | **Outbound** | All dial out. RTMP conventionally lands on 1935 at the far end |
| WHEP-server output (media) | — | UDP | **Inbound** | Binds port `0` (`0.0.0.0:0`, or `public_ip:0` when `public_ip` is set) — **ephemeral, and there is no field to pin the port**. Not firewall-friendly; reach browser viewers through the relay's [viewer distribution](/relay/viewer-distribution/) instead |
| HLS output, CMAF output | `ingest_url` | TCP | **Outbound** | Both are **push** outputs: artefacts are HTTP `PUT` to the ingest URL. The edge does not serve HLS or CMAF to pulling clients |
| Bonded leg, `type: "udp"` | `bind` / `remote` | UDP | Both | `bind` is mandatory on a bonded **input** (the receive side) and optional on a bonded output |
| Bonded leg, `type: "rist"` | `local_bind` / `remote` | UDP | Both | Required in `receiver` role. Even port, plus **that port + 1** for RTCP |
| Bonded leg, `type: "quic"` | `addr` | UDP | Both | A bonded **input** leg is always the QUIC server and binds `addr`; a bonded **output** leg is always the client and dials it. The `role` field in config is ignored |
| Bonded leg, `type: "relay"` | `relay_addrs[]` | UDP | **Outbound** | Dials out from an ephemeral local port — no inbound rule. This is the reason to prefer relay legs when the receiving edge is behind NAT |
| Tunnel, `direction: egress` | `local_addr` | TCP or UDP | **Inbound** | The tunnel's local ingest socket. Usually loopback or a trusted LAN address, but it *is* a bind |
| Tunnel, `mode: direct`, `direction: ingress` | `direct_listen_addr` | UDP — QUIC by default, plain UDP with `transport: "udp"` | **Inbound** | The only tunnel mode that requires an inbound rule, and only on one side |

Types that bind **nothing**: `sdi`, `mxl_video` / `mxl_audio` / `mxl_anc`,
`display`, `media_player`, `replay`, `test_pattern`, and `mosaic` (a multiviewer
wall composites node-local inputs and publishes as an ordinary flow source, so
its ports are its flow's outputs).

## Three deployment shapes

### 1. Caller / push everywhere — zero inbound

Configure every input in a connecting mode (SRT caller, RTSP pull, WHEP client,
bonded relay legs) and every output as a push. The node then only ever
*originates* connections.

- **Inbound:** none.
- **Outbound:** the manager's `wss://` port, plus whatever your sources and
  destinations listen on.
- Firewall: `default deny incoming`, `default allow outgoing`. Done.

This is the right shape for an edge on the public internet or in a hostile
network. Prefer it whenever the far end can listen.

### 2. Listener-mode inputs — open exactly the ports you bind

When a source can only push to you, the edge binds a listener the source must
reach. Open **those ports and nothing wider**, scoped to the source CIDR
wherever you can. Do not open a range "to be safe" — every open port is attack
surface, and the list is short and knowable (see [Deriving the list from a
running config](#deriving-the-list-from-a-running-config)).

### 3. Relay tunnels — the inbound surface belongs to the relay

With `mode: relay`, two edges meet through a stateless relay. Both dial out;
neither needs an inbound media rule. Use it when both ends are behind NAT.

`mode: direct` is the alternative, and it requires *one* side to be reachable —
that side needs an inbound rule for `direct_listen_addr`.

## A worked example

A contribution edge behind NAT: one SRT listener input on 9000, a UDP multicast
output to the local plant, and a manager on the public internet.

```json
{
  "version": 2,
  "server": { "listen_addr": "127.0.0.1", "listen_port": 8080 },
  "manager": { "enabled": true, "urls": ["wss://manager.example.tv:8443"] },
  "inputs": [
    {
      "id": "in-camera-a",
      "name": "Camera A",
      "type": "srt",
      "mode": "listener",
      "local_addr": "0.0.0.0:9000",
      "latency_ms": 200
    }
  ],
  "outputs": [
    {
      "id": "out-plant",
      "name": "To plant",
      "type": "udp",
      "dest_addr": "239.20.1.5:5004",
      "dscp": 46
    }
  ],
  "flows": [
    {
      "id": "flow-main",
      "name": "Camera A to plant",
      "input_ids": ["in-camera-a"],
      "output_ids": ["out-plant"]
    }
  ]
}
```

`manager.enabled` is **not** implied by `manager.urls` — it defaults to `false`, and
the client is only spawned when it is `true`.

That config needs exactly one inbound rule. With `ufw`:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
# SRT listener input "Camera A" — scope it to the encoder's public IP.
sudo ufw allow from 203.0.113.40 to any port 9000 proto udp comment 'bilbycast SRT in'
sudo ufw enable
```

The same thing in `nftables`:

```
table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif lo accept
    # SRT listener input "Camera A".
    ip saddr 203.0.113.40 udp dport 9000 accept
  }
}
```

Note what is **not** in either ruleset:

- No rule for the manager. The edge dials `manager.example.tv:8443` outbound;
  the reply arrives on the established connection.
- No rule for the UDP output. It is a send.
- No rule for port 8080. It is bound to loopback, and nothing off-box needs it.

Add a RIST listener input on `0.0.0.0:6000` to that config and the rule set
grows by **two** ports, not one:

```bash
sudo ufw allow from 203.0.113.41 to any port 6000:6001 proto udp comment 'bilbycast RIST in'
```

## Deriving the list from a running config

Rather than guessing, read the ports out of the node's own `config.json`. Field
names differ per input type, so match on `type`:

```bash
jq -r '
  .inputs[]
  | if   .type == "rtmp" then "rtmp\ttcp\t\(.listen_addr)"
    elif .type == "srt"  then
      (if .mode == "listener" or .mode == "rendezvous"
       then "srt\tudp\t\(.local_addr)" else empty end)
    elif .type == "rist" then "rist\tudp\t\(.bind_addr)  (+1 for RTCP)"
    elif .type == "bonded" then
      ( .paths[].transport
        | "bonded/\(.type)\tudp\t\(.bind // .local_bind // .addr // "outbound only")" )
    elif has("bind_addr") then "\(.type)\tudp\t\(.bind_addr)"
    else empty end
' config.json
```

```
rtmp		tcp	0.0.0.0:1935
srt		udp	0.0.0.0:9000
rist		udp	0.0.0.0:6000  (+1 for RTCP)
udp		udp	239.1.1.1:5004
bonded/udp	udp	0.0.0.0:7000
bonded/quic	udp	0.0.0.0:7100
bonded/relay	udp	outbound only
```

Add `.inputs[].redundancy` and `.tunnels[]` by hand — a 2022-7 second leg and a
`direct_listen_addr` both bind too. Treat the output as a checklist and confirm
each line against [Configuration](/edge/configuration/).

## Things that catch people out

- **RIST always costs two ports.** `bind_addr` must be even; RTCP binds that
  port + 1. The `+1` is derived in the transport and is not configurable, on
  both the `rist` input type and a bonded `rist` leg.
- **An input that belongs to no flow still binds its port.** At node start, every
  listener-type input not referenced by an enabled flow gets a *standby* socket —
  SRT listener, RTP, UDP, RIST, RTMP, `rtp_audio` and ST 2110-20/-30/-31/-40
  (ST 2110-23 is excluded) — so the manager can show "listening" / "bound"
  without a running flow. Existing in `config.json` is enough; the port list you
  must open is the input list, not the flow list.
- **SMPTE 2022-1 FEC needs no extra rule.** FEC packets are queued onto the same
  wire-emit instance as the media, so they leave the same socket for the same
  destination port.
- **HLS and CMAF are push, not pull.** Both `PUT` to `ingest_url`. Nobody fetches
  a playlist from the edge — if you want viewers pulling, that is the relay's
  [viewer distribution](/relay/viewer-distribution/) role.
- **WHEP-server outputs cannot be pinned.** The media socket always binds port
  `0` (`0.0.0.0:0`, or `public_ip:0` when `public_ip` is set). Only the WHIP
  *input* has a `bind_addr`.
- **RTSP defaults to TCP interleaving**, which is what you want through a
  firewall. `transport: "udp"` gives lower latency and adds ephemeral RTP/RTCP
  ports that no static rule can cover.
- **mDNS is always on.** The `_nmos-node._tcp` advertisement is registered at
  startup regardless of NMOS configuration, so the node joins the 5353 multicast
  group on every boot.
- **Multicast is not just a firewall question.** A multicast `bind_addr` triggers
  an IGMP/MLD join; `source_addr` makes it source-specific (IGMPv3). Switch and
  router configuration matters at least as much as the host rules.

## When a bind fails

A port that is already taken is not a silent failure. The edge emits a Critical
event with a stable `error_code` in `details` — `port_conflict` for `EADDRINUSE`,
`bind_failed` for anything else — carrying `component`, `addr` and `protocol`,
and the same code rides back on `command_ack.error_code`. Both show up on the
manager's Events page. The manager also preflights new inputs and outputs against
already-managed entities and rejects a collision with HTTP 422 before any
WebSocket round-trip.

See [Events & Alarms](/edge/events-and-alarms/) for the full catalogue.

## See also

- [Configuration](/edge/configuration/) — every field named above, in schema form.
- [API Reference](/edge/api-reference/) — what lives on the 8080 listener, and its auth model.
- [Setup Wizard](/edge/setup-wizard/) — first-boot provisioning over loopback or an SSH tunnel.
- [IP Tunneling](/manager/ip-tunneling/) — relay vs direct tunnels and how the manager provisions them.
- [Multi-Path Bonding](/edge/bonding/) and [Bonding Network Setup](/edge/bonding-network-setup/) — per-leg binds, NIC pinning and gateway-mode routing.
- [Security](/security/) — the wider trust model.
