---
title: Prometheus Metrics
description: Every metric family bilbycast-edge emits on /metrics — names, labels, when each series appears, and a worked Prometheus scrape configuration.
---

bilbycast-edge serves the Prometheus text exposition format at `GET /metrics` on the
node's API listener. One scrape returns a snapshot of the node, its host resources, its
PTP clock, and every **currently running** flow — inputs, outputs, transport legs,
TR-101290 analyzer counters and detected media.

Every metric name is prefixed `bilbycast_edge_`. This page is the complete list: if a
family is not on it, `/metrics` does not emit it. A large amount of the edge's telemetry
is deliberately **not** Prometheus-shaped — see [What is not on `/metrics`](#what-is-not-on-metrics)
at the bottom before you go looking for a series that does not exist.

## The endpoint

| | |
|---|---|
| Route | `GET /metrics` — at the root of the API server, **not** under `/api/v1` |
| Port | `server.listen_port`, default `8080` |
| Bind | `server.listen_addrs`, default `["127.0.0.1", "[::1]"]` — **loopback only** |
| Content type | `text/plain; version=0.0.4; charset=utf-8` |
| Status | Always `200 OK`. There is no error path — a node with nothing running returns the node-level families and stops |
| Auth | Public unless `server.auth.enabled` **and** `server.auth.public_metrics: false` |

A default install answers only on loopback, so either run the scraper on the node or widen
the listener first — `--bind-addrs 0.0.0.0,[::]` on the command line, or `server.listen_addrs`
in `config.json`. See [Configuration → Server](/edge/configuration/#server-configuration).

```bash
curl -s http://127.0.0.1:8080/metrics | head -20
```

```
# HELP bilbycast_edge_info Application info
# TYPE bilbycast_edge_info gauge
bilbycast_edge_info{version="0.109.0"} 1
# HELP bilbycast_edge_uptime_seconds Application uptime
# TYPE bilbycast_edge_uptime_seconds gauge
bilbycast_edge_uptime_seconds 48213
# HELP bilbycast_edge_flows_total Total configured flows
# TYPE bilbycast_edge_flows_total gauge
bilbycast_edge_flows_total 4
# HELP bilbycast_edge_flows_active Currently running flows
# TYPE bilbycast_edge_flows_active gauge
bilbycast_edge_flows_active 3

# HELP bilbycast_edge_system_cpu_percent System CPU usage percentage
# TYPE bilbycast_edge_system_cpu_percent gauge
bilbycast_edge_system_cpu_percent 22.4
# HELP bilbycast_edge_system_ram_percent System RAM usage percentage
# TYPE bilbycast_edge_system_ram_percent gauge
bilbycast_edge_system_ram_percent 31.8
```

### Scraping an authenticated node

`server.auth.public_metrics` defaults to `true`, so **turning API auth on does not by
itself protect `/metrics`** — the route stays on the unauthenticated router until you set
`public_metrics: false`. Once you do, it moves behind the JWT middleware and any role
(`admin` or `monitor`) is accepted.

Tokens come from `POST /oauth/token` with the OAuth 2.0 `client_credentials` grant, and
they expire after `server.auth.token_lifetime_secs` (default `3600`), so a scraper needs
to refresh them rather than pin one. Two things to get right:

- The edge reads `grant_type`, `client_id` and `client_secret` **from the request body**
  — form-urlencoded or JSON. It does not read HTTP Basic credentials from the
  `Authorization` header.
- `/health` is registered on the public router unconditionally. `public_metrics: false`
  moves `/metrics` and nothing else.

Give the scraper its own `monitor`-role client rather than sharing the admin one. This is an
excerpt — merge it into the `server` block already in `config.json`, which also carries
`listen_addr` and `listen_port`:

```json
{
  "server": {
    "auth": {
      "enabled": true,
      "jwt_secret": "7c1f9a4b2e6d80c3f5a71b9e4d2c60a8f3b5719ecd42068af1b3e5d7902c46ba",
      "public_metrics": false,
      "clients": [
        {
          "client_id": "prometheus",
          "client_secret": "replace-with-a-long-random-per-scraper-secret",
          "role": "monitor"
        }
      ]
    }
  }
}
```

Startup validation refuses the node outright if any of this is wrong: with `enabled: true`,
`jwt_secret` must be **at least 32 characters**, `clients` must be non-empty, and every entry
needs a non-empty `client_id` and `client_secret` plus a `role` of exactly `admin` or
`monitor`.

## What a scrape actually contains

`/metrics` is a snapshot of what exists right now, not a fixed family list.

- **Node, host-resource, PTP and replay-storage families are unconditional.** They appear
  on every scrape, including on a node with no flows configured at all. (Replay needs the
  `replay` Cargo feature, which is on by default.)
- **Everything per-flow is gated on at least one running flow.** Flows are registered with
  the stats collector when they start and removed when they stop, so a configured-but-stopped
  flow contributes nothing — unlike `GET /api/v1/stats`, which pads the response with idle
  entries. With zero running flows the entire flow block, including the SRT, RIST, bond,
  TR-101290 and media families, is absent.
- **A family whose subsystem is idle still emits its `# HELP` / `# TYPE` header with no
  samples.** As soon as one flow is running you will see the SRT, RIST and bond headers
  even on a node that has never carried a leg of that kind. Do not read a header as
  evidence that a leg exists.
- **Series gap rather than reporting zero.** Output latency, PDV jitter, inter-arrival time,
  per-PID bitrates and the three slaved-only PTP gauges are suppressed when the underlying
  sample is missing. Alert on `absent()` when you need to tell "no errors" from "not watching".
- **The five `bilbycast_edge_media_*` families carry no `# HELP` or `# TYPE` line.** They
  are exposed untyped; Prometheus ingests them fine.
- **A scrape does not roll the TR-101290 windows.** `/metrics` reads those counters without
  resetting them, so it cannot steal error counts from the manager's 1 Hz feed. The
  per-output **latency** window is the one exception: every reader — `/metrics`,
  `GET /api/v1/stats` and the 1 Hz WebSocket publisher — drains it on read, so the surfaces
  split the latency samples between them instead of each seeing all of them.

Counters restart at zero when a flow restarts — a fresh accumulator is registered on every
start — so always read them through `rate()` or `increase()`, which handle the reset.

Several counters carry no `_total` suffix despite being declared `counter`:
`…_flow_input_packets_lost`, `…_flow_input_packets_filtered`,
`…_flow_output_packets_dropped` and every `…_bond_*` counter. Those are the names the edge
emits; do not "correct" them in a dashboard.

## Label conventions

Twenty label names appear across the whole surface. There is **no `input_id` label on any
series** — it exists only as a JSON field on the REST and WebSocket stats payloads.

| Label | Where | Values |
|-------|-------|--------|
| `version` | `bilbycast_edge_info` | The running build's version string |
| `flow_id` | every per-flow family | Flow ID from `config.json` |
| `output_id` | per-output families, and output-side SRT / RIST / bond legs | Output ID from `config.json` |
| `leg` | SRT and RIST only | SRT: `input`, `input_leg2`, `leg1`, `leg2`. RIST: `leg1`, `leg2` |
| `leg_role` | RIST and bond only | `input` (receive side) or `output` (send side) |
| `path_id`, `path_name`, `transport` | per-path bond families | Path ID and operator-set name from the bond config; transport is `udp`, `quic`, `rist` or `relay` |
| `stat` | `bilbycast_edge_flow_output_latency_us` | `min`, `avg`, `max` |
| `domain` | PTP families | PTP domain number |
| `state` | `bilbycast_edge_ptp_state` | `unavailable`, `acquiring`, `locked`, `holdover`, `master`, `unknown` |
| `pid` | media families | Elementary-stream PID, formatted `0x0100` |
| `codec`, `resolution`, `profile`, `level` | `bilbycast_edge_media_video_info` | Display strings from the analyzer |
| `codec`, `sample_rate`, `channels`, `language` | `bilbycast_edge_media_audio_info` | Display strings; `language` is present only when the ES declares one |
| `type` | `bilbycast_edge_media_pid_bitrate_bps` | `video` or `audio` |

**SRT and RIST do not share a convention.** SRT carries `leg` and never `leg_role`; RIST
carries both. A selector written for one matches nothing on the other.

## Node

Unconditional, four series per scrape.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `bilbycast_edge_info` | gauge | `version` | Always `1`; the build version rides as a label |
| `bilbycast_edge_uptime_seconds` | gauge | — | Seconds since process start |
| `bilbycast_edge_flows_total` | gauge | — | Flows present in the configuration, running or not |
| `bilbycast_edge_flows_active` | gauge | — | Flows currently running |

`bilbycast_edge_flows_total - bilbycast_edge_flows_active` is the count of configured flows
that are stopped, and is the only way `/metrics` shows you that they exist.

## Host resources

Unconditional. Sampled by a background monitor every 5 seconds.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `bilbycast_edge_system_cpu_percent` | gauge | — | Whole-host CPU utilisation, 0–100 |
| `bilbycast_edge_system_ram_percent` | gauge | — | Whole-host RAM utilisation, 0–100 |
| `bilbycast_edge_system_ram_used_bytes` | gauge | — | RAM used, bytes |
| `bilbycast_edge_system_ram_total_bytes` | gauge | — | RAM installed, bytes |
| `bilbycast_edge_system_resources_critical` | gauge | — | `1` while CPU or RAM has been over its critical threshold past the grace period |

All five are emitted whether or not the node has a `resource_limits` block, but
`resources_critical` is only ever *set* by the threshold evaluator, which runs only when
that block is configured. On a node without one it is pinned at `0` forever — a flat `0`
there is not evidence of a healthy host. Note the plural in `resources_critical`; the
singular form matches nothing.

## PTP clock

Unconditional — the node-level PTP monitor polls `ptp4l` over its management socket every
5 seconds and reloads `ptp.conf` each tick, so these series exist even on a node with no
ST 2110 flow and no PTP at all. The `domain` label is the domain read from `ptp.conf`,
falling back to `127` when the file does not set one.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `bilbycast_edge_ptp_locked` | gauge | `domain` | `1` when the clock is healthy — a `locked` slave **or** `master`; `0` in every other state |
| `bilbycast_edge_ptp_state` | gauge | `domain`, `state` | State set: the one active `state` label carries `1` |
| `bilbycast_edge_ptp_offset_ns` | gauge | `domain` | Signed offset from the grandmaster, nanoseconds |
| `bilbycast_edge_ptp_mean_path_delay_ns` | gauge | `domain` | Mean path delay, nanoseconds |
| `bilbycast_edge_ptp_steps_removed` | gauge | `domain` | Hops from the grandmaster, per BMCA |

The last three are emitted **only while slaved** — `locked` or `holdover`. They are
meaningless in `master`, `acquiring`, `unavailable` and `unknown`, so the series gaps
instead of reporting a stale `0`. Each also gaps individually when `ptp4l` did not return
that particular value. A node with no PTP daemon therefore shows exactly two series:

```
bilbycast_edge_ptp_locked{domain="127"} 0
bilbycast_edge_ptp_state{domain="127",state="unavailable"} 1
```

Graph offset and path delay over time to catch excursions, asymmetry and grandmaster
changes; alert on `bilbycast_edge_ptp_locked == 0`. Threshold crossings also surface as
discrete events — see [Time (PTP)](/edge/ptp/) and
[Events & Alarms](/edge/events-and-alarms/).

## Per-flow input

One series per running flow, labelled `flow_id`. These are flow-level aggregates summed
across **every running input** on the flow — the active member and any warm standby
members alike — not the active member alone. Per-member figures exist only as
`inputs_live[]` on the JSON stats surfaces.

| Metric | Type | Description |
|--------|------|-------------|
| `bilbycast_edge_flow_input_packets_total` | counter | Packets received |
| `bilbycast_edge_flow_input_bytes_total` | counter | Bytes received |
| `bilbycast_edge_flow_input_bitrate_bps` | gauge | Receive bitrate estimate, bits/sec |
| `bilbycast_edge_flow_input_packets_lost` | counter | Packets detected as lost — see the note below the table for what each input type actually counts |
| `bilbycast_edge_flow_input_fec_recovered_total` | counter | Lost packets recovered by SMPTE 2022-1 FEC |
| `bilbycast_edge_flow_input_redundancy_switches_total` | counter | Times an RTP SMPTE 2022-7 input changed which leg it took a packet from. Only the unbuffered merger counts: an input with `redundancy.path_differential_ms` set (the buffered merger), and SRT / RIST leg-2 redundancy, leave it at `0` |
| `bilbycast_edge_flow_input_packets_filtered` | counter | Packets dropped before publication — source-IP filter, RTP payload-type filter, ingress rate limiter, or the flow's bandwidth limit while it is blocked |
| `bilbycast_edge_flow_pdv_jitter_us` | gauge | Packet delivery variation, microseconds. Emitted only when a sample exists |
| `bilbycast_edge_flow_iat_avg_us` | gauge | Mean RTP inter-arrival time, microseconds. Emitted only when a sample exists |

`packets_lost` is not one measurement. On an RTP input, and on an SRT input carrying
RTP-over-TS, it counts gaps in the RTP sequence number. On a RIST input it is the larger of
that and the RIST legs' unrecovered-loss totals — the same losses
`bilbycast_edge_rist_packets_lost_total` reports per leg. A raw-TS SRT input and a plain UDP
input carry no wire sequence number to gap-check, so it stays at `0` on both no matter how
bad the path is.

`packets_filtered` is the one to watch when a feed looks dead but the socket is receiving:
a source-IP filter silently discarding an otherwise-healthy stream shows up here and
nowhere else.

## Per-flow output

One series per output on each running flow, labelled `flow_id` and `output_id`.

| Metric | Type | Description |
|--------|------|-------------|
| `bilbycast_edge_flow_output_packets_total` | counter | Packets sent |
| `bilbycast_edge_flow_output_bytes_total` | counter | Bytes sent |
| `bilbycast_edge_flow_output_bitrate_bps` | gauge | Send bitrate estimate, bits/sec |
| `bilbycast_edge_flow_output_packets_dropped` | counter | Packets this output lost to backpressure — it fell behind the flow's broadcast bus (`Lagged`), or its wire-send queue was full |
| `bilbycast_edge_flow_output_fec_sent_total` | counter | SMPTE 2022-1 FEC packets generated for this output |
| `bilbycast_edge_flow_output_latency_us` | gauge | End-to-end latency, microseconds — three series per output, `stat="min"`, `"avg"` and `"max"` |
| `bilbycast_edge_flow_output_latency_frames` | gauge | The same latency in video frames |

Both latency families are conditional. `latency_us` appears only when the output has
completed at least one send since the window was last drained — and every reader drains it,
so with the manager's 1 Hz feed running that window is under a second. `latency_frames`
needs a detected frame rate on the flow's first video elementary stream on top of that, so a
freshly started output, or any output on an audio-only flow, has neither.

`packets_dropped` rising is backpressure at that one output — it could not keep up and the
edge dropped rather than stalling the flow. It says nothing about the other outputs on
the same flow, which is the point of reading it per `output_id`.

## SRT

Two families, on any flow with an SRT input or output. Labels are `flow_id` plus `leg` —
and `output_id` on the send side. There is no `leg_role` here.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `bilbycast_edge_srt_rtt_ms` | gauge | `flow_id`, `leg`, `output_id` on outputs | Smoothed SRT round-trip time, milliseconds |
| `bilbycast_edge_srt_loss_total` | counter | `flow_id`, `leg`, `output_id` on outputs | Cumulative SRT packet loss, send and receive directions combined |

Leg labels differ by side: an input leg is `leg="input"`, its 2022-7 companion is
`leg="input_leg2"`, and output legs are `leg="leg1"` and `leg="leg2"`.

**The two families do not cover the same legs.** `srt_rtt_ms` is emitted for all four;
`srt_loss_total` is emitted for `leg="input"` and for `leg="leg1"` on outputs only, so a
leg-2 loss series does not exist. Sender-retransmit and receiver-recovery counters are not
on `/metrics` at all — they ride the WebSocket stats feed and
`GET /api/v1/stats`.

## RIST

Six families, all emitted together for each RIST leg. Labels are `flow_id`,
`leg_role` (`input` or `output`), `leg` (`leg1` or `leg2`), plus `output_id` on the send
side.

| Metric | Type | Description |
|--------|------|-------------|
| `bilbycast_edge_rist_rtt_ms` | gauge | Smoothed round-trip time, milliseconds |
| `bilbycast_edge_rist_nack_sent_total` | counter | NACK feedback messages sent to the peer — receiver side |
| `bilbycast_edge_rist_nack_received_total` | counter | NACKs received from the peer — sender side |
| `bilbycast_edge_rist_retransmit_total` | counter | Packets retransmitted in response to NACKs — sender side |
| `bilbycast_edge_rist_packets_lost_total` | counter | Packets not recovered by ARQ, dropped before delivery — receiver side |
| `bilbycast_edge_rist_packets_recovered_total` | counter | Lost packets subsequently recovered — receiver side |

**Each leg only ever fills its own half of that table.** The three receiver-side counters
move on `leg_role="input"` and sit at `0` on `leg_role="output"`; the two sender-side
counters do the reverse. A ratio that mixes the halves on one leg divides by zero. Pair
`packets_recovered_total` with `nack_sent_total` on the receiving node, and
`retransmit_total` with `nack_received_total` on the sending one.

`packets_lost_total` alone will not separate a genuinely clean link from one whose ARQ is
quietly carrying it — both read near zero. Read it against `nack_sent_total`.

## Bonding

Fourteen families, emitted for flows using a bonded input or output. Only the
`bilbycast-bonding` transport populates them; native libsrt socket-group bonding does not
appear here. See [Multi-Path Bonding](/edge/bonding/).

Every series carries `flow_id` and `leg_role`, plus `output_id` on the send side. The
per-path series add `path_id`, `path_name` and `transport`.

### Per bond leg

| Metric | Type | Description |
|--------|------|-------------|
| `bilbycast_edge_bond_gaps_recovered` | counter | Sequence gaps closed by the bond's ARQ — receiver side |
| `bilbycast_edge_bond_gaps_lost` | counter | Sequence gaps that could not be recovered — receiver side |
| `bilbycast_edge_bond_packets_duplicated` | counter | Packets the scheduler deliberately sent on more than one path — sender side |
| `bilbycast_edge_bond_throughput_bps` | gauge | Aggregate bond bandwidth, bits/sec — the sum of the per-path gauges |

### Per path

| Metric | Type | Description |
|--------|------|-------------|
| `bilbycast_edge_bond_rtt_ms` | gauge | Path round-trip time, milliseconds |
| `bilbycast_edge_bond_loss_fraction` | gauge | Recent loss rate on the path, `0.0`–`1.0` |
| `bilbycast_edge_bond_path_throughput_bps` | gauge | Bandwidth on this path, bits/sec |
| `bilbycast_edge_bond_path_dead` | gauge | `1` when the liveness probe has declared the path dead, `0` when alive. There is no `path_alive` |
| `bilbycast_edge_bond_path_packets_sent` | counter | Packets transmitted on the path |
| `bilbycast_edge_bond_path_packets_received` | counter | Packets received on the path |
| `bilbycast_edge_bond_path_retransmits_sent` | counter | ARQ retransmits emitted on the path — sender side |
| `bilbycast_edge_bond_path_nacks_sent` | counter | NACKs emitted on the path — receiver side |
| `bilbycast_edge_bond_path_nacks_received` | counter | NACKs received on the path — sender side |
| `bilbycast_edge_bond_path_keepalives_sent` | counter | Keepalives sent to hold the path open |

Both throughput gauges track the media byte counter — media plus ARQ, duplicates and the
bond header. They exclude proactive FEC repair and the AEAD envelope, so on a bond running
FEC they read below the real wire load. The gross figures exist as `fec_throughput_bps`
and `wire_throughput_bps` on the JSON stats surfaces only.

## TR-101290

Ten counter families, labelled `flow_id`, carrying the analyzer's **lifetime** totals.
Emitted per flow only while the analyzer is populated, so a flow with the analyzer off
gaps rather than reporting zero. PCR is split across two families — there is no combined
`_pcr_errors_total`.

| Metric | Type | Description |
|--------|------|-------------|
| `bilbycast_edge_tr101290_ts_packets_total` | counter | TS packets examined — the denominator for every rate below |
| `bilbycast_edge_tr101290_sync_byte_errors_total` | counter | `0x47` sync-byte mismatches |
| `bilbycast_edge_tr101290_cc_errors_total` | counter | Continuity-counter discontinuities |
| `bilbycast_edge_tr101290_pat_errors_total` | counter | PAT errors |
| `bilbycast_edge_tr101290_pmt_errors_total` | counter | PMT errors |
| `bilbycast_edge_tr101290_pid_errors_total` | counter | PID errors — an advertised ES PID is absent |
| `bilbycast_edge_tr101290_tei_errors_total` | counter | Transport error indicator set |
| `bilbycast_edge_tr101290_crc_errors_total` | counter | CRC-32 errors on PAT/PMT sections |
| `bilbycast_edge_tr101290_pcr_discontinuity_errors_total` | counter | PCR discontinuity errors |
| `bilbycast_edge_tr101290_pcr_accuracy_errors_total` | counter | PCR accuracy errors |

The Priority 1 / 2 / 3 pass-fail rollups are computed over a rolling window and are not
Prometheus families — they ride the JSON stats surfaces. On `/metrics` you build the
equivalent yourself from `rate()` over these counters.

## Media analysis

Five families describing what the analyzer detected in the running flow's transport
stream. Emitted per flow while a media-analysis result exists. These are the only families
that carry no `# HELP` / `# TYPE` header.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `bilbycast_edge_media_video_info` | gauge | `flow_id`, `pid`, `codec`, `resolution`, `profile`, `level` | Always `1`; the video ES description rides as labels |
| `bilbycast_edge_media_video_framerate` | gauge | `flow_id`, `pid` | Detected frame rate. Emitted only once a rate is resolved |
| `bilbycast_edge_media_audio_info` | gauge | `flow_id`, `pid`, `codec`, `sample_rate`, `channels`, `language` | Always `1`; the audio ES description rides as labels |
| `bilbycast_edge_media_pid_bitrate_bps` | gauge | `flow_id`, `pid`, `type` | Per-ES bitrate. Suppressed when the measurement is `0` |
| `bilbycast_edge_media_total_bitrate_bps` | gauge | `flow_id` | Total measured bitrate. Suppressed when `0` |

Two shapes to plan for before you write a join:

- A field the analyzer has not resolved renders as the literal string `"unknown"` — the
  label is always present. This covers `resolution`, `profile` and `level` on
  `..._video_info`, and `sample_rate` and `channels` on `..._audio_info`.
- On `..._audio_info`, `language` is present **only** when the elementary stream declares
  one, so two series of the same family can carry different label sets.

`codec` values are display strings, not identifiers: `"H.264/AVC"`, `"H.265/HEVC"`,
`"AAC-LC"`, `"E-AC-3"`. `pid` is rendered in hex, e.g. `pid="0x0100"`.

```
bilbycast_edge_media_video_info{flow_id="hd-contribution",pid="0x0100",codec="H.264/AVC",resolution="1920x1080",profile="High",level="4.0"} 1
bilbycast_edge_media_video_framerate{flow_id="hd-contribution",pid="0x0100"} 25.00
bilbycast_edge_media_pid_bitrate_bps{flow_id="hd-contribution",pid="0x0100",type="video"} 8412000
bilbycast_edge_media_audio_info{flow_id="hd-contribution",pid="0x0101",codec="AAC-LC",sample_rate="48000",channels="2",language="eng"} 1
bilbycast_edge_media_pid_bitrate_bps{flow_id="hd-contribution",pid="0x0101",type="audio"} 128000
bilbycast_edge_media_total_bitrate_bps{flow_id="hd-contribution"} 8704000
```

## Replay storage

Node-level, unlabelled, and present on any binary built with the `replay` Cargo feature —
which is on by default and in all three published release artefacts. Unlike the per-flow
families these report `0` rather than vanishing when nothing is recording. See
[Replay](/edge/replay/).

| Metric | Type | Description |
|--------|------|-------------|
| `bilbycast_edge_replay_recordings_count` | gauge | Recordings on disk under the replay root |
| `bilbycast_edge_replay_recordings_bytes` | gauge | Bytes consumed by on-disk replay segments |
| `bilbycast_edge_replay_orphan_recordings_count` | gauge | Recordings that no currently-running flow is recording into |
| `bilbycast_edge_replay_orphan_bytes` | gauge | Bytes held by those orphan recordings |
| `bilbycast_edge_replay_root_free_bytes` | gauge | Free bytes on the replay-root filesystem |
| `bilbycast_edge_replay_root_total_bytes` | gauge | Size of the replay-root filesystem |

The two filesystem gauges are omitted entirely when the replay root cannot be stat'd —
it does not exist yet, or `statvfs` failed — so treat their absence as "unknown", not zero.

Orphan bytes are the storage-creep alarm. A recording counts as orphaned the moment no
*running* flow is armed against it, so a stopped flow's recording is an orphan too: watch
`bilbycast_edge_replay_orphan_bytes` climbing while nobody is deliberately recording.

## Worked example

A scrape config for a small fleet, and the alerts worth having on day one.

```yaml
scrape_configs:
  - job_name: bilbycast-edge
    scrape_interval: 10s
    scrape_timeout: 5s
    static_configs:
      - targets:
          - edge-truck-1.example.tv:8080
          - edge-mcr-a.example.tv:8080
        labels:
          site: sydney

  # Same fleet with server.auth.public_metrics = false.
  - job_name: bilbycast-edge-authenticated
    scrape_interval: 10s
    scheme: https
    oauth2:
      client_id: prometheus
      client_secret_file: /etc/prometheus/bilbycast-edge.secret
      token_url: https://edge-mcr-b.example.tv:8080/oauth/token
    static_configs:
      - targets: ['edge-mcr-b.example.tv:8080']
```

A 10 s interval suits the whole surface — the bond and redundancy gauges move fastest, and
scrape volume is driven by series cardinality rather than frequency. Cardinality scales
with flows × outputs × legs × paths, plus one series per detected elementary stream; a node
running a dozen flows is a few hundred series.

```promql
# Input has stopped arriving on a flow that is still running.
rate(bilbycast_edge_flow_input_packets_total[1m]) == 0

# Detected input loss as a fraction of received packets. This is gross loss:
# a sequence gap is counted when it is seen, and a later FEC repair does not
# take it back, so subtract the recovery rate for the residual figure.
(rate(bilbycast_edge_flow_input_packets_lost[5m])
   - rate(bilbycast_edge_flow_input_fec_recovered_total[5m]))
  / rate(bilbycast_edge_flow_input_packets_total[5m]) > 0.0001

# Continuity errors — the first thing a broadcast operator is asked about.
rate(bilbycast_edge_tr101290_cc_errors_total[5m]) > 0

# An output shedding packets under backpressure.
rate(bilbycast_edge_flow_output_packets_dropped[5m]) > 0

# Any dead bond path, named.
bilbycast_edge_bond_path_dead == 1

# RTT spread across a bond's paths — the number that predicts reorder depth.
max by (flow_id) (bilbycast_edge_bond_rtt_ms)
  - min by (flow_id) (bilbycast_edge_bond_rtt_ms)

# Share of the bond each path is carrying; a leg near zero is dead weight.
bilbycast_edge_bond_path_throughput_bps
  / ignoring (path_id, path_name, transport) group_left
    bilbycast_edge_bond_throughput_bps

# PTP not locked. Pair with `for: 2m` on the alerting rule so a single
# re-acquisition does not page anyone.
bilbycast_edge_ptp_locked == 0

# The node restarted between scrapes. Use resets(), not changes(): uptime rises
# on every scrape, so changes() is true on any running node — only the drop back
# to zero marks a restart.
resets(bilbycast_edge_uptime_seconds[10m]) > 0

# Replay storage creeping while nothing is meant to be recording.
bilbycast_edge_replay_orphan_bytes
  / bilbycast_edge_replay_root_total_bytes > 0.5
```

## What is not on `/metrics`

A large part of the edge's telemetry is structured per-flow or per-output JSON that does
not flatten usefully into label sets. It reaches the manager on the WebSocket stats feed
and is served over REST at `GET /api/v1/stats` and `GET /api/v1/stats/{flow_id}` — see the
[API Reference](/edge/api-reference/). None of it has a Prometheus family:

- **Tunnels.** No `bilbycast_edge_tunnel_*` family exists. Per-tunnel counters are served
  at `GET /api/v1/tunnels` and `GET /api/v1/tunnels/{id}`.
- **ST 2110 red/blue redundancy.** The per-leg receive, forward and duplicate counters are
  JSON-only; the only redundancy signal on `/metrics` is
  `bilbycast_edge_flow_input_redundancy_switches_total`.
- **PID-bus per-ES counters** for assembled flows, and the per-output **PCR accuracy trust**
  reservoir.
- **Master-clock state**, **edge-added A/V skew** and **A/V mux interleave**.
- **Wire-pacing and egress de-jitter**, and **ingress de-jitter** buffer telemetry.
- **Display outputs**, **SDI port status**, **media-player playout** and the
  **content-analysis** tiers.
- **Bandwidth-monitor limit state.**
- **Events and alarms.** These are discrete state changes, not rates, and are not modelled
  as counters. Alert on them through the manager's event stream — see
  [Events & Alarms](/edge/events-and-alarms/).
