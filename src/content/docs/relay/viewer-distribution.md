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
WebRTC stack). Use the release installer rather than the bare binary — it
verifies the signed manifest, unpacks the distribution **tarball** and installs
the systemd unit:

```bash
curl -fsSL https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/install-relay.sh \
  | sudo bash -s -- \
      --manager wss://manager.example.com/ws/node \
      --registration-token <token-from-the-manager-UI> \
      --with-portal https://manager.example.com \
      --player-origin https://relay.example.com
```

`--with-portal` also installs **`bilbycast-portal`**, the sign-in viewer portal
([below](#the-viewer-portal)). It is a second binary that ships **only inside
the distribution tarball** — the bare
`bilbycast-relay-$(uname -m)-linux-distribution` file published alongside it
carries the relay and nothing else, so a plain `curl` of that binary cannot
give you a portal. `--player-origin` is the relay's own public origin, and it
is what lets the DVR player renew a viewer's token in the background; leave it
out and a portal viewer's access ends three hours in, mid-event, with nothing
reported at either end.

The relay comes up **idle and secure** and is configured entirely from the
manager — no config-file editing. The portal is installed but deliberately
*not* started: it needs a service token you generate in the manager first
(DVR Sessions → Portal logins), and one started without it refuses every
viewer.

### TLS / secure context

Browsers require a secure context, so **front the relay's HTTP listener
(`:4485`) with a TLS-terminating reverse proxy or load balancer** presenting a
CA-signed certificate on the relay's hostname, and use that `https://` hostname
as the public base URL below. (The WebRTC media path is independently encrypted
with DTLS/SRTP either way.)

## 2. Configure it from the manager

On the relay's detail page, click **Configure →** on the Viewer Distribution
card (or open the relay's **Configure** page and pick the **Distribution** tab).
Set:

- **Public IP** — the relay's reachable IP (advertised to browsers so their
  WebRTC media can reach it). The form suggests the address the manager already
  observed for the relay — click to accept it. It must be a routable IP, not a
  hostname or a private/LAN address; the readiness panel flags either.
- **Public base URL** — the `https://` hostname viewers use. The readiness panel
  shows a hard warning if it isn't `https://`, because browsers silently refuse
  WebRTC and playback from a non-secure origin — the most common "it just doesn't
  work" trap. The form suggests the URL the relay already advertises.
- **Viewer portal URL** — optional, and the label undersells it. It is offered
  to a viewer as "sign in again" when their token runs out, *and* it is what
  arms background token renewal in the DVR player: leave it blank and a
  portal viewer's three hours become a hard limit, silently. Must start with
  `http://` or `https://`.
- **Require ingest token** (recommended on) / **Require viewer token** (off =
  public streams). Each shows the consequence of the choice inline.
- **Cascade sources** — optional, for scale-out (see below). Add one structured
  row per source; the form validates each and warns if a source points back at
  this relay (a cascade loop).

The **Readiness** panel at the top of the form is a live checklist (secure
context, routable public IP, token secret, relay online) so you can see whether
viewers will actually be able to connect before you walk away.

Click **Save + push to relay**. The manager generates a shared token secret (or
use the one on the Settings page), stores your config, and pushes it to the
relay. The relay applies it live and remembers it across restarts — you never
edit the relay's `config.json`. If the relay is momentarily offline the config
is stored and applied automatically on reconnect (the result line tells you
which happened). A **Get a viewer link** helper on the same page mints a
shareable `…/watch/{stream}` link and shows you its expiry so you don't hand out
a link that stops working before the event.

This tab does not own the whole distribution config. The origin token gate and
the origin's retention policy have no control here — they are pushed by the
manager's DVR-session machinery instead, per stream, and are described under
[Origin storage and retention](#origin-storage-and-retention). Both routes send
the same `configure_distribution` command and merge into what the relay already
holds, so saving this tab does not clear them.

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

:::caution[`require_viewer_token` gates WHEP only]
`GET /origin/<stream>/<file>` — the LL-HLS / CMAF tier described under
[Scaling to large audiences](#scaling-to-large-audiences) — has a gate of its
own, **`require_origin_token`, and it is off by default**. That default is
deliberate: the origin is the CDN-facing half of the surface, and a CDN pulls
it with no credential of the relay's. So on a relay left at the defaults the
viewer gate is bypassable by fetching
`https://relay.example.com/origin/<stream>/index.m3u8` directly — do not read
"viewer token required" as "this stream is not readable without a credential".

Set `require_origin_token: true` to close that. The origin GET then takes the
same viewer token WHEP does, as `Authorization: Bearer` or `?token=`, and is
checked before the store is touched so a refusal cannot be used to probe which
streams exist. When the credential arrives as `?token=` on a playlist the relay
rewrites that playlist's own URIs to carry it, so native HLS (Safari, iOS —
which cannot set a header on a segment fetch) keeps playing behind the gate.
With no `token_secret` in place a gated request answers `500` rather than
opening.

**The manager turns it on for you when a DVR session exists.** Every push a DVR
session makes carries `require_origin_token: true`, and it stays on after the
last session on that relay stops — turning it back off would briefly open every
stream still on disk.

Leave it off only for an origin a CDN pulls, and restrict that listener at the
network or reverse-proxy layer instead.

The write surfaces are gated separately, by `require_ingest_token` (default
**on**), which covers both the WHIP offer and the edge's `PUT` to the origin.
:::

A viewer token may be presented either as `?token=…` on the URL or as an
`Authorization: Bearer` header; the header is checked first, so an explicit
credential always outranks a URL. The built-in `/watch/<stream>` player reads
the query form off its own URL and forwards it as a header.

:::note[Prefer the header form for anything long-lived]
The relay's HTTP listener is plain HTTP by design and expects a
TLS-terminating proxy in front — and every default proxy access-log format
(nginx `$request`, Apache `%r`, HAProxy, ALB, CloudFront) records the full
request line, query string included. Viewer tokens are stateless with **no
revocation path** and the manager's default TTL is **6 hours**, so a token
lifted from a proxy log or from browser history is replayable against a live
feed for that long. Mint a short `ttl_secs` for query-form links, use the
`Authorization: Bearer` form for programmatic clients, and strip `token` from
the query in your proxy's log format if you can.
:::

Portal-issued tokens are the other half of that picture: they last **3 hours**,
the player renews them in the background, and the manager re-checks entitlement
before signing each renewal — so for a portal viewer the short expiry is
revocation latency rather than a countdown. It does not give a manager-minted
link token a revocation path; that one stays replayable for its full TTL. See
[The viewer portal](#the-viewer-portal).

## Browser DVR player

The relay serves a second, very different player at `GET /dvr/{stream}`. Where
`/watch` is WHEP — sub-second, but live-only, with no buffer, no seekable range
and no `playbackRate` — `/dvr` plays the **LL-HLS origin**, so it can seek back
across the retained window and step single frames. Seek depth is therefore
whatever `origin_retention_secs` is holding: the 60 s default is a live-only
figure, and a DVR surface wants it raised (see
[Origin storage and retention](#origin-storage-and-retention)).

### Two renditions

The page expects a **pair** of streams and treats them as one thing being
watched:

| Rendition | Origin path | Encoding | Used for |
|---|---|---|---|
| main | `{stream}` | long-GOP | live, the 33 / 50 / 100 % speed presets, frame jog, and the still after a scrub |
| proxy | `{stream}-proxy` | low-resolution **all-intra** | shuttle, reverse, and the picture *while* a scrub thumb is held |
| thumbnails | `thumbs.vtt` + sprite sheets | JPEG sprites | the preview under the thumb while dragging (the player no-ops without it) |

**One viewer token covers both.** A token minted for `show` also admits
`show-proxy`; the converse does not hold, so handing someone the low-resolution
rendition does not hand them the full-resolution one. The rendition suffix list
is closed (`-proxy`), which has one consequence worth knowing: an unrelated
stream literally *named* `show-proxy` is readable with a `show` token.

### Controls

Live/scrub toggle, forward playback at 33 %, 50 % and 100 %, fast-forward and
rewind cycling 2x → 4x → 8x → 16x on repeated presses, single-frame jog either
way, marks (tap to set, prev/next to skip, hold for the list), a zoomable
timeline, a scrub-preview thumbnail, a time-of-day readout of the moment the
frame was ingested, full screen, mute and a settings drawer. Keyboard: `J`/`L`
shuttle, `K` stop, `,`/`.` frame step, `Space` play/pause, `End` live, `F` full
screen, `M` mark, `[`/`]` previous/next mark.

### Picture modes

Settings offers three points on a bandwidth curve — the rates measured on one
live feed:

| Mode | Moving | Stopped | Continuous rate |
|---|---|---|---|
| **Full** (default) | 1080p | 1080p | ~9.3 Mbit/s |
| **Balanced** | 640x360 | **1080p** | ~3.1 Mbit/s, plus ~2 MB each time you stop |
| **Low** | 640x360 | 640x360 | ~3.1 Mbit/s |

In both reduced modes the low-resolution rendition *is* the moving picture, so
nothing decodes it twice: in Low the second video element carries no source at
all, and in Balanced it is attached only to fetch the full-resolution still once
you stop. Shuttle and scrub work in all three, because the proxy is all-intra.
The choice is remembered per feed on that device and takes effect on reload.

### Query parameters

| Parameter | Effect |
|---|---|
| `?main=` | Override the main rendition's stream name (default `{stream}`) |
| `?proxy=` | Override the proxy rendition (default `{stream}-proxy`) |
| `?token=` | Viewer token — needed only when `require_origin_token` is on |
| `?fps=` | Frame-step size (default `25`) |
| `?debug=1` | Diagnostic overlay: stream, buffer and decode state |
| `?selftest=1` | Open the self-test panel on load (below) |

The page does not leave the credential in the URL: under MSE it re-attaches it
as a Bearer header on every request and strips the query parameter with
`history.replaceState`, keeping the token for the life of the tab so a reload
still works. Native HLS keeps the query form, because it cannot set a header.
`/dvr/hls.js` is a **vendored** copy of hls.js served by the relay itself with a
long immutable cache — not a CDN pull, so the player has no third-party
dependency at play time.

### Self-test on the viewer's own device

`GET /dvr/{stream}?selftest=1` — also reachable from Settings → **Run the player
self-test** — answers the question a workstation measurement cannot: whether the
device in the viewer's hands can actually present this feed. It runs on a
deliberate tap, takes about a minute, and prints plain text an operator can read
off the screen or photograph. Four measurements:

1. **Shuttle rate inside the buffer** — 50 seeks in 2 s, main then proxy, then
   both again in the reverse order so warming cannot favour whichever went
   first. Frames are counted as *presented*, not as sought.
2. **Scrub preview across the bar** — 20 positions, split into shown, past the
   newest sprite sheet (expected at the live edge) and covered-but-blank
   (should be zero).
3. **Dragging the bar** — 40 moves through the real handlers, which is the only
   way to see whether the handover to the proxy fires at all.
4. **Token renewal** — exercises the renewal path against the current token's
   expiry rather than waiting out the clock.

## The viewer portal

A gated feed has two ways in. The **link** is issued per session from the
manager and is revocable — right for a one-off guest. The **portal** is the
login, right for staff who watch regularly and for whom issuing and chasing
links is the worse job. Neither replaces the other.

`bilbycast-portal` is a second binary that runs beside the relay and ships only
inside the distribution tarball
([install it with `--with-portal`](#1-install-a-distribution-capable-relay)). A
viewer signs in through your identity provider, sees the feeds they are entitled
to, clicks one, and lands in the DVR player with a token that admits that feed
and nothing else.

**It holds no secret and stores no state.** It does not sign tokens — it asks
the manager to mint one, and the manager re-checks the entitlement before it
does. It does not hold entitlements — it asks the manager on every page load, so
withdrawing someone's access takes effect on their next click rather than on the
next successful push to a box that might be unreachable. And it is not the
relay: separate binary, separate unit, separate user, because a bug in a
public-facing web page must not be able to take the box's media termination with
it.

### The trust boundary

The portal authenticates nobody. It learns who you are from a header —
`Remote-User` by default, `username_header` to change it — that your
forward-auth proxy sets once it has authenticated the viewer. **That header is a
claim, not a proof**, so two settings hold the boundary and both fail closed:

- `listen_addr` defaults to `127.0.0.1:8088`, so the proxy on the same host is
  the only thing that can reach the port.
- `trusted_proxies` names the peers whose header is believed, and defaults to
  loopback only. An **empty list means nobody**, never "any" — the portal
  refuses to start rather than treat it as a wildcard.

The peer address is checked before the header is read. Moving the portal off
loopback is supported — the proxy may legitimately be on another host — but it
warns at startup, because `trusted_proxies` is then the only thing left holding
the boundary.

The service token it calls the manager with comes from `BILBYCAST_PORTAL_TOKEN`
rather than the config file, so it can live in a systemd `EnvironmentFile` with
its own permissions. `logout_url` is optional: the portal cannot end a session it
never started, so the most it can do is send the viewer to the identity
provider's own logout — unset, no button is offered, which beats one that
appears to work.

### Background token renewal

A portal-minted token lasts **3 hours**, which does not cover a match plus its
build-up, and the failure lands mid-second-half. So the player renews itself
about **ten minutes before expiry**, calling `GET /api/renew?stream=…` on the
portal. That renewal goes back through the manager exactly as the first mint did
and **the manager re-checks entitlement before it signs** — which is what makes
the short expiry revocation latency rather than a countdown.

Renewal needs two settings on two different services, and either one missing
disables it **silently**:

- **On the relay** — `distribution.portal_url`, the manager's **Viewer portal
  URL** field. Blank, and the player schedules no renewal at all, however the
  portal is configured.
- **On the portal** — `player_origins` must name the origin the player is served
  from, exactly. Renewal is a cross-origin request carrying the viewer's session
  cookie, which is the shape a CSRF wants, so the list is explicit, **empty
  means nobody**, and `*` is refused at startup because a response carrying
  `Access-Control-Allow-Credentials` may not answer a wildcard origin.

`install-relay.sh --player-origin https://relay.example.com` writes the second
one for you.

## Origin storage and retention

The LL-HLS origin is disk-backed, and the window it holds is what a DVR viewer
can seek across. The knobs, with the defaults a relay starts on:

| Field | Default | What it does |
|---|---|---|
| `origin_storage_dir` | `/var/lib/bilbycast/relay/origin` | Where segments are written. **Adopted** on startup rather than wiped, so a restart costs a segment or two instead of the whole DVR depth. Give it a directory of its own — everything under it becomes evictable, and a non-empty directory carrying no `.bilbycast-origin` marker is refused rather than adopted. |
| `origin_retention_secs` | `60` (bounds `1`–`86400`) | **DVR seek depth.** Size it to the window the edge advertises in its playlist *plus headroom*; retaining less produces 404s on seek for anyone parked mid-window. 60 s is a live-only default — a scrub-back surface wants minutes to hours. |
| `origin_max_bytes_per_stream` | 8 GiB (min 16 MiB) | Safety bound, not policy: a bitrate spike must not fill the volume just because retention has not elapsed. Hitting it evicts oldest-first and silently shortens the window. |
| `origin_window_segments` | `8` (bounds `1`–`64`) | A **floor**, not the window — the minimum recent segments kept whatever the two above say. It stops a stalled or very-low-bitrate stream having its window aged out from under a live player. |
| `origin_idle_grace_secs` | `60` (max 86400) | How long past retention a stream may sit with no `PUT` before it is reclaimed outright — segments, manifest, init and directory. |
| `origin_min_free_bytes` | 5 GiB (`0` disables; otherwise 16 MiB–1 TiB) | Free-space floor on the volume. |

Two of those deserve more than a table row.

**`origin_storage_dir` and `origin_min_free_bytes` are the two the manager
cannot set** — a push can change only the four rows between them.
`origin_min_free_bytes` is read from the relay's config file, never from a
push, and deliberately so: the manager sizes retention from the window an
operator asked for and cannot see this relay's disk, because no health payload
reports free space. So the relay is what
has to refuse. Its sweep evicts **oldest-first across every stream**, which means
one stream filling the volume shortens every DVR window on the box rather than
ending one session to save another. A value outside the bounds is fatal at
startup rather than clamped — a floor of `5` bytes (meaning 5 GiB) reads as
configured while never being able to refuse anything.

**Retention is manager-owned at runtime, and settable per stream.** The four
policy values above are only the node's starting point; `configure_distribution`
carries a live node-wide replacement plus per-stream overrides keyed by stream
id:

```json
{
  "origin_policy": { "retention_secs": 3900 },
  "origin_stream_policies": {
    "match-feed":       { "retention_secs": 7200 },
    "match-feed-proxy": { "retention_secs": 7200 }
  }
}
```

Every field inside a policy is optional, and a per-stream entry layers **on top
of** the resolved node default rather than replacing it — so an override naming
only `retention_secs` still inherits the byte bound and the segment floor. That
is what makes a long window on one feed possible without taxing the whole node.
Three behaviours to plan around:

- `origin_stream_policies` **replaces the whole override set** on each push, so
  an empty object clears every override. A merge would leave an ended session's
  window in force for the life of the relay, holding that stream's disk with
  nothing on any surface to say why.
- Only the **node-wide** default is persisted into the relay's config file.
  Per-stream overrides are session-lifetime and do not survive a relay restart.
- The relay must advertise the **`origin-policy`** capability or the manager
  refuses the push outright. An older relay applies the keys it recognises and
  ignores the rest, so it would ack a retention policy and hold none of it — the
  manager declines rather than recording a success it cannot see is false. A
  `drop_origin_streams` list rides the same command and retires named streams
  outright; the manager sends one when a session is **deleted**, so its disk
  comes back then rather than whenever the node default happens to expire.

**Sizing a distribution relay's disk.** Budget roughly
`bitrate × origin_retention_secs / 8` per stream, and remember a DVR feed is two
streams — main plus proxy — plus thumbnails. A 60-minute window on a 9.3 Mbit/s
main and a 3.1 Mbit/s proxy is about 5.6 GB per concurrent session, and
`origin_min_free_bytes` needs its 5 GiB underneath all of them.

## Scaling to large audiences

A single relay serves roughly **hundreds to low-thousands** of concurrent WHEP
viewers before its uplink or CPU saturates. A separate `max_viewers_per_ip` cap
(default **256**) limits concurrent WHEP viewers from any one source IP as a
DoS control on the public endpoint; past it the offer is answered `429` and the
relay raises a Warning `distribution` event. Beyond a relay's own ceiling:

- **WHEP cascade** — deploy additional *regional* relays that pull the stream
  from an *origin* relay and re-fan-it-out locally. Each regional relay is
  simply a WHEP client of the origin, so an origin feeds N regionals and each
  serves nearby viewers. Add cascade sources on the regional relay's
  **Configure → Distribution** tab in the manager (one structured row per
  source: local stream id · upstream WHEP URL · optional token), or in config:

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
