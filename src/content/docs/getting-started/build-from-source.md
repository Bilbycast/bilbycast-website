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
git clone https://github.com/Bilbycast/bilbycast-manager.git
git clone https://github.com/Bilbycast/bilbycast-relay.git
```

Cargo resolves the sibling crates automatically via the path-dependency entries in `bilbycast-edge/Cargo.toml`.

## Install build-time apt packages

```bash
sudo apt update
sudo apt install build-essential cmake make clang libclang-dev pkg-config \
                 libssl-dev g++ libdrm-dev libasound2-dev libudev-dev
```

For the edge `*-linux-full` variant (libx264 + libx265 software encoders):

```bash
sudo apt update
sudo apt install libx264-dev libx265-dev libnuma-dev
```

x86_64 only, for the QuickSync encoder (oneVPL):

```bash
sudo apt update
sudo apt install libvpl-dev
```

## Build

```bash
# Default edge — AGPL-only, no software video encoders
cd bilbycast-edge && cargo build --release && cd ..

# Or the full edge — matches the *-linux-full release tarball
cd bilbycast-edge && cargo build --release --features video-encoders-full && cd ..

# Manager (needs Postgres at runtime)
cd bilbycast-manager && cargo build --release && cd ..

# Relay
cd bilbycast-relay && cargo build --release && cd ..
```

The release binaries land in each crate's `target/release/`.

## Run

```bash
./bilbycast-edge/target/release/bilbycast-edge --config config.json
cd bilbycast-manager && cargo run --release -- serve   # needs BILBYCAST_JWT_SECRET + BILBYCAST_MASTER_KEY
./bilbycast-relay/target/release/bilbycast-relay
```

For the manager + relay setup steps that the release tarballs guide you through (Postgres, secrets, registration tokens, systemd units), follow [Install the manager](/manager/getting-started/) and [Install the relay](/relay/getting-started/) — substitute the path to your `target/release/` binary for the tarball one.

## Feature flags

The most useful Cargo feature flags on the edge:

| Flag | Default | Effect |
|------|---------|--------|
| `tls` | on | HTTPS + RTMPS |
| `webrtc` | on | WebRTC WHIP / WHEP via str0m |
| `fdk-aac` | on | In-process AAC decode and encode |
| `video-thumbnail` | on | In-process video decode + thumbnail JPEG, plus Opus / MP2 / AC-3 audio encode |
| `replay` | on | Continuous flow recording to disk + clip playback as a fresh input |
| `display` | on (Linux) | Local-display output (HDMI / DisplayPort + ALSA) |
| `video-encoder-x264` | off | H.264 software transcoding via libx264 (GPL-2.0-or-later) |
| `video-encoder-x265` | off | HEVC software transcoding via libx265 (GPL-2.0-or-later) |
| `video-encoder-nvenc` | off | NVIDIA NVENC H.264 / HEVC |
| `video-encoder-qsv` | off | Intel QuickSync H.264 / HEVC (x86_64 only) |
| `video-encoders-full` | off | Composite of all four — used by the `*-linux-full` release variant |

Default-off encoder flags are off because they pull in extra system dependencies and (for x264 / x265) flip the binary licence to AGPL-3.0-or-later as a combined work with GPL-2.0-or-later code. The release matrix builds two variants per architecture so users don't have to think about this — pick the tarball that matches your needs and skip the source build.
