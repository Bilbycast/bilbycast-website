---
title: Audio Gateway
description: Bridge AES67 / SMPTE ST 2110-30/-31 audio over the public internet, transcode sample rate / bit depth / channel routing per output, ship 48 kHz LPCM as SMPTE 302M-in-MPEG-TS, and re-encode compressed audio (AAC / HE-AAC / Opus / MP2 / AC-3) for RTMP, HLS, and WebRTC egress.
sidebar:
  order: 8
---

This page covers bilbycast-edge as an **IP audio gateway**: bridging
PCM audio between studios, carrying radio contribution feeds over the
public internet, distributing talkback over encrypted SRT links, and
interoperating with the standard broadcast tool stack (`ffmpeg`,
`srt-live-transmit`, hardware encoders/decoders that speak SMPTE 302M
LPCM-in-MPEG-TS). It also covers the compressed-audio bridge that
decodes AAC contribution feeds in-process (via Fraunhofer FDK AAC by
default — AAC-LC, HE-AAC v1/v2, multichannel up to 7.1) and re-encodes
them to AAC, HE-AAC v1/v2, Opus, MP2, or AC-3 on RTMP, HLS, WebRTC,
SRT, UDP, RTP, and RIST outputs. On the default build all codecs
encode in-process — AAC via FDK AAC (`fdk-aac` feature) and Opus /
MP2 / AC-3 via FFmpeg libavcodec + libopus (`media-codecs`
feature). An ffmpeg subprocess fallback is used only when those
features are disabled.

If you only want byte-identical SMPTE ST 2110-30/-31 passthrough on a
local broadcast plant, see [SMPTE ST 2110](/edge/st2110/) — that
remains the lowest-latency, zero-overhead path. This page covers
everything ST 2110 *can't* do on its own: format conversion, no-PTP
operation, WAN transport, and compressed-audio egress.

> **Why this exists.** bilbycast-edge originally shipped ST 2110 audio
> as strict byte-identical RTP passthrough — input and output format
> had to match exactly, and there was no signal processing on the
> audio path. That made it useless for the cases this guide covers.
> The audio gateway feature set turns that Phase 1 plumbing into a
> real audio gateway: per-output PCM transcoding, a generic `rtp_audio`
> variant with no PTP requirement, SMPTE 302M LPCM-in-MPEG-TS over
> SRT / UDP / RTP/MP2T, an in-process AAC decode bridge (FDK AAC) for
> compressed contribution audio, and an audio encoder for RTMP / HLS /
> WebRTC compressed egress (in-process FDK AAC for AAC codecs,
> in-process libavcodec + libopus for Opus / MP2 / AC-3 — an ffmpeg
> subprocess only when those features are compiled out).

---

## What you can do with it

| Task | Tool inside bilbycast-edge |
|---|---|
| Bridge AES67 stereo to a 44.1 kHz / 16-bit ST 2110-30 monitor | `transcode` block on the output |
| Sum a 5.1 surround source to stereo for monitoring | `transcode.channel_map_preset: "5_1_to_stereo_bs775"` |
| Carry a radio feed over the public internet to a third-party decoder | SRT output with `transport_mode: "audio_302m"` |
| Bridge audio between two studios that don't share a PTP fabric | `rtp_audio` input/output (no PTP requirement) |
| Hot-swap channel routing on a live monitor mix | IS-08 active channel map (`/x-nmos/channelmapping/v1.0/map/activate`) |
| Atomically start a multi-essence broadcast group (audio + ANC) | `start_flow_group` manager command |
| Send 24-bit LPCM to a hardware decoder that expects MPEG-TS over UDP | UDP output with `transport_mode: "audio_302m"` |
| Send 24-bit LPCM to a hardware decoder that expects RTP/MP2T (RFC 2250) | `rtp_audio` output with `transport_mode: "audio_302m"` |
| Ingest AAC contribution from an RTMP / RTSP / SRT / UDP / RTP-TS source and land it as PCM on ST 2110-30/-31 or SMPTE 302M | Phase A in-process `audio_decode` bridge (FDK AAC: AAC-LC, HE-AAC v1/v2, multichannel; symphonia fallback: AAC-LC mono/stereo) |
| Re-encode audio for YouTube / Twitch / HLS / WebRTC / SRT / RIST / UDP / RTP egress (AAC-LC, HE-AAC v1/v2, MP2, AC-3; Opus on `webrtc` only) | Phase B `audio_encode` block — AAC codecs encode in-process via FDK AAC, Opus / MP2 / AC-3 encode in-process via libavcodec on the default `media-codecs` build (ffmpeg subprocess fallback otherwise) |
| Deliver an AAC contribution to browsers as Opus in one hop | Combined Phase A + Phase B chain — RTMP AAC input → WebRTC WHEP Opus output |

---

## Audio inputs and outputs at a glance

| `type` | Direction | Wire format | PTP | Use case |
|---|---|---|---|---|
| `st2110_30` | Input + Output | RFC 3551 RTP, L16/L24 PCM, big-endian | Required for proper ST 2110-30 PM/AM profile | Local broadcast plant with shared PTP |
| `st2110_31` | Input + Output | RFC 3551 RTP, AES3 sub-frames in 24-bit | Required | Local plant transparent AES3 transport (preserves Dolby E) |
| `st2110_40` | Input + Output | RFC 8331 ANC | Required | SCTE-104 ad markers, SMPTE 12M timecode, captions |
| `rtp_audio` | Input + Output | RFC 3551 RTP, L16/L24 PCM | **Not required** | WAN contribution, talkback, ffmpeg/OBS interop |
| `srt` (with `transport_mode: audio_302m`) | Output | SMPTE 302M LPCM in MPEG-TS, over SRT | N/A | WAN transport with ARQ, ffmpeg/srt-live-transmit interop |
| `udp` (with `transport_mode: audio_302m`) | Output | SMPTE 302M LPCM in MPEG-TS, over UDP | N/A | Legacy hardware that expects raw TS over UDP |
| `rtp_audio` (with `transport_mode: audio_302m`) | Output | SMPTE 302M LPCM in MPEG-TS, wrapped in RFC 2250 RTP/MP2T (PT 33) | N/A | Hardware that expects MPEG-TS over RTP |

The `rtp_audio` input/output is wire-identical to ST 2110-30 (same RTP
header, same big-endian L16/L24 payload) but with relaxed validation —
sample rates 32 / 44.1 / 48 / 88.2 / 96 kHz, no `clock_domain`
requirement, no NMOS PTP advertising, no RFC 7273 timing reference.
Internally it shares the ST 2110-30 runtime with `clock_domain` forced
off so the same transcode stage, IS-08 hot reload, SMPTE 2022-7
redundancy, and per-output stats wiring all work for free.

---

## The `transcode` block — per-output PCM conversion

Every audio output (`st2110_30`, `st2110_31`, `rtp_audio`) accepts an
optional `transcode` field. When present, bilbycast-edge inserts a
per-output PCM conversion stage between the broadcast channel
subscriber and the RTP send loop:

```text
flow input (RFC 3551 RTP, any rate/depth/channels)
        │
        ▼
broadcast::channel<RtpPacket>
        │  subscribe
        ▼
┌──────────────────────────────────────┐
│  TranscodeStage (per output)         │
│  ┌────────────────────────────────┐  │
│  │ PcmDepacketizer                │  │
│  │   ↓                            │  │
│  │ decode big-endian PCM → f32    │  │
│  │   ↓                            │  │
│  │ apply channel matrix           │  │
│  │   (IS-08 active or static)    │  │
│  │   ↓                            │  │
│  │ rubato SRC (sinc or fast)      │  │
│  │   ↓                            │  │
│  │ encode f32 → big-endian PCM    │  │
│  │   (TPDF dither on down-cvt)    │  │
│  │   ↓                            │  │
│  │ PcmPacketizer                  │  │
│  └────────────────────────────────┘  │
└──────────────┬───────────────────────┘
               │
               ▼
       RTP socket send (Red + Blue legs)
```

When `transcode` is **absent**, the output runs the existing
byte-identical passthrough path — no allocation, no signal processing,
zero overhead. The transcoder only ever runs when the operator opts in
on a specific output.

The same three outputs also accept an optional `audio_track_index`
(`0`..=`15`). When the upstream input carries MPEG-TS (SRT, RTP, UDP,
RTMP, RTSP), it selects which audio elementary stream in the PMT is
de-embedded to PCM — `0` is the first audio track, `1` the second, and
so on. Unset takes the first audio track, and the field is ignored when
the input is already a native audio essence (ST 2110-30/-31,
`rtp_audio`). An index past the last audio track in the PMT is clamped
to the last one silently — no event is raised — so check the demuxer's
`TS demux: … audio PID` log line if a language selection lands on the
wrong track.

### Allowed values

```json
{
  "transcode": {
    "sample_rate": 44100,
    "bit_depth": 16,
    "channels": 2,
    "channel_map": [[0], [1]],
    "channel_map_preset": null,
    "packet_time_us": 4000,
    "payload_type": 96,
    "src_quality": "high",
    "dither": "tpdf"
  }
}
```

| Field | Allowed values | Default | Notes |
|---|---|---|---|
| `sample_rate` | `32000`, `44100`, `48000`, `88200`, `96000` | input sample rate | Pass-through if equal to input |
| `bit_depth` | `16`, `20`, `24` | input bit depth | L20 is carried as L24 with the bottom 4 bits zero per RFC 3190 §4.5 |
| `channels` | `1`..=`16` | input channel count | Must agree with `channel_map` length |
| `channel_map` | `[[in_ch, ...], ...]` | identity (or auto-promote) | One row per output channel; each row lists input channel indices to sum (unity gain) |
| `channel_map_with_gain` | `[[[in_ch, gain], ...], ...]` | none | Same shape as `channel_map` but each entry carries a linear gain: `1.0` = unity, `0.7071` ≈ −3 dB, `10.0` = +20 dB (the ceiling) |
| `channel_map_preset` | one of the named presets | none | Mutually exclusive with `channel_map` and `channel_map_with_gain` |
| `packet_time_us` | `125`, `250`, `333`, `500`, `1000`, `4000` | `1000` | 4 ms is a sensible default for talkback / WAN |
| `payload_type` | `96`..=`127` | `97` | RTP dynamic payload type |
| `src_quality` | `"high"`, `"fast"` | `"high"` | High = `rubato::SincFixedIn` (sinc, broadcast quality). Fast = `rubato::FastFixedIn` (polynomial, lower latency). |
| `dither` | `"tpdf"`, `"none"` | `"tpdf"` | TPDF triangular dither on bit-depth downconversion. `"none"` truncates. |

`channel_map`, `channel_map_with_gain` and `channel_map_preset` are
mutually exclusive — specify at most one. If all three are absent and
the input/output channel counts agree, the matrix defaults to identity.
If they differ by exactly mono→stereo (1→2) or stereo→mono (2→1), a
sensible default preset is auto-applied. Any other shape mismatch must
be specified explicitly via one of the three fields — the validator
rejects ambiguous configs at config load time.

### Channel routing presets

| Preset | Input ch | Output ch | Math |
|---|---|---|---|
| `mono_to_stereo` | 1 | 2 | L = R = ch0 |
| `stereo_to_mono_3db` | 2 | 1 | mono = (L + R) × 0.7071 (~ −3 dB) |
| `stereo_to_mono_6db` | 2 | 1 | mono = (L + R) × 0.5 (~ −6 dB) |
| `5_1_to_stereo_bs775` | 6 | 2 | ITU-R BS.775: Lt = L + (−3 dB)·C + (−3 dB)·Ls; Rt = R + (−3 dB)·C + (−3 dB)·Rs (LFE dropped). 5.1 channel order: L, R, C, LFE, Ls, Rs |
| `7_1_to_stereo_bs775` | 8 | 2 | ITU-R BS.775 extended: Lt = L + (−3 dB)·C + (−3 dB)·Lss + (−3 dB)·Lrs; Rt mirrors. 7.1 channel order: L, R, C, LFE, Lss, Rss, Lrs, Rrs |
| `4ch_to_stereo_lt_rt` | 4 | 2 | Lt = L + (−3 dB)·Ls; Rt = R + (−3 dB)·Rs. Quad order: L, R, Ls, Rs |

Need a custom routing matrix? Use `channel_map` directly. For example,
to route a 4-channel input where you want output ch0 = (in0 + in2) and
output ch1 = (in1 + in3):

```json
"channel_map": [[0, 2], [1, 3]]
```

`channel_map` treats every routed input as unity gain. For a custom
matrix with per-entry gains, use `channel_map_with_gain` instead — each
entry is `[in_ch, gain]`, the gain is linear (`1.0` = unity, `0.7071`
≈ −3 dB) and bounded `0.0`..=`10.0` (+20 dB). This swaps L/R and
attenuates the right channel by 3 dB:

```json
"channel_map_with_gain": [[[1, 1.0]], [[0, 0.7071]]]
```

### SRC quality and dither

bilbycast-edge uses [`rubato`](https://docs.rs/rubato) for sample rate
conversion. Two profiles:

- **`high`** — `SincFixedIn` with a 256-tap windowed sinc filter and
  256× oversampling. Broadcast monitoring quality. ~3-5 ms of conversion
  delay. CPU cost is several × the `fast` profile. **Default.**
- **`fast`** — `FastFixedIn` with linear polynomial interpolation and
  64-tap sinc. Lower CPU, ~1 ms latency, audibly worse on critical
  content. Use for talkback / IFB paths where pristine fidelity is not
  required.

Bit-depth down-conversion (e.g., L24 → L16) applies **TPDF**
(triangular probability density function) dither by default to break
quantization correlation. Set `dither: "none"` to truncate instead —
faster, slightly worse quality, only do this when the downstream is
going to dither anyway.

### IS-08 channel-map hot reload

When the operator activates a new IS-08 channel map via the NMOS REST
API (`POST /x-nmos/channelmapping/v1.0/map/activate`), every running
audio output's transcoder picks up the new routing on the next packet —
no flow restart, no audio glitch, no listener disconnect.

How it works under the hood:

1. `Is08State` holds a `tokio::sync::watch::Sender<Arc<ChannelMap>>`.
2. On activation, the new map is pushed through the watch channel.
3. Each per-output `TranscodeStage` holds a
   `MatrixSource::Is08Tracked` value with a `watch::Receiver` and the
   output's IS-08 id (e.g., `st2110_30:my-flow:my-output`).
4. On every packet, the transcoder calls `rx.has_changed()` (a single
   atomic load). If `false`, the cached per-output matrix is reused
   (an `Arc` clone). If `true`, the receiver snapshots the new map and
   recomputes the matrix once.

Steady-state cost on the hot path: one atomic load + one `Arc::clone`.
No locks, no allocations.

The per-output **static** `channel_map` from the operator's `transcode`
config is the **fallback** — if the IS-08 map has no entry for this
output, or its entry has zero channels, the static matrix is used.
Cross-input routing in IS-08 (where one output channel references a
different upstream input) is treated as muted on this output's
transcoder — single-flow audio routing only, by design.

### Stats

When a transcoder is active on an output, the per-output stats snapshot
gains a `transcode_stats` block:

```json
{
  "output_id": "monitor-stereo",
  "packets_sent": 12000,
  "bytes_sent": 3456000,
  "transcode_stats": {
    "input_packets": 12000,
    "output_packets": 11999,
    "dropped": 0,
    "format_resets": 0,
    "last_latency_us": 1820
  }
}
```

| Field | Meaning |
|---|---|
| `input_packets` | RTP packets the transcoder pulled from the broadcast channel |
| `output_packets` | RTP packets the transcoder emitted (may differ from input due to packet-time conversion) |
| `dropped` | Packets dropped inside the transcoder (decode error, malformed RTP, resampler failure). Distinct from broadcast-channel lag drops |
| `format_resets` | Times the transcoder rebuilt internal state due to a detected upstream format change |
| `last_latency_us` | Most recent end-to-end transcoder latency, microseconds (input recv timestamp → emit timestamp) |

When `transcode` is absent, `transcode_stats` is omitted from the
snapshot — the wire format stays clean for passthrough flows.

---

## The `rtp_audio` input/output — generic PCM/RTP without ST 2110 baggage

`rtp_audio` is the no-PTP variant of ST 2110-30. Same wire format
(RFC 3551 RTP + big-endian L16/L24 PCM payload), relaxed constraints:

- Sample rate: any of **32000, 44100, 48000, 88200, 96000 Hz**
- Bit depth: **16 or 24**
- Channels: **1..=16**
- Packet time: 125 / 250 / 333 / 500 / 1000 / 4000 / 20000 µs
- Dynamic payload type: 96..=127
- **No PTP requirement**, no RFC 7273 timing reference, no NMOS
  `clock_domain` advertising

Use it for radio contribution feeds over the public internet, talkback
between studios that don't share a PTP fabric, ffmpeg / OBS / GStreamer
interop, and any general PCM-over-RTP source where ST 2110-30's PTP
assumption is overkill.

### Example: `rtp_audio` input

```json
{
  "id": "perth-contribution-rx",
  "name": "Perth contribution receiver",
  "input": {
    "type": "rtp_audio",
    "bind_addr": "0.0.0.0:5004",
    "sample_rate": 48000,
    "bit_depth": 24,
    "channels": 2,
    "packet_time_us": 1000,
    "payload_type": 97
  },
  "outputs": []
}
```

### Example: `rtp_audio` output with transcoded downmix

```json
{
  "type": "rtp_audio",
  "id": "monitor-mix",
  "name": "Monitor stereo to control room",
  "dest_addr": "239.10.20.1:5004",
  "sample_rate": 48000,
  "bit_depth": 24,
  "channels": 2,
  "packet_time_us": 1000,
  "payload_type": 97,
  "transcode": {
    "sample_rate": 44100,
    "bit_depth": 16,
    "channels": 2,
    "channel_map_preset": "5_1_to_stereo_bs775"
  }
}
```

`rtp_audio` outputs share the `transcode` block exactly with ST 2110-30
outputs and reuse the same shared runtime — the only difference is that
the synthesized internal config has `clock_domain: None`, so the PTP
reporter and any NMOS `clock_domain` advertising are skipped.

---

## SMPTE 302M LPCM in MPEG-TS — `transport_mode: "audio_302m"`

SMPTE 302M is the broadcast industry standard for carrying lossless PCM
audio inside MPEG-2 transport streams. It avoids any audio codec
dependency (no AAC, no AC-3, no MP2), and it's exactly what
hardware encoders, hardware decoders, and the standard ffmpeg /
srt-live-transmit tool stack expect for lossless audio over MPEG-TS
contribution links.

bilbycast-edge packs 48 kHz LPCM (16 / 20 / 24 bit, 2 / 4 / 6 / 8
channels) as 302M private PES inside a single-program MPEG-TS, with
the PMT carrying the `BSSD` (`0x42535344`) registration descriptor that
identifies the elementary stream as 302M. The bit packing matches
ffmpeg's `libavcodec/s302menc.c` byte-for-byte; round trips through
bilbycast-edge's internal `S302mPacketizer` ↔ `S302mDepacketizer` are
sample-exact at 16-bit and within ±1 LSB at 24-bit (verified by unit
tests).

### Where it works

| Output | `transport_mode` | What it sends |
|---|---|---|
| `srt` | `"audio_302m"` | 7 × 188 byte (1316-byte) MPEG-TS chunks over an SRT live socket |
| `udp` | `"audio_302m"` | 7 × 188 byte MPEG-TS chunks as plain UDP datagrams |
| `rtp_audio` | `"audio_302m"` | 7 × 188 byte MPEG-TS chunks wrapped in an RFC 2250 RTP/MP2T packet (payload type 33) |

In all three modes, the runtime instantiates an internal pipeline:

```text
Transcode (force 48 kHz, even channels, 16/20/24-bit)
  → S302mPacketizer (4-byte AES3 header + bit-packed samples per pair)
  → TsMuxer.mux_private_audio (BSSD PMT + private PES on AUDIO_PID)
  → 1316-byte chunk bundling
  → SRT/UDP/RTP socket
```

When the upstream input is **not** 48 kHz, bilbycast-edge's transcode
stage (see above) automatically resamples it to 48 kHz before 302M
packetization — that's the explicit design choice, since 302M is
48-kHz-only per the spec. Mono inputs are auto-promoted to stereo;
odd-channel inputs are rounded up to the next even count (capped at 8
to stay within 302M's channel limits).

### Why 48 kHz only?

Per SMPTE 302M-2007, the audio sampling frequency is **48 kHz, full
stop**. Combined with bilbycast-edge's transcode stage, the design
pattern is: a 44.1 kHz radio feed gets resampled up to 48 kHz before
302M packetization, transported over SRT, and the receiving end
resamples back down to 44.1 kHz if it cares. This is exactly what
professional broadcast contribution links already do, and it
interoperates cleanly with every 302M-aware decoder in the wild.

### Mutually exclusive with FEC, program filtering, and 2022-7

The `audio_302m` mode is **mutually exclusive** with:

- `packet_filter` (SRT FEC) — bilbycast-edge's SRT FEC is XOR over TS
  payload bytes and doesn't usefully protect audio elementary stream
  content.
- `program_number` — 302M emits a single-program TS, by definition.
- SMPTE 2022-7 redundancy on the SRT output — the 302M output path
  doesn't yet duplicate to a second leg.

Validation rejects all three combinations at config load time. If you
need wire-level protection on a 302M-over-SRT link, rely on SRT's own
ARQ; if you need redundancy, run two parallel flows on independent
links.

### Interop tests

Four runnable shell scripts in
`testbed/audio-tests/302m-interop/` exercise the wire boundary against
the standard tool stack:

| Script | Direction | Status |
|---|---|---|
| `01-ffmpeg-to-bilbycast-srt.sh` | ffmpeg `-c:a s302m -f mpegts srt://...` → bilbycast-edge SRT input | **SKIPPED** until SRT 302M input demux lands (see [Limitations](#limitations-and-deferred-items)) |
| `02-bilbycast-to-ffmpeg.sh` | bilbycast-edge SRT 302M output → ffmpeg consumer → WAV verify | **READY** |
| `03-bilbycast-via-slt.sh` | bilbycast-edge → `srt-live-transmit` → bilbycast-edge | **SKIPPED** (depends on input demux) |
| `04-bilbycast-to-tee-ffprobe.sh` | bilbycast-edge → `srt-live-transmit` → `.ts` file → `ffprobe` codec verify | **READY** |

Each script auto-detects whether `ffmpeg` and `srt-live-transmit` are
installed; if either is missing, the script prints `SKIPPED:` and exits
0 so it can be run safely inside CI without forcing every CI worker to
have the broadcast tool stack installed.

---

## The `audio_decode` bridge — AAC contribution into PCM outputs (Phase A)

bilbycast-edge carries an in-process AAC decoder
(`engine::audio_decode::AacDecoder`) that turns compressed audio
carried inside MPEG-TS — whether delivered over RTMP, RTSP, SRT, UDP,
or RTP/MP2T — into f32 planar PCM on the broadcast channel. That PCM
is what the PCM-only outputs consume: ST 2110-30 (and via SMPTE 302M:
the `srt`, `udp`, and `rtp_audio` 302M output modes).

**Default (`fdk-aac` feature, on by default):** Fraunhofer FDK AAC
via FFI. Supports AAC-LC, HE-AAC v1 (SBR), HE-AAC v2 (PS), AAC-LD,
AAC-ELD, and multichannel up to 7.1. **Fallback (no `fdk-aac`
feature):** `symphonia-codec-aac` — AAC-LC mono/stereo only; HE-AAC
and multichannel are rejected with an `audio_decode` Critical event.

No ffmpeg is required for this path. The decoder is part of the
bilbycast-edge binary itself.

This is the Phase A half of the compressed-audio bridge. Combined with
the Phase B `audio_encode` block (below), it lets a single
bilbycast-edge process ingest an AAC RTMP contribution feed and emit
Opus over WebRTC to browsers — **no separate transcode box**.

---

## The `audio_encode` block — compressed-audio egress (RTMP / HLS / WebRTC)

bilbycast-edge originally treated audio on the RTMP, HLS, and WebRTC
outputs as **passthrough only**: AAC frames demuxed from the input TS
were re-wrapped into FLV / TS / RTP and sent on. That left two big
gaps:

1. **No bitrate / sample rate normalisation.** A 320 kbps AAC
   contribution feed went to YouTube at 320 kbps even when the
   operator wanted 96 kbps.
2. **WebRTC silently dropped audio entirely** when the source was AAC,
   because Opus is the only realistic WebRTC audio codec and there
   was no decode/encode bridge.

The `audio_encode` block, available on the RTMP, HLS, CMAF, WebRTC,
SRT, RIST, UDP, and RTP output types (TS outputs use the streaming
`engine::ts_audio_replace::TsAudioReplacer`, which rewrites the PMT
stream_type in place and leaves video / other PIDs untouched), fills
both gaps. When set, the output decodes the source audio in-process and
re-encodes via Phase B's `engine::audio_encode::AudioEncoder`. AAC
sources (stream_type `0x0F`) decode through the Phase A FDK AAC bridge;
on the default `media-codecs` build MP2 (`0x03` / `0x04`), AC-3
(`0x80` / `0x81` / `0xC1`), E-AC-3 (`0x87` / `0xC2`) and AAC-LATM
(`0x11`) decode through the in-process libavcodec bridge
(`engine::audio_decode::ff_codec_for_stream_type`) instead.

**Default build (`fdk-aac` + `media-codecs`, both on by default):**
all codecs encode in-process. AAC codecs (AAC-LC, HE-AAC v1, HE-AAC
v2) use Fraunhofer FDK AAC; Opus / MP2 / AC-3 use FFmpeg libavcodec
(+ libopus). No external subprocess, no ffmpeg binary on PATH
required. **Fallback (features disabled):** the encoder falls back to
an ffmpeg subprocess for the affected codecs. Outputs without
`audio_encode` set keep working regardless.

```jsonc
{
  "type": "rtmp",
  "id": "yt-rtmp",
  "name": "YouTube push",
  "dest_url": "rtmps://a.rtmps.youtube.com/live2",
  "stream_key": "...",
  "audio_encode": {
    "codec": "aac_lc",
    "bitrate_kbps": 96
  }
}
```

### Codec × output validity matrix

| Output | Allowed `codec` | Default | Notes |
|---|---|---|---|
| `rtmp` | `aac_lc`, `he_aac_v1`, `he_aac_v2` | `aac_lc` | FLV only carries AAC. With the default `fdk-aac` feature, all AAC profiles are encoded in-process. Without it, HE-AAC v2 requires an ffmpeg build with `libfdk_aac`. Each re-encoded tag (`silent_fallback` silence included) carries the raw access unit, the encoder's ADTS header removed, and the sequence header names the format that header does — for `he_aac_v1` / `he_aac_v2` its core: half the output rate (24 kHz for a 48 kHz output) and, for v2, mono, with SBR / PS signalled implicitly, as passthrough of an HE-AAC source always announced it. Up to and including v0.116.0 every re-encoded tag carried its 7-byte ADTS header, which ffmpeg read past and GStreamer's faad decoded nothing from, and an HE-AAC sequence header named the output rate and channels. The same-codec fast path, which passes the source's frames through, was never affected. |
| `hls` | `aac_lc`, `he_aac_v1`, `he_aac_v2`, `mp2`, `ac3` | `aac_lc` | HLS-TS supports MP2 (stream type 0x04) and AC-3 (private_stream_1) so long as the consumer's player does. |
| `cmaf` | `aac_lc`, `he_aac_v1`, `he_aac_v2` | `aac_lc` | AAC family only — MP2 / AC-3 / Opus are rejected. A `transcode` block on a CMAF output is rejected unless `audio_encode` is also set. Each re-encoded sample is the raw access unit and the track's `esds` names what the encoder's ADTS header does — for HE-AAC its core rate (also the track timescale) and, for v2, mono, SBR / PS signalled implicitly. Up to and including v0.116.0 every sample kept its 7-byte ADTS header inside the `mdat` and the track named the output rate under AAC-LC. Full field table: [CMAF Output](/edge/configuration/#cmaf-output). |
| `webrtc` | `opus` | `opus` | WebRTC realistically only does Opus. Validation also rejects `audio_encode` + `video_only=true` (an audio MID must be negotiated in SDP). |
| `srt`, `rist`, `udp`, `rtp` (TS outputs) | `aac_lc`, `he_aac_v1`, `he_aac_v2`, `mp2`, `ac3` | `aac_lc` | `TsAudioReplacer` rewrites the PMT stream_type in place and leaves video / other PIDs untouched. Mutually exclusive with `transport_mode: audio_302m`. **Opus is not in the allowed set on any of the four** — the validator refuses `codec: "opus"` on a TS output; use a `webrtc` output for Opus egress. |

The validator enforces this matrix at config load time and on every
`update_config` manager command — invalid combinations are rejected
without touching the running flows.

### Bitrate / sample rate / channel defaults

| Codec | Default bitrate (kbps) |
|---|---|
| `aac_lc` | 128 |
| `he_aac_v1` | 64 |
| `he_aac_v2` | 32 |
| `opus` | 96 |
| `mp2` | 192 |
| `ac3` | 192 |

If `sample_rate` is unset, the encoder uses the input PCM sample rate.
**Opus is always carried at 48 kHz on the wire** regardless of
`sample_rate`, per RFC 7587. If `channels` is unset, the encoder uses
the input channel count, mixed down to the codec's most when the codec takes
fewer (AC-3 to 5.1, the second surround pair folded into the first at
−3 dB; MP2 to stereo; WebRTC's Opus to stereo); when set, the ceiling is
per codec (see the
[validation quick reference](#validation-rules-quick-reference)).

### Other `audio_encode` fields

Beyond `codec` / `bitrate_kbps` / `sample_rate` / `channels`, the block
carries:

| Field | Meaning |
|---|---|
| `source_audio_pid` | Pin the transcoder to a specific audio PID (`0x0010`..=`0x1FFE`). Unset locks onto the **first** audio elementary stream in the active program's PMT. A configured PID that is absent from the live PMT falls back to that first-match behaviour and raises the Warning `audio_source_pid_not_found` rather than failing. The in-place transcoder is single-program, so producing two language variants needs one output per track, each with its own `program_number` filter and `source_audio_pid`. RTMP, CMAF, WebRTC and HLS outputs, which pick their track themselves, honour the pin too — see [Which audio track an RTMP, CMAF, WebRTC or HLS output takes](#which-audio-track-an-rtmp-cmaf-webrtc-or-hls-output-takes) below. |
| `silent_fallback` | Inject a continuous zero-filled PCM track whenever the source has no audio PID, or stops delivering audio mid-stream. Default `false`. Required by ingest services that gate their live-preview thumbnailer on the presence of audio, and by segmenters (WebRTC / CMAF-LL) that expect monotonic audio timestamps per segment. |
| `opus_vbr_mode` | `"vbr"` (constrained VBR) or `"cbr"`. Unset uses libopus's default (VBR). Opus only. |
| `opus_fec` | In-band forward error correction for the previous frame. Default off. Opus only. |
| `opus_dtx` | Discontinuous transmission — skip frames during silence. Default off. Opus only. |
| `opus_frame_duration_ms` | `5`, `10`, `20` (default), `40` or `60`. Opus only. |

The four `opus_*` knobs are **rejected at config load** on any codec
other than `opus`, so a stray setting surfaces as a validation error
instead of running with default Opus behaviour.

One caveat on those four: they only reach libopus through the **ffmpeg
subprocess** backend, where they become `-vbr` / `-fec` / `-dtx` /
`-frame_duration` arguments. The in-process libavcodec encoder a
default build uses for Opus is opened with codec / sample rate /
channels / bitrate only, so on every published release artefact the
`opus_*` fields validate but change nothing.

### AAC layouts, wider sources and configuration changes

- **7.1 targets.** An `aac_lc` target at `channels: 8` is written as channel configuration 0 with the program_config_element (PCE) of its layout — centre, front pair, surround pair, rear pair, LFE — in every frame (9 bytes a frame), and CMAF and RTMP carry that PCE in the track configuration too. fdk-aac's 7.1 mode is channel configuration 12, which an ADTS header cannot hold, so up to and including v0.116.0 every 7.1 AAC target (TS outputs, HLS, CMAF, RTMP) announced 4.0 with no layout. ffmpeg decodes it as 7.1, each input channel on its own output channel; receivers that followed the 4.0 header now get eight channels.
- **7.1 sources.** The AAC decoders hand out all eight channels of a 7.1 source, each in its own slot, which the channel stage converts to what each output carries: an AAC target with no `channels` keeps 7.1, AC-3 is mixed down to 5.1 and MP2 to stereo. A source in channel configuration 7 — how ffmpeg's `aac` and Nero write 7.1 into ADTS — is read as they mean it, and as ffmpeg and FAAD decode it: centre, then the front, side and back pairs, element by element, so the front pair stays front through every re-encode. fdk-aac reads configuration 7 by the letter of the standard, as 7.1 (wide); taken that way, its front pair would go out as a 7.1 AAC target's side pair and its side pair in front, and an AC-3 5.1 target would fold the front pair into the surrounds. A program_config_element naming three front elements (7.1 wide stated outright) is still decoded as fdk reads it. Up to and including v0.116.0 the decoder mixed anything wider than six channels down to 5.1, and an AC-3 or MP2 target with no `channels` lost the audio of a 7.1 E-AC-3 source.
- **PCE-signalled sources** (channel configuration 0 — ISDB-T 1seg, such as NHK's service). Such a source names its layout in a PCE that only some frames carry. RTMP and CMAF passthrough, and the replay MP4 export, copy the PCE into the track configuration, and a re-encode on RTMP, CMAF or WebRTC builds its decoder from it. RTMP, CMAF and WebRTC hold the audio back until the first frame that carries it (about half a second on NHK) and publish every frame from there; with none within 5 s of audio they raise the Warning `aac_channel_layout_missing` (once per wait) and go on holding. Up to and including v0.116.0 RTMP and CMAF published a two-byte configuration naming channel configuration 0 and no layout, which ffmpeg, GStreamer and faad refuse to open, and a re-encode refused the source.
- **Sources wider than stereo on RTMP and WebRTC.** With `audio_encode`, a 5.1 or 7.1 AAC source is decoded whole and goes through the channel stage, as an AC-3 one does: on RTMP kept at its layout or converted to `channels` / the `transcode` block's; on WebRTC mixed down to stereo for its Opus stream unless a count is set (an MP2, AC-3 or E-AC-3 source too, which used to open a multichannel Opus encoder no WebRTC peer reads). Up to and including v0.116.0 both outputs refused a wider AAC source with only a log line and published no audio.
- **A source whose AAC configuration changes** (a switch to another feed). An RTMP output sends a new sequence header with the first frame of the new configuration, as FLV publishers do; RTMP, CMAF and WebRTC re-encodes rebuild their decoder for it. Each frame is taken under the configuration it carries. A CMAF passthrough output cannot follow such a change, since its init is committed, and raises the Warning `aac_config_changed` (category `cmaf`, once per change); restart it, or set `audio_encode`, where sources of different configurations are switched. Up to and including v0.116.0 an RTMP output announced the first configuration for the whole connection (a 44.1 kHz source switched in after a 48 kHz one decoded 9 % fast) and the re-encodes kept their first decoder.
- **Opus as a source.** An `audio_encode` on a TS output or input now re-encodes a single mono or stereo Opus stream (the "Opus" registration descriptor, with no Opus extension descriptor or one naming channel configuration 1 or 2) to the configured codec, so an ingress `audio_encode` on a WHIP or WHEP input, whose audio is always Opus, now does what it says. Multistream Opus still passes through with `audio_transcode_source_not_found` (reason `codec_not_replaceable`). Up to and including v0.116.0 every Opus stream passed through that way.

### Which audio track an RTMP, CMAF, WebRTC or HLS output takes

These four outputs pick their audio track themselves rather than through the TS replacer, with or without `audio_encode`, and honour `audio_encode.source_audio_pid` when it is set:

- **RTMP, CMAF and WebRTC** take, unpinned, the program's **first audio stream they can publish**, and the first audio stream of all only when the program carries none. Without `audio_encode` the first stream they pass through comes first — AAC on RTMP and CMAF, Opus-in-TS on WebRTC — so an RTMP output on an ATSC program carrying AC-3 then AAC publishes the AAC; a program with none falls to the first stream they could publish through the block. A pin is taken when it names a track the output can publish; otherwise (absent from the PMT, not audio, or a codec the output cannot publish) the output takes the track it would take unpinned, and a later PMT that carries the pin moves it back.
- **A PMT update that drops every audio stream** leaves an output that demuxes the TS (RTMP, CMAF, WebRTC, the local display, SDI) on none: it stops demuxing the old PID, and a later PMT bringing audio back is selected afresh by the same rule. The same goes for the video and SCTE-35 PIDs. Only a PMT section whose CRC checks counts, so one damaged in transit changes nothing. Up to and including v0.116.0 the output stayed on the dropped PID and demuxed whatever still came on it.
- **HLS** takes, unpinned, the **last** audio stream it can decode, as before. A pin is taken when it names one it can decode; otherwise (absent, or AC-4 / DTS) it falls back to that last one. This is the in-process remux every release build runs; the ffmpeg-subprocess fallback of a build without `media-codecs` still takes ffmpeg's own choice and ignores the pin.

What each can publish: **RTMP and CMAF** carry AAC as it is, and MP2 / AC-3 / E-AC-3 / AAC-LATM re-encoded through `audio_encode` (on a `media-codecs` build; without one, AAC only) — never Opus-in-TS or AC-4. **WebRTC** carries Opus-in-TS, and AAC (plus MP2 / AC-3 / E-AC-3 / AAC-LATM on a `media-codecs` build) re-encoded to Opus through `audio_encode` — never AC-4.

Two Warnings say what happened:

- **`audio_source_pid_not_found`** (category `flow`, output-scoped, details `{ error_code, pinned_pid, actual_pid, actual_stream_type }`) whenever the output is on a track other than its pin, with a message naming the track it fell back to. Once per (pinned, actual) pair for the output's lifetime, re-armed when the pin reappears: a WebRTC output raises it once, not per WHEP viewer or WHIP reconnect, and an RTMP output not again on a reconnect.
- **`audio_codec_unpublishable`** (category `rtmp`, `cmaf` or `webrtc`, output-scoped, details `{ error_code, audio_pid, stream_type, source_codec, flow_id }`) when an RTMP, CMAF or WebRTC output is on a track it cannot publish. Pinned or not, that happens only when the program carries no audio stream the output can publish, which leaves it on the program's first. The output publishes none of the source's audio. Once per episode — not again while it stays on that PID and codec — and on WebRTC once for the output, not per viewer, and never on a `video_only` output. Under `silent_fallback`, RTMP and WebRTC now lay silence on such a track, which an AC-4 track used to hold off. A pin on that first stream raises this Warning alone; a pin on another stream raises `audio_source_pid_not_found` as well.

:::caution[Upgrading from v0.116.0 or earlier: check each pin]
Up to and including v0.116.0 these four outputs ignored `source_audio_pid`: RTMP, CMAF and WebRTC published the program's first audio stream whatever its codec — so an MPTS whose first audio track is AC-4 (or, on RTMP and CMAF, Opus-in-TS) published no audio, without a word — and HLS the last one it could decode. An output that carries a pin now publishes the pinned track, so check before upgrading that each pin names the track you want.
:::

### Same-codec passthrough fast path (RTMP only)

The RTMP output detects the case where you set
`audio_encode = { codec: aac_lc }` with no overrides on an AAC-LC
source, and skips both decoder and encoder construction — the
existing zero-cost passthrough path runs unchanged. This is the right
behaviour for "I want to confirm the config schema accepts
audio_encode but I don't actually need to re-encode anything." Any
field override (`bitrate_kbps`, `sample_rate`, `channels`) forces the
full decode/encode chain.

An HE-AAC source carries the AAC-LC profile in its ADTS header too (SBR /
PS are signalled implicitly), so the source is told by what its first frame
decodes to — twice its header's rate, or stereo from a mono core — and an
HE-AAC source is re-encoded to the AAC-LC the block asks for, at the cost of
a decode and an encode. The judgement is made again whenever the source's
AAC configuration changes (a switch to another feed); a switch from an
AAC-LC feed to an HE-AAC one leaves the fast path for the re-encode, and up
to a frame of audio may be garbled at that switch. Up to and including
v0.116.0 an HE-AAC source went out as HE-AAC under a config asking for
AAC-LC.

HLS does **not** implement this fast path because we'd have to inspect
the source TS to detect AAC-LC vs HE-AAC, which requires PMT + audio
descriptor parsing. Operators who want HLS passthrough simply omit the
`audio_encode` block. WebRTC also has no fast path — the source is
always AAC, the sink is always Opus, so passthrough is impossible.

### Failure modes

The encoder is opt-in and fails fast with a clear `audio_encode`
category event to the manager (Critical severity) when:

- **ffmpeg is missing in `PATH`** — **only on a build with `fdk-aac`
  and/or `media-codecs` compiled out.** On a default build (and on all
  three published release artefacts) no `audio_encode` codec touches
  ffmpeg at all. Where the subprocess backend is in play, outputs with
  `audio_encode` set refuse to start (HLS) or drop audio for the rest
  of the output's lifetime after logging once (RTMP / WebRTC).
- **Input audio is unsupported**: on a default build the decoder
  handles AAC (AAC-LC, HE-AAC v1/v2, multichannel up to 7.1, via FDK
  AAC) plus MP2, AC-3, E-AC-3 and AAC-LATM via the libavcodec bridge.
  Without `media-codecs`, only the AAC family decodes; without
  `fdk-aac` as well, the symphonia fallback narrows that to AAC-LC
  mono/stereo. Two per-output exceptions hold on every build: an RTMP
  output discards an Opus source outright, and HLS refuses
  `codec: opus` as a target. The output drops audio
  and emits the failure event so the operator sees the problem. The
  only AAC profile refused is one whose ADTS header is not AAC-LC
  (AAC-Main, SSR, LTP): HE-AAC, multichannel and PCE-signalled sources
  are decoded. What the WebRTC Opus re-encode still refuses (a reserved
  sampling-frequency index, a configuration its decoder will not open)
  raises a Warning `audio_encode` event; up to and including v0.116.0
  it was a log line only.
- **`compressed_audio_input` is false**: the flow input cannot carry
  TS audio (e.g. ST 2110-30, `rtp_audio` are PCM-only). The output
  drops audio.
- **Encoder configuration error**: the in-process FDK AAC or
  libavcodec encoder (or, on a feature-stripped build, the ffmpeg
  subprocess) rejects the codec/profile combination. The in-process
  backends return the error straight to the caller — there is no
  silent fall-through to ffmpeg.
- **Restart cap exhausted** (ffmpeg backend only): the
  `engine::audio_encode` supervisor restarts ffmpeg with exponential
  backoff up to 5 times in any 60-second window. After that it gives
  up and emits the Critical event. The in-process backends use no
  subprocess and have no restart budget, so on a default build this
  mode cannot occur.

The supervisor also emits **`audio_encode` Info** when the encoder
starts successfully (with codec / bitrate / SR / channels in the
event details) and **`audio_encode` Warning** on each restart (with
the restart counter).

### Marquee end-to-end chain: AAC → Opus WebRTC

The biggest single use case for `audio_encode` is the Phase A + Phase
B end-to-end chain: AAC contribution comes in via RTMP / SRT / RTSP /
UDP-TS (decoded by Phase A's `AacDecoder`), runs through Phase B's
in-process libavcodec + libopus encoder, and is distributed via WebRTC
WHEP or WHIP — all inside one bilbycast-edge process with no external
transcoder.

```jsonc
{
  "id": "aac-to-opus-distro",
  "name": "RTMP AAC contribution -> Opus WHEP distribution",
  "input": {
    "type": "rtmp",
    "listen_addr": "0.0.0.0:1935",
    "app": "live",
    "stream_key": "src"
  },
  "outputs": [{
    "type": "webrtc",
    "id": "whep-out",
    "name": "WHEP browser distribution",
    "mode": "whep_server",
    "video_only": false,
    "audio_encode": { "codec": "opus", "bitrate_kbps": 96 }
  }]
}
```

### Performance

On the default build — and on all three published release artefacts —
every `audio_encode` codec runs **in-process**:

- **No subprocess on RTMP / WebRTC.** `AudioEncoder::spawn` dispatches
  AAC-LC / HE-AAC v1 / HE-AAC v2 to FDK AAC and Opus / MP2 / AC-3 to
  libavcodec (+ libopus) before it ever reaches the ffmpeg backend.
  Both encode synchronously inside `submit_planar`: samples are
  accumulated to the codec's frame size and encoded on the caller's
  task — no pipes, no driver tasks, no stderr drainer. Neither
  in-process backend falls back to ffmpeg on failure; it returns the
  error.
- **libavcodec + rubato for rate conversion.** When the source rate
  differs from the target (e.g. 44.1 kHz AAC in → 48 kHz Opus out),
  the libavcodec backend builds a `rubato` resampler ahead of the
  encoder — the in-process equivalent of ffmpeg's `-ar`.
- **HLS re-encodes per segment, in-process.** `remux_segment_audio`
  runs `remux_ts_audio_inprocess` on a `spawn_blocking` thread (the C
  codec calls are synchronous): decode every audio PES to PCM,
  re-encode, re-packetise the result onto the same audio PID, and
  rewrite that PID's `stream_type` in the PMT. Per-segment work is
  acceptable because HLS segments are typically 2-6 s.

**Builds without `media-codecs` / `fdk-aac`** fall through to the
ffmpeg subprocess backend for the affected codecs, and only there does
the original architecture apply: one persistent ffmpeg per encoded
RTMP / WebRTC output with three concurrent driver tasks — stdin writer
(PCM in via a bounded(64) channel, **drop-on-full** so a slow encoder
never cascades backpressure into the input; drops land on
`OutputStatsAccumulator.packets_dropped`), stdout reader + per-codec
framer, and a stderr drainer that must always run or ffmpeg deadlocks
on a full pipe. HLS's per-segment ffmpeg fork returns only when
`media-codecs` specifically is off — its in-process remuxer is gated on
that feature alone. The data path is never blocked either way.

---

## Flow groups

A flow group binds multiple per-essence flows on the same edge into a
single logical unit. The classic use case is "audio + ANC + (future)
video share a PTP clock domain and must activate together".

```json
{
  "version": 1,
  "server": { "listen_addr": "0.0.0.0", "listen_port": 8080 },
  "flow_groups": [
    {
      "id": "studio-a-program",
      "name": "Studio A program",
      "clock_domain": 0,
      "flow_ids": ["studio-a-stereo", "studio-a-anc"]
    }
  ],
  "flows": [
    { "id": "studio-a-stereo", "...": "ST 2110-30 audio flow" },
    { "id": "studio-a-anc",   "...": "ST 2110-40 ANC flow" }
  ]
}
```

The audio gateway phase added two new manager protocol commands that
operate on flow groups:

| Command | Edge action |
|---|---|
| `start_flow_group { flow_group_id }` | Spawns every member flow's `FlowRuntime::start` in **parallel**. If any member fails, every member that did start is rolled back via `destroy_flow` and the command returns an error (all-or-nothing). |
| `stop_flow_group { flow_group_id }` | Best-effort parallel `destroy_flow` for every member. Individual member failures are logged but do not abort the rest. |

See the [Manager Protocol](/edge/manager-protocol/) page for the full
wire-level command / response shapes.

> **Caveat — IS-05 group barrier.** Atomicity here means
> "FlowManager-perspective atomic" (every member's `FlowRuntime::start`
> future completes within roughly one tokio scheduler tick). The IS-05
> grouped *activation* barrier — where multiple receivers in a group
> wait on a shared `tokio::sync::Notify` so they apply staged transport
> params at the same `activation_time` — is a deferred follow-up. See
> [Limitations](#limitations-and-deferred-items).

---

## Validation rules quick reference

The validator runs at config load time and on every `update_config`
manager command. Failed validation rejects the change without touching
the running flows.

| Field | Allowed values |
|---|---|
| `transcode.sample_rate` | 32000, 44100, 48000, 88200, 96000 |
| `transcode.bit_depth` | 16, 20, 24 |
| `transcode.channels` | 1..=16; beside an AAC `audio_encode`, 1..=6 or 8 for `aac_lc` / `he_aac_v1` and exactly 2 for `he_aac_v2` |
| `transcode.channel_map.length` | must equal `transcode.channels` |
| `transcode.channel_map[i][j]` | must be `< input.channels` |
| `transcode.channel_map_with_gain.length` | must equal `transcode.channels` |
| `transcode.channel_map_with_gain[i][j][0]` | non-negative integer, `< input.channels` |
| `transcode.channel_map_with_gain[i][j][1]` | `0.0`..=`10.0` linear gain (`1.0` = unity, `0.7071` ≈ −3 dB, `10.0` = +20 dB) |
| `transcode.channel_map_preset` | `mono_to_stereo`, `stereo_to_mono_3db`, `stereo_to_mono_6db`, `5_1_to_stereo_bs775`, `7_1_to_stereo_bs775`, `4ch_to_stereo_lt_rt` |
| `transcode.channel_map` + `transcode.channel_map_with_gain` + `transcode.channel_map_preset` | mutually exclusive — at most one |
| `transcode.packet_time_us` | 125, 250, 333, 500, 1000, 4000 |
| `transcode.payload_type` | 96..=127 |
| `transcode.src_quality` | `"high"`, `"fast"` |
| `transcode.dither` | `"tpdf"`, `"none"` |
| `rtp_audio.sample_rate` | 32000, 44100, 48000, 88200, 96000 |
| `rtp_audio.bit_depth` | 16, 24 |
| `rtp_audio.channels` | 1..=16 |
| `rtp_audio.packet_time_us` | 125, 250, 333, 500, 1000, 4000, 20000 |
| SRT/UDP/`rtp_audio` `transport_mode` | `"ts"` (default — UDP/SRT) or `"rtp"` (default — `rtp_audio`) or `"audio_302m"` |
| SRT `transport_mode == "audio_302m"` | rejects `packet_filter`, `program_number`, `redundancy` |
| UDP `transport_mode == "audio_302m"` | rejects `program_number` |
| SMPTE 302M channel count (when 302M mode active) | 2, 4, 6, 8 (auto-promote mono → stereo) |
| `audio_encode.codec` (RTMP) | `aac_lc`, `he_aac_v1`, `he_aac_v2` |
| `audio_encode.codec` (HLS) | `aac_lc`, `he_aac_v1`, `he_aac_v2`, `mp2`, `ac3` |
| `audio_encode.codec` (CMAF) | `aac_lc`, `he_aac_v1`, `he_aac_v2` |
| `audio_encode.codec` (WebRTC) | `opus` |
| `audio_encode.codec` (SRT / RIST / UDP / RTP) | `aac_lc`, `he_aac_v1`, `he_aac_v2`, `mp2`, `ac3` |
| `audio_encode.bitrate_kbps` | 16..=512 |
| `audio_encode.sample_rate` | 8000, 16000, 22050, 24000, 32000, 44100, 48000 |
| `audio_encode.channels` | per codec: `aac_lc` 1..=6 or 8 (7 is refused: fdk-aac has no 6.1 mode); `ac3` 1..=6; `he_aac_v1` / `opus` / `mp2` 1..=2; `he_aac_v2` exactly 2 (Parametric Stereo — mono is rejected); `s302m` (accepted only on a PCM **input**'s `audio_encode`) 2, 4, 6 or 8 |
| `audio_encode.source_audio_pid` | `0x0010`..=`0x1FFE` |
| `audio_encode.opus_vbr_mode` | `"vbr"`, `"cbr"` (rejected on a non-Opus codec, as are the other three `opus_*` fields) |
| `audio_encode.opus_frame_duration_ms` | 5, 10, 20, 40, 60 |
| `audio_encode` on WebRTC + `video_only=true` | rejected (audio MID required in SDP) |

**One exception: AAC channel counts on a whole config are repaired, not refused.** An edit that names an input or output with `audio_encode.channels: 7` and `aac_lc`, or a `transcode` block's `channels` of 7 or 9–16 beside `aac_lc` / `he_aac_v1` (other than 2 beside `he_aac_v2`), is refused. Releases up to and including v0.116.0 accepted those counts and then carried no audio, with a Critical `audio_encode` event, so a whole config that still holds one — at load, on `POST /api/v1/config/reload`, `PUT /api/v1/config` or a manager `update_config` push — is repaired instead: 7 becomes 6, 9–16 become 8, HE-AAC v2 becomes 2. The load and the reload write the repair back to `config.json`, and each repair raises a Warning `config` event (`aac_channels_repaired`, with `details.field`, `.codec`, `.was` and `.now`). Check that the count it sets is the one you want.

---

## Limitations and deferred items

These are **known gaps** in the current Audio Gateway feature set.
They're documented so you can plan around them. None block the use
cases in this guide that are marked READY.

1. **SRT 302M input demux.** The SRT input does not yet recognize
   incoming SMPTE 302M-in-MPEG-TS streams and demux them back to RTP
   audio. The wiring inside `input_srt.rs` to walk the PMT, locate
   the BSSD elementary stream, reassemble PES, depacketize the LPCM,
   and republish as RTP audio is not yet written. Until then, interop
   tests 01 and 03 in `testbed/audio-tests/302m-interop/` print
   `SKIPPED`, and inbound 302M-over-SRT flows are documented but
   inactive at runtime. Use `rtp_audio` or `st2110_30` inputs
   instead, or use the outbound 302M-over-SRT direction which fully
   works today.

2. **IS-05 grouped activation barrier.** `FlowManager::start_flow_group`
   provides "all-or-nothing from the FlowManager perspective" — every
   member's `FlowRuntime::start` future completes within roughly one
   tokio scheduler tick. But the IS-05 staging path does not yet gate
   immediate activations on a per-group `tokio::sync::Notify` barrier:
   each receiver in a group still applies its staged transport params
   independently. For most operational use this is fine (spread is
   tens of milliseconds at worst), but strict NMOS controllers that
   expect a single shared `activation_time` across grouped receivers
   will want the barrier extension once it lands.

3. **SMPTE 2022-7 redundancy on the SRT 302M output.** The standard
   ST 2110-30 / -31 output supports 2022-7 dual-leg duplication (the
   transcoder runs once and feeds both Red and Blue legs from the
   post-transcode buffer). The SRT 302M output **does not** — its
   pipeline is single-leg. If you need wire-level redundancy on a
   302M contribution link, run two parallel flows on independent SRT
   connections. The validator rejects `transport_mode == "audio_302m"`
   combined with `redundancy` to surface this at config load time.

4. **AAC family coverage.** With the default `fdk-aac` feature, the
   Phase A in-process decoder handles **AAC-LC, HE-AAC v1 (SBR),
   HE-AAC v2 (PS), AAC-LD, AAC-ELD, and multichannel up to 7.1**.
   Only when `fdk-aac` is disabled does the `symphonia-codec-aac`
   fallback restrict the input to **AAC-LC mono / stereo** — under
   that fallback, HE-AAC v1/v2 and multichannel AAC are rejected with
   an `audio_decode` Critical event.

5. **L20 wire format.** L20 is accepted by the validator and the
   transcoder; it's serialized on the wire as L24 with the bottom 4
   bits zeroed per RFC 3190 §4.5. If you specifically need L20-aware
   receivers to advertise L20 in their SDP, the on-the-wire bytes are
   correct but the NMOS advertisement may need a follow-up to surface
   L20 explicitly.
