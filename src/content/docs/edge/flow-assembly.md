---
title: Flow Assembly (PID Bus)
description: Build a fresh MPEG-TS — SPTS or MPTS — from elementary streams pulled off any of a flow's inputs. Per-PID routing, Essence selectors, pre-bus hitless, PCM/AES3 inputs via audio_encode, runtime hot-swap.
sidebar:
  order: 4
---

A bilbycast-edge flow normally forwards the bytes of its active input out to every output — a **passthrough** flow. Flow Assembly is the second mode: the flow **builds a fresh MPEG-TS from elementary streams pulled off any of its inputs** (video from input A, audio from input B, multi-program playout from N sources) and publishes that synthesised TS onto the same broadcast channel every output already consumes.

Every existing output type consumes the assembled TS unchanged — UDP, RTP (with or without 2022-1 FEC / 2022-7 hitless), SRT (incl. bonded / 2022-7), RIST (incl. ARQ), RTMP/RTMPS, HLS, CMAF / CMAF-LL, WebRTC WHIP/WHEP. There is no output-type gate: if a passthrough flow could reach it, an assembled flow can reach it.

Internally the mechanism is a per-flow **PID bus**: every referenced input demuxes its TS into `(input_id, source_pid) → ElementaryStream` entries on a lock-free bus, and an assembler subscribes to the slots named in the flow's `assembly` block.

## What problem it solves

| You want to… | Before | With Flow Assembly |
|---|---|---|
| Mix video from input A with audio from input B as one SPTS out | Required an external mux — the edge couldn't splice ES between inputs | `assembly.kind = spts` with two slots, one per input |
| Build an MPTS carrying Studio 1 + Studio 2 from different sources | Had to pre-mux upstream and ingest the finished MPTS | `assembly.kind = mpts`, two programs each with their own slots |
| Publish a single SPTS built from two redundant ingress legs | SMPTE 2022-7 at the transport layer only (RTP/SRT/RIST) | Pre-bus `Hitless` source with primary-preference and a 200 ms stall timer |
| Swap which PID / input feeds a given program's audio at runtime | Had to stop + restart the flow | `UpdateFlowAssembly` — unchanged slots keep running, PMT version bumps mod 32 |

Passthrough flows keep working exactly as before. `assembly = null` (or `assembly.kind = passthrough`) is the default, and existing configs are unaffected.

## Assembly kinds

| Kind | What it builds | Programs | PCR requirement |
|---|---|---|---|
| `passthrough` | No assembly. Forwards the active input's bytes. Runtime-equivalent to `assembly = null`. | Must be empty | None |
| `spts` | Single-program TS from selected ES slots. | Exactly one | Flow-level *or* program-level `pcr_source` (program-level wins) |
| `mpts` | Multi-program TS, fresh PAT listing every program, one synthesised PMT per program. | One or more, unique `program_number` per program | Every program needs an effective `pcr_source` (its own, or the flow-level fallback) |

## Minimal SPTS example — video from input A + audio from input B

```json
{
  "id": "mixed-feed",
  "name": "Mixed Feed",
  "input_ids": ["cam-a", "mic-b"],
  "output_ids": ["udp-out", "srt-out"],
  "assembly": {
    "kind": "spts",
    "pcr_source": { "input_id": "cam-a", "pid": 256 },
    "programs": [
      {
        "program_number": 1,
        "service_name": "Mixed",
        "pmt_pid": 4096,
        "streams": [
          { "source": { "type": "pid",     "input_id": "cam-a", "source_pid": 256 }, "out_pid": 256, "stream_type": 27, "label": "Video (cam A)" },
          { "source": { "type": "essence", "input_id": "mic-b", "kind": "audio"   }, "out_pid": 257, "stream_type": 15, "label": "Audio (mic B)" }
        ]
      }
    ]
  }
}
```

## Minimal MPTS example — two programs from three inputs

```json
"assembly": {
  "kind": "mpts",
  "pcr_source": { "input_id": "cam-a", "pid": 256 },
  "programs": [
    {
      "program_number": 1,
      "service_name": "Studio 1",
      "pmt_pid": 4096,
      "pcr_source": { "input_id": "cam-a", "pid": 256 },
      "streams": [
        { "source": { "type": "pid",     "input_id": "cam-a", "source_pid": 256 }, "out_pid": 256, "stream_type": 27 },
        { "source": { "type": "essence", "input_id": "mic-a", "kind": "audio" },   "out_pid": 257, "stream_type": 15 }
      ]
    },
    {
      "program_number": 2,
      "service_name": "Studio 2",
      "pmt_pid": 4112,
      "pcr_source": { "input_id": "cam-b", "pid": 256 },
      "streams": [
        { "source": { "type": "pid", "input_id": "cam-b", "source_pid": 256 }, "out_pid": 272, "stream_type": 36 },
        { "source": { "type": "pid", "input_id": "cam-b", "source_pid": 257 }, "out_pid": 273, "stream_type": 15 }
      ]
    }
  ]
}
```

## Slot sources — where the bytes come from

Every slot in a program's `streams[]` picks its source from one of three variants:

- **`"pid"`** — explicit PID off a named input: `{ "type": "pid", "input_id": "...", "source_pid": 256 }`. Use when the operator knows the exact upstream PID (from the input's live PSI catalogue, or a written spec).
- **`"essence"`** — first elementary stream of a given kind off a named input: `{ "type": "essence", "input_id": "...", "kind": "video" | "audio" | "subtitle" | "data" }`. Useful when the upstream is single-program and the operator just wants "its video" / "its audio" without binding to a specific PID. Resolves at flow start against the input's PSI catalogue, and re-resolves on every `UpdateFlowAssembly`.
- **`"hitless"`** — primary-preference pre-bus merger: `{ "type": "hitless", "primary": { <pid|essence> }, "backup": { <pid|essence> } }`. A merger task subscribes to both legs and forwards the primary verbatim; if no primary packet arrives for 200 ms it flips to the backup, and a short hold-off brings it back when primary traffic resumes. Either leg must itself be `pid` or `essence` — nested Hitless is rejected.

The `hitless` slot source is **not** SMPTE 2022-7 sequence-aware dedup — the PID bus today doesn't carry upstream RTP sequence numbers, so the merger compares on packet arrival timing rather than sequence. For byte-perfect dual-leg dedup use SMPTE 2022-7 at the input transport layer (RTP/SRT/RIST) — assembly can sit on top of that.

## PCR rules

- **SPTS** — exactly one PCR reference is required. Either set `assembly.pcr_source` at the top of the assembly, or set `pcr_source` on the one program. If both are set, program-level wins. The referenced `(input_id, pid)` must resolve to a concrete slot (or an Essence slot's input) inside the program, otherwise the flow fails to start with `pid_bus_pcr_source_unresolved`.
- **MPTS** — every program needs an effective PCR, whether from its own `pcr_source` or from the flow-level fallback. Validation catches a program with neither at config-save time. Per-program PCR enforces the H.222.0 rule that a program's `PCR_PID` must be one of its own ES PIDs.
- The chosen PCR rides byte-for-byte onto the assembled TS; the synthesised PMT's `PCR_PID` field points at the corresponding slot's `out_pid`.

## Input requirements — what can feed the bus

Every input referenced by any slot must either already produce MPEG-TS on the broadcast channel, or be configured so the runtime can wrap it into TS before publishing to the bus.

**Inputs that produce TS natively (always eligible):**
SRT, UDP, RTP (with `is_raw_ts: true`), RIST, RTMP (after the built-in FLV→TS muxer), RTSP, WebRTC WHIP/WHEP, ST 2110-20, ST 2110-23, Bonded, TestPattern.

**PCM / AES3 inputs that become TS when `audio_encode` is set on the input:**

| Input | Eligible `audio_encode.codec` |
|---|---|
| ST 2110-30 (L16 / L24 PCM) | `aac_lc`, `he_aac_v1`, `he_aac_v2`, `s302m` |
| `rtp_audio` (RFC 3551 PCM over RTP) | `aac_lc`, `he_aac_v1`, `he_aac_v2`, `s302m` |
| ST 2110-31 (AES3 transparent — Dolby E, etc.) | `s302m` only (the 337M sub-frames ride through the 302M wrap bit-for-bit) |

Without `audio_encode` set, an assembly referencing one of these inputs fails bring-up with `pid_bus_spts_input_needs_audio_encode`.

**Inputs with no current path to TS:** ST 2110-40 (ancillary data) — wrapping ANC into TS is deferred; referencing one emits `pid_bus_spts_non_ts_input`.

**Codec support on the decoded-ES cache:** `aac_lc`, `he_aac_v1`, `he_aac_v2`, `s302m`. `mp2` and `ac3` parse and validate successfully but fail loudly at flow bring-up with `pid_bus_audio_encode_codec_not_supported_on_input` until the matching muxer wrappers land.

## Runtime behaviour

- The assembler subscribes to the per-ES bus (`(input_id, source_pid) → EsPacket`), rewrites each 188-byte TS packet's PID to the configured `out_pid`, stamps a per-out-PID monotonic continuity counter, bundles 7 TS packets into MTU-safe 1316-byte RTP packets, and publishes them onto the flow's existing broadcast channel — exactly where a passthrough forwarder would.
- PAT and PMT are **synthesised on a 100 ms cadence**. When the PAT set changes, `PAT.version_number` bumps mod 32. When a program's slot composition or `pcr_source` changes, that program's `PMT.version_number` bumps mod 32 — both counters advance monotonically across swaps to avoid phantom-version collisions.
- PCR rides onto the TS byte-for-byte from the referenced slot's source packets.
- A 10 ms safety-net flush keeps partially-filled bundles shipping during sparse periods (audio-only idle, keyframe gaps) so downstream sockets never see multi-second silence.
- Backpressure: slot fan-ins are `broadcast::Receiver<EsPacket>`. Slow consumers drop rather than stall the demuxer — the same lock-free, never-block-the-data-path discipline used everywhere else in the edge.

## Hot-swap — `UpdateFlowAssembly`

The assembly plan is hot-swappable. A manager `UpdateFlowAssembly` WS command — or a direct `PUT /api/v1/flows/{flow_id}/assembly` REST call on the edge — replaces the running plan without tearing the flow down:

- Slots that are unchanged keep their existing bus fan-in tasks — **no packet gap**.
- Slots whose `source`, `out_pid`, `stream_type`, or `label` changed have their fan-ins re-spawned; fan-ins for removed slots are cancelled.
- Per-program `PMT.version_number` bumps for any program whose composition or PCR source changed.
- `PAT.version_number` bumps only when the set of programs changed (added / removed / renumbered).
- PSI is re-emitted immediately on swap so receivers see the new PMT before any packet lands on a new `out_pid`.
- The new assembly is persisted to `config.json` only after the swap succeeds. A no-op swap (incoming plan deserialises byte-equal to current) is a silent short-circuit.
- **Transitions across the passthrough boundary (passthrough ↔ spts/mpts) are rejected.** Those require a full `UpdateFlow` round-trip because the plumbing on the flow changes (bus + assembler spawn vs. direct broadcast).

## Interaction with output-level PID remap (`pid_map`)

The assembly owns the PID layout of the TS it produces — every slot's `out_pid`, every program's `pmt_pid`, whichever slot got selected as PCR. An output's `pid_map` applies **after** the assembly on the way out, so the same assembled PID layout can be published and then re-labelled per output if an external downstream has hard-coded PID expectations. Prefer picking the right `out_pid` in the assembly directly — `pid_map` is an escape hatch for downstream constraints you can't change.

## Monitoring

A running assembled flow exposes:

- **Flow-card badge** in the manager UI — `SPTS ASSEMBLED` / `MPTS ASSEMBLED` (cyan).
- **Assembled Output section** on the flow card — one sub-table per program listing each slot's `out_pid`, `stream_type`, resolved kind, source label (or `Hitless(A/B)`), live bitrate, packets, CC errors, PCR discontinuity counters from `FlowStats.per_es[]`.
- **Per-output PCR trust** — `p50 / p99` columns on the Outputs table, fed by `OutputStats.pcr_trust`. The sampler records `|ΔPCR_µs − Δwall_µs|` on successful sends of PCR-bearing TS packets into a rotating 4096-sample reservoir and exposes p50 / p95 / p99 / max.
- **Flow-rollup PCR trust** — `FlowStats.pcr_trust_flow` (Samples, p50 / p95 / p99 / Max, window-p95) rendered at the bottom of the flow card.
- **Events** — every `pid_bus_*` error code rides as a Critical event with structured `details` (`error_code`, `input_id`, `input_type`, `program_number`, …) so the manager UI can highlight the offending field on Create/Update modals without parsing the error string. See [Events & Alarms — PID bus / Flow Assembly](/edge/events-and-alarms/).

## Validation rules

All enforced at config-save time (plus belt-and-braces checks at flow bring-up). None of these can slip past to runtime:

- `passthrough` must have empty `programs` and no `pcr_source`.
- `spts` must have exactly one program.
- `mpts` must have at least one program; all `program_number` values unique, all `pmt_pid` values unique.
- Every referenced `input_id` must be in the flow's `input_ids`.
- `program_number` must be `> 0` (0 is reserved for the NIT).
- `pmt_pid` and every `out_pid` must be in `0x0010..=0x1FFE` (reserved PIDs and the NULL PID are refused).
- Within a program, every `out_pid` must be unique and must not equal that program's `pmt_pid`.
- `service_name` ≤ 128 chars; slot `label` ≤ 256 chars.
- SPTS: flow-level `pcr_source` or the one program's `pcr_source` must be set.
- MPTS: every program's effective `pcr_source` (own or flow-level fallback) must be set.
- When `pcr_source` resolves concretely, it must hit one of that program's slots (Pid match) or one of its Essence-slot inputs.
- Hitless nested inside another Hitless is rejected.
- Non-TS inputs without a valid `audio_encode` are rejected at flow bring-up with a specific `pid_bus_*` error code.

## Related

- **[MPTS → SPTS filtering](/edge/configuration/#mpts--spts-filtering)** — the simpler story: forward an upstream MPTS verbatim and optionally down-select a single program per output. Complementary to Flow Assembly — assembly builds *fresh* TS from elementary streams; filtering re-packs an existing TS.
- **[Events & Alarms](/edge/events-and-alarms/)** — the `pid_bus_*` error code reference.
- **[Hot Input Switching](/edge/overview/)** — format-agnostic zero-gap cutover between a flow's inputs, via `TsContinuityFixer`, for passthrough flows.
