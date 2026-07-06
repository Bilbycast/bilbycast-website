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

The capability is **off until you configure it** — this binary still behaves as a
pure forwarder unless you add the `distribution` block below.

## 2. Configure it

Add a `distribution` block to the relay's config:

```json
{
  "distribution": {
    "enabled": true,
    "http_addrs": ["0.0.0.0:4485", "[::]:4485"],
    "public_ip": "203.0.113.10",
    "public_base_url": "https://relay.example.com",
    "ingest_addrs": ["0.0.0.0:4486", "[::]:4486"],
    "token_secret": "<64 hex chars — the same value you set in the manager>",
    "require_viewer_token": false,
    "require_ingest_token": true,
    "max_viewers_per_ip": 256,
    "origin_window_segments": 8
  }
}
```

- **`public_ip`** — the relay's reachable IP, advertised to browsers so their
  WebRTC media can reach it. Required for viewers off the relay's own network.
- **`public_base_url`** — the HTTPS URL viewers use (see TLS below).
- **`token_secret`** — a shared 64-hex secret; set the same value on the manager
  (`distribution_token_secret` setting) so its minted viewer links validate.

### TLS / secure context

Browsers require a secure context, so **front the relay's HTTP listener
(`:4485`) with a TLS-terminating reverse proxy or load balancer** presenting a
CA-signed certificate on `public_base_url`'s hostname. (The WebRTC media path is
independently encrypted with DTLS/SRTP either way.)

## 3. Send a stream to it

**No edge changes needed.** On the edge's flow, add (or edit) a **WebRTC output**
in WHIP-client mode and point its endpoint at the relay:

```
https://relay.example.com/whip/<stream-name>
```

The edge's existing output does the H.264 + Opus encoding; the relay fans it out.

## 4. Share the viewer link

Viewers open, in any modern browser:

```
https://relay.example.com/watch/<stream-name>
```

That's a built-in player. For embedding in your own page, point a WHEP player at
`https://relay.example.com/whep/<stream-name>`. The relay caches the latest
keyframe, so late-joiners start playing immediately.

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
  serves nearby viewers. Configure a regional relay with a `cascade_sources`
  entry pointing at the origin's WHEP URL:

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
