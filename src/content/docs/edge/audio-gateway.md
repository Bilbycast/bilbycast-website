---
title: Audio Gateway
description: Bridge AES67 / SMPTE ST 2110-30/-31 audio over the public internet, transcode sample rate / bit depth / channel routing per output, and ship 48 kHz LPCM as SMPTE 302M-in-MPEG-TS for byte-identical interop with broadcast hardware.
sidebar:
  order: 8
---

bilbycast-edge ships as an **IP audio gateway**: bridging PCM audio between studios, carrying radio contribution feeds over the public internet, distributing talkback over encrypted SRT links, and interoperating with the standard broadcast tool stack (`ffmpeg`, `srt-live-transmit`, hardware encoders/decoders that speak SMPTE 302M LPCM-in-MPEG-TS).

If you only want byte-identical SMPTE ST 2110-30/-31 passthrough on a local broadcast plant, see [SMPTE ST 2110](/edge/st2110/) — that remains the lowest-latency, zero-overhead path. This page covers everything ST 2110 *can't* do on its own: format conversion, no-PTP operation, and WAN transport.

## What you can do with it

| Task | Tool inside bilbycast |
|---|---|
| Bridge AES67 stereo to a 44.1 kHz / 16-bit ST 2110-30 monitor | `transcode` block on the output |
| Sum a 5.1 surround source to stereo for monitoring | `transcode.channel_map_preset: "5_1_to_stereo_bs775"` |
| Carry a radio feed over the public internet to a third-party decoder | SRT output with `transport_mode: "audio_302m"` |
| Bridge audio between two studios that don't share a PTP fabric | `rtp_audio` input/output (no PTP requirement) |
| Hot-swap channel routing on a live monitor mix | IS-08 active channel map (`/x-nmos/channelmapping/v1.0/map/activate`) |
| Atomically start a multi-essence broadcast group (audio + ANC) | `start_flow_group` manager command |
| Send 24-bit LPCM to a hardware decoder that expects MPEG-TS over UDP | UDP output with `transport_mode: "audio_302m"` |
| Send 24-bit LPCM to a hardware decoder that expects RTP/MP2T (RFC 2250) | `rtp_audio` output with `transport_mode: "audio_302m"` |

## Audio inputs and outputs at a glance

| `type` | Direction | Wire format | PTP | Use case |
|---|---|---|---|---|
| `st2110_30` | Input + Output | RFC 3551 RTP, L16/L24 PCM, big-endian | Required | Local broadcast plant with shared PTP |
| `st2110_31` | Input + Output | RFC 3551 RTP, AES3 sub-frames in 24-bit | Required | Local plant transparent AES3 (preserves Dolby E) |
| `st2110_40` | Input + Output | RFC 8331 ANC | Required | SCTE-104, SMPTE 12M timecode, captions |
| `rtp_audio` | Input + Output | RFC 3551 RTP, L16/L24 PCM | **Not required** | WAN contribution, talkback, ffmpeg/OBS interop |
| `srt` (`transport_mode: audio_302m`) | Output | SMPTE 302M LPCM in MPEG-TS, over SRT | N/A | WAN transport with ARQ, ffmpeg/srt-live-transmit interop |
| `udp` (`transport_mode: audio_302m`) | Output | SMPTE 302M LPCM in MPEG-TS, over UDP | N/A | Legacy hardware that expects raw TS over UDP |
| `rtp_audio` (`transport_mode: audio_302m`) | Output | SMPTE 302M LPCM in MPEG-TS, in RFC 2250 RTP/MP2T (PT 33) | N/A | Hardware that expects MPEG-TS over RTP |

`rtp_audio` is wire-identical to ST 2110-30 (same RTP header, same big-endian L16/L24 payload) but with relaxed validation: sample rates 32 / 44.1 / 48 / 88.2 / 96 kHz, no `clock_domain` requirement, no NMOS PTP advertising, no RFC 7273 timing reference. Internally it shares the ST 2110-30 runtime with `clock_domain` forced off so the same transcode stage, IS-08 hot reload, SMPTE 2022-7 redundancy, and per-output stats wiring all work for free.

## The `transcode` block

Every audio output (`st2110_30`, `st2110_31`, `rtp_audio`) accepts an optional `transcode` field. When present, bilbycast inserts a per-output PCM conversion stage between the broadcast channel subscriber and the RTP send loop:

```text
flow input (any rate / depth / channels)
        │
        ▼
broadcast::channel<RtpPacket>
        │  subscribe
        ▼
┌──────────────────────────────────────┐
│  TranscodeStage (per output)         │
│   PcmDepacketizer                    │
│   ↓ decode big-endian PCM → f32      │
│   ↓ apply channel matrix             │
│     (IS-08 active or static)         │
│   ↓ rubato SRC (sinc or fast)        │
│   ↓ encode f32 → big-endian PCM      │
│     (TPDF dither on down-cvt)        │
│   ↓ PcmPacketizer                    │
└──────────────────────────────────────┘
               │
               ▼
       RTP socket send (Red + Blue legs)
```

When `transcode` is **absent**, the output runs the existing byte-identical passthrough path — no allocation, no signal processing, zero overhead. The transcoder only ever runs when the operator opts in on a specific output.

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
| `sample_rate` | `32000`, `44100`, `48000`, `88200`, `96000` | input rate | Pass-through if equal to input |
| `bit_depth` | `16`, `20`, `24` | input depth | L20 carried as L24 with bottom 4 bits zero per RFC 3190 §4.5 |
| `channels` | `1`–`16` | input channels | Must agree with `channel_map` length |
| `channel_map` | `[[in_ch, ...], ...]` | identity (or auto-promote) | Each row lists input channel indices to sum (unity gain) |
| `channel_map_preset` | one of the named presets | none | Mutually exclusive with `channel_map` |
| `packet_time_us` | `125`, `250`, `333`, `500`, `1000`, `4000` | `1000` | 4 ms is sensible for talkback / WAN |
| `payload_type` | `96`–`127` | `97` | RTP dynamic payload type |
| `src_quality` | `"high"`, `"fast"` | `"high"` | High = `rubato::SincFixedIn`. Fast = `rubato::FastFixedIn`. |
| `dither` | `"tpdf"`, `"none"` | `"tpdf"` | TPDF dither on bit-depth downconversion |

If `channel_map` and `channel_map_preset` are both absent and the input/output channel counts agree, the matrix defaults to identity. Mono→stereo (1→2) and stereo→mono (2→1) auto-apply a sensible default preset; any other shape mismatch must be specified explicitly — the validator rejects ambiguous configs at config load time.

### Channel routing presets

| Preset | In → Out | Math |
|---|---|---|
| `mono_to_stereo` | 1 → 2 | L = R = ch0 |
| `stereo_to_mono_3db` | 2 → 1 | mono = (L + R) × 0.7071 (~ −3 dB) |
| `stereo_to_mono_6db` | 2 → 1 | mono = (L + R) × 0.5 (~ −6 dB) |
| `5_1_to_stereo_bs775` | 6 → 2 | ITU-R BS.775; LFE dropped |
| `7_1_to_stereo_bs775` | 8 → 2 | ITU-R BS.775 extended |
| `4ch_to_stereo_lt_rt` | 4 → 2 | Lt/Rt with −3 dB surrounds |

For custom routing, use `channel_map` directly. The current schema treats every routed input as unity gain.

### SRC quality and dither

bilbycast uses [`rubato`](https://docs.rs/rubato) for sample rate conversion:

- **`high`** (default) — `SincFixedIn` with a 256-tap windowed sinc filter and 256× oversampling. Broadcast monitoring quality. ~3–5 ms conversion delay.
- **`fast`** — `FastFixedIn` with linear polynomial interpolation and 64-tap sinc. Lower CPU, ~1 ms latency, audibly worse on critical content. Use for talkback / IFB paths.

Bit-depth down-conversion (e.g., L24 → L16) applies **TPDF** (triangular probability density function) dither by default to break quantization correlation. Set `dither: "none"` to truncate.

### IS-08 channel-map hot reload

When the operator activates a new IS-08 channel map via `POST /x-nmos/channelmapping/v1.0/map/activate`, every running audio output's transcoder picks up the new routing on the next packet — no flow restart, no audio glitch, no listener disconnect.

Steady-state cost on the hot path: one atomic load + one `Arc::clone`. No locks, no allocations.

The per-output **static** `channel_map` from the operator's `transcode` config is the **fallback** — if the IS-08 map has no entry for this output, or its entry has zero channels, the static matrix is used.

### Stats

When a transcoder is active on an output, the per-output stats snapshot gains a `transcode_stats` block:

```json
{
  "output_id": "monitor-stereo",
  "packets_sent": 12000,
  "transcode_stats": {
    "input_packets": 12000,
    "output_packets": 11999,
    "dropped": 0,
    "format_resets": 0,
    "last_latency_us": 1820
  }
}
```

When `transcode` is absent, `transcode_stats` is omitted from the snapshot.

## SMPTE 302M LPCM in MPEG-TS — `transport_mode: "audio_302m"`

`transport_mode: "audio_302m"` on an SRT, UDP, or `rtp_audio` output ships 48 kHz LPCM as SMPTE 302M-in-MPEG-TS. The PMT carries the BSSD registration descriptor (tag `0x05` with `format_identifier = "BSSD"`); audio is bundled into 1316-byte (7 × 188) TS chunks. Output is byte-identical with `ffmpeg -c:a s302m -f mpegts ...` and accepted by `srt-live-transmit` and broadcast hardware decoders.

```json
{
  "type": "srt",
  "id": "perth-relay",
  "mode": "caller",
  "address": "203.0.113.10:9000",
  "transport_mode": "audio_302m",
  "transcode": {
    "sample_rate": 48000,
    "bit_depth": 24,
    "channels": 2
  }
}
```

### Why 48 kHz only?

SMPTE 302M is defined for 48 kHz LPCM at 16, 20, or 24-bit depth, even channel counts only. bilbycast forces a 48 kHz transcode whenever `audio_302m` is set, regardless of input rate. If your input is already 48 kHz at the right depth and channel count, the SRC layer is a no-op.

### Mutually exclusive with FEC, program filtering, and 2022-7

`audio_302m` is a fully-formed single-program TS that bilbycast generates from scratch — there are no upstream MPTS programs to filter, no per-packet FEC parity to layer on, and no second leg to deduplicate. Validation rejects any `audio_302m` output that also sets `program_number`, `packet_filter` (SRT FEC), or a `redundancy` block.

### Interop tests

The `testbed/audio-tests/302m-interop/` directory contains shell scripts that exercise byte-identical round-trip with:

- `ffmpeg -c:a s302m -f mpegts srt://...`
- `srt-live-transmit srt://... file://...`
- `tsduck` PMT inspection
- Reference broadcast hardware decoders

## Worked use case: AES67 contribution Sydney → Perth

Bridge an AES67 stereo source on the Sydney plant to a Perth decoder over the public internet using SRT-302M with ARQ and AES-128 encryption.

**Sydney edge — input from AES67 multicast, SRT 302M output:**

```json
{
  "id": "syd-perth-feed",
  "input": {
    "type": "st2110_30",
    "address": "239.0.0.10:5004",
    "interface": "10.0.0.1",
    "clock_domain": 127,
    "sample_rate": 48000,
    "bit_depth": 24,
    "channels": 2
  },
  "outputs": [
    {
      "type": "srt",
      "id": "perth",
      "mode": "caller",
      "address": "perth.example.com:9000",
      "transport_mode": "audio_302m",
      "passphrase": "redactedpassphrase!",
      "key_length": 16,
      "latency_ms": 1500
    }
  ]
}
```

The SRT output runs the existing 1500 ms ARQ buffer, so any single packet loss is recovered without an audible glitch. ChaCha20-Poly1305 (via the tunnel) and AES-128 (via SRT) protect the link end-to-end.

## Validation rules quick reference

| Rule | Where |
|---|---|
| `transcode.sample_rate` ∈ {32k, 44.1k, 48k, 88.2k, 96k} | `validate_transcode()` |
| `transcode.bit_depth` ∈ {16, 20, 24} | same |
| `channel_map` row count must equal `channels` | same |
| `channel_map` and `channel_map_preset` are mutually exclusive | same |
| `transport_mode: "audio_302m"` requires 48 kHz, even channels, 16/20/24 bit | `validate_output_audio_302m()` |
| `audio_302m` is incompatible with `program_number`, `packet_filter`, `redundancy` | same |
| Only `srt`, `udp`, and `rtp_audio` outputs accept `audio_302m` | same |

## Limitations and deferred items

- **SRT 302M input** — output is fully implemented; the demuxer to accept SRT 302M as a flow input is deferred. Use `rtp_audio` or `st2110_30` inputs instead.
- **Per-entry channel-map gains** — custom `channel_map` rows are unity-gain only. Use a named preset for non-unity gains (which apply −3 dB / −6 dB internally).
- **Cross-input IS-08 routing** — the IS-08 channel map is treated as a single-flow audio router. Routes that reference a different upstream input are muted on the consuming transcoder.
- **Sample rates above 96 kHz** — not supported by the SRC profiles in either direction.
