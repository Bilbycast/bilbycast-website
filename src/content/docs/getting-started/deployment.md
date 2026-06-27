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
| Manager web UI / REST / WS | 8443 | HTTPS / WSS | Port override `BILBYCAST_PORT`; bind addresses `BILBYCAST_LISTEN_ADDRS` (default `0.0.0.0,[::]` — dual-stack). |
| Manager ACME HTTP-01 challenge | 80 | HTTP | Only when `BILBYCAST_ACME_ENABLED=true`. Bind addresses `BILBYCAST_ACME_LISTEN_ADDRS` (default `0.0.0.0,[::]`). |
| Edge REST API + setup wizard + NMOS IS-04/05/08 | 8080 | HTTP / HTTPS | Override via `--port` / `--bind` (legacy single-addr) or `--bind-addrs` (comma-separated dual-stack). Config field `server.listen_addrs`. |
| Edge embedded monitor dashboard | 9090 | HTTP | Override via `--monitor-port`. Config field `monitor.listen_addrs` for dual-stack. |
| Edge Prometheus `/metrics` | 8080 | HTTP / HTTPS | Same listener as REST API |
| Edge media-protocol bind ports | _per-flow_ | varies | Set per input / output (SRT, RIST, RTP, UDP, RTMP, RTSP, HLS, WebRTC, ST 2110). Each accepts v4 or v6 via the per-input `bind_addr`. |
| Relay QUIC | 4433 | QUIC / UDP (TLS 1.3) | Override via `--quic-addr` (legacy) or `--quic-addrs` (comma-separated). Config field `quic_addrs` defaults dual-stack. |
| Relay native-UDP carrier | 4434 | UDP (plain) | Plain-UDP data plane for native SRT/RIST + bond legs over relay; on by default. Override via `--udp-relay-addrs`; disable via `--no-udp-relay`. Config field `udp_relay_addrs` defaults dual-stack. |
| Relay REST API | 4480 | HTTP | Override via `--api-addr` / `--api-addrs`. Config field `api_addrs` defaults dual-stack. |

**Dual-stack (IPv4 + IPv6) is on by default** across the manager, edge, and relay binaries. Each listener binds `0.0.0.0` and `[::]` simultaneously, with `IPV6_V6ONLY=1` on the v6 socket so the two families coexist on the same port. Operators with v6 connectivity get it automatically — point an AAAA record at the box alongside the A record. To restrict, set the relevant env var / config field to just `0.0.0.0` (v4 only), `[::]` (v6 only), or a specific interface address.

## Firewall

Open these in your firewall:

- **Manager host** — TCP 8443 inbound from operators' browsers and from every edge / relay site. TCP 80 inbound from the public internet only when using ACME.
- **Relay host** — UDP 4433 inbound from every edge that pairs through it; UDP 4434 inbound too if edges carry native SRT/RIST or bond legs over this relay. TCP 4480 only if you query its REST stats from the manager or your monitoring host.
- **Edge host** — typically only outbound: TCP 8443 to the manager and UDP 4433 (plus UDP 4434 for the native-UDP carrier) to the relay. **Inbound** is needed only for media protocols you've configured as listeners (SRT listener, RTSP server, WHIP server, etc.).

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
2. **Tier-1 broadcast-spec PCR_AC on TS outputs** (UDP / RTP / 302M) for contribution-grade decoders running with T-STD `PCR_AC` alarms enabled (Appear X10, Cobalt 9202, Cisco D9824). With PTP + `etf` qdisc + a HW-PTP NIC + `BILBYCAST_ENABLE_TXTIME=1` set on the edge, PCR_AC drops below 500 ns (T-STD spec).

For compressed TS feeding VLC, ffplay, OBS, web players, cloud receivers, or most professional decoders in standard tolerance mode, **you don't need any of this** — the edge's default `clock_nanosleep` wire-pacing tier handles compressed TS through 2 Gbps with sub-3 ms PCR_AC max on a commodity Linux NIC.

The full setup — install the ETF qdisc, persist it via the `bilbycast-etf-qdisc@.service` systemd unit, run `ptp4l` + `phc2sys`, opt the edge in via `BILBYCAST_ENABLE_TXTIME=1`, and the verification ladder — is in [Wire-Time Precision](/edge/wire-pacing/). For the deeper PTP integration story (lock states, NMOS clock advertising, what `ptp4l` management messages bilbycast polls), see [PTP integration](/edge/ptp/).

Quick install of `linuxptp` if you're going down that path:

```bash
sudo apt update && sudo apt install linuxptp   # Debian / Ubuntu
sudo dnf install linuxptp                      # RHEL / Fedora
```

If you're running compressed TS to VLC, ffplay, OBS, cloud receivers, or most professional decoders in standard tolerance mode — including 2022-7 dual-leg hitless on a single edge — **you can skip both pages**. The default install ships the userspace `clock_nanosleep` wire-pacing tier, which handles compressed TS through 2 Gbps with sub-3 ms PCR_AC max on commodity Linux — no qdisc, no PTP, no HW-PTP NIC required.
