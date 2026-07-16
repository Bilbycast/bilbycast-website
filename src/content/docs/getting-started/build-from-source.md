---
title: Build from Source
description: How to clone and compile bilbycast-edge, manager, and relay yourself.
sidebar:
  order: 5
---

Pre-built binaries cover most cases — see the per-product getting-started pages first. Build from source only if you need a feature flag combination the release matrix doesn't ship, or you want to follow the development branch.

## What you'll need

- A Linux host with Rust stable (edition 2024 — install via [rustup.rs](https://rustup.rs/)).
- The build-time apt packages below.
- Roughly 5 GB of disk for the workspace + build artefacts.

## Clone the workspace

The edge has several path-dependency sibling crates that must live in the same parent directory before it can compile:

```bash
git clone https://github.com/Bilbycast/bilbycast-libsrt-rs.git           # default SRT backend
git clone https://github.com/Bilbycast/bilbycast-fdk-aac-rs.git --recurse-submodules
git clone https://github.com/Bilbycast/bilbycast-ffmpeg-video-rs.git --recurse-submodules
git clone https://github.com/Bilbycast/bilbycast-rist.git
git clone https://github.com/Bilbycast/bilbycast-bonding.git
git clone https://github.com/Bilbycast/bilbycast-edge.git
git clone https://github.com/Bilbycast/bilbycast-relay.git
```

Cargo resolves the sibling crates automatically via the path-dependency entries in `bilbycast-edge/Cargo.toml`.

The **manager** source is proprietary (EULA-licensed) and not publicly cloneable — install the signed pre-built tarball via [Install the manager](/manager/getting-started/) instead. The manager has no feature-flag combinations that would warrant a source build.

## Install build-time apt packages

```bash
sudo apt update
sudo apt install build-essential cmake make clang libclang-dev pkg-config \
                 libssl-dev g++ libdrm-dev libasound2-dev libudev-dev
```

To match the release feature set (libx264 + libx265 software encoders, plus NVENC + NVDEC headers):

```bash
sudo apt update
sudo apt install libx264-dev libx265-dev libnuma-dev
```

x86_64 only, for the QuickSync encoder (oneVPL):

```bash
sudo apt update
sudo apt install libvpl-dev
```

ARM Rockchip SBCs (RK3568 / RK3588 — NanoPi R5S/R6S, Orange Pi 5, Radxa Rock 5B) only, for the **RKMPP** hardware H.264 / HEVC encoder. `rockchip_mpp` isn't in stock Ubuntu, so add the maintained Rockchip multimedia PPA first:

```bash
sudo add-apt-repository -y ppa:jjriek/rockchip-multimedia
sudo apt update
sudo apt install librockchip-mpp-dev libdrm-dev
```

Only the userspace dev package is needed to *build* — the VPU (`/dev/mpp_service`) is a runtime dependency, so this compiles on any aarch64 host, not just a Rockchip board.

## Build

```bash
# Edge — matches the release tarball (every video codec backend compiled in)
cd bilbycast-edge && cargo build --release --features video-encoders-full && cd ..

# Or a minimal edge — protocol bridging only, no software video encoders
cd bilbycast-edge && cargo build --release && cd ..

# Edge with Rockchip RKMPP hardware encode (RK3568 / RK3588 only)
cd bilbycast-edge && cargo build --release \
    --features "video-encoder-x264 video-encoder-x265 video-encoder-rkmpp display" && cd ..

# Relay
cd bilbycast-relay && cargo build --release && cd ..
```

The release binaries land in each crate's `target/release/`.

:::tip[Rockchip: prefer the prebuilt binary]
Each release publishes a dedicated `bilbycast-edge-aarch64-linux-rockchip.tar.gz` with RKMPP already compiled in (plus x264 / x265 CPU fallback for 10-bit / 4:2:2, which the VPU can't encode). Install that instead of building unless you need a custom feature set — and the manager's remote-upgrade path auto-selects it for nodes running the Rockchip variant. RKMPP encode needs a Rockchip **BSP kernel** exposing `/dev/mpp_service` and the running user in the `video` group.
:::

## Run

```bash
./bilbycast-edge/target/release/bilbycast-edge --config config.json
./bilbycast-relay/target/release/bilbycast-relay
```

For the manager + relay setup steps that the release tarballs guide you through (Postgres, secrets, registration tokens, systemd units), follow [Install the manager](/manager/getting-started/) and [Install the relay](/relay/getting-started/) — for the relay, substitute the path to your `target/release/` binary for the tarball one.

## Feature flags

The most useful Cargo feature flags on the edge:

| Flag | Default | Effect |
|------|---------|--------|
| `tls` | on | HTTPS + RTMPS |
| `webrtc` | on | WebRTC WHIP / WHEP via str0m |
| `fdk-aac` | on | In-process AAC decode and encode |
| `media-codecs` | on | In-process video decode + thumbnail JPEG, plus Opus / MP2 / AC-3 audio encode |
| `replay` | on | Continuous flow recording to disk + clip playback as a fresh input |
| `display` | on (Linux) | Local-display output (HDMI / DisplayPort + ALSA) |
| `video-encoder-x264` | off | H.264 software transcoding via libx264 (GPL-2.0-or-later) |
| `video-encoder-x265` | off | HEVC software transcoding via libx265 (GPL-2.0-or-later) |
| `video-encoder-nvenc` | off | NVIDIA NVENC H.264 / HEVC |
| `video-encoder-qsv` | off | Intel QuickSync H.264 / HEVC (x86_64 only) |
| `video-decoder-nvdec` | off | NVIDIA NVDEC hardware decode for the local-display output (`h264_cuvid` / `hevc_cuvid`); shares `nv-codec-headers` with `video-encoder-nvenc` |
| `video-decoder-qsv` | off | Intel QSV hardware decode for the local-display output (`h264_qsv` / `hevc_qsv`); shares `libvpl-dev` with `video-encoder-qsv`; x86_64 only |
| `video-encoder-vaapi` | off | VAAPI H.264 / HEVC encode (`h264_vaapi` / `hevc_vaapi`) — AMD (Mesa radeonsi) or Intel (iHD); royalty-free. Needs `libva-dev` + `libdrm-dev`; Linux only |
| `video-decoder-vaapi` | off | VAAPI hardware decode for the local-display output; zero-copy DMA-BUF / KMS scanout. Same deps as `video-encoder-vaapi`; Linux only |
| `video-encoder-rkmpp` | off | Rockchip **RKMPP** hardware H.264 / HEVC encode (`h264_rkmpp` / `hevc_rkmpp`, 8-bit 4:2:0) on aarch64 RK3568 / RK3588. Needs `librockchip-mpp-dev`; **not** in `video-encoders-full` (Rockchip-only, links dynamically). Shipped prebuilt as the `aarch64-linux-rockchip` release artefact |
| `video-encoders-full` | off | Composite of every **x86_64 / generic-aarch64** video codec backend — encoders (x264 + x265 + NVENC + QSV + VAAPI) **and** HW decoders (NVDEC + QSV-decode + VAAPI-decode). Used by the `*-full` release tarballs; runtime probe auto-detects which backends the host can actually open. Excludes RKMPP (Rockchip-only — see `video-encoder-rkmpp`) |

Default-off encoder flags are off because they pull in extra system dependencies and (for x264 / x265) flip the binary licence to AGPL-3.0-or-later as a combined work with GPL-2.0-or-later code. The published release tarball turns them on via `video-encoders-full` so you don't have to think about this — install the signed binary unless you have a reason to compile your own.
