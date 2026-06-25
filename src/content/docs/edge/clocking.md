---
title: Master Clock & A/V Sync
description: Per-flow master clock, encoder-style PES PTS regeneration, lipsync trim, and how to choose between Wallclock, source-PCR PLL, and PTP.
sidebar:
  order: 12
---

Every flow on bilbycast-edge runs against a per-flow **master clock**. PCR generation, output emission timing, and lipsync trim all bottom out on the same `MasterClock::now_27mhz()` call. That single anchor is what makes 2022-7 hitless redundancy across two edges work without an external genlock, and what lets the encoder-style PES PTS regenerator produce master-clock-derived timestamps when the configuration warrants it.

This page covers when to leave the master alone (the default is almost always right), when to opt in to source-PCR PLL or PTP, and how the encoder-style PES PTS regeneration paths interact with the master.

## Why a per-flow master

Before this work landed, every output stage owned its own emission timing. Output PCR was derived from PES PTS (`pts × 300 − preroll`), which means PCR jitter mirrored the encoder pipeline depth. On a transcoded SRT → RTP flow we measured **30–50 ms** of residual A/V drift even after fixing every other PCR / PTS bug along the way.

A single per-flow clock fixes this:

- **PCR is generated from the master clock**, not derived from PTS. Multiple outputs of the same flow emit identical PCR sequences regardless of pipeline depth.
- **PTS still flows from the source** via the per-input `src_pts_queue`, so A/V offset versus source is preserved.
- **Cross-edge coherence is free** when two edges slave to the same source PCR or the same PTP grandmaster. 2022-7 hitless at the receiver works without external genlock hardware.

## Master kinds

| Kind | When auto-selected | Lock criterion |
|------|--------------------|----------------|
| `Wallclock` | **Default** for SRT / RTP / UDP / RIST / RTMP / RTSP / `media_player` / `replay` / `test_pattern` / `rtp_audio` / `bonded`; WebRTC ingress; idle flows. | Always locked, monotonic — no convergence concept. |
| `SourcePcrPll` | Flow Assembly (PID bus) flows — the assembler needs the recovered source clock to keep cross-program PCR coherent. | PI loop converges; p99 jitter < 100 µs over 64-sample window after ≥ 100 samples. |
| `Ptp` | ST 2110-20/-23/-30/-31/-40 and MXL inputs. | `ptp4l` reports `port_state == SLAVE` and the offset is within tolerance. |

### Why Wallclock is the default for contribution TS sources

An earlier auto-policy picked `SourcePcrPll` for SRT / RTP / UDP / RIST / RTMP / RTSP. In practice the PLL never locks on contribution sources that carry per-source-restart PCR discontinuities — `ffmpeg -re -stream_loop -1 -c copy` on a 30-second file, every kind of looping playout, SCTE-35 splice insertions, source encoder restarts. With Wallclock as the default the master is always locked, always monotonic, and the encoder-style PES PTS regenerators can anchor against a clean timeline immediately.

Operators who run on PTP-disciplined or clean-PCR contribution sources and want cross-edge coherence opt in via the per-flow `master_clock.kind` config field:

| Value | Effect |
|---|---|
| `"contribution"` *(preferred)* | Opt in to the source-PCR PLL — surfaces intent on telemetry as a "contribution" master kind. |
| `"source_pcr_pll"` *(legacy alias)* | Retained for back-compat. Identical behaviour to `"contribution"`. |
| `"ptp"` | Force the PTP master regardless of input type. Refuses to start if `ptp4l` isn't reporting `SLAVE`. |
| `"wallclock"` | Force Wallclock regardless of input type. (Refused on ST 2110 + MXL flows — they need real time discipline.) |
| `null` *(default)* | Auto-pick per the table above. |

## Encoder-style PES PTS regeneration

Every TS-carrying ingress regenerates PES PTS/DTS at the byte level **by default**. The per-input `passthrough_clock: bool` config field (default `false` — i.e. regeneration on) lets an operator opt **out**: set `passthrough_clock: true` to emit the source PCR/PTS bytes unchanged. With regeneration active, the byte-level rewriter rewrites each PES header's PTS (and DTS when present) so emitted timestamps come from the per-flow master clock instead of the source TS bytes.

The model is per-PID **anchor + source-delta**:

```text
On first PES of PID (or on a > 500 ms source-PTS discontinuity):
    anchor_out_90k = master.now_27mhz()/300 + PCR_PREROLL_90K  (= 7 200, 80 ms)
                     + lipsync_offset_90k (audio PIDs only)
    anchor_src_90k = source PES PTS

On every subsequent PES:
    delta_src = source_pts - anchor_src_90k        (wrapping, 33-bit)
    out_pts   = anchor_out_90k + delta_src
    out_dts   = out_pts - (source_pts - source_dts)  (when DTS present)
```

This preserves the source's PES inter-arrival timing exactly (no per-PES master_now jitter injection) while making absolute PTS values master-clock-derived. DTS preserves the source PTS-DTS delta so H.264 / HEVC B-frame reorder still decodes correctly.

A **10 s safety check** on the anchor candidate falls back to the raw source PTS when master and source are wildly uncorrelated (Wallclock master + small-offset encoder PTS — the common case today). The rewriter switches to master-clock-derived PTS only when master and source agree to within 10 s — i.e. PTP master with PTP-disciplined source, or a locked `SourcePcrPll` master.

**When does it actually rewrite?** Only when the 10 s safety lets it. On a flow with `Wallclock` master and a typical encoder-relative source PTS, the safety triggers and the anchor falls back to source PTS — effectively a no-op. To unlock master-clock-derived PTS output the flow needs:

- `master_clock.kind = "ptp"` with PTP-disciplined sources, **or**
- `master_clock.kind = "contribution"` (or `"source_pcr_pll"`) **and** the PLL has locked.

The transcoded audio path uses the same model in `engine::ts_audio_replace::TsAudioReplacer::set_av_sync_pacer` — same `anchor_target` helper, same 10 s safety, same opt-in surface.

### When to leave `passthrough_clock` off (regeneration on)

| Situation | Recommendation |
|---|---|
| Two edges slaved to the same PTP grandmaster, dual-leg 2022-7 to a tier-1 receiver | **Leave on** (default). Combined with `master_clock.kind = "ptp"` the two edges emit coherent PCR + PTS. |
| Two edges slaved to the same clean upstream encoder, 2022-7 hitless | **Leave on** (default). Combined with `master_clock.kind = "contribution"`. Wait for `master_clock.locked = true` before measuring. |
| Single edge, single output, no cross-host coherence requirement | Either — the default (regeneration on) is correct and adds negligible overhead; `passthrough_clock: true` is also fine. |
| You must emit the source PCR/PTS bytes unchanged | Set `passthrough_clock: true` to opt out of regeneration. |

## PCR pre-roll

Every master-clocked PCR is emitted as `master_now − PCR_PREROLL_27MHZ` with the pre-roll at **80 ms** (2 160 000 ticks). This matches the ISO/IEC 13818-1 Annex L T-STD model — receivers need PCR to lead PTS by at least the transport-buffer + CPB pre-roll. 80 ms also limits the apparent A/V offset on receivers that don't apply T-STD scheduling to audio.

The pre-roll is fixed today; future work may expose it per-flow for low-latency contribution where 40 ms would be preferable.

## Lipsync trim

The master-clock handle exposes a per-flow lipsync offset bounded **±18 000** in 90 kHz ticks (±200 ms). Operators nudge it via the manager UI's per-flow telemetry card or directly with the WS command:

```json
{ "type": "command", "payload": { "action": "set_master_clock_lipsync",
                                  "flow_id": "...",
                                  "lipsync_offset_90k": 9000 } }
```

The trim applies to:

- The PES PTS rewriter (`engine::ts_pts_rewriter`) on audio PIDs.
- The transcoded audio replacer (`TsAudioReplacer::set_av_sync_pacer`) on its emitted PES PTS.

It does **not** yet apply to the transcoded video replacer's output PTS — that wire-up is planned. PCR generation is unaffected (the trim moves only the audio PTS values relative to PCR).

## Telemetry

Every running flow surfaces a `master_clock` block on `FlowStats`:

```json
{
  "master_clock": {
    "kind": "source_pcr_pll",
    "locked": true,
    "rate_offset_ppm": -2.34,
    "jitter_us": 18,
    "lipsync_offset_90k": 0
  }
}
```

The manager renders the kind label, lock chip, rate offset, p99 jitter, and the trim knob on the per-flow detail page.

## Capability gating

Edges advertise `"master_clock"` on `HealthPayload.capabilities`. Manager UI gates the per-flow telemetry card and the lipsync trim knob on this string, so older edges hide the controls automatically and the relevant commands stay safe to send.

## Relationship to wire pacing

The master clock chooses **the PCR values written into TS bytes**. [Wire pacing](/edge/wire-pacing/) makes the **PCR-bearing packets hit the wire at the wallclock instant the PCR implies**. Both are required for tier-1 PCR_AC at the receiver.

The pieces fit together like this:

```
            ┌──────────────┐   now_27mhz()
            │ MasterClock  ├────────────┐
            └──────┬───────┘            ▼
                   │             ┌──────────────────┐
       ingress     │             │ TsVideoReplacer  │── master-clocked PCR ──→ TS bytes ──┐
       PCR samples │             │ TsAudioReplacer  │  (PTS still from src_pts_queue)     │
                   ▼             └──────────────────┘                                     │
            ┌──────────────┐                                                              ▼
            │ PcrIngress   │                                              ┌─────────────────────────────┐
            │   Sampler    │                                              │ broadcast_tx → wire_emit    │
            └──────┬───────┘                                              │ (per-output PCR-anchored)   │
                   │ samples                                              └─────────────────────────────┘
                   ▼
            ┌──────────────┐
            │ PcrPll       │
            └──────────────┘
```

## Known limitations

- **`AudioMaster`** (ALSA local-display master) is reserved but not implemented; the kind tag falls through to Wallclock.
- **Lipsync trim** applies to PES PTS but not to the transcoded video replacer's output PTS yet.
- **PCR pre-roll** is hard-coded at 80 ms; per-flow override is planned for low-latency contribution.
- **Passthrough PCR bytes** are not rewritten by `engine::ts_pts_rewriter` — only PES PTS/DTS. PCR continues to ride the source bytes through to the per-output wire pacer, which paces the wallclock egress correctly regardless.

## See also

- [Time (PTP)](/edge/ptp/) — pick a PTP role and confirm grandmaster lock.
- [Wire-Time Precision](/edge/wire-pacing/) — closed-loop wire pacing on the egress side.
- [Codec matrix](/edge/codec-matrix/) — what backends the master-clock-aware transcoders use.
- [Edge repo `docs/clocking.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/clocking.md) — the source-of-truth module map, PLL convergence test data, and PCR pre-roll constants.
