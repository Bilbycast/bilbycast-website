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
git clone https://github.com/Bilbycast/bilbycast-libsrt-rs.git --recurse-submodules   # SRT backend (the only one)
git clone https://github.com/Bilbycast/bilbycast-fdk-aac-rs.git --recurse-submodules
git clone https://github.com/Bilbycast/bilbycast-ffmpeg-video-rs.git --recurse-submodules
git clone https://github.com/Bilbycast/bilbycast-rist.git
git clone https://github.com/Bilbycast/bilbycast-bonding.git
git clone https://github.com/Bilbycast/bilbycast-mxl-rs.git --recurse-submodules
git clone https://github.com/Bilbycast/bilbycast-decklink-rs.git
git clone https://github.com/Bilbycast/bilbycast-rga-rs.git
git clone https://github.com/Bilbycast/bilbycast-edge.git
git clone https://github.com/Bilbycast/bilbycast-relay.git
```

Clone **all** of them before you build anything — even for the minimal edge build below. `bilbycast-mxl-rs`, `bilbycast-decklink-rs` and `bilbycast-rga-rs` back the off-by-default `mxl`, `sdi-decklink` and `rga-transfer` features, but they are unconditional path-dependency entries in `bilbycast-edge/Cargo.toml`, and Cargo loads every path dependency's manifest while resolving the graph whether or not its feature is enabled. A missing sibling directory aborts the build at manifest load, before a single crate compiles.

The **manager** source is proprietary (EULA-licensed) and not publicly cloneable — install the signed pre-built tarball via [Install the manager](/manager/getting-started/) instead. The manager has no feature-flag combinations that would warrant a source build.

## Install build-time apt packages

```bash
sudo apt update
sudo apt install build-essential cmake make clang libclang-dev pkg-config \
                 libssl-dev g++ nasm libdrm-dev libasound2-dev libudev-dev
```

Don't drop `nasm`: on x86 / x86_64 the vendored FFmpeg build script falls back to `--disable-x86asm` when nasm isn't on `PATH` and the build then *succeeds*, emitting only a `cargo:warning` about the assembly-less libswscale it produced. Read the build log rather than treating a green build as a correct binary.

To match the `*-full` release feature set you need the dev headers for **every** backend `video-encoders-full` compiles in — x264 + x265 (software encoders), VAAPI (encode + decode), and QSV (x86_64). Most come from apt:

```bash
sudo apt update
sudo apt install libx264-dev libx265-dev libnuma-dev \
                 libva-dev libvpl-dev
```

One asymmetry to know about before you distribute what you build: Debian / Ubuntu's `libx264-dev` ships no `libx264.a`, so the build script finds no static archive and links libx264 **dynamically** (with a `cargo:warning` saying so). The result is pinned to the build host's `libx264.so.<build>` SONAME — x264 pastes its build number into symbol names, so a soname symlink on the target does not rescue it. For a portable binary, build x264 from source with `./configure --enable-static --enable-pic --disable-cli` and put that prefix's `lib/pkgconfig` first on `PKG_CONFIG_PATH`, which is exactly what the release workflow does. `libx265-dev` needs none of this — it does ship `libx265.a`, and `libnuma-dev` satisfies its `-lnuma` at the static link.

`libva-dev` is required by both `video-encoder-vaapi` and `video-decoder-vaapi`; `libvpl-dev` (oneVPL) covers `video-encoder-qsv` + `video-decoder-qsv` and is **x86_64 only** — omit it on aarch64 (Intel QuickSync is x86_64-only, and the aarch64 `*-full` artefact excludes QSV).

`video-encoders-full` also compiles in NVENC (`video-encoder-nvenc`) and NVDEC (`video-decoder-nvdec`), which need the **NVIDIA codec headers**. Ubuntu does not package these — they must be cloned and installed from source before the full build will compile:

```bash
git clone https://git.videolan.org/git/ffmpeg/nv-codec-headers.git
cd nv-codec-headers && sudo make install && cd ..
```

Without both the VAAPI headers and the NVENC/NVDEC headers in place, `--features video-encoders-full` fails to compile. (You don't need an NVIDIA GPU or driver to *build* — the headers are enough; NVENC/NVDEC simply stay dormant at runtime on hosts without the driver.)

ARM Rockchip SBCs (RK3568 / RK3588 — NanoPi R5S/R6S, Orange Pi 5, Radxa Rock 5B) only, for the **RKMPP** hardware H.264 / HEVC encode + decode and the **RGA** DRM_PRIME→sysmem transfer (`rga-transfer`). Neither `rockchip_mpp` nor `librga` is in stock Ubuntu, so add the maintained Rockchip multimedia PPA first:

```bash
sudo add-apt-repository -y ppa:jjriek/rockchip-multimedia
sudo apt update
sudo apt install librockchip-mpp-dev librga-dev librga2 libdrm-dev
```

`librga2` is not optional. This PPA's `librga-dev` declares no dependency on the runtime package, so installing only the dev half leaves `/usr/lib/aarch64-linux-gnu/librga.so` dangling at a `librga.so.2` that isn't there — and that doesn't fail early, it fails at the *final link* of the edge binary, roughly twelve minutes in, as `cannot find -lrga`.

The hardware is a runtime dependency only — the VPU (`/dev/mpp_service`) and the 2D accelerator (`/dev/rga`) — so these features compile on any aarch64 host, not just a Rockchip board.

## Build

```bash
# Edge — matches the published x86_64-linux-full release tarball
cd bilbycast-edge && cargo build --release \
    --features "video-encoders-full display multiviewer mxl mxl-not-built sdi-decklink" && cd ..

# Or a minimal edge — protocol bridging only, no software video encoders
cd bilbycast-edge && cargo build --release && cd ..

# Edge with Rockchip RKMPP hardware encode + decode (RK3568 / RK3588 only)
# rga-transfer is the RGA DRM_PRIME->sysmem copy that fixes RK3588 display stutter —
# the feature that distinguishes the aarch64-linux-rockchip release artefact.
cd bilbycast-edge && cargo build --release \
    --features "video-encoder-rkmpp video-decoder-rkmpp rga-transfer display" && cd ..

# Relay — matches the lean *-linux release tarball (opaque forwarder only)
cd bilbycast-relay && cargo build --release && cd ..

# Or the relay with viewer distribution — matches the *-linux-distribution tarball
cd bilbycast-relay && cargo build --release \
    --features "viewer-distribution-vendored,portal" && cd ..
```

The release binaries land in each crate's `target/release/`.

`video-encoders-full` is only the codec half of a `*-full` artefact — `multiviewer`, `mxl` and `sdi-decklink` are separate features, which is why the command above names them. Two of those carry build-time prerequisites of their own: `mxl` needs the `bilbycast-mxl-rs` sibling and its submodule (`mxl-not-built` skips the heavy libmxl C++ build and dlopens `libmxl.so` at runtime instead — see [MXL](/edge/mxl/)), and `sdi-decklink` needs `DECKLINK_SDK_DIR` pointed at the EULA-gated Blackmagic SDK's `Linux/include` directory or `libdecklink-sys`'s build script panics when it is unset (see [SDI](/edge/sdi/)). Drop `sdi-decklink` from the feature list to build a full edge without SDI.

The relay's `default` feature set is empty, so a bare `cargo build --release` is the pure opaque forwarder: no WHEP SFU, no LL-HLS / CMAF origin, no viewer portal. The distribution command additionally produces a second binary, `bilbycast-portal`, alongside `bilbycast-relay` — see [Viewer distribution](/relay/viewer-distribution/).

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
