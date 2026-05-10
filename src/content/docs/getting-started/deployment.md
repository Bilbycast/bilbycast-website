---
title: Deployment Overview
description: Where each component runs, what talks to what, and which ports to open.
sidebar:
  order: 2
---

This page is the high-level map of a bilbycast deployment. It covers the topology, the default ports, and where to read next for each component. For step-by-step install instructions, follow the per-product getting-started guides linked below.

## Topology

```
                       ┌──────────────────────┐
                       │   bilbycast-manager   │  TCP 8443 (WSS, HTTPS)
                       └─▲──────────▲─────────┘
                         │          │
                  outbound│          │outbound
                    WSS   │          │ WSS
                         │          │
   ┌─────────────────────┴──┐    ┌──┴────────────────────┐
   │ bilbycast-edge (Site A) │    │ bilbycast-edge (Site B) │
   └──────────┬──────────────┘    └─┬─────────────────────┘
              │                     │
              │ QUIC (UDP 4433)     │ QUIC (UDP 4433)
              │ outbound to relay   │ outbound to relay
              ▼                     ▼
            ┌────────────────────────┐
            │ bilbycast-relay         │ UDP 4433 (QUIC)
            └────────────────────────┘
```

All control connections are **outbound from edges and relays to the manager** over `wss://`, so devices behind NAT or restrictive firewalls don't need any inbound port. That's the whole point of the design.

## Recommended install order

1. **[Install the manager](/manager/getting-started/)** first — it's the central control plane. Edges and relays connect outbound to it once it's online.
2. **[Install the relay](/relay/getting-started/)** — only if your edges can't reach each other directly. Two edges on the same LAN, or edges on either end of a site-to-site VPN, don't need it.
3. **[Install one or more edges](/edge/getting-started/)** — each registers itself with the manager via the browser-based setup wizard.
4. **[Install Appear-X gateways](/appear-x-gateway/setup-guide/)** — only if you have Appear-X broadcast devices to bridge in.

If you'd rather build from source instead of using the pre-built tarballs, see [Build from source](/getting-started/build-from-source/).

## Default ports

| Service | Port | Protocol | Notes |
|---------|------|----------|-------|
| Manager web UI / REST / WS | 8443 | HTTPS / WSS | Override via `BILBYCAST_PORT` |
| Manager ACME HTTP-01 challenge | 80 | HTTP | Only when `BILBYCAST_ACME_ENABLED=true` |
| Edge REST API + setup wizard + NMOS IS-04/05/08 | 8080 | HTTP / HTTPS | Override via `--port` / `--bind` |
| Edge embedded monitor dashboard | 9090 | HTTP | Override via `--monitor-port` |
| Edge Prometheus `/metrics` | 8080 | HTTP / HTTPS | Same listener as REST API |
| Edge media-protocol bind ports | _per-flow_ | varies | Set per input / output (SRT, RIST, RTP, UDP, RTMP, RTSP, HLS, WebRTC, ST 2110) |
| Relay QUIC | 4433 | QUIC / UDP (TLS 1.3) | Override via `--quic-addr` |
| Relay REST API | 4480 | HTTP | Override via `--api-addr` |

## Firewall

Open these in your firewall:

- **Manager host** — TCP 8443 inbound from operators' browsers and from every edge / relay site. TCP 80 inbound from the public internet only when using ACME.
- **Relay host** — UDP 4433 inbound from every edge that pairs through it. TCP 4480 only if you query its REST stats from the manager or your monitoring host.
- **Edge host** — typically only outbound: TCP 8443 to the manager and UDP 4433 to the relay. **Inbound** is needed only for media protocols you've configured as listeners (SRT listener, RTSP server, WHIP server, etc.).

## Verifying the stack end-to-end

Once everything is up:

```bash
# Manager health
curl -k https://MANAGER-HOST:8443/health

# Edge health (locally)
curl http://EDGE-HOST:8080/health

# Relay health (only if running)
curl http://RELAY-HOST:4480/health
```

In the manager UI:

- `/admin/nodes` — every edge / relay should show **online** with a recent `last_seen`.
- The node detail page surfaces the **capabilities** the edge advertised (`replay`, `display`, `st2110-30`, …) and a **Resources** card with the per-host hardware probe.
- For a quick smoke test, see [Your first flow](/getting-started/first-flow/) — a localhost UDP loopback finishes in under five minutes.

## Optional — broadcast-grade wire-time precision (PTP + `etf` qdisc)

Two separate cases need this:

1. **SMPTE ST 2110 essence flows** that interoperate with other ST 2110 equipment require a shared PTP grandmaster.
2. **Broadcast-spec PCR_AC on TS outputs** (UDP / RTP / SRT / RIST / RTMP / 302M). Without PTP + the `etf` qdisc, the wire pacer's PCR accuracy lands at ~70 µs p50 with multi-millisecond p99 outliers — fine for VLC and casual receivers, **not** fine for broadcast-grade hardware decoders or multi-edge 2022-7 hitless. With PTP + `etf` + a hardware-PTP NIC, PCR_AC drops below 500 ns (T-STD spec).

The full setup — three steps (NIC selection, `etf` qdisc install, `ptp4l` config), the verification ladder, and the operator escape hatch — is in [Wire-Time Precision](/edge/wire-pacing/). For the deeper PTP integration story (lock states, NMOS clock advertising, what `ptp4l` management messages bilbycast polls), see [PTP integration](/edge/ptp/).

Quick install of `linuxptp` if you're going down that path:

```bash
sudo apt update && sudo apt install linuxptp   # Debian / Ubuntu
sudo dnf install linuxptp                      # RHEL / Fedora
```

If you're running a single edge for monitoring or operator preview only — not production-grade contribution / distribution — you can skip both pages. The default install ships ~70 µs p50 PCR_AC out of the box, which is enough for VLC, ffplay, OBS, and most prosumer receivers.
