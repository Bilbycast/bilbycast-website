---
title: NMOS
description: AMWA NMOS support — IS-04 Node API, IS-05 Connection Management, IS-08 Audio Channel Mapping, BCP-004 Receiver Capabilities, mDNS-SD discovery, and an opt-in IS-04 registration client.
sidebar:
  order: 7
---

bilbycast-edge implements the broadcast-audio, broadcast-data, and
uncompressed-video subsets of the AMWA NMOS specifications:

| Spec | Endpoint | Coverage |
|------|----------|----------|
| IS-04 v1.3 | `/x-nmos/node/v1.3/` | self, devices, sources, flows, senders, receivers |
| IS-04 v1.3 registration client | outbound to a registry's `/x-nmos/registration/v1.3/` | optional, opt-in via the `nmos_registration` config block — see below |
| IS-05 v1.1 | `/x-nmos/connection/v1.1/` | single sender/receiver staged + active + transporttype + constraints |
| IS-08 v1.0 | `/x-nmos/channelmapping/v1.0/` | io, map/active, map/staged, map/activate (active map persists to disk) |
| BCP-004 | embedded in IS-04 receiver caps | constraint_sets for ST 2110 audio, data, and video inputs |
| mDNS-SD | `_nmos-node._tcp` | best-effort registration via the `mdns-sd` crate |

## Format detection

Each flow's input is classified at IS-04 list time:

- `InputConfig::St2110_30` / `St2110_31` → `urn:x-nmos:format:audio`
- `InputConfig::St2110_40` → `urn:x-nmos:format:data`
- `InputConfig::St2110_20` / `St2110_23` → `urn:x-nmos:format:video`
- everything else → `urn:x-nmos:format:mux`

The same classifier drives the receiver `caps` block:

- **Audio receivers** advertise BCP-004 constraint sets keyed by
  `urn:x-nmos:cap:format:*` URNs (sample_rate, channel_count,
  sample_depth).
- **Data receivers** (ST 2110-40) advertise
  `media_types: ["video/smpte291"]`.
- **Video receivers** (ST 2110-20 / -23) advertise
  `media_types: ["video/raw"]` with BCP-004 constraints:
  `urn:x-nmos:cap:format:color_sampling` (`YCbCr-4:2:2`),
  `component_depth` (8 or 10), `frame_width` / `frame_height` (the
  configured resolution), and `grain_rate` (the configured frame rate).

NMOS controllers use these constraint sets to reject incompatible
senders before activation.

## BCP-004 receiver capabilities

```json
{
  "caps": {
    "media_types": ["audio/L16", "audio/L24"],
    "constraint_sets": [{
      "urn:x-nmos:cap:format:media_type": { "enum": ["audio/L16", "audio/L24"] },
      "urn:x-nmos:cap:format:sample_rate": { "enum": [{ "numerator": 48000 }] },
      "urn:x-nmos:cap:format:channel_count": { "enum": [2] },
      "urn:x-nmos:cap:format:sample_depth": { "enum": [24] }
    }]
  }
}
```

ST 2110-40 receivers advertise `media_types: ["video/smpte291"]`.
Non-ST-2110 receivers continue to advertise the historical
`video/MP2T` shape so existing NMOS controllers don't break.

## PTP clocks

When any flow on the node sets `clock_domain`, the IS-04 `/self`
resource includes a single PTP clock entry (`name: "clk0"`,
`ref_type: "ptp"`). Sources whose flow has `clock_domain` set
reference this clock by name. The `locked` field is reported as `false`
until live PTP integration lands; the manager UI uses
`FlowStats.ptp_state.lock_state` for the real view — see
[ST 2110](/edge/st2110/#ptp-integration) for the PTP architecture.

## IS-08 audio channel mapping

The IS-08 endpoints expose every ST 2110-30/-31 audio input and output
under `/io`. The active map is persisted to
`<config_dir>/nmos_channel_map.json` (next to `config.json`) and
reloaded on startup. Both staged and active maps support the standard
PUT/POST + activate workflow.

Bilbycast does not currently re-route channels internally — the map is
a passthrough — but the endpoints exist so external NMOS controllers
can stage and activate maps and the manager UI can render the channel
layout.

**Bounds**: at most 1024 outputs per map, at most 64 channels per
output. Controllers exceeding these limits receive a
`413 PAYLOAD_TOO_LARGE` response.

## mDNS-SD registration

On startup the edge calls a small `mdns-sd` helper to register
`_nmos-node._tcp` on the local link. Failures (no multicast on the
selected interface, daemon errors) are logged once and swallowed; flow
startup is never blocked. The handle is dropped on process exit, which
unregisters the service cleanly.

## Registration client (push to an NMOS registry)

mDNS-SD covers LAN-only deployments; registry-driven controllers
usually discover nodes through an NMOS **registry** instead. When
`nmos_registration.enabled: true`, the edge spawns a background task
that POSTs its IS-04 v1.3 resources (node + device + sources + flows +
senders + receivers) to a configured registry and heartbeats the node
so the registry's query API surfaces the edge to controllers.

```json
{
  "nmos_registration": {
    "enabled": true,
    "registry_url": "https://registry.example.com:8235",
    "api_version": "v1.3",
    "heartbeat_interval_secs": 5,
    "request_timeout_secs": 10,
    "bearer_token": "optional-static-bearer-token"
  }
}
```

| Field | Default | Notes |
|-------|---------|-------|
| `enabled` | `false` | Set to `true` to spawn the task. |
| `registry_url` | — | Base URL of the registry. Do **not** include `/x-nmos/...` — the path is appended internally. `https://` is recommended for any non-loopback registry. |
| `api_version` | `"v1.3"` | Only `v1.3` is supported. |
| `heartbeat_interval_secs` | `5` | 1–60 s. The registry treats nodes as expired after roughly 12 s of missed heartbeats. |
| `request_timeout_secs` | `10` | 1–30 s. |
| `bearer_token` | `null` | Optional static `Authorization: Bearer …` header attached to every registry request. Persisted encrypted in `secrets.json` and stripped before the config is sent to the manager. |

Resource UUIDs are deterministic (UUID v5 rooted at the persisted
`node_id`), so restarts update the registry record in place rather than
orphaning resources. The task hashes the resource set on every heartbeat
tick and only re-POSTs the full set when a flow is added / removed /
edited; otherwise it just heartbeats. Network or 5xx errors retry with
exponential backoff capped at 30 s, and a clean shutdown issues a single
`DELETE` so the registry stops listing the node immediately.

Registration lifecycle surfaces on the manager's event feed under
category `nmos_registry`:

| Severity | error_code | Meaning |
|----------|-----------|---------|
| Info | `nmos_registered` | First successful POST of the node resource. |
| Warning | `nmos_heartbeat_lost` | Heartbeat returned non-2xx; the client falls back to re-registering. |
| Critical | `nmos_registration_failed` | A registration POST returned 4xx/5xx. Client retries with backoff. |
| Warning | `nmos_registry_unreachable` | Network / DNS / TLS error reaching the registry. Client retries with backoff. |

The registration client is purely additive — it does not turn off the
`_nmos-node._tcp` mDNS-SD advertisement, so a mixed network (some
controllers using mDNS, some using a registry) gets both. Registry
autodiscovery, multi-registry failover, and IS-10 OAuth2
client-credentials against the registry are out of scope in this
release (supply the registry URL and, if needed, a static bearer token
manually).

## Authentication

NMOS auth follows a secure-by-default policy tied to the main
`auth.enabled` switch:

- **`auth.enabled: true` and `nmos_require_auth` unset** — NMOS
  IS-04/IS-05/IS-08 require JWT Bearer auth. A startup info line confirms
  the policy.
- **`auth.enabled: true` and `nmos_require_auth: false`** — NMOS stays
  public to preserve compatibility with a controller that can't
  authenticate; a loud `SECURITY:` warning is logged at startup.
- **`auth.enabled: false`** — NMOS stays public regardless of
  `nmos_require_auth` (nothing to auth against).

When NMOS auth is active, controllers obtain a token via `/oauth/token`
first, then include `Authorization: Bearer <token>` on every NMOS
request. Both `admin` and `monitor` roles have full access.

## Backward compatibility

Multi-essence audio + data + video resources are additive — old NMOS
controllers that only consumed `format:mux` continue to work because
mux flows are still classified the same way. ST 2110-20 / -23 flows
advertise `format:video` with the `video/raw` media type; controllers
that don't recognise `video/raw` see the flow but ignore the constraint
set (graceful degrade). The IS-08 router is mounted under a fresh URL
prefix and is invisible to controllers that don't speak it. The mDNS-SD
registration is supplementary to manual NMOS registry configuration.

## Pending external validation

The following items are deferred until matching tooling becomes
available in the test lab:

- **AMWA NMOS Testing Tool** runs against IS-04, IS-05, IS-08, BCP-004.
  Expected pass matrix:
  - IS-04: pass on `test_01` (resources have valid UUIDs / formats /
    transports) through `test_19` (clocks).
  - IS-05: pass on staged/active round-trip for sender + receiver,
    with transport-file SDP advertisement for ST 2110 senders.
  - IS-08: pass on `io`, `map/active`, `map/staged`, `map/activate`
    happy paths.
  - BCP-004: pass on receiver caps containing `media_types` plus a
    `constraint_sets` block matching the configured sample rate /
    channel count / bit depth.
- **Sony NMOS Commissioning Tool** end-to-end smoke against a real
  Lawo or Riedel device.
