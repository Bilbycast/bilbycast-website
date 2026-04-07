---
title: Usage Guide
description: Embedding bilbycast-srt as a Rust library — caller / listener / rendezvous, encryption, FEC, Stream ID access control, and pluggable congestion control.
sidebar:
  order: 2
---

bilbycast-srt is a pure-Rust SRT protocol implementation split into three crates:

| Crate | Purpose | When to use it |
|---|---|---|
| `srt-protocol` | Wire format, state machines, encryption, FEC, congestion control — **no I/O** | Embedding SRT into a custom event loop, FFI bindings, or sans-IO testing |
| `srt-transport` | Tokio-based async transport with `SrtSocket` / `SrtListener` | Most Rust applications |
| `srt-ffi` | C API matching `srt.h` (work in progress) | Linking SRT into a C/C++ project |

This page is for users embedding `srt-transport` directly. For a feature comparison against libsrt, see the [libsrt Comparison](/srt/libsrt-comparison/).

## Add the dependency

```toml
[dependencies]
srt-transport = { git = "https://github.com/Bilbycast/bilbycast-srt", branch = "main" }
tokio = { version = "1", features = ["full"] }
```

(Or use a path dependency if you have the workspace checked out next to your project.)

## Caller — connect to a listener

```rust
use srt_transport::SrtSocketBuilder;
use tokio::time::Duration;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut socket = SrtSocketBuilder::new_caller("203.0.113.5:9000".parse()?)
        .latency(Duration::from_millis(120))
        .passphrase("MyVerySecretPass".to_string())
        .key_length(16)
        .connect()
        .await?;

    // Stream MPEG-TS or any opaque payload
    let mut buf = vec![0u8; 1316];
    loop {
        let n = read_from_somewhere(&mut buf).await?;
        socket.send(&buf[..n]).await?;
    }
}
```

## Listener — accept callers

```rust
use srt_transport::SrtListenerBuilder;

let mut listener = SrtListenerBuilder::new("0.0.0.0:9000".parse()?)
    .passphrase("MyVerySecretPass".to_string())
    .key_length(16)
    .listen()
    .await?;

while let Some(conn) = listener.accept().await {
    let mut socket = conn?;
    println!("Accepted from {}", socket.peer_addr());
    println!("Stream ID: {:?}", socket.stream_id());
    tokio::spawn(handle_stream(socket));
}
```

## Rendezvous — symmetric peer-to-peer

```rust
let mut socket = SrtSocketBuilder::new_rendezvous(
        "0.0.0.0:9000".parse()?,            // local
        "203.0.113.5:9000".parse()?,        // remote
    )
    .latency(Duration::from_millis(200))
    .connect()
    .await?;
```

Both peers must use the same call. Useful when both endpoints are behind NAT and have negotiated a hole-punch via a third party.

## Encryption — AES-CTR vs AES-GCM

bilbycast-srt supports AES-128, AES-192, and AES-256 in two modes:

| Mode | When to use |
|---|---|
| **AES-CTR** (default, libsrt-compatible) | Maximum interop with libsrt v1.5.5 callers |
| **AES-GCM** (AEAD) | Production-grade authenticated encryption, recommended for new deployments |

```rust
use srt_transport::CryptoMode;

let socket = SrtSocketBuilder::new_caller(addr)
    .passphrase("MyVerySecretPass".to_string())
    .key_length(32)                           // AES-256
    .crypto_mode(CryptoMode::AesGcm)          // AEAD
    .connect()
    .await?;
```

> **Heads up**: libsrt v1.5.5 still gates GCM behind a preview build flag (epic #2336), and even with the preview build it requires TSBPD and forbids listener-side enforcement. bilbycast-srt's GCM is production-ready and works in all roles. If you're talking to a libsrt peer, use CTR unless you've verified the peer build supports GCM.

## FEC via `packet_filter`

bilbycast-srt implements libsrt v1.5.5-compatible Forward Error Correction. Configure it with the same `packet_filter` string libsrt uses:

```rust
let socket = SrtSocketBuilder::new_caller(addr)
    .packet_filter("fec,cols:10,rows:5,layout:staircase,arq:onreq")
    .connect()
    .await?;
```

Available layouts:

| Layout | Recovery | Overhead |
|---|---|---|
| `even` (row-only) | Single-packet loss within a row | `100/cols`% |
| `staircase` | Single-packet loss within a row OR column | `100/cols + 100/rows`% |
| `staircase` + 2D | Cascading row+column recovery for higher loss rates | Same as staircase |

ARQ integration modes:

| Mode | Behaviour |
|---|---|
| `always` | FEC and ARQ run in parallel |
| `onreq` | FEC handles immediate recoveries; ARQ kicks in only for losses FEC couldn't fix (lower bandwidth) |
| `never` | FEC only, no retransmission |

The handshake negotiates `packet_filter` via `SRT_CMD_FILTER` — both peers must agree, otherwise the connection is rejected.

## Stream ID and access control

Callers can send a Stream ID in the handshake; listeners can use it to accept or reject the connection:

```rust
// Caller side
let socket = SrtSocketBuilder::new_caller(addr)
    .stream_id("#!::r=studio-a,m=publish,u=alice".to_string())
    .connect()
    .await?;
```

```rust
// Listener side — implement an access control callback
use srt_transport::{AccessControl, HandshakeInfo, RejectReason};

struct MyAcl;

impl AccessControl for MyAcl {
    fn check(&self, info: &HandshakeInfo) -> Result<(), RejectReason> {
        match info.stream_id() {
            Some(id) if id.contains("u=alice") => Ok(()),
            Some(_) => Err(RejectReason::Auth),
            None => Err(RejectReason::BadResource),
        }
    }
}

let listener = SrtListenerBuilder::new(addr)
    .access_control(Box::new(MyAcl))
    .listen()
    .await?;
```

The structured `#!::key=value,...` format is parsed automatically. Stream IDs are limited to 512 bytes per the SRT spec.

## Stats — 80+ counters

Each `SrtSocket` exposes its full stats snapshot via `socket.stats()`. The snapshot is a single struct with 80+ fields covering:

- Packet counts: sent, received, dropped, lost, retransmitted
- Byte counts: same breakdown
- Rates: send/recv Mbps, instantaneous and smoothed
- RTT: min, max, current, smoothed
- Bandwidth: estimated, available
- ACK / NAK timing and counts
- Flow control: window, congestion window, flight size
- Buffer state: send buffer, receive buffer, occupancy
- TSBPD: sender delay, receiver delay
- FEC: recovered packets, uncorrectable losses, FEC overhead
- Reordering: packets dropped due to reorder timeout

Pull stats on a timer for monitoring:

```rust
use std::time::Duration;
use tokio::time::interval;

let mut tick = interval(Duration::from_secs(1));
loop {
    tick.tick().await;
    let s = socket.stats();
    println!("RTT={:.1} ms  loss={}  recovered={}",
        s.rtt_ms, s.pkt_lost_total, s.fec_recovered_pkts);
}
```

## Pluggable congestion control

The default is `LiveCC` (constant-rate, ~MPEG-TS bitrate, the SRT default). For bulk transfer, switch to `FileCC`:

```rust
use srt_transport::{CongestionControl, FileCC};

let socket = SrtSocketBuilder::new_caller(addr)
    .congestion_control(Box::new(FileCC::default()))
    .connect()
    .await?;
```

For research or specialised workloads, implement the `CongestionControl` trait yourself — `srt-protocol` is sans-IO so you can write CC algorithms without touching the transport layer.

## Stability fixes

Recent fixes worth knowing about:

- **TSBPD drop race** — fixed via Release/Acquire atomics. The original implementation had a window where the drop predicate could see a stale tail and discard a packet that was about to be ACKed. The fix is in place; the alternative "TSBPD-aware `recv()`" approach was abandoned because it caused FEC head-of-line blocking.
- **TSBPD `base_time` calibration** — refined on the first data packet (rather than only at handshake time) so high-latency links no longer report negative inter-arrival times in the first second.
- **ISN handling for rendezvous** — the initial sequence number negotiation for rendezvous mode was tightened to match libsrt's behaviour. Older bilbycast-srt builds occasionally failed to interop with libsrt rendezvous peers; this is fixed.

For currently-known issues (notably some FEC C++ interop edge cases — Rust↔Rust FEC is fully functional), see `KNOWN_ISSUES.md` in the repository.

## C FFI status

The `srt-ffi` crate exposes a C API matching `srt.h`. **It is currently work-in-progress**: the core protocol and transport are fully functional via Rust, but the FFI surface still has a number of unimplemented functions. If you specifically need C interop, check the source for the current set of exported symbols, or open an issue requesting the functions you need.

For Rust-native consumers, prefer `srt-transport` directly — there's no overhead from going through the FFI layer.
