---
title: MXL (Media eXchange Layer)
description: Same-host shared-memory cloud-native broadcast composition via the EBU / Linux Foundation Media eXchange Layer.
sidebar:
  order: 13
---

bilbycast-edge can attach to **MXL (Media eXchange Layer)** flows as both producer and consumer. MXL is the EBU / Linux Foundation shared-memory transport for same-host broadcast composition — multiple containerised media services on one box pass uncompressed essence through `/dev/shm` instead of a loopback NIC.

MXL is the on-host complement of ST 2110. Where ST 2110 carries uncompressed essence over IP between hosts, MXL carries it through shared memory between processes on the same host. PTP-locked, well-defined timing model, same RFC packet shapes for ANC. The natural shape for a Kubernetes pod chain — SRT-in from venue → branding pod (MXL) → audio-mixer pod (MXL) → contribution-encoder pod → SRT/RIST-out — with one PTP clock and no loopback-NIC tax.

## When to use it

- **Same-host composition pipelines.** Branding, graphics, audio routing, multi-angle replay as a chain of MXL-attached pods.
- **ST 2110 ↔ MXL bridging.** Pull a ST 2110-20 feed off the wire, publish it onto an MXL domain for downstream pods to consume.
- **Cross-vendor interop in cloud broadcast.** MXL is the EBU + Linux Foundation + NABA reference layer for software-based broadcast — vendors targeting NAB 2026 / IBC 2026 are aligning around it.

MXL is **not** cross-host transport. For that, use SRT / RIST / RTP / ST 2110 / [bonding](/edge/bonding/) — MXL's experimental Fabrics API is deliberately not enabled here. MXL is also same-host only; two edges on different machines must use one of the IP transports to bridge.

## License + status

- **License:** Apache-2.0 (compatible with bilbycast-edge's AGPL-3.0-or-later combined work).
- **Upstream version:** libmxl v1.0.2 (pinned as a git submodule; the v1.0 API is explicitly frozen).
- **Maintainer:** [dmf-mxl/mxl](https://github.com/dmf-mxl/mxl) — EBU, Linux Foundation, NABA, plus broadcaster contributors.

## Feature flag — `mxl` (off by default)

MXL ships compiled-in on the release binary but requires the `mxl` Cargo feature when building from source. The release tarball is built with `mxl mxl-not-built` — the Rust glue is in, libmxl.so is discovered at runtime via dlopen rather than baked in. That keeps the `*-linux-full` tarball portable across hosts that may or may not have libmxl installed.

If the runtime probe doesn't find libmxl.so on the dynamic loader path, the edge starts cleanly without the `mxl-video` / `mxl-audio` / `mxl-anc` capability bits. Config validation never consults the probe, so the refusal lands at flow start rather than at config load: an MXL **output** fails to start outright, and an MXL **input** raises a Critical `mxl_domain_unavailable` event and then produces nothing while the rest of the flow keeps running. Loud on both sides — but on the input side it is an event to watch for, not a config the edge refused to accept.

## Install libmxl on the host

MXL needs libmxl.so reachable by the edge at runtime. Three options:

### Option A — apt-installed package (when distributions package it)

Distributions are picking libmxl up gradually. When your distro ships it, the standard `ldconfig`-resolved `/usr/lib/.../libmxl.so` is found automatically.

### Option B — build libmxl from source (today's path on Ubuntu 24.04)

bilbycast-mxl-rs vendors the upstream `dmf-mxl/mxl` repo as a submodule. Build prereqs (Ubuntu 24.04):

```bash
sudo apt update
sudo apt install -y clang cmake ninja-build bison flex lld pkg-config \
                    libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev
git clone --depth 1 https://github.com/microsoft/vcpkg.git ~/vcpkg
~/vcpkg/bootstrap-vcpkg.sh
```

Then build from the bilbycast-mxl-rs source tree:

```bash
git clone --recurse-submodules https://github.com/Bilbycast/bilbycast-mxl-rs.git
cd bilbycast-mxl-rs
export CC=clang CXX=clang++
cargo build --release
```

The build product lands inside Cargo's target directory. Locate it and install system-wide:

```bash
LIBMXL=$(find target -name 'libmxl.so' -not -path '*/deps/*' | head -1)
sudo cp -P "${LIBMXL}"* /usr/local/lib/
sudo ldconfig
```

### Option C — env-var override (development)

For development without `sudo`, point the edge at the in-tree `libmxl.so` directly:

```bash
export BILBYCAST_LIBMXL_SO=/path/to/libmxl.so
export LD_LIBRARY_PATH=$(dirname "$BILBYCAST_LIBMXL_SO"):$LD_LIBRARY_PATH
./bilbycast-edge --config config.json
```

## Verify the probe

The edge publishes no capability list over its own REST API — the bits ride the manager WebSocket on `HealthPayload.capabilities`. Three checks, in the order they answer:

**1. The startup log.** Restart the edge and look for the `mxl: probe …` line:

```
mxl: probe succeeded — libmxl loaded from /usr/local/lib/libmxl.so; /dev/shm tmpfs check = OK
```

That line means the three capability bits are advertised. `mxl: probe found no libmxl.so — mxl-* capabilities will not be advertised` means the dynamic loader couldn't reach it — revisit Option A / B / C above. A `/dev/shm tmpfs check = MISS (libmxl perf will degrade)` is a **non-fatal performance warning**, not a probe failure: the probe has already succeeded and the bits are advertised either way.

**2. The binary.** Confirm the feature was compiled in:

```bash
./bilbycast-edge --print-capabilities | grep -x 'feature mxl'
```

The flag prints two lists — one `feature` line per compiled-in Cargo feature, then the capability list evaluated cold. `capability mxl-video` never appears in it: the flag returns before the boot probe that `dlopen`s libmxl has run.

**3. The manager.** Drop an `mxl_*` node onto the unit in the [Visual Flow Editor](/manager/visual-flow-editor/) — it reads the bits off the node's last health tick and flags *"This physical unit does not advertise support for ..."* when no `mxl*` capability is there. That is the only manager surface that consults them today.

## PTP is mandatory

The grain timing model in MXL requires every attached process to agree on the same monotonic 27 MHz reference — on bilbycast that's the per-flow [master clock](/edge/clocking/) bound to `ptp4l`. MXL flows get there on their own: the auto-selector maps every `mxl_*` input to the `ptp` master-clock kind, so leaving `master_clock` unset (or `"auto"`) is the correct configuration.

Nothing enforces it, though. An explicit `master_clock.kind = "wallclock"` on an MXL flow is currently **accepted and honoured** — no validator inspects `master_clock.kind` for MXL flows — so setting it silently drops the grain timing model onto a free-running, undisciplined clock. Don't set it.

If PTP isn't already set up on the host, switch the Time page to **Auto** (find a grandmaster) or **Grandmaster** (provide one yourself) — see [Time (PTP)](/edge/ptp/). The boot probe only `dlopen`s `libmxl.so` — it reads no PTP state of any kind, so the `mxl-*` capability bits appear on a host with no grandmaster in sight. PTP is a per-flow operational requirement here, not a capability gate.

## Input variants

Add an MXL input by setting `type: "mxl_video"`, `"mxl_audio"`, or `"mxl_anc"`. All three share the `(domain_path, flow_name)` domain reference — the pair both ends must agree on for libmxl to route grains — and then diverge per essence: `mxl_video` also carries the raster, the frame rate and a mandatory encode block, `mxl_audio` adds defaulted channel and packet-time fields, and `mxl_anc` carries nothing beyond the domain reference.

```json
{
  "id": "mxl-video-in",
  "name": "MXL video in from sibling pod",
  "type": "mxl_video",
  "domain_path": "/dev/shm/mxl",
  "flow_name": "studio-1-cam-a",
  "width": 1920,
  "height": 1080,
  "frame_rate_num": 30000,
  "frame_rate_den": 1001,
  "video_encode": {
    "codec": "h264_auto", "chroma": "yuv422p", "bit_depth": 10, "bitrate_kbps": 20000
  }
}
```

Shared by all three variants:

| Field | Type | Notes |
|-------|------|-------|
| `type` | string | `"mxl_video"`, `"mxl_audio"`, `"mxl_anc"`. |
| `domain_path` | string | **Required.** Absolute path, 1–4096 chars — the MXL domain directory, conventionally `/dev/shm/<name>`. There is no default; omitting it is a config error. Keep it on tmpfs / ramfs, or libmxl's shared-memory performance model degrades sharply. |
| `flow_name` | string | **Required.** libmxl flow name — **`[A-Za-z0-9_-]` only, 1–256 chars**, so spaces and dots are rejected at config load. The edge hashes it with `uuid_v5(NAMESPACE_DNS, flow_name)` to compute the MXL flow id — see [Flow id interop](#flow-id-interop) below. |
| `clock_domain` | u8 | PTP clock domain `0..=127`. Inherits from the flow when omitted. |

Then, per essence:

| Variant | Additional fields |
|---------|-------------------|
| `mxl_video` | **Required:** `width`, `height`, `frame_rate_num`, `frame_rate_den`, and a `video_encode` block (see below). Optional `pid_overrides` for the synthesised TS. |
| `mxl_audio` | `channels` (1 / 2 / 4 / 8 / 16, default 2), `packet_time_us` (125 / 250 / 333 / 500 / 1000 / 4000, default 1000 — ST 2110-30 PM-compatible), plus optional `transcode`, `audio_encode` and `pid_overrides`. |
| `mxl_anc` | None. |

`mxl_video` carries uncompressed V210 (Y'CbCr 4:2:2 10-bit progressive) at the negotiated raster + rate. `mxl_audio` carries Float32 PCM at 48 kHz (mono or interleaved channels). `mxl_anc` carries RFC 8331-shaped ancillary data (officially supported since libmxl v1.0.1).

### Encoding to TS for transport / assembly

`mxl_video` and `mxl_audio` are uncompressed essences. To carry either onto a TS transport (SRT, RTP, UDP, RIST) or feed it into a [Flow Assembly](/edge/flow-assembly/) PID bus, it has to be encoded first.

On **`mxl_video` that path is live, and the `video_encode` block is mandatory** — it's the one in the example above. The input unpacks each V210 grain to planar 4:2:2 10-bit, encodes it with the named backend and muxes the result onto the flow's broadcast channel, exactly like the ST 2110-20 ingress path. Naming a backend this build wasn't compiled with is refused at config load, not at the first frame.

On **`mxl_audio` the encode chain is not implemented.** `audio_encode` is accepted by validation and charged to the resource budget, then ignored: the read loop drains Float32 grains and discards them. No event fires in that case — the `mxl_audio_no_encode_set` Warning is raised only when `audio_encode` is *omitted* — so a flow configured this way produces silence with nothing on the Events page to explain it.

`mxl_anc` is RFC 8331 either way — it can be carried into ST 2110-40 outputs verbatim with no transformation.

## Output variants

Mirror shape — set `type: "mxl_video" | "mxl_audio" | "mxl_anc"` on the output. The edge publishes onto the named flow on the chosen domain.

```json
{
  "id": "mxl-video-out",
  "name": "MXL video out to downstream pod",
  "type": "mxl_video",
  "domain_path": "/dev/shm/mxl",
  "flow_name": "studio-1-cam-a-branded",
  "width": 1920,
  "height": 1080,
  "frame_rate_num": 30000,
  "frame_rate_den": 1001
}
```

Output essence is V210 (video), Float32 PCM @ 48 kHz (audio), or RFC 8331 (ANC). Conversion from TS or other input shapes runs in-process via the edge's existing decode + scale paths — see [Codec matrix](/edge/codec-matrix/) for what backends activate where.

## Flow id interop

MXL identifies flows by UUID, not by name. To attach to a flow published by **any third-party MXL producer** (upstream `mxl-gst-testsrc`, vendor pods), compute the UUID the same way bilbycast does:

```
flow_id = uuid_v5(NAMESPACE_DNS, flow_name)
```

The peer's NMOS / config JSON `id` field must carry the same UUID-v5 hash. Mismatched names produce silent no-grain attachment — there's no decode-time error because libmxl just sees an empty flow slot.

A confirmed interop recipe between bilbycast-edge and `mxl-gst-testsrc`: pick a flow name (e.g. `studio-1-cam-a`), compute its v5 UUID once (`uuidgen -n @dns -N studio-1-cam-a -s` or any equivalent helper), and paste that UUID into the gst pipeline's NMOS JSON. From then on both sides attach to the same shared-memory grain stream.

## Capabilities

`HealthPayload.capabilities` carries one or more of:

| Capability | Meaning |
|---|---|
| `mxl-video` | `mxl_video` input + output usable on this host. |
| `mxl-audio` | `mxl_audio` input + output usable. |
| `mxl-anc` | `mxl_anc` input + output usable. |

All three are advertised together when libmxl probes successfully. The manager UI gates the MXL input + output dropdowns on these strings, so older edges (and edges without libmxl reachable) hide the options automatically.

## Limitations (v1)

- **Audio bridge stubbed; video bridge complete.** The **video** bridge is fully implemented both ways: `run_mxl_video_input` drives a scaled encoder (V210 → H.264 / HEVC → TS) and `run_mxl_video_output` drives decode + scale (TS → V210 grains). Only the **audio** bridge is incomplete, and the two halves report differently. The **output** side (TS → PCM decode) is scaffolded and always raises a `mxl_audio_decode_pending` Warning at flow start. The **input** side (PCM → TS encode) is missing too, but its `mxl_audio_no_encode_set` Warning fires only when `audio_encode` is *omitted* — set it and the grains are drained silently, with no event at all. ANC pass-through is end-to-end and stable. Track progress in the edge repo's [`docs/mxl-integration-plan.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/mxl-integration-plan.md).
- **V210 + Float32 PCM @ 48 kHz are the only essence formats.** Other source pixel formats are converted via libswscale at encode time; other audio sample rates need explicit transcode (the edge will refuse a silent rate change).
- **Same-host only.** MXL's experimental Fabrics API (cross-host) is deliberately not enabled. Cross-host stays on SRT / RIST / ST 2110 / [bonding](/edge/bonding/).
- **No sub-grain I/O / slices.** The upstream experimental ultra-low-latency mode is not enabled — we'll pick it up when it leaves experimental.

## See also

- [`bilbycast-edge/docs/mxl-integration-plan.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/mxl-integration-plan.md) — architectural plan, FFI design, and the broadcast-quality gate plan.
- [Time (PTP)](/edge/ptp/) — pick a PTP role and confirm grandmaster lock before bringing up MXL.
- [Master clock & A/V sync](/edge/clocking/) — why MXL flows resolve to a PTP master, and what an explicit wallclock override costs.
- [SMPTE ST 2110](/edge/st2110/) — the IP-transport sibling MXL was modelled after.
- [Codec matrix](/edge/codec-matrix/) — what video / audio encode backends activate on which hosts.
