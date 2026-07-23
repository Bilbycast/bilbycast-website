---
title: RIST Library Overview
description: bilbycast-rist — pure-Rust implementation of the RIST Simple Profile, wire-verified against librist 0.2.11.
sidebar:
  order: 1
---

bilbycast-rist is a pure-Rust implementation of the RIST (Reliable Internet Stream Transport) protocol for professional broadcast media transport. It wraps standard RTP/RTCP with automatic retransmission (ARQ) to recover lost packets over lossy IP networks — internet, satellite, cellular — without the latency penalty of FEC-only approaches.

Zero C/C++ dependencies. Wire-verified against [librist](https://code.videolan.org/rist/librist) 0.2.11 (Simple Profile), and interoperable with FFmpeg `rist://` and GStreamer `ristenc`/`ristdec`.

## Features

- **No external system libraries** — builds with `cargo build` alone
- **Wire-verified** — 100% bidirectional interop with librist 0.2.11 Simple Profile
- **NACK-based ARQ** — receiver detects gaps and requests retransmission
- **RTT-aware timing** — NACK scheduling adapts to measured round-trip time
- **Dual-port RTP/RTCP** — standard even/odd port pair (RFC 3550)
- **SMPTE 2022-7 bonding** — hitless merge across redundant network paths
- **Low, bounded latency** — configurable receiver buffer (typically 100–2000 ms)
- **Async I/O** — Built on Tokio, lock-free data path

## Workspace Structure

```
bilbycast-rist/
  rist-protocol/    # Pure protocol logic (no I/O, no async runtime)
  rist-transport/   # Async I/O layer (tokio-based networking)
```

| Crate | Use When |
|-------|----------|
| `rist-protocol` | Building a custom transport or embedding RIST logic — packet parsing/serialisation, RTCP state machines, NACK tracking, RTT estimation, bonding merger. No I/O dependencies. |
| `rist-transport` | Building Rust applications that need RIST — tokio-based sender/receiver tasks, dual-port UDP channels, public `RistSocket` API. |

## Quick Start

```rust
use rist_transport::{RistSocket, RistSocketConfig};
use bytes::Bytes;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // --- Sender ---
    let config = RistSocketConfig {
        local_addr: "0.0.0.0:6010".parse()?,
        ..Default::default()
    };
    let sender = RistSocket::sender(config, "10.0.0.2:6000".parse()?).await?;
    sender.send(Bytes::from_static(&[0x47, 0x00, 0x00, 0x10])).await?;

    // --- Receiver ---
    let config = RistSocketConfig {
        local_addr: "0.0.0.0:6000".parse()?,
        ..Default::default()
    };
    let mut receiver = RistSocket::receiver(config).await?;
    while let Some(payload) = receiver.recv().await {
        // payload is the raw MPEG-TS data (no RTP header)
        println!("received {} bytes", payload.len());
    }
    Ok(())
}
```

## Specifications

| Spec | Title | Status |
|------|-------|--------|
| TR-06-1:2020 | RIST Simple Profile | Implemented |
| TR-06-2:2024 | RIST Main Profile | Types stubbed (GRE-over-UDP, DTLS, AES-CTR, null-packet deletion — dedicated follow-up sprints) |
| RFC 3550 | RTP: A Transport Protocol for Real-Time Applications | Implemented |
| RFC 4585 | Extended RTP Profile for RTCP-Based Feedback (AVPF) | Implemented (Generic NACK) |

## Interoperability

Tested against librist 0.2.11 (Simple Profile, `-p 0`) under adverse-network conditions (10% loss / 200 ms delay / 50 ms jitter on both RTP and RTCP paths):

| Direction | Rate | Delivery |
|-----------|------|----------|
| librist ristsender → bilbycast receiver | 5 Mbps | 100% |
| librist ristsender → bilbycast receiver | 50 Mbps | 100% |
| bilbycast sender → librist ristreceiver | 5 Mbps | 100% (stats-verified) |
| bilbycast sender → librist ristreceiver | 50 Mbps | 99.996% |

## In bilbycast-edge

RIST is an always-compiled, first-class input **and** output protocol in bilbycast-edge — there is no feature flag to enable it. The edge integration is wire-verified against the full librist 0.2.11 ARQ matrix in both directions.

See the [Usage Guide](/rist/usage/) for embedding the library, and the [Protocol Reference](/rist/protocol-reference/) for wire formats and state-machine detail.
