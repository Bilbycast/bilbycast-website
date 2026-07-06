---
title: Viewer Distribution (WHEP + LL-HLS)
description: Reach browser viewers natively from a bilbycast relay — a WHEP SFU for sub-second WebRTC plus an LL-HLS/CMAF origin for CDN-scale audiences, with no external streaming server.
sidebar:
  order: 3
---

A relay can optionally act as a **viewer-distribution node** — reaching web
browsers directly, with **no external WHIP/WHEP server** (mediamtx, LiveKit,
Cloudflare Stream, …) and **no ports opened on your edge**. It offers two
complementary tiers:

| Tier | How viewers watch | Latency | Scale | Use it for |
|------|-------------------|---------|-------|-----------|
| **WHEP SFU** | WebRTC in any browser | sub-second | ~hundreds–low-thousands per relay (cascade beyond) | interactive, betting-grade, bounded audiences |
| **LL-HLS origin** | HLS/DASH via a CDN | 1–5 s | millions (HTTP caching) | one-to-many web audiences at scale |

Your edge already produces both formats — choose per audience; they are not
either/or.

## Why the relay does this

Edge nodes sit behind NAT and often run on limited (≈3 Mbps cellular) uplinks,
so they cannot send a separate copy to every viewer. The relay is already
public, already manager-controlled, and already deployed — so the one-to-many
fan-out happens there, and your edge only ever sends **one** stream out.

```
 Edge  ──WHIP (H.264 + Opus)──►  Relay  ──WHEP──►  browsers   (sub-second)
  (existing WebRTC output)         │      LL-HLS ──► CDN ──► browsers (1–5 s)
```

## 1. Install a distribution-capable relay

The capability ships in the **`-distribution`** release variant (it bundles the
WebRTC stack). Download it instead of the plain forwarder binary:

```bash
curl -fsSL -o bilbycast-relay \
  "https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/bilbycast-relay-$(uname -m)-linux-distribution"
chmod +x bilbycast-relay
```

Run it (or install it as a service). It comes up **idle and secure** and is
configured entirely from the manager — no config-file editing.

### TLS / secure context

Browsers require a secure context, so **front the relay's HTTP listener
(`:4485`) with a TLS-terminating reverse proxy or load balancer** presenting a
CA-signed certificate on the relay's hostname, and use that `https://` hostname
as the public base URL below. (The WebRTC media path is independently encrypted
with DTLS/SRTP either way.)

## 2. Configure it from the manager

On the relay's detail page, open **Configure distribution** and set:

- **Public IP** — the relay's reachable IP (advertised to browsers so their
  WebRTC media can reach it).
- **Public base URL** — the `https://` hostname viewers use.
- **Require ingest token** (recommended on) / **Require viewer token** (off =
  public streams).
- **Cascade sources** — optional, for scale-out (see below).

Click **Save + push to relay**. The manager generates a shared token secret (or
use the one on the Settings page), stores your config, and pushes it to the
relay. The relay applies it live and remembers it across restarts — you never
edit the relay's `config.json`.

## 3. Send a stream to it — one click

**No edge changes needed.** On the edge flow, add a **WebRTC output**, and in the
WHIP-client fields use **"Distribute via a bilbycast relay"**: pick your
distribution relay, type a stream name, and click **Fill from relay**. The
manager mints the tokens, fills in the WHIP URL + token, and shows you a
shareable viewer link. Save the output — the edge starts pushing to the relay,
which fans it out to browsers.

## 4. Share the viewer link

The **Fill from relay** step gives you a copyable link like:

```
https://relay.example.com/watch/<stream-name>
```

Open it in any modern browser — that's a built-in player. For embedding in your
own page, point a WHEP player at `https://relay.example.com/whep/<stream-name>`.
The relay caches the latest keyframe, so late-joiners start playing immediately.

The relay's detail page in the manager shows a **Viewer Distribution** card with
live viewer counts, active streams, and bytes served.

### Access control

By default streams are **public** (anyone with the link can watch). To gate
them, set `require_viewer_token: true` and have the manager mint short-lived
viewer links via `POST /api/v1/nodes/{relay}/distribution/streams` — the returned
`watch_url` carries a signed, expiring token.

## Scaling to large audiences

A single relay serves roughly **hundreds to low-thousands** of concurrent WHEP
viewers before its uplink or CPU saturates. Beyond that:

- **WHEP cascade** — deploy additional *regional* relays that pull the stream
  from an *origin* relay and re-fan-it-out locally. Each regional relay is
  simply a WHEP client of the origin, so an origin feeds N regionals and each
  serves nearby viewers. Add cascade sources from the regional relay's
  **Configure distribution** panel in the manager (one line per source:
  `local_stream  http://origin-relay:4485/whep/stream`), or in config:

  ```json
  {
    "distribution": {
      "enabled": true,
      "cascade_sources": [
        { "upstream_whep_url": "http://origin-relay:4485/whep/big-game",
          "local_stream": "big-game",
          "token": "<origin viewer token, if the origin is gated>" }
      ]
    }
  }
  ```

  Viewers then watch `https://<regional-relay>/watch/big-game`. Point each
  viewer at the nearest regional relay (automatic geo assignment is a planned
  manager enhancement).

- **LL-HLS** — front the relay's origin (`/origin/<stream>/…`, fed by the edge's
  CMAF output) with any CDN. This inherits HTTP caching and scales to millions
  with zero per-viewer state, at the cost of a few seconds of latency.

There is no "unlimited viewers, no extra infrastructure" — very large audiences
need either a relay cascade (WebRTC) or a CDN (LL-HLS).
