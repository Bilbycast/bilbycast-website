---
title: Master Clock & A/V Sync
description: Per-flow master clock, encoder-style PES PTS regeneration, lipsync trim, and how to choose between Wallclock, source-PCR PLL, and PTP.
sidebar:
  order: 12
---

Every flow on bilbycast-edge runs against a per-flow **master clock**. Emission timing, the PCR/PES anchor, and lipsync trim all bottom out on the same `MasterClock::now_27mhz()` call. That single anchor is what makes every output of one flow emit an identical PCR sequence regardless of pipeline depth — which is what dual-leg 2022-7 needs — and what lets the encoder-style PES PTS regenerator produce master-clock-derived timestamps when the configuration warrants it. It does **not** put two separate edges on one timeline; that needs an [alignment group](#cross-node-egress-alignment-epoch_lock).

This page covers when to leave the master alone (the default is almost always right), when to opt in to source-PCR PLL or PTP, and how the encoder-style PES PTS regeneration paths interact with the master.

## Why a per-flow master

Before this work landed, every output stage owned its own emission timing, each sampling its own clock. On a transcoded SRT → RTP flow we measured **30–50 ms** of residual A/V drift even after fixing every other PCR / PTS bug along the way.

A single per-flow clock fixes this:

- **PCR is anchored on the master clock, not sampled from it per packet.** There are two production generators and neither derives steady-state PCR from the master once the anchor is set. In **muxer mode** (`engine::ts_pts_rewriter`) the master clock places the first PCR at `master_now − preroll`; every later PCR is `anchor + (src_pcr − anchor_src)`, free-running on the *source* clock. A source discontinuity larger than 500 ms is flagged DI=1 either way, but only some are re-anchored: a backward jump, and a forward jump the wall clock did **not** witness (a file-loop wrap, where source PCR leaps a whole programme in milliseconds of real time), get a master-bridged re-anchor; a forward jump the wall clock *did* witness — a live edit point, a splice — passes through unchanged, precisely so rate accuracy survives it. On the **transcoded path** (`engine::av_sync_mux`) PCR is derived from the source PES PTS as `pts × 300 − preroll` — deterministic, and kept that way on purpose. An earlier revision sampled the master clock there instead and was withdrawn: the sample was taken inside the encoder pipeline while the packet's wire time was set by send pacing, so the emitted PCR had no fixed relationship to its own arrival instant and professional decoders flagged it as PCR jitter (measured stdev 176 ms). What the per-flow master still guarantees is that **every output of one flow emits an identical PCR sequence regardless of pipeline depth**.
- **PTS still flows from the source** via the per-input `src_pts_queue`, so A/V offset versus source is preserved.
- **Cross-edge coherence is not free**, and sharing a grandmaster does not buy it. In muxer mode the anchor is stamped at the instant the *first PCR arrives at this node*, so a node's emitted PCR carries that node's own ingest latency as a fixed additive term. Two edges fed the same feed over paths differing by 120 ms emit PCRs 120 ms apart — measured, with both nodes on one master clock. Within a single flow every output is coherent, which is what 2022-7 dual-leg needs; across two nodes you need an [alignment group](#cross-node-egress-alignment-epoch_lock).

## Master kinds

Auto-selection is resolved per flow by `build_master_clock` from the **flow role**, which overrides the older per-input default table:

| Kind | When auto-selected | Lock criterion |
|------|--------------------|----------------|
| **Auto PLL cascade** (`SourcePcrPll` → `Ptp` → `Wallclock`) | **Default** for a single-source live-contribution flow (SRT / RTP / UDP / RIST / RTMP / RTSP) **and** for a single-input Flow Assembly (PID bus) flow. The cascade tries the source-PCR PLL **first**, holding Wallclock only until the PLL locks, then promotes to PTP if disciplined. | Active rung's own criterion — see below. Wallclock rung is always locked; PLL rung converges (PI loop, p99 jitter < 100 µs over a 64-sample window after ≥ 100 samples); PTP rung follows `ptp4l`. |
| `Wallclock` | Multi-input switcher, `file` / `media_player` / `replay`, WebRTC, `test_pattern`, `rtp_audio`, and `bonded` flows; idle flows. | Always locked, monotonic — no convergence concept. |
| `Ptp` | ST 2110-20/-23/-30/-31/-40 and MXL inputs. | `ptp4l` reports `port_state == SLAVE` and the offset is within tolerance. |

### How the auto cascade behaves on contribution sources

The cascade lets a clean, PTP-disciplined, or locked-PLL contribution source reach a rate-accurate, source-disciplined master automatically, while staying always-locked on messier feeds. It starts on Wallclock (always monotonic, so the encoder-style PES PTS regenerators can anchor against a clean timeline immediately), attempts the source-PCR PLL, and only promotes off Wallclock once a rung actually locks. On contribution sources that carry per-source-restart PCR discontinuities — `ffmpeg -re -stream_loop -1 -c copy` on a 30-second file, looping playout, SCTE-35 splice insertions, source encoder restarts — the PLL never locks, so the cascade stays on the Wallclock rung and behaves exactly like a forced Wallclock master.

The active rung shows up on telemetry as `kind`, and the operator's request shows up as `configured_kind` (see [Telemetry](#telemetry)), so the manager can render `Auto → Source PCR PLL` / `Auto → PTP` / `Auto → Wallclock`.

Operators can pin a specific master rather than take the auto cascade, via the per-flow `master_clock.kind` config field:

| Value | Effect |
|---|---|
| `"auto"` / `null` *(default)* | Auto-pick per the table above (the cascade for single-source contribution + single-input assembly; Wallclock or PTP for the rest). `null` and the explicit string `"auto"` are equivalent. |
| `"contribution"` *(preferred)* | Force the source-PCR PLL — surfaces intent on telemetry as a "contribution" master kind. |
| `"source_pcr_pll"` *(legacy alias)* | Retained for back-compat. Identical behaviour to `"contribution"`. |
| `"passthrough"` | Wallclock-backed master with **no PLL and no lock/fallback alarm** — the plain always-locked timeline intended for most contribution-to-distribution flows where the operator hasn't pinned `source_pcr_pll`. |
| `"ptp"` | Force the PTP master regardless of input type. Refuses to start if `ptp4l` isn't reporting `SLAVE`. |
| `"wallclock"` | Force Wallclock regardless of input type. (Refused on ST 2110 + MXL flows — they need real time discipline.) |

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
| One edge, dual-leg 2022-7 to a tier-1 receiver | **Leave on** (default). Both legs of one flow already emit an identical PCR sequence — that is what the per-flow master is for. |
| Two edges carrying the same feed, cut between them downstream | **Turn it off** — set `passthrough_clock: true` (or use a `bonded` input) and join both outputs to an [alignment group](#cross-node-egress-alignment-epoch_lock). Regeneration re-stamps PCR against each node's own arrival instant, which is exactly the difference alignment has to cancel; a shared PTP grandmaster does not change that. |
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
    "configured_kind": "auto",
    "locked": true,
    "rate_offset_ppm": -2.34,
    "jitter_us": 18,
    "lipsync_offset_90k": 0
  }
}
```

- `kind` is the **active rung** — the master actually running right now.
- `configured_kind` is the **operator's request** — what `master_clock.kind` was set to (`"auto"` when unset). The auto cascade carries both so the manager can render a compound label like `Auto → Source PCR PLL` / `Auto → PTP` / `Auto → Wallclock`; when a specific kind is pinned, `kind` and `configured_kind` agree.

The manager renders the kind label (including the compound `configured → active` form), lock chip, rate offset, p99 jitter, and the trim knob on the per-flow detail page.

## Capability gating

Edges advertise `"master_clock"` on `HealthPayload.capabilities`. Manager UI gates the per-flow telemetry card and the lipsync trim knob on this string, so older edges hide the controls automatically and the relevant commands stay safe to send.

## Cross-node egress alignment (`epoch_lock`)

Everything above is per-flow, and per-flow is per-node. Two edges forwarding the same contribution feed over independent paths emit it at instants separated by their ingest-latency difference — routinely hundreds of milliseconds. Cutting between them on a downstream switcher shows a jump in content and in receiver buffer occupancy.

An **alignment group** cancels that difference. Each member's UDP/RTP output carries an `epoch_lock` block and derives every PCR-bearing datagram's release instant from a shared anchor plus a fixed `egress_offset_ms` dwell — by arithmetic rather than by a feedback loop, so alignment never has to converge. The result is a clean **cut** between nodes, not a seamless 2022-7 merge.

Four things about it matter on this page:

- **The shared anchor is minted by the manager, not by a node.** Any mapping a node infers from its own observations is stamped on arrival, so it already carries the very latency alignment must cancel. The manager mints from the *slowest* member's arrival plus a margin, which makes each member's required dwell its lead over the slowest rather than its absolute end-to-end latency.
- **Alignment and PCR/PTS regeneration are mutually exclusive.** The PCR reaching the emitter has to be a function of the content, not of the node, so every input must be `bonded` or set `passthrough_clock: true` — which also turns off the PES PTS regeneration and the discontinuity bridge described above.
- **Scope is narrow and enforced.** Single-input, single-program, non-transcoded, non-assembled UDP/RTP forwarding, with explicit `egress_pacing: "pcr"` and no `cbr_pad_to_kbps`. `egress_offset_ms` is bounded 150–800 ms and must be identical on every member.
- **Every member's host clock still has to agree.** The anchor names an absolute wall instant, and each member releases when *its own* host clock reaches that instant plus the dwell. So a clock offset between two members misaligns the group by exactly that offset — and nothing reports it, because each node is doing precisely what it was told and both look healthy. Discipline every member to the same NTP or PTP source, and treat host clock discipline as part of the feature, not a background detail.

Edges advertise `"epoch_lock"` on `HealthPayload.capabilities`; an edge without it ignores the config block silently, which looks exactly like success, so every manager surface gates on the bit. Full operator walkthrough: [Aligned Output](/manager/aligned-output/). Field reference: [Configuration](/edge/configuration/).

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
- **Cross-node alignment (`epoch_lock`) is not hardware-verified.** The release arithmetic is unit-tested and in verified parity with the manager's mint, but the physical claim — two edges on independent paths emitting the same content at the same wire instant — needs a two-node bench run measuring the egress-instant delta. A single node cannot measure its own alignment.
- **Passthrough PCR bytes** are not rewritten by `engine::ts_pts_rewriter` — only PES PTS/DTS. PCR continues to ride the source bytes through to the per-output wire pacer, which paces the wallclock egress correctly regardless.

## See also

- [Time (PTP)](/edge/ptp/) — pick a PTP role and confirm grandmaster lock.
- [Wire-Time Precision](/edge/wire-pacing/) — closed-loop wire pacing on the egress side.
- [Codec matrix](/edge/codec-matrix/) — what backends the master-clock-aware transcoders use.
- [Edge repo `docs/clocking.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/clocking.md) — the source-of-truth module map, PLL convergence test data, and PCR pre-roll constants.
