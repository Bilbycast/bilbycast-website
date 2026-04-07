---
title: PTP Integration
description: How bilbycast-edge integrates with an external linuxptp ptp4l daemon for SMPTE ST 2110 timing.
sidebar:
  order: 10
---

bilbycast-edge integrates with PTP (Precision Time Protocol, IEEE 1588-2008) **best-effort, via an external `ptp4l` daemon**. There is no embedded PTP slave in the standard build — the design splits the high-precision kernel/hardware timestamping work into the well-tested `linuxptp` project and asks bilbycast only to *observe* the resulting clock state via `ptp4l`'s management socket.

This page covers the operational story: when PTP matters, what bilbycast actually polls, what lock states it reports, how to wire it up, and what's planned for the future `--features ptp-internal` build.

## When PTP matters

PTP is **required** for compliant SMPTE ST 2110-30 / -31 / -40 essence flows that need to interoperate with other ST 2110 equipment on the same broadcast plant. Specifically:

- ST 2110 PM (1 ms packet time, default) and AM (125 µs) profiles depend on a shared PTP grandmaster.
- NMOS IS-04 advertises a `clock` resource per device when any flow declares `clock_domain` — receivers use this to confirm clock alignment before activating a connection.
- BCP-004 receiver caps include media-clock constraints that imply PTP synchronisation.

PTP is **not required** for:

- `rtp_audio` inputs and outputs (no `clock_domain`, no NMOS PTP advertising — see [Audio Gateway](/edge/audio-gateway/)).
- SRT, RTP/MP2T, UDP, RTMP, RTSP, HLS, WebRTC, ST 2022-1/2 transports.
- WAN audio contribution via `audio_302m` over SRT.

If you're not running ST 2110 essence flows, you can skip this page.

## What bilbycast actually polls

bilbycast does **not** open raw PTP sockets, claim a NIC, or run PTP state machines. Instead it polls the `ptp4l` management socket — by default a Unix datagram socket at `/var/run/ptp4l` — and reads the `PORT_DATA_SET` and `TIME_STATUS_NP` management messages. From those it derives a single `PtpStateHandle` per `clock_domain`, which surfaces in:

- Per-flow stats: `FlowStats.ptp_state` (one of `locked`, `locked_holdover`, `free_run`, `unavailable`).
- NMOS IS-04 clock resource: a `ptp` clock entry on `/x-nmos/node/v1.3/self` whenever any flow declares `clock_domain`.
- The manager UI (when the edge advertises the `st2110-*` capability): a PTP card with current lock state and grandmaster identity.

If `ptp4l` is not running, the management socket is missing, or the socket exists but doesn't respond, the polled state falls back to `unavailable`. **The flow does not fail to start** — it will run, send/receive packets, and report `ptp_state: "unavailable"` so an operator can see the problem.

## Lock states

| State | Meaning |
|---|---|
| `locked` | `ptp4l` reports the port is in `SLAVE` state and the offset from the grandmaster is below the threshold |
| `locked_holdover` | Recently locked but the master has gone away or is reporting an unstable offset; bilbycast still trusts the local clock for a configurable holdover window |
| `free_run` | No master has ever been seen since startup, or holdover has expired — the local clock is running free |
| `unavailable` | The management socket is missing or unresponsive — bilbycast cannot determine state |

The state is sampled on a low-frequency timer (default ~1 s) and cached. Reading it from the data path is a single atomic load — there is zero per-packet PTP work.

## Wiring it up

### 1. Install `linuxptp`

```bash
sudo apt install linuxptp        # Debian / Ubuntu
sudo dnf install linuxptp        # RHEL / Fedora
```

### 2. Sample `ptp4l.conf` for SMPTE ST 2110 PM/AM

```ini
[global]
domainNumber          127
priority1             248
priority2             248
clockClass            248
clockAccuracy         0xFE
offsetScaledLogVariance 0xFFFF
free_running          0
network_transport     UDPv4
delay_mechanism       E2E
hybrid_e2e            1
tx_timestamp_timeout  10
logging_level         6

[eth0]
```

Then run as a systemd service or directly:

```bash
sudo ptp4l -i eth0 -m -f /etc/linuxptp/ptp4l.conf
```

### 3. Tell bilbycast which `clock_domain` your flows use

```json
{
  "id": "studio-feed",
  "input": {
    "type": "st2110_30",
    "address": "239.0.0.10:5004",
    "interface": "10.0.0.1",
    "clock_domain": 127,
    "sample_rate": 48000,
    "bit_depth": 24,
    "channels": 2
  },
  "outputs": []
}
```

Any flow with `clock_domain` set will:

- Pull the cached `PtpStateHandle` for that domain into its stats accumulator.
- Cause the NMOS Node API to advertise a `ptp` clock entry on `/x-nmos/node/v1.3/self`.

You don't need to point bilbycast at a specific socket path in normal deployments — it auto-discovers `/var/run/ptp4l`. To override:

```json
{
  "ptp": {
    "management_socket": "/run/ptp/ptp4l.0.sock"
  }
}
```

## Verified NIC families

PTP precision is dominated by the NIC's hardware timestamping support. bilbycast itself uses `SO_TIMESTAMPING` via libc directly (no `nix` dependency, macOS returns `Unsupported`). The following NIC families have been verified with `linuxptp`:

| Vendor | Family | Notes |
|---|---|---|
| Intel | i210, i350, X710, E810 | All support hardware tx/rx timestamping; X710/E810 recommended for high-density plants |
| Mellanox / NVIDIA | ConnectX-5, ConnectX-6, ConnectX-7 | Hardware timestamping verified; pair with `mlx5_core` driver |

Other PTP-capable NICs should work — the requirement is hardware tx/rx timestamping support exposed via `SO_TIMESTAMPING`. Test with `ethtool -T <iface>` to confirm.

## What's deferred — `--features ptp-internal`

A future build flag `--features ptp-internal` is reserved for an in-process PTP slave implementation based on [`statime`](https://github.com/pendulum-project/statime), the pure-Rust PTP stack from the Pendulum project. The motivation is to:

- Eliminate the `linuxptp` external dependency.
- Run on platforms where `ptp4l` is not packaged (containers, immutable OS images, embedded ARM).
- Get tighter integration with bilbycast's stats / event pipeline (PTP state changes as first-class events).

Until that lands, the recommended path is `linuxptp` + the management-socket integration described on this page. The external-daemon model has the advantage of zero in-process overhead, well-understood operational behaviour, and decades of production hardening.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ptp_state: "unavailable"` on every flow | `ptp4l` not running, or the management socket path is non-default. Check `ls -l /var/run/ptp4l` |
| `ptp_state: "free_run"` | No master visible on the network, or `ptp4l` is misconfigured. Check `pmc -u -b 0 'GET CURRENT_DATA_SET'` |
| Receivers reject ST 2110 connections from this edge | NMOS Node API isn't advertising a `ptp` clock entry — confirm at least one flow has `clock_domain` set, then check `/x-nmos/node/v1.3/self` |
| `linuxptp` thinks it's locked but bilbycast still says `unavailable` | bilbycast process can't read the management socket — check Unix permissions on `/var/run/ptp4l` |
