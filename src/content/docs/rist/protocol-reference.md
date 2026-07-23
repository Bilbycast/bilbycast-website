---
title: Protocol Reference
description: Wire formats, state machines, and design decisions in the pure-Rust bilbycast-rist RIST Simple Profile implementation.
sidebar:
  order: 3
---

Technical details of the bilbycast-rist implementation, covering wire formats, state machines, and design decisions.

## Specifications

| Spec | Title | Status |
|------|-------|--------|
| RFC 3550 | RTP: A Transport Protocol for Real-Time Applications | Implemented |
| RFC 4585 | Extended RTP Profile for RTCP-Based Feedback (AVPF) | Implemented (Generic NACK) |
| TR-06-1:2020 | RIST Simple Profile | Implemented |
| TR-06-2:2024 | RIST Main Profile | Types stubbed |

## Packet Formats

### RTP (RFC 3550)

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|V=2|P|X|  CC   |M|     PT      |       sequence number         |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                           timestamp                           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                             SSRC                              |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

- **V** = 2 (always)
- **PT** = 33 (MPEG-2 TS, per SMPTE 2022-1)
- **Timestamp** = NTP-aligned, 90 kHz clock (NTP_seconds × 90000, truncated to 32 bits)
- **Payload** = 1316 bytes (7 × 188-byte TS packets, standard for broadcast)

The RTP retransmit flag is carried in the SSRC LSB (LSB=1 marks a retransmission), the authoritative source for the `retransmits_received` stat.

### RTCP Sender Report (PT=200)

Sent by the sender every 100 ms. Always RC=0 (no report blocks) per TR-06-1. The NTP and RTP timestamps use the same wall-clock source; the receiver uses this mapping to compute output timing.

### RTCP Receiver Report (PT=201)

Sent by the receiver every 100 ms. RC=1 with one report block, or RC=0 for keepalive.

### RTCP SDES (PT=202)

Sent with every compound RTCP. One chunk, one CNAME item, 32-bit aligned.

### RTCP NACK (PT=205)

Two formats, both as Transport-layer Feedback (RTPFB):

**Bitmask NACK (FMT=1, RFC 4585)** — `[PID(16), BLP(16)]*`. PID identifies one lost packet; BLP is a bitmask covering packets PID+1 through PID+16.

**Range NACK (FMT=15, TR-06-1)** — `[start(16), extra(16)]*`. Identifies a contiguous range: start through start+extra (inclusive).

bilbycast-rist also **parses** librist's default APP-based range NACK (PT=204, "RIST" subtype 0), verified against librist 0.2.11.

### RTCP APP — RTT Echo (PT=204)

Optional mechanism for measuring round-trip time (TR-06-1 Section 5.2.6).

- **Request (subtype=2)**: `SSRC, "RIST", timestamp_MSW, timestamp_LSW`
- **Response (subtype=3)**: `SSRC, "RIST", timestamp_MSW, timestamp_LSW, processing_delay_us`

### Compound RTCP

All RTCP is sent as compound packets (RFC 3550 Section 6.1). First packet must be SR or RR. Parsing is lenient — unknown sub-packets (e.g. XR PT=77, librist's RRT extension) are tolerated and preserved rather than aborting the compound.

- Sender compound: `[SR, SDES, RTT_echo_request?]`
- Receiver compound: `[RR, SDES, NACK?, RTT_echo_request?]`
- RTT Echo Response compound: `[RR(empty), RTT_echo_response]`

## State Machines

### NACK Scheduler (receiver side)

O(1) gap detection using a flat ring buffer indexed by `seq % 4096`.

1. **Gap detection**: when packet N arrives and expected was M (M < N), mark M..N-1 as missing
2. **NACK timing**: first NACK after `base_delay` (20 ms); subsequent retries at `RTT` intervals if RTT is known
3. **Max retries**: after `max_nack_retries` (default 10) attempts, give up on the packet
4. **Recovery**: when an out-of-order or retransmitted packet arrives, deactivate its NACK slot

A fast NACK pump (10 ms tick, RTT-scaled retry delay) drives retransmission requests, and a receiver-side reorder / jitter buffer handles out-of-order delivery.

### Retransmit Buffer (sender side)

O(1) insert and lookup using a flat ring buffer indexed by `seq % capacity`.

- Default capacity: 2048 packets (power of two for fast modulo via bitmask)
- Each slot stores `Bytes` (reference-counted, zero-copy on retransmit)
- Stale detection: slot stores the sequence number; lookup verifies it matches

### RTT Estimator

TCP-style EWMA (RFC 6298):

- `SRTT = 7/8 × SRTT + 1/8 × sample`
- `RTTVAR = 3/4 × RTTVAR + 1/4 × |SRTT - sample|`
- NACK delay = SRTT / 2

### Bonding Merger (SMPTE 2022-7)

Deduplicates packets arriving on multiple network paths:

- Maintains a window of recently seen sequence numbers
- First arrival wins; duplicates are dropped
- Handles wraparound at the 16-bit sequence boundary

## Timestamp Design

RTP timestamps are NTP-aligned at 90 kHz:

```
rtp_timestamp = (NTP_time_in_microseconds * 90 / 1000) as u32
```

Where NTP time = Unix time + 2,208,988,800 seconds. This makes the SR's NTP-to-RTP mapping exact, which is required for correct output timing in receivers. Both RTP data packets and RTCP SR packets derive timestamps from the same wall-clock epoch captured at sender start (monotonic `Instant` paired with `SystemTime` for NTP conversion).

## Port Convention

RIST Simple Profile uses adjacent UDP port pairs:

- **RTP data**: even port P
- **RTCP control**: port P + 1

Both sender and receiver bind dual-port channels. The port must be even; odd ports are rejected with `ChannelError::OddPort`.

## Socket Configuration

Sockets are created with:

- `SO_REUSEADDR` — allows quick restart after crash
- 32 MB receive buffer — prevents kernel drops at high bitrates
- 32 MB send buffer — prevents send blocking during retransmit bursts
- Non-blocking mode — for tokio async I/O

## Lock-Free Design

The sender and receiver tasks own all mutable state. No `Mutex` or `RwLock` on the data path:

- Sender task: sequence counter, RTCP state, retransmit buffer, RTT estimator
- Receiver task: RTCP state, NACK scheduler, RTT estimator
- Communication: `mpsc` channels for application data in/out; a shared `RistConnStats` handle (`Arc<AtomicU64>`) exposes counters lock-free

The `tokio::select!` loop handles all I/O multiplexing without blocking.
