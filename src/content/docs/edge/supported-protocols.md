---
title: Supported Protocols
description: Complete protocol reference for bilbycast-edge — all input and output protocols.
sidebar:
  order: 2
---

## Overview

bilbycast-edge is a media gateway supporting multiple transport protocols for professional broadcast and streaming workflows.

Optional audio and video codec paths ship as Cargo features. The default build enables `fdk-aac` (in-process AAC via Fraunhofer FDK AAC) and `video-thumbnail` (FFmpeg libavcodec/libswscale for in-process video decode + JPEG encode + Opus/MP2/AC-3 audio encode). H.264/HEVC software video encoding requires `video-encoder-x264` (GPL), `video-encoder-x265` (GPL), or `video-encoder-nvenc` (NVIDIA GPU required); the `*-full` release channel bundles all three. The full video-encode reference, per-codec defaults, and licence breakdown live in `bilbycast-edge/docs/transcoding.md` in the repo.

## Input Protocols

### RTP (SMPTE ST 2022-2)
- **Direction:** Input
- **Transport:** UDP unicast or multicast, IPv4 and IPv6
- **Payload:** MPEG-2 Transport Stream in RTP per SMPTE ST 2022-2
- **Features:**
  - SMPTE 2022-1 FEC decode (column + row parity)
  - IGMP/MLD multicast group join with interface selection
  - Source IP allow-list filtering (RP 2129 C5)
  - RTP payload type filtering (RP 2129 U4)
  - Per-flow ingress rate limiting (RP 2129 C7)
  - DSCP/QoS marking on egress (RP 2129 C10)
  - VSF TR-07 mode: auto-detects JPEG XS streams

### UDP (Raw MPEG-TS)
- **Direction:** Input
- **Transport:** UDP unicast or multicast, IPv4 and IPv6
- **Payload:** Raw MPEG-TS datagrams (no RTP headers required)
- **Features:**
  - Accepts any UDP datagram (no RTP v2 header filtering)
  - IGMP/MLD multicast group join with interface selection
  - Compatible with OBS, ffmpeg `udp://` output, srt-live-transmit, VLC

### SRT (Secure Reliable Transport)
- **Direction:** Input
- **Transport:** UDP with ARQ retransmission
- **Modes:** Caller, Listener, Rendezvous
- **Features:**
  - AES-128/192/256 encryption (AES-CTR default, AES-GCM authenticated encryption selectable via `crypto_mode`)
  - Stream ID access control (`stream_id`, max 512 chars per SRT spec; supports `#!::r=name,m=mode,u=user` structured format)
  - FEC (Forward Error Correction) via `packet_filter` — XOR-based row/column parity, staircase layout, ARQ integration modes (`always`/`onreq`/`never`), wire-compatible with libsrt v1.5.5
  - Configurable latency buffer (symmetric or asymmetric receiver/sender latency)
  - Retransmission bandwidth capping (Token Bucket shaper via `max_rexmit_bw`)
  - SMPTE 2022-7 hitless redundancy merge (dual-leg input)
  - Automatic reconnection
  - **`transport_mode: "audio_302m"`** (deferred — see [Audio Gateway — Limitations](/edge/audio-gateway/#limitations-and-deferred-items)): demux SMPTE 302M LPCM-in-MPEG-TS from `ffmpeg -c:a s302m`, `srt-live-transmit`, or hardware encoders, and republish as RTP audio packets onto the broadcast channel

### RIST (VSF TR-06-1 Simple Profile)
- **Direction:** Input and Output
- **Transport:** UDP with RTCP NACK-driven retransmission
- **Implementation:** `bilbycast-rist`, a two-crate workspace (`rist-protocol` + `rist-transport`). Wire-verified against librist 0.2.11 `ristsender` / `ristreceiver`
- **Features:**
  - Reliable RTP over UDP with RTCP NACK retransmission, RTT echo, SDES, and NTP-aligned RTP timestamps
  - Dynamic RTCP source-address learning so receivers work through NAT
  - SMPTE 2022-7 bonding handled in the protocol layer (not just at the broadcast channel)
  - MPTS passthrough or per-output MPTS→SPTS filter via `program_number`
  - Optional `audio_encode` on the TS (same codec matrix as SRT / UDP / RTP)
  - Optional `video_encode` on the TS (same encoders as SRT / UDP / RTP)
  - Optional output `delay` block (`fixed`, `target_ms`, `target_frames`)

### `rtp_audio` (RFC 3551 PCM over RTP, no PTP)
- **Direction:** Input and Output
- **Transport:** UDP unicast or multicast, IPv4 and IPv6
- **Payload:** Big-endian L16 or L24 PCM in standard RFC 3551 RTP
- **Why it exists:** Wire-identical to SMPTE ST 2110-30 but with relaxed
  constraints — sample rates 32 / 44.1 / 48 / 88.2 / 96 kHz, no PTP
  requirement, no RFC 7273 timing reference, no NMOS `clock_domain`
  advertising. Use this for radio contribution feeds over the public
  internet, talkback between studios that don't share a PTP fabric, and
  ffmpeg / OBS / GStreamer interop where ST 2110-30's PTP assumption
  is overkill.
- **Features:**
  - Same `transcode` block as ST 2110-30 outputs (sample-rate / bit-depth
    / channel routing — see [Audio Gateway](/edge/audio-gateway/))
  - SMPTE 2022-7 dual-leg redundancy
  - Source IP allow-list filtering
  - **Output also supports** `transport_mode: "audio_302m"` to wrap the
    audio as SMPTE 302M-in-MPEG-TS inside RFC 2250 RTP/MP2T (PT 33)
    — useful for hardware decoders that consume MPEG-TS over RTP

### Bonded (multi-path aggregation)
- **Direction:** Input and Output
- **Transport:** N heterogeneous paths over UDP, QUIC (RFC 9221 DATAGRAM),
  or RIST Simple Profile, chosen per-path
- **Payload:** Any bytes — MPEG-TS, RTP, or raw — framed inside a 12-byte
  bond header with a 32-bit sequence across all paths
- **Scheduler:** `media_aware` default (walks H.264/HEVC NAL units and
  duplicates IDR frames across the two lowest-RTT paths), `weighted_rtt`,
  or `round_robin`
- **Why it exists:** Carrier-grade path aggregation for broadcast — the
  capability typically sold as a dedicated bonded-cellular encoder or
  SD-WAN bonding appliance, built directly into the edge. Outperforms
  per-protocol bonding (SRT groups, RIST 2022-7) on mixed-link
  heterogeneous scenarios, with frame-accurate failover via IDR
  duplication rather than stream-wide doubling
- **Features:**
  - NACK-driven ARQ over a 32-bit sequence space with per-path retransmit
    targeting
  - Reassembly buffer with configurable `hold_ms` for late-arrival
    tolerance
  - Per-path keepalives → live RTT, jitter, loss, throughput stats
    exposed through the manager UI and Prometheus
  - QUIC paths negotiate ALPN `bilbycast-bond` (self-signed dev mode
    and production PEM mode both supported)
  - `program_number` filter on the output side for MPTS → SPTS
    down-selection before bonding
- **When not to use it:** Use libsrt socket groups for two SRT legs to
  the same receiver, RIST SMPTE 2022-7 for two RIST legs. Bonded is
  the universal option for N ≥ 2 heterogeneous links carrying any
  inner protocol — see [Multi-Path Bonding](/edge/bonding/) for the
  full reference.

## Output Protocols

### RTP (SMPTE ST 2022-2)
- **Direction:** Output
- **Transport:** UDP unicast or multicast
- **Payload:** RTP-wrapped MPEG-TS packets with RTP headers
- **Features:**
  - SMPTE 2022-1 FEC encode
  - DSCP/QoS marking (default: 46 Expedited Forwarding)
  - Multicast with interface selection
  - **MPTS passthrough** (default) or optional MPTS→SPTS program filter via `program_number`

### UDP (Raw MPEG-TS)
- **Direction:** Output
- **Transport:** UDP unicast or multicast
- **Payload:** Raw MPEG-TS datagrams (7×188 = 1316 bytes, no RTP headers)
- **Features:**
  - Strips RTP headers when input is RTP-wrapped
  - TS sync detection and packet alignment
  - DSCP/QoS marking
  - Compatible with ffplay, VLC, multicast distribution
  - **MPTS passthrough** (default) or optional MPTS→SPTS program filter via `program_number`
  - **`transport_mode: "audio_302m"`**: when the upstream input is an audio
    essence, run the per-output transcode + SMPTE 302M packetizer +
    TsMuxer pipeline and emit 7×188-byte MPEG-TS chunks containing
    48 kHz LPCM (16/20/24 bit, 2/4/6/8 channels) as plain UDP datagrams.
    Useful for legacy hardware decoders that consume raw MPEG-TS over
    UDP. Mutually exclusive with `program_number`. See
    [Audio Gateway](/edge/audio-gateway/) for the full pipeline.

### SRT (Secure Reliable Transport)
- **Direction:** Output
- **Modes:** Caller, Listener, Rendezvous
- **Features:**
  - AES encryption (AES-CTR or AES-GCM via `crypto_mode`)
  - Stream ID access control (`stream_id`, max 512 chars; callers send during handshake, listeners filter)
  - FEC (Forward Error Correction) via `packet_filter` — same capabilities as SRT input
  - Asymmetric latency support (independent receiver/sender latency)
  - Retransmission bandwidth capping (Token Bucket shaper)
  - SMPTE 2022-7 hitless redundancy duplication (dual-leg output)
  - Non-blocking mpsc bridge prevents TCP backpressure from affecting other outputs
  - Automatic reconnection
  - **MPTS passthrough** (default) or optional MPTS→SPTS program filter via `program_number`
  - **`transport_mode: "audio_302m"`**: when the upstream input is an
    audio essence, run the per-output transcode (force 48 kHz, even
    channels, 16/20/24-bit) + SMPTE 302M packetizer + TsMuxer (BSSD
    registration descriptor in PMT) + 1316-byte chunk bundling
    pipeline. Interoperable with `ffmpeg -c:a s302m`,
    `srt-live-transmit`, and broadcast hardware decoders that expect
    302M LPCM in MPEG-TS over SRT. Mutually exclusive with
    `packet_filter`, `program_number`, and 2022-7 redundancy. See
    [Audio Gateway](/edge/audio-gateway/) for the full pipeline,
    interop tests, and worked use cases.

### RTMP/RTMPS
- **Direction:** Input (publish) and Output (publish)
- **Transport:** TCP (RTMP) or TLS over TCP (RTMPS)
- **Use case:** Delivering to Twitch, YouTube Live, Facebook Live; ingesting from OBS, Wirecast, ffmpeg
- **Features:**
  - Native RTMP protocol implementation (handshake, chunking, AMF0)
  - Demuxes H.264 and AAC from MPEG-2 TS, muxes into FLV
  - Automatic AVC sequence header (SPS/PPS) and AAC config generation
  - Reconnection with configurable delay and max attempts
  - Non-blocking: uses mpsc bridge pattern, never blocks other outputs
  - **MPTS-aware:** on an MPTS input, selects program by `program_number` or (default) locks onto the lowest-numbered program in the PAT
  - **Optional `audio_encode` block (Phase B):** re-encodes audio so the operator can normalise bitrate / sample rate / channel count or upgrade to HE-AAC v1/v2 (`aac_lc`, `he_aac_v1`, `he_aac_v2`). With the default `fdk-aac` feature, AAC codecs encode in-process via FDK AAC (no ffmpeg needed). Same-codec passthrough fast path skips both decoder and encoder when the source is already AAC-LC and no overrides are set. Outputs without `audio_encode` keep working without ffmpeg installed. See [Audio Gateway — `audio_encode`](/edge/audio-gateway/#the-audio_encode-block--compressed-audio-egress-rtmp--hls--webrtc).
  - **Optional `video_encode` block:** H.264 targets emit classic FLV; HEVC targets emit Enhanced RTMP v2 extended VideoTagHeader (`hvc1` FourCC, hvcC assembled from the encoder's extradata). RTMP HEVC passthrough (no `video_encode`) also rides the E-RTMP path, with hvcC built from the demuxer's cached VPS/SPS/PPS.
- **Limitations:**
  - RTMPS (TLS) uses the `tls` feature (enabled by default).
  - Single-program by spec — only one program can be published per output.

### HLS Egress
- **Direction:** Output only
- **Transport:** HTTP PUT/POST over TCP
- **Use case:** YouTube HLS ingest (supports HEVC/HDR content)
- **Features:**
  - Segments MPEG-2 TS data into time-bounded chunks
  - Generates rolling M3U8 playlist
  - Configurable segment duration (0.5-10 seconds)
  - Optional Bearer token authentication
  - Async HTTP upload, non-blocking to other outputs
  - **MPTS passthrough** (default) or optional MPTS→SPTS program filter via `program_number` — filtered segments carry a rewritten single-program TS
  - **Optional `audio_encode` block (Phase B):** each segment is re-encoded with the configured audio codec and re-muxed back into MPEG-TS in-process (video PIDs pass through unchanged). Allowed codecs: `aac_lc`, `he_aac_v1`, `he_aac_v2`, `mp2`, `ac3`. AAC codecs use the in-process FDK AAC encoder (default `fdk-aac` feature); MP2 / AC-3 use in-process libavcodec on the default `video-thumbnail` build, with an ffmpeg subprocess fallback when the feature is disabled.
- **Limitations:**
  - Output only. Segment-based transport inherently adds 1-4 seconds of latency.
  - Uses a minimal built-in HTTP client (not a full HTTP/2 client).

### CMAF / CMAF-LL
- **Direction:** Output only
- **Transport:** HTTP(S) PUT to an ingest endpoint
- **Use case:** OTT distribution to CDNs that accept fragmented MP4 (CloudFront, Akamai, Fastly, bespoke origins) with simultaneous HLS (Apple) and MPEG-DASH (Widevine/PlayReady) player reach, low-latency live, and DRM-protected streams.
- **Implementation:** hand-rolled ISO-BMFF box writer (no MP4 crate dependency) in `engine/cmaf/`. Sibling of the HLS output with fragmented MP4 segments instead of TS.
- **Features:**
  - **Dual manifests:** emits `.m3u8` (HLS) and `.mpd` (DASH) off the same CMAF segment set — operators reach Apple and DASH players with a single push. `manifests` is a subset of `["hls", "dash"]` (default both).
  - **Standard CMAF:** whole-segment HTTP PUT — target `segment_duration_secs` (1.0-10.0, default 2.0), rolling playlist of `max_segments` (1-30, default 5).
  - **Low-latency CMAF (LL-CMAF):** `low_latency: true` enables chunked-transfer PUT + `#EXT-X-PART` in HLS and DASH `availabilityTimeOffset`. Chunk cadence set by `chunk_duration_ms` (100-2000, default 500). Sub-second end-to-end latency on a well-tuned CDN.
  - **Video passthrough or re-encode:** H.264 and HEVC source streams ride unchanged by default. Setting `video_encode` forces a `VideoDecoder` → `VideoEncoder` pipeline (x264/x265/NVENC, same schema as other outputs) with GoP alignment to `segment_duration_secs`. HEVC output is DASH-only — HLS fMP4 HEVC (`hvc1`) playback support varies by client, so prefer `manifests: ["dash"]` when encoding to HEVC.
  - **HEVC `hvc1`/`hev1` signalling:** DASH MPD carries the codec FourCC in the `<Representation codecs="...">` attribute; iOS Safari compatibility drives `hvc1` by default.
  - **Audio passthrough or re-encode:** AAC sources ride unchanged by default. Setting `audio_encode` runs the decode → optional `transcode` → re-encode pipeline with the AAC family only (`aac_lc`, `he_aac_v1`, `he_aac_v2`). MP2, AC-3, and Opus are not valid for CMAF.
  - **ClearKey CENC encryption** (ISO/IEC 23001-7 Common Encryption). Two schemes:
    - **`cenc`** — AES-CTR. Widevine and PlayReady standard. Pairs with DASH for the broadest DRM reach.
    - **`cbcs`** — AES-CBC with 1:9 pattern. FairPlay / Apple standard. Pairs with HLS for iOS / tvOS.
  - **DRM bring-your-own:** the edge emits a W3C EME ClearKey `pssh` box automatically; operators can additionally supply pre-built Widevine, PlayReady, and FairPlay `pssh` boxes via `encryption.pssh_boxes` and the edge copies them verbatim into the init segment's `moov`. Commercial DRM license servers are operator-managed (not part of bilbycast).
  - **Subsample encryption** keeps video NAL prefixes and parameter sets in the clear (first ~32 bytes per NAL), encrypts the rest. `senc`/`saio`/`saiz` boxes per segment.
  - **Optional Bearer auth** on uploads via `auth_token`.
  - **MPTS filtering:** optional `program_number` selector filters an MPTS input to a single program before segmenting.
  - **Never blocks the broadcast subscriber:** all codec work runs in `tokio::task::block_in_place`; the LL-CMAF chunked upload uses a bounded `mpsc(8)` with drop-on-full semantics so a slow CDN can't back-pressure the rest of the flow.
- **Limitations:**
  - Output only — bilbycast-edge does not ingest its own CMAF output (the playback side is any compliant HLS or DASH player).
  - HLS fMP4 HEVC clients are inconsistent; re-encoding to HEVC → HLS typically fails on older Apple devices. Recommended: `manifests: ["dash"]` when re-encoding HEVC, or stick to H.264 when serving HLS.
  - `transcode` requires `audio_encode` to be set — it has no effect on passthrough audio and is rejected at validation.
- **Reference:** see [Configuration — CMAF Output](/edge/configuration/#cmaf-output) for the field table and worked examples, and `bilbycast-edge/docs/cmaf.md` in the repo for the implementation deep-dive (threading model, segment boundary semantics, DASH manifest profile, CENC subsample algorithm).

### RTSP
- **Direction:** Input only
- **Transport:** TCP (interleaved) or UDP
- **Client library:** `retina`
- **Features:**
  - Pull H.264 or H.265/HEVC video and AAC audio from IP cameras and media servers
  - Digest and Basic authentication support
  - TCP interleaved (default, works through firewalls) or UDP transport
  - Automatic reconnection with configurable delay
  - Received media is muxed into MPEG-TS with proper PAT/PMT program tables
  - Audio-only streams supported (PAT/PMT emitted even without video)
- **Limitations:**
  - Input only (no RTSP server mode)
  - AAC audio is passed through as ADTS in MPEG-TS

### SMPTE ST 2110-20 / -23 (uncompressed video)
- **Direction:** Input and Output
- **Transport:** RFC 4175 RTP/UDP, multicast or unicast
- **Payload:** YCbCr 4:2:2 8-bit or 10-bit uncompressed. ST 2110-23 adds two partition modes on top of -20: **2SI** (two-sample interleave) for UHD over multiple 10 GbE pipes, and **sample-row** for higher framerates
- **PTP:** Best-effort PTP slave via external `ptp4l` — same wiring as the audio essences
- **Dual-network:** SMPTE 2022-7 Red/Blue bind on input and output
- **Egress pipeline:** The flow's MPEG-TS video ES is demuxed, decoded via `video-engine::VideoDecoder`, scaled into planar 4:2:2 8/10-bit via `VideoScaler`, then RFC 4175-packetised onto the wire (Red plus optional Blue). Outputs only need the default `video-thumbnail` feature
- **Ingress pipeline:** RFC 4175 depacketise to raw frames, feed through `video-engine::VideoEncoder` in a blocking worker, then `TsMuxer` into the flow. Inputs require a `video_encode` block and a compiled-in `video-encoder-*` feature (libx264, libx265, or NVENC)
- **Status:** Phase 2 shipped. ST 2110-22 (JPEG XS) is deferred pending a libjxs wrapper crate
- **NMOS:** Advertised as `urn:x-nmos:format:video` in IS-04, with BCP-004 receiver caps reflecting the configured width/height/framerate/sampling

### SMPTE ST 2110-30 / -31 (PCM / AES3 audio)
- **Direction:** Input and Output
- **Transport:** RFC 3551 RTP/UDP, multicast or unicast, with
  IGMP/MLD multicast group join and interface selection
- **Payload:** Big-endian L16/L24 PCM (-30) or AES3 sub-frames (-31,
  always 24-bit, transparent to Dolby E and AES3 user/channel-status
  bits)
- **Wire constraints:** sample_rate 48000 / 96000 Hz; bit_depth 16 or
  24; channels 1, 2, 4, 8, 16; packet_time 125 / 250 / 333 / 500 / 1000
  / 4000 µs; payload_type 96–127
- **PTP:** best-effort PTP slave via the external `ptp4l` daemon's
  management Unix socket. PTP state surfaces through stats; no
  in-process PTP daemon ships with the edge.
- **Features:**
  - SMPTE 2022-7 dual-network ("Red"/"Blue") bind on input and output,
    with hitless merge on input via `engine::st2110::redblue::RedBluePair`
  - Source IP allow-list filtering (single-leg only)
  - **Per-output PCM transcode** (`transcode` block): sample-rate / bit-depth
    / channel-routing conversion via the lock-free `engine::audio_transcode`
    stage. IS-08 channel-map activations propagate without flow restart
    via a `tokio::sync::watch` channel — see
    [Audio Gateway](/edge/audio-gateway/) for the full feature set,
    presets, and worked examples.
  - **Compressed-audio ingress (Phase A):** when the upstream flow input is AAC in MPEG-TS (carried over RTMP / RTSP / SRT / UDP / RTP), the in-process `engine::audio_decode::AacDecoder` turns it into f32 planar PCM so ST 2110-30 / -31 outputs — and the `srt` / `udp` / `rtp_audio` 302M output modes — can carry it without ffmpeg. Default FDK AAC backend supports AAC-LC, HE-AAC v1/v2, and multichannel up to 7.1; symphonia fallback supports AAC-LC mono/stereo only.
- **NMOS:** advertised as `urn:x-nmos:format:audio` in IS-04, with
  BCP-004 receiver caps reflecting the configured sample rate, channel
  count, and sample depth

### SMPTE ST 2110-40 (ancillary data)
- **Direction:** Input and Output
- **Transport:** RFC 8331 RTP/UDP
- **Payload:** Bit-packed RFC 8331 ANC (SCTE-104 ad markers, SMPTE 12M
  timecode, CEA-608/708 captions, AFD, CDP)
- **Features:**
  - Same SMPTE 2022-7 dual-network and source allow-list options as -30/-31
  - SCTE-104 messages auto-detected and emitted as `scte104` events
- **NMOS:** advertised as `urn:x-nmos:format:data` in IS-04. Receivers advertise `media_types: ["video/smpte291"]`.

### WebRTC (WHIP/WHEP)
- **Direction:** Input and Output
- **Transport:** UDP (ICE-lite/DTLS/SRTP) via the `str0m` WebRTC stack
- **Status:** Fully implemented. The `webrtc` feature is enabled by default.
- **Four modes:**
  - **WHIP input** (server): Accept contributions from OBS, browsers — endpoint at `/api/v1/flows/{id}/whip`
  - **WHIP output** (client): Push media to external WHIP endpoints (CDN, cloud)
  - **WHEP output** (server): Serve browser viewers — endpoint at `/api/v1/flows/{id}/whep`
  - **WHEP input** (client): Pull media from external WHEP servers
- **Video:** H.264 only on egress (browsers don't decode HEVC over WebRTC). HEVC sources are auto-transcoded to H.264 by the same `VideoDecoder` / `VideoEncoder` pair used for explicit `video_encode` — drop an HEVC SRT feed onto a WHEP output and browsers just work. Validation rejects `x265` / `hevc_nvenc` targets for WebRTC outputs. The encoder is opened with `global_header = false` so SPS/PPS ride in-band on every IDR and the RFC 6184 packetizer forwards them as ordinary NAL units
- **Audio:** Opus passthrough by default — Opus flows natively on WebRTC paths and gets muxed into MPEG-TS for SRT/RIST/RTP/UDP outputs. **Without `audio_encode`, AAC sources going to a WebRTC output automatically fall back to video-only.** Setting an `audio_encode` block (codec: `opus`) enables the Phase B chain: input AAC is decoded in-process via the Phase A `engine::audio_decode::AacDecoder` (FDK AAC by default, supporting AAC-LC / HE-AAC v1/v2 / multichannel) and re-encoded as Opus in-process via libavcodec + libopus (on the default `video-thumbnail` build; ffmpeg subprocess fallback when the feature is disabled), then written to the WebRTC audio MID via str0m. This is the marquee Phase A+B chain — **AAC RTMP contribution → Opus WebRTC distribution** — all inside one bilbycast-edge process with no external transcoder. Requires `video_only=false`.
- **MPTS-aware outputs:** on an MPTS input, WHIP/WHEP outputs select program by `program_number` or (default) lock onto the lowest-numbered program in the PAT. Single-program by spec.
- **Interoperability:** Compatible with OBS, browsers, Cloudflare, LiveKit, and other standard WHIP/WHEP implementations.
- **Security:** Bearer token authentication on WHIP/WHEP endpoints, DTLS/SRTP encryption, ICE-lite for server modes.
- **NAT traversal:** Configurable `public_ip` and optional `stun_server` for ICE candidate advertisement.

## MPEG-TS Program Handling

### MPTS / SPTS Support
- **All TS-carrying inputs** (UDP, RTP, SRT) accept both **SPTS** (single-program) and **MPTS** (multi-program) transport streams. Non-TS inputs (RTMP, RTSP, WebRTC) synthesise a single-program TS internally.
- **TS-native outputs** (UDP, RTP, SRT, HLS) pass the full MPTS through by default. Each output may opt into a per-program filter via `program_number`, which rewrites the PAT to a single-program form and drops packets for every PID that isn't part of the selected program. FEC (2022-1) and hitless redundancy (2022-7) protect the filtered bytes, so receivers see a valid SPTS.
- **Re-muxing outputs** (RTMP, WebRTC) and the **thumbnail generator** honour the same `program_number` field to select which program's elementary streams to extract. The default (unset) locks onto the lowest `program_number` in the PAT for deterministic behaviour.
- **Per-output scope:** one flow can fan an MPTS out to multiple outputs, each locked onto a different program, while a sibling output forwards the full MPTS unchanged.

## Video Transcoding (`video_encode`)

SRT, RIST, UDP, RTP, RTMP, and WebRTC outputs accept an optional `video_encode` block. TS-carrying outputs (SRT / RIST / UDP / RTP) run the streaming `engine::ts_video_replace::TsVideoReplacer`: the source video ES is demuxed, decoded via `video-engine::VideoDecoder`, re-encoded via `video-engine::VideoEncoder`, and re-muxed into the output TS — non-video PIDs (audio, PCR, PSI, ST 2110-40 ANC) pass through untouched. RTMP drives the same decoder/encoder pair, emitting classic FLV for H.264 targets and Enhanced RTMP v2 (`hvc1` FourCC, hvcC extradata) for HEVC targets. WebRTC is H.264-only and auto-transcodes HEVC sources.

Supported encoders (opt-in via Cargo features):

| Feature | Codec | Runtime |
|---|---|---|
| `video-encoder-x264` | H.264 via libx264 (GPL v2+) | CPU |
| `video-encoder-x265` | HEVC via libx265 (GPL v2+) | CPU |
| `video-encoder-nvenc` | H.264 / HEVC via NVIDIA NVENC (LGPL-clean API, requires NVIDIA GPU + driver) | GPU |
| `video-encoders-full` | All three, for `*-linux-full` release builds | — |

Default release builds (`*-linux`) ship AGPL-only without software encoders. The `*-linux-full` release channel bundles libx264 + libx265 + NVENC and is an AGPL-3.0-or-later combined work.

ST 2110-22 (JPEG XS) transcoding is deferred pending a libjxs wrapper. HLS `video_encode` is the last deferred transport — tracked in the repo's `transcoding.md`.

## Output Delay (path synchronisation)

SRT, RIST, RTP, and UDP outputs accept an optional `delay` block so parallel paths with different processing latencies stay aligned. Three modes:

- **`fixed`** — constant delay in milliseconds, applied at the output
- **`target_ms`** — self-adjusting target end-to-end latency in milliseconds
- **`target_frames`** — frame-accurate target latency using the auto-detected input frame rate, with optional ms fallback if the frame rate cannot be determined

Typical use case: a flow with a clean primary feed and a secondary feed that goes through an external loudness processor or captioning engine. Apply the right mode on the clean output to compensate for the extra latency on the processed path.

## Seamless Input Switching

Flows can be configured with multiple `input_ids`; only one is active at a time. Switching is driven by `POST /api/v1/flows/{id}/activate-input` and is zero-gap:

- A shared `TsContinuityFixer` (per flow) with per-input PSI caching resets CC state on switch, creating a clean-break CC jump so receivers resync
- The new input's cached PAT/PMT is injected with a bumped `version_number` (CRC32 recalculated) to force receivers to re-parse even when inputs share PSI version numbers
- All subsequent packets forward immediately — no buffering delay, no renegotiation

The switcher is fully format-agnostic: inputs can use different codecs, containers, and transports. A flow can have H.264 SRT on one input, HEVC RIST on another, JPEG XS on a third, and uncompressed ST 2110-20 on a fourth, and cut between them with no visible gap on the output.

For non-TS transports (raw ST 2110 RTP audio or video), the fixer is transparent.

## Monitoring and Analysis

### TR-101290 Transport Stream Analysis
- Priority 1: Sync byte, continuity counter, PAT/PMT presence
- Priority 2: TEI, PCR discontinuity, PCR accuracy
- Runs as independent broadcast subscriber (zero jitter impact)
- Skipped automatically for non-TS inputs (ST 2110-30/-31/-40, `rtp_audio`, WebRTC)

### MPEG-TS Program Analysis
- Parses PAT and every PMT from the input broadcast channel
- Reports **per-program stream breakdown** in the manager UI: each program's video PIDs (codec, resolution, frame rate, profile, level) and audio PIDs (codec, sample rate, channels, language)
- Handles PAT/PMT version bumps and programs coming/going mid-stream
- `program_count` in stats reflects the number of programs advertised in the PAT

### VSF TR-07 Awareness
- Auto-detects JPEG XS (stream type 0x61) in PMT
- Reports TR-07 compliance status via API and dashboard
- Enable with `tr07_mode: true` in RTP input config

### SMPTE Trust Boundary Metrics (RP 2129)
- Inter-arrival time (IAT): min/max/avg per reporting window
- Packet delay variation (PDV/jitter): RFC 3550 exponential moving average
- Filtered PDV (CMAX): peak-to-peak filtered metric
- Source IP filtering (C5), payload type filtering (U4), rate limiting (C7)
- DSCP/QoS marking (C10)
- Per-flow bandwidth monitoring for trust boundary enforcement
- Flow health derivation (M6): Healthy/Warning/Error/Critical

## Cargo Features

| Feature | Description | Default |
|---------|-------------|---------|
| `tls` | Enable RTMPS (RTMP over TLS) via `rustls` / `tokio-rustls` | **Yes** |
| `webrtc` | Enable WebRTC WHIP/WHEP input and output via `str0m` | **Yes** |
| `fdk-aac` | In-process AAC decode + encode via Fraunhofer FDK AAC (AAC-LC, HE-AAC v1/v2, multichannel up to 7.1). Replaces symphonia decode and the ffmpeg AAC encode subprocess | **Yes** |
| `video-thumbnail` | In-process video decode, JPEG thumbnail encode, uncompressed ST 2110-20/-23 video decode, and Opus / MP2 / AC-3 audio encode via FFmpeg libavcodec / libswscale / libopus. Eliminates all ffmpeg subprocess dependencies on the default build | **Yes** |
| `video-encoder-x264` | H.264 video transcoding via libx264. **GPL v2+** — binaries with this feature are an AGPL-3.0-or-later combined work | No |
| `video-encoder-x265` | HEVC video transcoding via libx265. **GPL v2+** — same combined-work implications as x264 | No |
| `video-encoder-nvenc` | NVIDIA NVENC H.264 / HEVC hardware encoders. LGPL-clean API layer; requires an NVIDIA GPU + proprietary driver at runtime | No |
| `video-encoders-full` | Composite: enables `video-encoder-x264` + `video-encoder-x265` + `video-encoder-nvenc`. Used by the `*-linux-full` release channel | No |

Default release binaries (`*-linux`) ship AGPL-only without software video encoders. The `*-linux-full` channel bundles GPL / NVENC encoders — see `bilbycast-edge/docs/transcoding.md` in the repo for the full licence breakdown and install steps.

## Architecture Notes

- All outputs subscribe to a shared broadcast channel independently
- Slow outputs receive `Lagged` errors and drop packets — they never block the input or other outputs
- TCP-based outputs (RTMP, HLS) use an mpsc bridge pattern to keep TCP operations off the broadcast receive path
- All monitoring (TR-101290, IAT/PDV, TR-07) runs on independent analyzer tasks with zero impact on the data plane
