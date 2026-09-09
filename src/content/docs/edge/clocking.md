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
| `"sender_timestamp"` | Recover rate from the **SRT sender's per-packet `srctime`** rather than from PCR sampled out of the TS bytes — for internet contribution where SRT's latency buffer makes PCR-from-bytes look jittery to the PLL while the sender's own clock is clean. **A label rather than a switch today**: it resolves to the same PLL runtime as `"contribution"`, and the rate reference is picked per packet by the ingress sampler on *any* PLL flow — `srctime` when the packet still carries one, PCR-from-bytes otherwise. Only SRT ever populates it, and the input's transcode / post-process stages (including the default muxer-mode rewriter) strip it, so in practice the PLL sees `srctime` only on an input running neither — `passthrough_clock: true` with no filters. Telemetry reports `kind: "source_pcr_pll"`; the pinned kind itself is not carried on the wire. |
| `"audio_master"` | Reserved for the local-display ALSA master; not implemented. Runs on a Wallclock-backed master with the kind tag preserved so the manager still shows the intent. |
| `"passthrough"` | Wallclock-backed master with **no PLL and no lock/fallback alarm** — the plain always-locked timeline intended for most contribution-to-distribution flows where the operator hasn't pinned `source_pcr_pll`. |
| `"ptp"` | Force the PTP master regardless of input type. Refuses to start if `ptp4l` isn't reporting `SLAVE`. |
| `"wallclock"` | Force Wallclock regardless of input type. (Refused on ST 2110 + MXL flows — they need real time discipline.) |

### PLL lock thresholds

Two optional fields sit alongside `kind` in the same per-flow `master_clock` block and tune the PLL rung, whether it was reached by the auto cascade or pinned explicitly:

| Field | Default | Effect |
|---|---|---|
| `pll_lock_timeout_s` | 30 s | How long the PLL gets to lock before the master drops to the wallclock rung and raises a Warning `master_clock_pll_fallback` event. `0` opts out of the fallback entirely — the flow then stays unlocked indefinitely on an unlockable source. Otherwise validated 5–300. |
| `pll_lock_jitter_us` | 100 µs | The p99 residual-jitter threshold at which the PLL declares lock, calibrated for hardware-paced contribution encoders. Prosumer encoders and internet contribution paths routinely sit in the 500 µs – 5 ms band on a perfectly healthy stream and so never cross the broadcast threshold; raise this to 500–2000 to let the PLL lock on those, at the cost of a looser recovered clock. Silently clamped to 50–5000 rather than rejected, and the unlock threshold tracks at 5× the lock value to keep the hysteresis. |

## Encoder-style PES PTS regeneration

Every TS-carrying ingress regenerates PES PTS/DTS at the byte level **by default**. The per-input `passthrough_clock: bool` config field (default `false` — i.e. regeneration on) lets an operator opt **out**: set `passthrough_clock: true` to emit the source PCR/PTS bytes unchanged. With regeneration active, the byte-level rewriter rewrites each PES header's PTS (and DTS when present) so emitted timestamps come from the per-flow master clock instead of the source TS bytes.

**MPTS sources are exempt, permanently.** The anchor model is SPTS-only, so the first PAT the rewriter parses that lists more than one program latches that input into verbatim passthrough for the life of the input — and the latch never clears, even if a later PAT drops back to a single program. On a multi-program source none of what follows applies: no PCR rewrite, no PES PTS/DTS regeneration, no discontinuity bridge, no PSI_RR injection. The flow's A/V skew telemetry reports the rewriter inactive too, so the lipsync trim reads as `0` there. Down-select to a single program at ingress with the per-input `program_number` filter if you need muxer-mode regeneration on one program of an MPTS — the filter emits a synthetic single-program PAT and runs ahead of the rewriter, so the latch never arms.

The model is a single per-input **anchor + source-delta**, shared by PCR and every PES PID:

```text
On the first PCR of the input (one anchor per input; PES never sets or moves it):
    anchor.src_27mhz = source PCR                                (27 MHz)
    anchor.out_27mhz = master.now_27mhz() - PCR_PREROLL_27MHZ    (2 160 000 ticks, 80 ms)

On every PES:
    out_27mhz = anchor.out_27mhz + (source_pts * 300 - anchor.src_27mhz)  (wrapping)
    out_pts   = (out_27mhz / 300) & 0x1_FFFF_FFFF
                + lipsync_offset_90k (audio PIDs only)
    out_dts   = the same formula applied to source_dts                    (when DTS present)
```

This preserves the source's PES inter-arrival timing exactly (no per-PES master_now jitter injection) while making absolute PTS values master-clock-derived. Because PCR and every PES PID share one anchor, the source's own PCR→PTS lead is carried over rather than re-derived, and the PTS-DTS delta falls out for free, so H.264 / HEVC B-frame reorder still decodes correctly. Re-anchoring happens only on the PCR path — a backward jump, or a forward jump the wall clock did not witness; a PES PTS discontinuity never moves the anchor.

**When does it actually rewrite?** Unconditionally. The rewriter passes PES timestamps through verbatim only until the first PCR of the input establishes the anchor; from that packet on, every PES PTS and DTS is re-stamped as anchor + source-delta, whichever master kind is active. There is no correlation test between master and source, no safety threshold that falls back to the raw source PTS, and no master kind that switches regeneration off. The only two opt-outs are `passthrough_clock: true` on the input and the MPTS latch above. (On a PID-bus assembled flow the per-input rewriters stand down and the assembler runs one rewriter, on one anchor, over the assembled output instead.)

The transcoded audio path does **not** anchor. `engine::ts_audio_replace::TsAudioReplacer` emits PES with source-relative PTS — its `anchor_target` helper ignores the pacer it is handed and returns the source PTS unchanged — because anchoring there would double-anchor the audio against the `ts_pts_rewriter` running on the same bytes downstream, which breaks A/V sync outright. One anchor per pipeline: the rewriter owns it for PCR, video PTS, audio PTS and SCTE-35 `pts_adjustment` alike.

### When to leave `passthrough_clock` off (regeneration on)

| Situation | Recommendation |
|---|---|
| One edge, dual-leg 2022-7 to a tier-1 receiver | **Leave on** (default). Both legs of one flow already emit an identical PCR sequence — that is what the per-flow master is for. |
| Two edges carrying the same feed, cut between them downstream | **Turn it off** — set `passthrough_clock: true` (or use a `bonded` input) and join both outputs to an [alignment group](#cross-node-egress-alignment-epoch_lock). Regeneration re-stamps PCR against each node's own arrival instant, which is exactly the difference alignment has to cancel; a shared PTP grandmaster does not change that. |
| Single edge, single output, no cross-host coherence requirement | Either — the default (regeneration on) is correct and adds negligible overhead; `passthrough_clock: true` is also fine. |
| You must emit the source PCR/PTS bytes unchanged | Set `passthrough_clock: true` to opt out of regeneration. |

## PCR pre-roll

The master clock places the **first** output PCR of an input at `master_now − PCR_PREROLL_27MHZ`, with the pre-roll at **80 ms** (2 160 000 ticks); every later PCR advances on the source delta from that anchor (`anchor_out + (src_pcr − anchor_src)`), with the master re-read only to size a discontinuity bridge. The pre-roll matches the ISO/IEC 13818-1 Annex L T-STD model — receivers need PCR to lead PTS by at least the transport-buffer + CPB pre-roll. 80 ms also limits the apparent A/V offset on receivers that don't apply T-STD scheduling to audio.

The pre-roll is fixed today; future work may expose it per-flow for low-latency contribution where 40 ms would be preferable.

## Lipsync trim

The master-clock handle exposes a per-flow lipsync offset bounded **±18 000** in 90 kHz ticks (±200 ms). Operators nudge it via the manager UI's per-flow telemetry card or directly with the WS command:

```json
{ "type": "command", "payload": { "action": "set_master_clock_lipsync",
                                  "flow_id": "...",
                                  "lipsync_offset_90k": 9000 } }
```

The trim applies to:

- The PES PTS rewriter (`engine::ts_pts_rewriter`) on audio PIDs — the only place it is applied. The transcoded audio replacer does not apply it: it emits source-relative PTS and leaves every anchor and trim to the rewriter downstream.

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
    "lipsync_offset_90k": 0,
    "active_input_id": "in-1"
  }
}
```

- `kind` is the **active rung** — the master actually running right now.
- `configured_kind` is the **operator's request** — what `master_clock.kind` was set to (`"auto"` when unset). The auto cascade carries both so the manager can render a compound label like `Auto → Source PCR PLL` / `Auto → PTP` / `Auto → Wallclock`; when a specific kind is pinned the field is omitted altogether, and reappears only if that PLL falls back — `kind` flips to `wallclock` while `configured_kind` reports `source_pcr_pll`.
- `active_input_id` names the input the clock is attributed to — for a PLL rung, the input whose PCR the loop is tracking, or the one it failed on. Assembled flows pin it to the designated `assembly.pcr_source` input for the flow's lifetime so a switcher Take doesn't relabel the clock source; every other flow has its active input restamped on each 1 Hz tick. Absent when the flow has no active input.
- `fallback_active` and `fallback_reason` appear once the fallback watcher has given up on a **pinned** PLL and dropped the master to the wallclock rung — `fallback_reason` is one of `no_pcr_observed`, `insufficient_samples` or `jitter_too_high`. Both are omitted from the wire otherwise: the auto cascade treats its wallclock rung as an expected floor and leaves them unset (`kind` / `configured_kind` tell that story instead), while an assembled flow raises them whenever the designated `assembly.pcr_source` PLL is unlocked, on any rung. The Warning event `master_clock_pll_fallback` fires on both paths — see [Events & Alarms](/edge/events-and-alarms/).

The manager renders the kind label (including the compound `configured → active` form), lock chip, rate offset, p99 jitter, and the trim knob on the per-flow detail page.

## Capability gating

Edges advertise `"master_clock"` on `HealthPayload.capabilities`. Manager UI gates the per-flow telemetry card and the lipsync trim knob on this string, so older edges hide the controls automatically and the relevant commands stay safe to send.

## Cross-node egress alignment (`epoch_lock`)

Everything above is per-flow, and per-flow is per-node. Two edges forwarding the same contribution feed over independent paths emit it at instants separated by their ingest-latency difference — routinely hundreds of milliseconds. Cutting between them on a downstream switcher shows a jump in content and in receiver buffer occupancy.

An **alignment group** cancels that difference. Each member's UDP/RTP output carries an `epoch_lock` block and derives every PCR-bearing datagram's release instant from a shared anchor plus a fixed `egress_offset_ms` dwell — by arithmetic rather than by a feedback loop, so alignment never has to converge. The result is a clean **cut** between nodes, not a seamless 2022-7 merge.

Four things about it matter on this page:

- **The shared anchor is minted by the manager, not by a node.** Any mapping a node infers from its own observations is stamped on arrival, so it already carries the very latency alignment must cancel. The manager mints from the *slowest* member's arrival plus a margin, which makes each member's required dwell its lead over the slowest rather than its absolute end-to-end latency.
- **Alignment and PCR/PTS regeneration are mutually exclusive.** The PCR reaching the emitter has to be a function of the content, not of the node, so every input must be `bonded` or set `passthrough_clock: true` — which also turns off the PES PTS regeneration and the discontinuity bridge described above.
- **Scope is narrow and enforced.** Single-input, single-program, non-transcoded, non-assembled UDP/RTP forwarding, with an unambiguous PCR PID — the output's `program_number` or an explicit `epoch_lock.pcr_pid`, one of the two required on every member — plus explicit `egress_pacing: "pcr"` and no `cbr_pad_to_kbps`. `egress_offset_ms` is bounded 150–800 ms and must be identical on every member.
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
