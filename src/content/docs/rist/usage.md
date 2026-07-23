---
title: Usage Guide
description: Embedding bilbycast-rist as a Rust library — sender / receiver, configuration, retransmit-buffer sizing, and using the protocol crate directly.
sidebar:
  order: 2
---

bilbycast-rist is a pure-Rust RIST implementation split into two crates:

| Crate | Purpose | When to use it |
|---|---|---|
| `rist-protocol` | Wire format, RTCP state machines, NACK tracking, RTT estimation, bonding merger — **no I/O** | Embedding RIST into a custom event loop, or sans-IO testing |
| `rist-transport` | Tokio-based async transport with the `RistSocket` API | Most Rust applications |

This page is for users embedding `rist-transport` directly. For wire formats and state-machine detail, see the [Protocol Reference](/rist/protocol-reference/).

## Add the dependency

```toml
[dependencies]
rist-transport = { path = "../bilbycast-rist/rist-transport" }
# or, if using only protocol types (no networking):
rist-protocol = { path = "../bilbycast-rist/rist-protocol" }
tokio = { version = "1", features = ["full"] }
```

## Sender

A RIST sender wraps application data (typically MPEG-TS) in RTP packets and sends them to a remote receiver, handling retransmission requests automatically.

```rust
use rist_transport::{RistSocket, RistSocketConfig};
use bytes::Bytes;
use std::net::SocketAddr;

async fn run_sender() -> anyhow::Result<()> {
    let config = RistSocketConfig {
        local_addr: "0.0.0.0:6010".parse()?,  // must be even port
        retransmit_buffer_capacity: 4096,      // packets kept for NACK recovery
        rtt_echo_enabled: true,                // measure RTT for optimal NACK timing
        ..Default::default()
    };

    let remote: SocketAddr = "10.0.0.2:6000".parse()?;
    let sender = RistSocket::sender(config, remote).await?;

    // Send MPEG-TS payloads (typically 1316 bytes = 7 x 188-byte TS packets)
    loop {
        let ts_data: Bytes = receive_from_encoder().await;
        sender.send(ts_data).await?;
    }
}
```

Sender behaviour:

- RTP packets are sent to the remote's even port (e.g. 6000); RTCP (SR + SDES) to the remote's odd port (e.g. 6001) every 100 ms
- Incoming NACKs trigger retransmission from the ring buffer
- RTT echo requests from the receiver are answered automatically
- The internal channel has capacity 256; if the application sends faster than the network can drain, `send()` will await

## Receiver

A RIST receiver listens for RTP data, detects packet loss via sequence gaps, and requests retransmission via NACK.

```rust
use rist_transport::{RistSocket, RistSocketConfig};

async fn run_receiver() -> anyhow::Result<()> {
    let config = RistSocketConfig {
        local_addr: "0.0.0.0:6000".parse()?,  // must be even port
        buffer_size: std::time::Duration::from_millis(1000), // 1s recovery window
        max_nack_retries: 10,
        ..Default::default()
    };

    let mut receiver = RistSocket::receiver(config).await?;

    // Receive payloads (RTP header stripped, just the TS data)
    while let Some(payload) = receiver.recv().await {
        // payload is Bytes, typically 1316 bytes of MPEG-TS
        forward_to_decoder(&payload).await;
    }
    Ok(())
}
```

Receiver behaviour:

- Binds to even port P (RTP) and P+1 (RTCP)
- Learns the sender's address from the first received RTP packet
- Detects gaps in the sequence-number stream
- Sends NACKs after RTT/2 (or a 20 ms floor when RTT is unknown or smaller)
- Retries up to `max_nack_retries` times per lost packet
- RTCP (RR + SDES + NACKs) emitted every 100 ms
- The internal delivery channel has capacity 1024; slow consumers cause packet drops (logged as warnings)

## Shutdown

```rust
sender.close();
receiver.close();  // also available via drop
```

## Configuration reference

```rust
pub struct RistSocketConfig {
    /// Local address to bind (RTP port, must be even).
    pub local_addr: SocketAddr,

    /// Remote address (for sender: receiver's RTP port).
    pub remote_addr: Option<SocketAddr>,

    /// Receiver buffer size (how long to wait for retransmissions).
    /// Higher values tolerate more loss but add latency.
    /// Typical: 100-2000 ms for broadcast, 50-200 ms for low-latency.
    pub buffer_size: Duration,

    /// Maximum NACK retransmission attempts per lost packet.
    /// After this many attempts, the packet is considered permanently lost.
    pub max_nack_retries: u32,

    /// RTCP compound packet emission interval.
    /// TR-06-1 requires <= 100 ms. Lower values improve loss recovery
    /// speed but increase control overhead.
    pub rtcp_interval: Duration,

    /// CNAME for SDES packets.
    /// If None, auto-generated from the local socket address.
    pub cname: Option<String>,

    /// Sender retransmit buffer capacity (number of packets).
    /// Must cover: max_rtt * packet_rate.
    /// Default 2048 covers ~4 seconds at 5 Mbps.
    pub retransmit_buffer_capacity: usize,

    /// Enable RTT echo request/response (optional per TR-06-1).
    /// Improves NACK timing when RTT varies. Disable for minimal overhead.
    pub rtt_echo_enabled: bool,
}
```

Defaults:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `local_addr` | `0.0.0.0:5000` | Local RTP bind address (must be even port) |
| `buffer_size` | 1000 ms | Receiver buffer for retransmission recovery |
| `max_nack_retries` | 10 | Max NACK attempts per lost packet before giving up |
| `rtcp_interval` | 100 ms | RTCP compound packet emission interval (TR-06-1 limit) |
| `retransmit_buffer_capacity` | 2048 | Sender retransmit ring buffer size (packets) |
| `rtt_echo_enabled` | true | Enable RTT measurement via RTCP APP echo |
| `cname` | auto | SDES CNAME string (auto-generated from local address) |

## Sizing the retransmit buffer

The retransmit buffer must hold enough packets to cover the maximum expected round-trip time:

```
capacity >= max_rtt_seconds * packets_per_second
```

| Bitrate | Packet rate (1316 B) | RTT 100 ms | RTT 500 ms | RTT 1000 ms |
|---------|---------------------|------------|------------|-------------|
| 5 Mbps  | ~475 pps            | 48         | 238        | 475         |
| 20 Mbps | ~1900 pps           | 190        | 950        | 1900        |
| 50 Mbps | ~4750 pps           | 475        | 2375       | 4750        |
| 100 Mbps| ~9500 pps           | 950        | 4750       | 9500        |

The default 2048 covers up to ~50 Mbps at 400 ms RTT. For higher bitrates or longer RTT, increase `retransmit_buffer_capacity`.

## Using the protocol crate directly

If you need to parse/serialise RIST packets without the transport layer (e.g. for a custom networking stack), use `rist-protocol` directly:

```rust
use rist_protocol::packet::rtp::{RtpHeader, RtpPacket};
use rist_protocol::packet::rtcp::{RtcpCompound, RtcpPacket};
use rist_protocol::packet::rtcp_sr::SenderReport;
use rist_protocol::protocol::nack_tracker::{NackScheduler, RetransmitBuffer};
use rist_protocol::protocol::rtt::RttEstimator;

// Parse an incoming RTP packet
let (header, header_size) = RtpHeader::parse(&udp_data)?;
let payload = &udp_data[header_size..];

// Parse a compound RTCP packet
let compound = RtcpCompound::parse(&rtcp_data)?;
for pkt in &compound.packets {
    match pkt {
        RtcpPacket::SenderReport(sr) => { /* process SR */ }
        RtcpPacket::Nack(nack) => { /* retransmit requested packets */ }
        _ => {}
    }
}
```

## Interop testing

Ready-to-use interop programs live in `rist-transport/examples/`. Build them with `cargo build --examples`, then run against librist 0.2.11:

```bash
# librist ristsender -> bilbycast receiver
cargo run --example interop_receiver -- --bind 0.0.0.0:6000 --output udp://127.0.0.1:7000
ristsender -i "udp://127.0.0.1:5000" -o "rist://127.0.0.1:6000?buffer=1000" -p 0

# bilbycast sender -> librist ristreceiver (note the @ = listen mode)
ristreceiver -i "rist://@:6100?buffer=1000" -o "udp://127.0.0.1:7100" -p 0
cargo run --example interop_sender -- --input udp://0.0.0.0:5100 --output 127.0.0.1:6100
```

Use `-p 0` on every librist invocation — it selects Simple Profile, which is required for interop. For rates above 100 Mbps, raise the OS-level UDP receive-buffer maximum (`net.core.rmem_max` on Linux, `net.inet.udp.recvspace` on macOS); bilbycast-rist already requests 32 MB socket buffers itself.

## Thread safety

`RistSocket` is `Send` but not `Sync`. The `send()` method takes `&self` (uses an internal `mpsc::Sender`, which is `Send + Sync`). The `recv()` method takes `&mut self`. For multi-threaded access to the receiver, wrap it in a `Mutex` or use a dedicated task.
