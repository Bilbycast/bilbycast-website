---
title: SRT Library Overview
description: bilbycast-srt — pure Rust implementation of the SRT protocol, wire-compatible with libsrt v1.5.5.
sidebar:
  order: 1
---

bilbycast-srt is a complete, pure-Rust implementation of the SRT (Secure Reliable Transport) protocol. It provides the same functionality as the original Haivision C++ SRT library but compiles without any external system dependencies.

## Features

- **Pure Rust** — No C/C++ dependencies, no system library linking
- **Wire-compatible** — Compatible with libsrt v1.5.5
- **Async I/O** — Built on Tokio for high-performance async networking
- **Encryption** — AES-128/192/256 in CTR and GCM modes via RustCrypto
- **FEC** — Forward Error Correction with row-only and staircase/2D layouts
- **Stream ID & Access Control** — Full handshake-based access control with 18 rejection codes
- **Statistics** — 80+ performance counters
- **C FFI** — Optional C-compatible API matching `srt.h`
- **Cross-platform** — Linux, macOS, Windows

## Workspace Structure

```
bilbycast-srt/
  srt-protocol/    # Pure protocol logic (no I/O, no async runtime)
  srt-transport/   # Async I/O layer (tokio-based networking)
  srt-ffi/         # C FFI compatibility layer (optional)
```

| Crate | Use When |
|-------|----------|
| `srt-protocol` | Building a custom transport or embedding SRT logic |
| `srt-transport` | Building Rust applications that need SRT |
| `srt-ffi` | Drop-in replacement for the C++ SRT library |

## Quick Start

```rust
use srt_transport::SrtListener;
use std::time::Duration;

// Start a listener
let mut listener = SrtListener::builder()
    .latency(Duration::from_millis(120))
    .live_mode()
    .bind("127.0.0.1:4200".parse()?)
    .await?;

// Accept a connection
let socket = listener.accept().await?;
let data = socket.recv().await?;
```

```rust
use srt_transport::SrtSocket;
use std::time::Duration;

// Connect as a caller
let socket = SrtSocket::builder()
    .latency(Duration::from_millis(120))
    .live_mode()
    .connect("127.0.0.1:4200".parse()?)
    .await?;

socket.send(b"Hello SRT!").await?;
```

## Advanced Features

### Encryption

```rust
let socket = SrtSocket::builder()
    .latency(Duration::from_millis(120))
    .passphrase("my-secret-passphrase")
    .crypto_mode(CryptoModeConfig::AesGcm)  // or AesCtr (default)
    .connect(addr)
    .await?;
```

### Stream ID Access Control

```rust
// Caller sends a Stream ID
let socket = SrtSocket::builder()
    .stream_id("my-stream-name")
    .connect(addr)
    .await?;

// Listener filters by Stream ID
let listener = SrtListener::builder()
    .access_control_fn(|info| {
        if info.stream_id() == Some("allowed-stream") {
            Ok(())
        } else {
            Err(RejectReason::Forbidden)
        }
    })
    .bind(addr)
    .await?;
```

### FEC (Forward Error Correction)

```rust
let socket = SrtSocket::builder()
    .packet_filter("fec,cols:10,rows:5,layout:staircase,arq:onreq")
    .connect(addr)
    .await?;
```

See [libsrt Comparison](/srt/libsrt-comparison/) for a detailed feature comparison with the C++ library.
