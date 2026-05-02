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

## Optional — PTP for ST 2110 essence flows

If you're running SMPTE ST 2110-30 / -31 / -40 essence flows that need PTP timing, install `linuxptp` on each edge host:

```bash
sudo apt update && sudo apt install linuxptp   # Debian / Ubuntu
sudo dnf install linuxptp                      # RHEL / Fedora
```

The edge polls `ptp4l`'s management socket — it doesn't run a PTP slave in-process. A worked example, including a sample `ptp4l.conf` and a systemd unit, is in [PTP integration](/edge/ptp/#wiring-it-up). Skip this entirely if you're not running ST 2110 — `rtp_audio`, SRT, RTP/MP2T, RTMP, RTSP, HLS, WebRTC, and the `audio_302m` transport mode have no PTP requirement.
