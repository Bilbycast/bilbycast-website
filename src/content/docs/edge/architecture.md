---
title: Architecture
description: bilbycast-edge system architecture, data flow model, and concurrency design.
sidebar:
  order: 5
---

## System Context

```
                          ┌─────────────────────────────┐
                          │     bilbycast-manager        │
                          │  (centralized monitoring)    │
                          └──────────┬──────────────────┘
                                     │ WebSocket
                                     │ (registration, commands)
                                     │
  ┌──────────────┐          ┌────────▼─────────────────────────────────────────────┐
  │   Operators  │──REST──▶ │                  bilbycast-edge                      │
  │  (API/Web)   │◀─WS────│                                                       │
  └──────────────┘          │  ┌─────────────────────────────────────────────────┐  │
                            │  │              CONTROL PLANE                      │  │
                            │  │                                                 │  │
                            │  │  ┌──────────┐  ┌────────────┐  ┌────────────┐  │  │
                            │  │  │ REST API │  │  Auth/JWT  │  │  Config    │  │  │
                            │  │  │ (axum)   │──│  (OAuth2)  │  │ (JSON +   │  │  │
                            │  │  │          │  │  RBAC      │  │  secrets)  │  │  │
                            │  │  └────┬─────┘  └────────────┘  └─────┬──────┘  │  │
                            │  │       │                              │         │  │
                            │  └───────┼──────────────────────────────┼─────────┘  │
                            │          │                              │            │
                            │  ┌───────▼──────────────────────────────▼─────────┐  │
                            │  │              DATA PLANE                        │  │
                            │  │                                                │  │
                            │  │  ┌──────────────────────────────────────────┐  │  │
                            │  │  │           FlowManager (DashMap)          │  │  │
                            │  │  │                                          │  │  │
                            │  │  │   ┌─────────── Flow N ──────────────┐   │  │  │
                            │  │  │   │                                 │   │  │  │
                            │  │  │   │  ┌─────────┐       broadcast(N)│   │  │  │
                            │  │  │   │  │  Input  │──────┬──────────┐ │   │  │  │
                            │  │  │   │  │  Task   │      │          │ │   │  │  │
                            │  │  │   │  └─────────┘      ▼          ▼ │   │  │  │
                            │  │  │   │                ┌────────┐┌────────┐│  │  │
                            │  │  │   │                │Output-1││Output-N││  │  │
                            │  │  │   │                │  Task  ││  Task  ││  │  │
                            │  │  │   │                └────────┘└────────┘│  │  │
                            │  │  │   │                                 │   │  │  │
                            │  │  │   │  CancellationToken (parent)    │   │  │  │
                            │  │  │   │  StatsAccumulator (AtomicU64)  │   │  │  │
                            │  │  │   │  TR-101290 Analyzer            │   │  │  │
                            │  │  │   │  Media Analyzer (toggleable)   │   │  │  │
                            │  │  │   └─────────────────────────────────┘   │  │  │
                            │  │  │                                          │  │  │
                            │  │  └──────────────────────────────────────────┘  │  │
                            │  │                                                │  │
                            │  │  ┌────────────────┐    ┌───────────────────┐   │  │
                            │  │  │ StatsCollector │    │  TunnelManager   │   │  │
                            │  │  │ (lock-free     │    │  (QUIC relay/    │   │  │
                            │  │  │  AtomicU64)    │    │   direct)        │   │  │
                            │  │  └────────────────┘    └───────────────────┘   │  │
                            │  │                                                │  │
                            │  └────────────────────────────────────────────────┘  │
                            │                                                      │
                            │  ┌────────────────────────────────────────────────┐  │
                            │  │              MONITOR PLANE                     │  │
                            │  │  ┌──────────┐  ┌──────────────┐  ┌─────────┐  │  │
                            │  │  │Dashboard │  │ WS Stats     │  │Promethe-│  │  │
                            │  │  │(embedded │  │ (1/sec       │  │us /metr-│  │  │
                            │  │  │ HTML/JS) │  │  broadcast)  │  │ics     │  │  │
                            │  │  └──────────┘  └──────────────┘  └─────────┘  │  │
                            │  └────────────────────────────────────────────────┘  │
                            └──────────────────────────────────────────────────────┘

  ┌─────────────┐                        │                      ┌─────────────┐
  │ TS ingest   │─── SRT/RIST/RTP/UDP ───┤                      │ TS egress   │
  │ Contribution│─── RTMP / RTSP ────────┤     bilbycast-edge   ├── SRT/RIST ─│
  │ Web ingest  │─── WHIP / WHEP ───────►│     (data plane)     │── RTP/UDP ──│
  │ Uncompressed│─── ST 2110 / MXL ─────►│                      │── RTMP(S) ──│
  │ SDI capture │─── DeckLink ──────────►│                      │── HLS/CMAF ─│
  │ Node-local  │─── testgen, mosaic, ──►│                      │── WHEP ─────│
  │ sources     │    media_player,       │                      │── ST2110/MXL│
  │             │    replay, bonded      │                      │── SDI / HDMI│
  └─────────────┘                        │                      └─────────────┘
```

Those groupings are a summary, not the type list. The edge ships **23 input
variants** and **20 output variants** on `InputConfig` / `OutputConfig` — the
current sets, with per-type fields, are in
[Supported Protocols](/edge/supported-protocols/).

The flow fan-out channel drawn as `broadcast(N)` above is sized per flow by the
flow's **bandwidth profile**: `Standard` = 16 384 slots, `HighBitrate` =
32 768, `Uncompressed` = 65 536. The profile is derived automatically — any
ST 2110-20 / -23 or MXL-video input promotes the whole flow to `Uncompressed`,
everything else lands on `Standard`. `HighBitrate` is never auto-selected; it
is reachable only by setting `bandwidth_profile` explicitly on the flow.

## Data Plane: Packet Flow

```
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                              FlowRuntime                                   │
  │                                                                            │
  │  INGRESS                      FAN-OUT                      EGRESS          │
  │                                                                            │
  │  ┌──────────────┐                                                          │
  │  │  RTP Input   │  ┌────────────────┐                                      │
  │  │  ┌─────────┐ │  │  RP 2129       │                                      │
  │  │  │ UDP Recv │─┼──▶  Ingress      │                                      │
  │  │  └─────────┘ │  │  Filters       │     ┌───────────────────┐            │
  │  │  ┌─────────┐ │  │  ┌───────────┐ │     │  broadcast::      │            │
  │  │  │ FEC     │◀┼──┤  │ C5: Src IP│ │     │  channel(N)       │            │
  │  │  │ Decode  │ │  │  │ U4: PT    │ ├────▶│                   │            │
  │  │  │ (2022-1)│─┼──▶  │ C7: Rate  │ │     │  Sender ────┐    │            │
  │  │  └─────────┘ │  │  └───────────┘ │     │             │    │            │
  │  └──────────────┘  └────────────────┘     │             ▼    │            │
  │                                           │  ┌──────────────┐│  ┌────────┐│
  │  ┌──────────────┐                         │  │ subscribe()  ├┼─▶│RTP Out ││
  │  │  SRT Input   │                         │  └──────────────┘│  │+FEC Enc││
  │  │  ┌─────────┐ │  ┌─────────────────┐   │  ┌──────────────┐│  │+DSCP   ││
  │  │  │ Leg A   │─┼──▶  Hitless Merge  │   │  │ subscribe()  ├┼─▶└────────┘│
  │  │  ├─────────┤ │  │  (2022-7)       ├──▶│  └──────────────┘│  ┌────────┐│
  │  │  │ Leg B   │─┼──▶  Seq dedup      │   │  ┌──────────────┐│  │SRT Out ││
  │  │  └─────────┘ │  └─────────────────┘   │  │ subscribe()  ├┼─▶│+Redund.││
  │  │  AES decrypt │                         │  └──────────────┘│  └────────┘│
  │  │  Auto-reconnect                        │  ┌──────────────┐│  ┌────────┐│
  │  └──────────────┘                         │  │ subscribe()  ├┼─▶│RTMP Out││
  │                                           │  └──────────────┘│  └────────┘│
  │  ┌──────────────┐                         │  ┌──────────────┐│  ┌────────┐│
  │  │  RTMP Input  │                         │  │ subscribe()  ├┼─▶│HLS Out ││
  │  │  ┌─────────┐ │                         │  └──────────────┘│  └────────┘│
  │  │  │ FLV→TS  │─┼───────────────────────▶│  ┌──────────────┐│  ┌────────┐│
  │  │  │ Muxer   │ │                         │  │ subscribe()  ├┼─▶│WebRTC  ││
  │  │  └─────────┘ │                         │  └──────────────┘│  └────────┘│
  │  │  H.264+AAC   │                         │                   │            │
  │  └──────────────┘                         └───────────────────┘            │
  │                                                                            │
  │  ┌──────────────┐                                                          │
  │  │  RTSP Input  │─── retina client ── H.264+AAC ── TsMuxer ──────────────▶│
  │  │  (IP camera) │    auto-reconnect                                        │
  │  └──────────────┘                                                          │
  │                                                                            │
  │  ┌──────────────┐                                                          │
  │  │  TR-101290   │◀── subscribe() ── (independent quality analyzer)         │
  │  │  Analyzer    │                                                          │
  │  └──────────────┘                                                          │
  │  ┌──────────────┐                                                          │
  │  │  Media       │◀── subscribe() ── (codec/resolution/fps detection)       │
  │  │  Analyzer    │    toggleable per-flow via media_analysis config          │
  │  └──────────────┘                                                          │
  └─────────────────────────────────────────────────────────────────────────────┘
```

## Concurrency & Shutdown Model

```
  main() shutdown signal (Ctrl+C)
  │
  ├─▶ FlowManager.stop_all()
  │     │
  │     ├─▶ Flow-1 cancel_token.cancel()
  │     │     ├─▶ input_task (child token) ──▶ exits select! loop
  │     │     ├─▶ tr101290_task (child)    ──▶ exits select! loop
  │     │     ├─▶ media_analysis (child)  ──▶ exits select! loop (if enabled)
  │     │     ├─▶ output-A (child token)   ──▶ exits select! loop
  │     │     └─▶ output-B (child token)   ──▶ exits select! loop
  │     │
  │     └─▶ Flow-N cancel_token.cancel()
  │           └─▶ (same hierarchy)
  │
  ├─▶ TunnelManager.stop_all()
  │
  └─▶ API server graceful shutdown

  Hot-add/remove (runtime, no restart):
  ├─ add_output()    ──▶ new child token + subscribe to broadcast
  └─ remove_output() ──▶ cancel child token only, others unaffected
```

## Security Layers

```
  External Request
  │
  ▼
  ┌────────────────────────────────────────┐
  │  Layer 1: TLS (default on)              │
  │  rustls + ring crypto                  │
  └────────────┬───────────────────────────┘
               ▼
  ┌────────────────────────────────────────┐
  │  Layer 2: OAuth 2.0 + JWT (HS256)     │
  │  /oauth/token → client_credentials    │
  │  Bearer token → HMAC-SHA256 verify    │
  │  Role-based: admin | monitor          │
  └────────────┬───────────────────────────┘
               ▼
  ┌────────────────────────────────────────┐
  │  Layer 3: Route-level RBAC            │
  │  Public:    /health, /oauth/token,   │
  │             /setup (gated by config) │
  │  Read-only: GET /api/v1/* (any role)  │
  │  Admin:     per-handler RequireAdmin  │
  │             extractor, NOT middleware │
  └────────────┬───────────────────────────┘
               ▼
  ┌────────────────────────────────────────┐
  │  Layer 4: Data plane ingress filters  │
  │  (RP 2129 / SMPTE trust boundaries)  │
  │  C5: Source IP allow-list (HashSet)   │
  │  U4: Payload type filter             │
  │  C7: Rate limiter (token bucket)     │
  └────────────────────────────────────────┘

  Tunnel Security:
  ┌────────────────────────────────────────┐
  │  QUIC + TLS 1.3 (quinn/rustls)        │
  │  E2E: ChaCha20-Poly1305 (AEAD)       │
  │  32-byte shared key per tunnel        │
  │  Manager generates + distributes keys │
  │  Relay is stateless (no auth/ACL)     │
  │  28 bytes overhead (12 nonce+16 tag)  │
  │  Per-tunnel PSK (direct mode)         │
  └────────────────────────────────────────┘

  SRT Security:
  ┌────────────────────────────────────────┐
  │  AES-128/192/256 encryption           │
  │  Passphrase auth (10-79 chars)        │
  └────────────────────────────────────────┘
```

The Layer 3 admin check is **not** middleware. The `/api/v1` stack proves only
that the bearer token is a valid, unexpired JWT; the role check is an opt-in
`RequireAdmin` extractor that each handler has to take as a parameter. It is
present on the flows, inputs and outputs handlers. Three write surfaces omit it
and are therefore reachable by any authenticated role, `monitor` included:

- `PUT /api/v1/ptp`
- `POST /api/v1/tunnels` and `DELETE /api/v1/tunnels/{id}`
- `POST` / `DELETE` on the four `/api/v1/flows/{id}/whip|whep` routes. The two
  `POST` offer handlers have a substitute check, but a conditional one: the
  per-flow `bearer_token` is enforced only when one is configured on that
  flow's WebRTC input/output. The two `DELETE` handlers read no headers at
  all, so a configured `bearer_token` does not cover them either — any valid
  token of any role can tear down a live session.

And when auth is disabled entirely — the shipped default — `RequireAdmin`
returns `Ok` unconditionally, so the admin/read-only distinction is moot on
every route until you turn auth on.

## Module Dependency Graph

```
                                 ┌──────────┐
                                 │  main.rs │
                                 └────┬─────┘
                                      │ 17 top-level modules
        ┌───────────┬───────────┬─────┴─────┬───────────┬───────────┐
        ▼           ▼           ▼           ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌────────┐ ┌─────────┐ ┌─────────┐
   │   api   │ │ engine  │ │  config  │ │ tunnel │ │ manager │ │ monitor │
   └────┬────┘ └────┬────┘ └──────────┘ └───┬────┘ └────┬────┘ └─────────┘
        │           │                       │           │
        └──────────▶│◀──────────────────────┴───────────┘
                    │
      ┌──────┬──────┴──┬───────────┬─────────┬─────────┬─────────┐
      ▼      ▼         ▼           ▼         ▼         ▼         ▼
   ┌─────┐┌─────┐┌────────────┐┌───────┐┌─────────┐┌────────┐┌────────┐
   │stats││ fec ││ redundancy ││ media ││ display*││replay* ││  srt   │
   └─────┘└─────┘└────────────┘└───────┘└─────────┘└────────┘└────────┘

   Cross-cutting, reached from everything above:
   util  ·  observability  ·  upgrade  ·  setup

   * feature-gated: `display` (Linux, `--features display`) and `replay`
     (`--features replay`). Both features are ON by default.
```

## Adding New Input/Output Types

Current pattern requires changes in these locations:

| Step | File | Change |
|------|------|--------|
| 1 | `src/config/models.rs` | Add variant to `InputConfig` or `OutputConfig` enum |
| 2 | `src/config/validation.rs` | Add validation rules for the new variant |
| 3 | `src/config/secrets.rs` | Add secret fields to `InputSecrets`/`OutputSecrets`, update `extract_from`/`merge_into`/`strip_secrets`/`has_secrets` |
| 4 | `src/engine/input_xxx.rs` or `output_xxx.rs` | Create the new task module |
| 5 | `src/engine/mod.rs` | Declare `pub mod` |
| 6 | `src/engine/flow.rs` | Add `match` arm in `start()` or `start_output()` |
| 7 | `src/engine/flow.rs` | Add config metadata extraction |

The spawn function signature convention — `spawn_udp_output` in full:
```rust
pub fn spawn_udp_output(
    config: UdpOutputConfig,
    broadcast_tx: &broadcast::Sender<RtpPacket>,
    output_stats: Arc<OutputStatsAccumulator>,
    cancel: CancellationToken,
    input_format: Option<InputFormat>,
    frame_rate_rx: Option<tokio::sync::watch::Receiver<Option<f64>>>,
    events: EventSender,
    av_sync_pacer: Option<Arc<crate::engine::av_sync_mux::AvSyncPacer>>,
    active_input_rx: tokio::sync::watch::Receiver<String>,
) -> JoinHandle<()>
```

Only the first four parameters — `config`, `broadcast_tx`, `output_stats`,
`cancel` — are a fixed prefix. After that each output takes what its transport
actually needs: `spawn_rtp_output` takes eight (no `input_format`),
`spawn_rist_output` nine (adds `flow_id`, drops `input_format`),
`spawn_hls_output` six (`event_sender` + `flow_id`). Every output must accept
and wire an `events: EventSender` so it can report `bind_failed` /
`port_conflict`, and any output that paces also takes `av_sync_pacer` +
`active_input_rx`. When the tail gets long, bundle it into a context struct the
way `spawn_srt_output` does — it takes five parameters, with everything past
`cancel` folded into `SrtOutputCtx`.

## Backpressure & QoS

```
  Input ──▶ broadcast::channel(16384 / 32768 / 65536) ──▶ Output subscribers
  (slot count set per flow by its bandwidth profile — see System Context)

  Slow output?
  ├─ recv() returns RecvError::Lagged(n)
  ├─ Output increments packets_dropped (AtomicU64)
  ├─ Input is NEVER blocked (other outputs unaffected)
  └─ No cascading backpressure

  SRT output inner buffer:
  ├─ mpsc queue: 4096 slots AND an 8 MiB byte ceiling, whichever binds first
  ├─ an empty queue always admits one item, however large
  │    → the real bound is max(8 MiB, largest single item)
  ├─ try_send() (non-blocking) — drops if full
  └─ Separate from broadcast backpressure

  Crossover is 2048 B/item: publishers that emit whole access units
  (RTMP / RTSP) hit the byte ceiling first, 188-byte TS publishers hit
  the slot count first.

  RTP output:
  └─ Direct send from broadcast receiver (no intermediate buffer)
```
