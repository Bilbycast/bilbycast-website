---
title: Viewer Portal
description: bilbycast-portal — a separate sign-in service beside a distribution relay that asks the manager which feeds a viewer may watch and hands them a short-lived DVR token.
sidebar:
  order: 4
---

A gated feed has two ways in. The **link** is minted per session from the
manager and is revocable — right for a one-off guest. The **portal** is the
login, right for staff who watch regularly and for whom issuing and chasing
links is the worse job. Neither replaces the other.

`bilbycast-portal` is that login. A viewer signs in through your existing
forward-auth identity provider (Authelia, in the worked example below), sees the
feeds they are entitled to, clicks one, and lands in the
[DVR player](/relay/viewer-distribution/) with a token that admits that feed and
nothing else.

It stores no state, and the one secret it holds is its own service token:

- **It does not sign tokens.** It asks the manager to mint one, and the manager
  re-checks the entitlement before it does. A public-facing VPS holding the key
  that signs every viewer credential would make a compromise there a compromise
  of every feed on every relay.
- **It does not hold entitlements.** It asks the manager on each page load, so
  withdrawing someone's access takes effect on their next click rather than on
  the next successful push to a box that might be unreachable.
- **It is not the relay.** Separate binary, separate systemd unit, separate
  user — because the relay terminates media for every viewer on the box, and a
  bug in a public-facing web page must not be able to take that with it.

## A second binary, not a relay mode

The portal is declared as its own `[[bin]]` in the relay's `Cargo.toml`, lives
outside `src/bin/` so it is not auto-discovered, and is gated on
`required-features = ["portal"]` — a plain `cargo build` simply does not produce
it and links no HTTP client:

```bash
cargo build --release --features portal      # -> target/release/bilbycast-portal
```

The `portal` feature is independent of `viewer-distribution`. The portal hands
out links to a relay, which need not be the one it sits beside, and building it
pulls in neither str0m nor OpenSSL.

**It ships only in the tarball.** The release workflow builds the two
`-distribution` artefacts with `--features "viewer-distribution-vendored,portal"`
and stages the portal into the signed tarball only — the bare binary published
alongside it is the relay and nothing else, so a plain `curl` of that file cannot
give you a portal.

| Release artefact | What it carries |
|---|---|
| `bilbycast-relay-<arch>-linux-distribution` | The relay binary alone. |
| `bilbycast-relay-<arch>-linux-distribution.tar.gz` | The relay, `bilbycast-portal`, `packaging/bilbycast-portal.service`, `packaging/bilbycast-portal.sysusers` and `portal-config.example.json`, alongside the relay's own unit and example config. |
| `bilbycast-relay-<arch>-linux` (lean forwarder) | No portal — the variant is built without the feature. |

The unit runs as `bilbycast-portal`, a distinct system account from
`bilbycast-relay` with home `/var/lib/bilbycast/portal` and `/usr/sbin/nologin`
as its shell. One account for both would mean a portal compromise could read the
relay's config and the manager secret in it. The unit carries the relay's
hardening profile unchanged — `ProtectSystem=strict`, an empty
`CapabilityBoundingSet`, `RestrictAddressFamilies=AF_INET AF_INET6` and the
rest are the same lines — and tightens the one thing the portal does not need:
`/etc/bilbycast` is `ReadOnlyPaths` here, where the relay has it under
`ReadWritePaths` so it can persist its node identity. The portal never persists
anything.

## Install it

`install-relay.sh` takes `--with-portal <manager base URL>`. That is the
manager's **HTTPS base URL**, not the WebSocket one — the portal talks to its
REST API:

```bash
curl -fsSL https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/install-relay.sh \
  | sudo bash -s -- \
      --manager wss://manager.example.com/ws/node \
      --registration-token <token-from-the-manager-UI> \
      --with-portal https://manager.example.com \
      --player-origin https://relay.example.com
```

| Path | What lands there |
|---|---|
| `/opt/bilbycast/portal/bilbycast-portal` | The binary, mode `0755`. |
| `/etc/systemd/system/bilbycast-portal.service` | The unit from the tarball. |
| `/etc/bilbycast/portal.json` | A generated config, mode `0644`. Written **only if absent**, so an upgrade never overwrites a working one. |
| `/etc/bilbycast/portal.env` | An empty `BILBYCAST_PORTAL_TOKEN=`, mode `0600`, group `bilbycast-portal`. |
| `/var/lib/bilbycast/portal` | The unit's working directory, owned by the service account. |

`--with-portal` against the lean forwarder tarball is **refused** with a message
saying the portal ships in the distribution variant, rather than installing a
relay and quietly skipping the half you asked for.

**The installer does not start the portal**, and cannot: it needs a manager
service token that does not exist until you generate one, and a portal started
without one does not start at all — validation runs once at startup and the
process exits with ``portal config: no manager token: set BILBYCAST_PORTAL_TOKEN
or `manager_token` in the config file``, so the packaged unit (`Restart=always`,
`RestartSec=3`) would only restart it into the same error every three seconds
until its start limit trips (ten failures in five minutes). Generate the token
(below), put it in `portal.env`, then:

```bash
sudo systemctl enable --now bilbycast-portal
```

`upgrade-relay.sh` carries the portal along automatically when the host has one —
no flag. The portal is swapped while the relay is down and started again only
after the relay's health probe passes, so it never comes up beside a relay that
is about to be rolled back; if the relay rolls back, so does the portal. If the
relay is healthy but the portal will not start, the portal is left stopped and
the failure printed — it is not the data plane. Upgrading with a *lean* tarball
on a host that runs a portal warns and leaves the portal alone.

## Configure it

`portal-config.example.json`, the shipped example. The installer writes a file
of the same shape to `/etc/bilbycast/portal.json`, filling in the
`--with-portal` URL as `manager_url` and `--player-origin`, if given, as the
single entry in `player_origins` — and no `logout_url`:

```json
{
  "listen_addr": "127.0.0.1:8088",
  "manager_url": "https://manager.example.com",
  "username_header": "Remote-User",
  "logout_url": "https://auth.example.com/logout",
  "trusted_proxies": ["127.0.0.1", "::1"],
  "player_origins": ["https://relay.example.com"]
}
```

| Field | Default | What it does |
|---|---|---|
| `listen_addr` | `127.0.0.1:8088` | Where to listen. Loopback, so the proxy on the same host is the only thing that can reach the port. |
| `manager_url` | *(required)* | The manager's base URL. Trailing slashes are stripped on load. |
| `manager_token` | `""` | The service token. Normally left empty here and supplied through `BILBYCAST_PORTAL_TOKEN`, which **overrides** the file. |
| `username_header` | `Remote-User` | The header the proxy puts the username in. Lower-cased on load; header lookup is case-insensitive either way. |
| `logout_url` | *(unset)* | Where "Sign out" points. Unset means no button is rendered. Not written by the installer — add it by hand. |
| `trusted_proxies` | `["127.0.0.1", "::1"]` | The peers whose username header is believed. **Empty means nobody.** |
| `player_origins` | `[]` | Origins allowed to renew a token. **Empty means no renewal at all.** Trailing slashes are stripped on load. |

The binary takes `--config <path>` (defaulting to `portal-config.json`, which is
why the packaged unit passes `--config /etc/bilbycast/portal.json`) and
`--listen <addr>` to override `listen_addr` without editing the file. A
`--listen` value is validated on the same pass as the file.

The service token goes in the environment rather than the file, because the file
is what gets copied between hosts while someone is debugging:

```
# /etc/bilbycast/portal.env   (0600, group bilbycast-portal)
BILBYCAST_PORTAL_TOKEN=<the value the manager generated>
```

### What refuses to start

Validation runs once at startup rather than per request, so a misconfigured
portal refuses to run instead of refusing every viewer with a message that looks
like their account being wrong. It bails on:

- no `manager_url`, or one that is neither `http://` nor `https://`;
- a plaintext `http://` `manager_url` without `BILBYCAST_ALLOW_INSECURE=1` — the
  manager token rides on every request to that URL, so plaintext hands out the
  portal's service identity;
- no manager token, from either the environment or the file;
- an empty or malformed `username_header`;
- a `logout_url` that is not `http://` or `https://`;
- an **empty `trusted_proxies`** — an empty list that meant "trust all" would
  turn a typo into an open portal;
- a `player_origins` entry of `*` (a response carrying
  `Access-Control-Allow-Credentials` may not answer a wildcard), one without a
  scheme, or one carrying a path;
- an unparseable `listen_addr`.

A `listen_addr` that is not loopback is **not** an error — the proxy may
legitimately be on another host — but it logs a warning at startup, because at
that point `trusted_proxies` is the only thing left holding the boundary.

## The trust boundary

The portal authenticates nobody. It learns who you are from a header that your
forward-auth proxy sets after it has authenticated the viewer. **That header is a
claim, not a proof** — anything that can reach the portal directly can set it and
become anyone.

The peer address is checked against `trusted_proxies` **before the header is read
at all**, so a misconfiguration cannot silently downgrade to trusting everyone. A
v4 proxy arriving over a dual-stack v6 socket as `::ffff:127.0.0.1` is matched
against its v4 form, which is what stops the loopback default failing on exactly
the deployment it was written for.

Past that check, a username is accepted only if it is non-empty, at most 256
characters, and free of control characters and whitespace — the same rule the
manager applies. Anything else could not have survived a header round-trip
intact, so matching it against an entitlement would be guesswork.

### Putting Authelia in front

Any forward-auth proxy works; the portal only needs the username header. With
Caddy:

```caddyfile
portal.example.com {
    forward_auth authelia:9091 {
        uri /api/authz/forward-auth
        copy_headers Remote-User Remote-Groups Remote-Name Remote-Email
    }
    reverse_proxy 127.0.0.1:8088
}
```

Two things to get right:

1. **The proxy must strip an inbound `Remote-User`** before setting its own. A
   client that supplies one and has it passed through is a client that picked its
   own identity.
2. **Nothing but the proxy may reach `127.0.0.1:8088`.** On a shared host that
   means keeping the loopback default rather than binding the LAN address.

## Portal logins

Entitlements live in the manager, under **DVR Sessions → Portal logins**. Add a
username, then tick the feeds it may watch.

The username is matched against the identity provider's spelling **exactly** — it
is a plain SQL equality, so `A.Smith` and `a.smith` are two different people,
because they are two different identities to the IdP. Two consequences follow,
and neither is visible from the manager's own screens:

- The manager cannot verify a username. Adding one grants access to whoever the
  IdP later decides that name belongs to, so **a username reused for a different
  person inherits the previous holder's entitlements**, and deleting a leaver in
  the IdP does not delete their rows here.
- Only sessions in the **`active`** state are listed. A feed that is not on air is
  simply absent, rather than offering a link to a black screen.

The tick list is a **replace**, not a merge: what is on screen when you save is
what is true afterwards. At most 256 feeds may be sent in one request.

### The service token

The portal authenticates to the manager with a shared service token, generated
under **DVR Sessions → Portal logins → Generate a token**.

| Property | Behaviour |
|---|---|
| Who may mint it | Super admin only — the credential is not group-scoped, so its holder can ask about any username in any group. |
| How it is produced | Generated, never typed. An operator asked to invent a machine credential invents a weak one. |
| Visibility | Shown once, in the response. The status endpoint reports only whether one is *configured*; the audit row records the rotation, never the value. |
| Rotating | Replaces the live one. The portal stops working until the new value is deployed: the manager answers the portal `401`, the portal turns any refusal into `502`, and every viewer sees **Cannot reach the manager right now** — a message about the manager, with nothing to say it is the portal's credential. So rotate deliberately. |
| Clearing | Turns the portal off outright, leaving no live credential behind. |
| None configured | The manager refuses every portal request. A manager never set up for a portal must not answer entitlement questions for whoever asks. |

## What a viewer sees

A page headed **Your feeds**, with "Signed in as *username*" beside it and a
**Sign out** link only when `logout_url` is set. Below it, one row per entitled
on-air feed — the feed's name and a **Watch** button — and a note that opening a
feed gives thirty minutes of access at a time: where renewal has been set up the
player extends that itself while they keep watching (see **Renewal, and the
origin gate** below); if it reports expired access instead, they come back here
and open the feed again.

**Watch** posts the *session* id to the portal, which asks the manager to mint,
and follows the returned URL **in the same tab** (a token-bearing URL opened with
`window.open()` gets blocked as a popup often enough that the failure would read
as the feed being broken). The viewer arrives at the relay's DVR page with
`?token=…`, plus `&hold=…` — an opaque id for this device, see **One viewing
session per login** below — and `&from=…`, this page's own origin, which the
player's back-to-feeds button honours only when it matches the relay's
configured `portal_url` and otherwise ignores.

With nothing entitled and on air, the page says so in one message. Distinguishing
"you have none" from "none are on air" would need the manager to report
entitlements for feeds it has decided not to show, which is precisely the oracle
the API declines to be: a viewer with no entitlement, a session that does not
exist, and a session that is not running all produce **one identical refusal**.

The feed list is rendered with `createElement` and `textContent`, and the page is
served with a `script-src 'self'` CSP — which is why the script is its own route
rather than an inline block.

## What a viewing token admits

A viewer token is an HMAC over `(scope, streams, expiry)`, signed by the manager
with the distribution `token_secret` — one secret, pushed to every distribution
relay it configures. There is no per-viewer state on the relay,
so **the list of streams travels inside the token**:

| Form | Shape |
|---|---|
| One stream | `{exp}.{hmac}` |
| Several | `{exp}.{stream,stream,…}.{hmac}` — sorted and de-duplicated, so the same set always mints the same token |

The HMAC covers that list, so adding a name to it invalidates the signature. A
one-element token is byte-identical to the older single-stream form, which is
what keeps already-issued WHEP tokens valid.

Two rules follow, and they are what makes the DVR player work off one credential:

- A token minted for `show` **also admits `show-proxy`** — its derived
  low-resolution rendition. The converse does not hold: a token minted for
  `show-proxy` admits only `show-proxy`.
- The manager mints a portal token over **both** of a session's stream ids, so the
  player fetches the main rendition and the proxy off the one credential.

A portal-minted token lasts **thirty minutes** — much shorter than the three
hours a token exchanged from a one-off link gets, because a viewer who came
through the portal renews (see below) and a link viewer cannot. The player
strips it, and the holder id beside it, from the URL on load — a viewer copying
the address bar should not hand out their credential —
and keeps it in `sessionStorage` for the life of the tab, so a reload, a
back-navigation or a restored tab does not report expired access that has not
expired. A token the origin refuses is forgotten, so one refusal cannot become a
loop that survives every reload.

When it does run out, the player offers a link straight back to **that feed** —
`{portal}/watch?stream={id}` — rather than to the portal's front page. The portal
already knows who they are, so recovering is one tap. A stream the viewer is not
entitled to and one that does not exist both land back on the front page, with no
hint of which.

## Renewal, and the origin gate

Thirty minutes does not cover a match plus its build-up, and the failure would
arrive before half-time. So the player renews itself **600 seconds before
expiry**, by calling `GET /api/renew?stream=…&held=…` on the portal — which puts
the entitlement re-check on a twenty-minute cadence.

That renewal goes back through the manager exactly as the first mint did, and
**the manager re-checks the entitlement before it signs**. That is what keeps a
short expiry meaningful: it is revocation latency, not a countdown. A renewal
that skipped the check would quietly turn "access lasts thirty minutes" into
"access lasts as long as the tab is open".

Renewal needs **two** settings, on two different services, and either one missing
disables it silently:

| Where | Setting | If it is missing |
|---|---|---|
| Relay | `distribution.portal_url` (the manager's **Viewer portal URL** field) | The player schedules no renewal at all, however the portal is configured. The thirty minutes become a hard limit. |
| Portal | `player_origins` | The renewal request is refused `403`, and the viewer loses access mid-event. |

`install-relay.sh --player-origin https://relay.example.com` writes the second one
for you; without it the installer prints a note saying tokens will not renew,
because the failure is otherwise silent.

The origin gate is a real CSRF boundary, not a formality: the renewal is a
cross-origin request carrying the viewer's session cookie. So:

- Matches are **exact**, never a prefix, and `*` is refused at startup.
- The origin is checked **before anything is done**, so an unlisted one cannot
  even cause a mint.
- Every exit *past* that check carries the CORS headers, refusals included — the
  origin is already trusted by then, and withholding them only turns a clear
  `403` into an opaque browser error. Responses also carry
  `Cache-Control: no-store` (the body is a credential) and `Vary: Origin`.

A failed renewal retries with a widening gap — 30 s, doubling to a 300 s ceiling —
and never past the token's own expiry, after which the expired-access link is the
honest answer. **Only a viewer who came through the portal can renew**, because
only they hold the session cookie; a guest on a one-off link cannot, and should
not — their three hours are the point of the link.

Removing a portal login stops that user getting *new* tokens immediately. A token
already in a browser keeps working until it expires: the relay verifies a
signature and an expiry and holds no per-viewer state to revoke. Thirty minutes
is the outer bound on how long a withdrawal takes to bite: the player renews ten
minutes early, so the manager re-checks the entitlement every twenty minutes,
and a refused renewal does not recall the token in hand — it runs out its
remaining ten minutes. A withdrawal therefore lands somewhere between ten and
thirty minutes after it is made.

## One viewing session per login

Pressing **Watch** — or following the player's `/watch?stream=…` link back —
*claims* the login. The manager records this device under an opaque holder id
(a random UUID, deliberately not the token: two tokens minted in the same second
for the same streams are byte-identical and cannot tell two devices apart),
hands it to the player as `&hold=…` beside the token, and the player presents it
back as `&held=…` on every renewal and every beat.

The record is keyed by **username**, not by username and feed, so one login is
one device on one feed at a time: opening a second feed, or the same feed on a
second device, displaces the first, and the newest device wins. A renewal from
the displaced device is answered `409` (`session_taken_over`); the player
forgets its token, pauses, and shows *This login is in use on another device.
Only one at a time.* with a link back to the feed, which takes the login back.
The displaced picture runs until that renewal, not mid-sentence, so the wait is
bounded by the token's remaining life. Claims, renewals and displacements land
in the manager's audit log.

Mints made only as a permission check — the three clips routes below — claim
nothing, so a clip poll cannot displace the viewer's own player. A renewal that
arrives without a holder is treated as a fresh Watch, so an older player keeps
its feed by retaking the login.

The beat, not the renewal, is what feeds the manager's "who is watching" count:
a renewal arrives every twenty minutes, a beat every minute (the cadence travels
in each reply as `next_beat_secs`, so it is the manager's to change), and a
viewer whose beats stop is dropped from the count after 150 s. It rides the same
two settings as renewal — `distribution.portal_url` on the relay and
`player_origins` on the portal — and without them no beat ever lands, so the
manager falls back to counting whoever holds a live token, which keeps a closed
tab in the count until its token runs out. Its DVR Sessions page says so rather
than asserting silence: the count is marked approximate, with a note that this
relay's player is not sending heartbeats.

## Exports

Once there is a clip on any feed the viewer may reach, the page grows an
**Exports** table — hidden until then, so someone whose feeds carry no clips is
not shown an empty shelf. It lists every clip cut from the player's Marks panel
on every feed the user may reach, newest first, with a download link that goes
through the portal and a delete button; a clip still being cut is listed too,
marked not ready, so an operator who has just pressed Export sees that something
is happening. Clips are kept for **24 hours after the feed stops**, on the
manager's clock (`clips_expire_at`, set when the session stops), and the
manager's expiry sweep is what removes them — which is why a stopped feed with
clips still appears here for a day, though never as something to watch. The
relay's own sweep is only a backstop for a manager that never comes back:
half-written uploads and media with no record beside it after an hour, and
anything older than seven days. A clip belongs to the session, not to whoever
exported it: anyone entitled to the feed can see it, download it and delete it.
While a cut is still pending the page re-asks every five seconds for up to ten
minutes from the last page load; a failed poll keeps asking, and only "nothing
pending" from the server stops it.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | The page. Served `no-store`, with `X-Frame-Options: DENY` and a `script-src 'self'` CSP. |
| `GET /portal.js` | Its script — a separate route so the page can carry that CSP. |
| `GET /api/feeds` | What the signed-in user may watch, plus their username and `logout_url`. |
| `POST /api/watch` | Mint a link for one feed. The body names the **session**; the username comes from the header and can never be supplied by the browser. Pressing Watch *claims* the login (see above). |
| `GET /watch?stream=…` | One tap back to a feed whose credential ran out — re-mints (claiming the login afresh) and redirects. This is where the player's expired-access link points. |
| `GET /api/renew?stream=…&held=…` | Background renewal. Cross-origin, so it answers only origins named in `player_origins`. `held` is the holder id the player was given: a renewal that presents it must still hold the login (else `409`), and one that omits it — an older player — is treated as a fresh Watch and retakes the login. The reply carries the new token and the holder. |
| `POST /api/beat?stream=…&held=…` | "Still watching", from a playing tab, on the cadence the manager's reply sets (`next_beat_secs`, currently 60 s; the player floors it at 15 s and pauses while the tab is hidden). Cross-origin and gated on `player_origins` exactly as renewal is. Authenticated by the same session cookie as everything else here, but it carries no viewing token and mints nothing: it moves one timestamp on a row this device must already hold, so without `held` it is `400`. The reply's `held: false` tells a displaced tab to stop beating — its picture is ended at its next renewal, not here — and any upstream failure answers `held: true`, so a lost beat costs a number on an operator's screen, never a picture. |
| `GET /api/clips` | Every clip — ready, still cutting, or failed — on every feed the user may reach, which includes a stopped feed for the 24 hours its clips are kept (the manager is asked `?for=clips`). Each feed costs one manager mint, purely as the permission check and re-made on every call rather than cached, plus one origin listing over the minted token, eight feeds at a time. A relay too old to know about clips answers 404 and is skipped silently. |
| `GET /api/clips/download?session=…&name=…` | Hands a finished clip to the viewer **through the portal** — re-minting as the permission check and streaming the bytes from the origin with the token in a header — so the viewer token never appears in a link they are told to right-click and save, nor in the relay's access log. |
| `DELETE /api/clips` | Removes one clip; the JSON body names the `session_id` and the clip `name`. Through the portal because the page's `connect-src 'self'` CSP stops the browser reaching the origin itself. The mint is the only check, so any viewer entitled to the feed may delete any clip on it — the stated design. An origin `404` counts as done. |
| `GET /healthz` | Liveness. Deliberately needs no user — a health check that required one would be reporting on the proxy. |

Upstream failures answer `502` with "Cannot reach the manager right now", never
`401`: a `401` from the manager is the *portal's* credential being wrong, and
telling the viewer they are not signed in would send them to log in again
forever.

## The player they land in

The portal hands off to the relay's DVR page at `/dvr/{stream_id}`. What arrives
is a full transport surface, not a video element:

| Control | Behaviour |
|---|---|
| Scrub bar | The lit portion is held on the device, and dragging there moves the real picture frame for frame; outside it you get a preview thumbnail while dragging and the video when you let go. A zoom slider sets how much of the window the bar covers. |
| Time ruler | Labelled marks at round clock times — `1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600` seconds — with the largest spacing that still puts **at least three across the bar**, plus minor marks subdividing it. Because each is pinned to an absolute moment, they drift left on their own as the view follows the playhead, and stop when the transport stops. |
| Marks | Press **MARK** (or `M`) to flag the moment you are looking at; hold for the list, and `[` / `]` to jump. Each carries a name and one of a **closed** six-colour palette — Red, Amber, Green, Blue, Purple, White. Closed for more than taste: the colour is written into an inline `style` and marks come out of `localStorage`, so only a listed value is accepted. Marks are per feed, per device, and are not shared with the operator next to you. |
| Picture ladder | Three points on the curve, chosen in Settings and applied on reload: **Full** (1080p throughout, about 9.3 Mbit/s), **Balanced** (low-resolution while moving, full resolution when stopped — about 3.1 Mbit/s plus roughly 2 MB each time you stop) and **Low** (low-resolution throughout, about 3.1 Mbit/s). The default is Full. Shuttle and scrub work in all three, because the low-resolution rendition is all-intra. |
| Frame stepping | `,` and `.`, or the jog buttons either side of pause. Jog stays on the main rendition; only shuttle hands over to the proxy. |
| Shuttle and rates | `J` / `L` cycle 2× / 4× / 8× / 16× in either direction, `K` stops; fixed rates of 33 %, 50 % and 100 % sit on the bar. |
| Full screen | The `F` key or the corner button. The button removes itself entirely on a browser with no Fullscreen API rather than sitting there inert. |
| Time of day | The left-hand readout is the wall-clock time the frame was ingested, as `HH:MM:SS:FF` — real time of day, not elapsed position — derived from the playlist's `EXT-X-PROGRAM-DATE-TIME`. It falls back to elapsed time when no wall clock is available. |
| Self-test | From Settings, or `?selftest=1`. About a minute, and it measures what *this device* can actually present rather than what the decoder reports: shuttle rate inside the buffer (50 seeks in 2 s), scrub preview coverage across the bar (20 positions), dragging through the real handlers (40 moves), and token renewal against the current token's expiry. |

Keyboard summary: `J`/`L` shuttle, `K` stop, `,`/`.` frame step, `Space`
play/pause, `End` live, `F` full screen, `M` mark, `[`/`]` previous/next mark,
`Escape` closes the innermost panel.

The page itself is served `no-store, must-revalidate`, so an upgraded player is
never masked by a cached copy.

## hls.js is vendored, not fetched

The DVR page loads **hls.js 1.6.16** from the relay itself, at
`GET /dvr/hls.js`, compiled into the binary. The response is
`public, max-age=31536000, immutable`, and the page appends `?v=1.6.16` so that
promise stays true across a version bump.

Vendored rather than CDN-referenced for two reasons, both load-bearing: relays are
frequently deployed where viewers have no route to the public internet, and
Android Chrome has no native HLS — so on the tablets this surface targets, hls.js
is not a progressive enhancement but the only way the page plays anything.

**Attribution.** hls.js is Apache-2.0, and vendoring it makes this a
redistribution: the bytes are compiled into the relay binary and served verbatim
to every DVR viewer, so §4's attribution has to travel with them. **Today it does
not.** The relay repository ships `LICENSE` and `LICENSE.commercial` but no
`NOTICE`, and the release tarball packs the licences, `README.md`, the example
configs and the `packaging/` units — not the vendor README that records the
upstream, version, SHA-256 and licence. Closing the gap means adding a relay
`NOTICE` naming hls.js 1.6.16 / Apache-2.0 and staging it into the tarball
alongside `LICENSE`, as bilbycast-edge already does with its own `NOTICE` files.
