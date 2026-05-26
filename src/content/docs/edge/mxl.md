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
- **Upstream version:** libmxl v1.0.1 (released 2026-05-07; v1.0 API explicitly frozen).
- **Maintainer:** [dmf-mxl/mxl](https://github.com/dmf-mxl/mxl) — EBU, Linux Foundation, NABA, plus broadcaster contributors.

## Feature flag — `mxl` (off by default)

MXL ships compiled-in on the release binary but requires the `mxl` Cargo feature when building from source. The release tarball is built with `mxl mxl-not-built` — the Rust glue is in, libmxl.so is discovered at runtime via dlopen rather than baked in. That keeps the `*-linux-full` tarball portable across hosts that may or may not have libmxl installed.

If the runtime probe doesn't find libmxl.so on the dynamic loader path, the edge starts cleanly without the `mxl-video` / `mxl-audio` / `mxl-anc` capability bits, and any flow referencing an MXL input/output is rejected with a clear validation error. No silent degradation.

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

After installing libmxl, restart the edge and check `/api/v1/stats/health`:

```bash
curl https://edge:8443/api/v1/stats/health -H "Authorization: Bearer $TOKEN" | \
  jq '.capabilities | map(select(startswith("mxl")))'
```

Expected output:

```json
["mxl-video", "mxl-audio", "mxl-anc"]
```

If the capabilities are absent, check the startup log for the `mxl: probe …` line — `probe found no libmxl.so` means the loader couldn't reach it (Option A/B/C above); `probe failed: /dev/shm is not tmpfs` means the kernel mount needs fixing on this host.

## PTP is mandatory

MXL flows fail validation when `master_clock.kind = "wallclock"`. The grain timing model in MXL requires every attached process to agree on the same monotonic 27 MHz reference — on bilbycast that's the per-flow [master clock](/edge/clocking/) bound to `ptp4l`.

If PTP isn't already set up on the host, switch the Time page to **Auto** (find a grandmaster) or **Grandmaster** (provide one yourself) — see [Time (PTP)](/edge/ptp/). The MXL bring-up probe waits for `port_state == SLAVE` before advertising the capability bits.

## Input variants

Add an MXL input by setting `type: "mxl_video"`, `"mxl_audio"`, or `"mxl_anc"`. All three share the same shape: attach to a domain + flow id on the local `/dev/shm` MXL store.

```json
{
  "id": "mxl-video-in",
  "name": "MXL video in from sibling pod",
  "type": "mxl_video",
  "domain": "/dev/shm/mxl",
  "flow_name": "studio-1-cam-a"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `type` | string | `"mxl_video"`, `"mxl_audio"`, `"mxl_anc"`. |
| `domain` | string | MXL domain mount point on the local host. Default `/dev/shm/mxl`. |
| `flow_name` | string | Human flow name. The edge hashes this with `uuid_v5(NAMESPACE_DNS, flow_name)` to compute the MXL flow id — see [Flow id interop](#flow-id-interop) below. |

`mxl_video` carries uncompressed V210 (Y'CbCr 4:2:2 10-bit progressive) at the negotiated raster + rate. `mxl_audio` carries Float32 PCM at 48 kHz (mono or interleaved channels). `mxl_anc` carries RFC 8331-shaped ancillary data (officially supported since libmxl v1.0.1).

### Encoding to TS for transport / assembly

`mxl_video` and `mxl_audio` are uncompressed essences. To carry them onto a TS transport (SRT, RTP, UDP, RIST) or feed them into a [Flow Assembly](/edge/flow-assembly/) PID bus, set per-input `video_encode` or `audio_encode`:

```json
{
  "id": "mxl-audio-in",
  "type": "mxl_audio",
  "domain": "/dev/shm/mxl",
  "flow_name": "studio-1-mic",
  "audio_encode": { "codec": "aac_lc", "bitrate_kbps": 192 }
}
```

`mxl_anc` is RFC 8331 either way — it can be carried into ST 2110-40 outputs verbatim with no transformation.

## Output variants

Mirror shape — set `type: "mxl_video" | "mxl_audio" | "mxl_anc"` on the output. The edge publishes onto the named flow on the chosen domain.

```json
{
  "id": "mxl-video-out",
  "name": "MXL video out to downstream pod",
  "type": "mxl_video",
  "domain": "/dev/shm/mxl",
  "flow_name": "studio-1-cam-a-branded"
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

- **Codec bridges scaffolded, not complete.** Video and audio encode-on-output paths are wired with explicit `mxl_video_encode_pending` / `mxl_audio_decode_pending` Warning events at flow start — those paths return clean errors today instead of silently producing wrong-output. ANC pass-through is end-to-end and stable. Track progress in the edge repo's [`docs/mxl-integration-plan.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/mxl-integration-plan.md).
- **V210 + Float32 PCM @ 48 kHz are the only essence formats.** Other source pixel formats are converted via libswscale at encode time; other audio sample rates need explicit transcode (the edge will refuse a silent rate change).
- **Same-host only.** MXL's experimental Fabrics API (cross-host) is deliberately not enabled. Cross-host stays on SRT / RIST / ST 2110 / [bonding](/edge/bonding/).
- **No sub-grain I/O / slices.** The upstream experimental ultra-low-latency mode is not enabled — we'll pick it up when it leaves experimental.

## See also

- [`bilbycast-edge/docs/mxl-integration-plan.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/mxl-integration-plan.md) — architectural plan, FFI design, and the broadcast-quality gate plan.
- [Time (PTP)](/edge/ptp/) — pick a PTP role and confirm grandmaster lock before bringing up MXL.
- [Master clock & A/V sync](/edge/clocking/) — why PTP is the only valid master for MXL flows.
- [SMPTE ST 2110](/edge/st2110/) — the IP-transport sibling MXL was modelled after.
- [Codec matrix](/edge/codec-matrix/) — what video / audio encode backends activate on which hosts.
