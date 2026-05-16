---
title: Wire-Time Precision (PCR_AC)
description: How bilbycast-edge paces UDP / RTP / SRT / RIST / ST 2110 outputs to the wire, and how to reach broadcast-spec PCR_AC (≤500 ns) with `etf` qdisc + `ptp4l` + a hardware-PTP NIC.
sidebar:
  order: 10
---

Every TS-bearing output on bilbycast-edge — UDP / RTP / SRT / RIST / RTP audio / 302M, plus ST 2110-20 / -23 / -30 / -31 / -40 — runs each datagram through a dedicated **wire-emit thread** that schedules the packet's release against a target wallclock instant. The closer that release lands to the spec-correct instant, the lower the **PCR accuracy** error (`PCR_AC` in T-STD terms — `|ΔPCR_µs − Δwall_µs|`) seen at the receiver. Sub-500 ns PCR_AC is the broadcast spec; cheap consumer paths land in the **milliseconds**, three orders of magnitude over.

This page covers the path that gets you to spec, what each piece does, and what the realistic numbers look like at each rung of the ladder.

## Why this matters

Receivers reconstruct their **System Time Clock (STC)** from the PCR field in the TS adaptation field. Audio and video presentation times are scheduled against that recovered STC. If the wallclock arrival of PCR-bearing packets jitters relative to the PCR values they carry, the receiver's STC inherits that jitter — manifesting as audio drift, lipsync drift, video frame drops, or full freeze on stricter decoders (broadcast-grade hardware decoders are tighter than VLC/ffplay).

ST 2110 has the same precision requirement framed slightly differently — the egress packet timestamp must align to the PTP-disciplined frame raster within a few hundred nanoseconds for ST 2110-21 narrow profile.

PCR_AC isn't a magic broadcast-only metric. **VLC's STC clock recovery breaks down somewhere around 1 ms p99 jitter**; once you cross that, you see the artefacts the user does.

## How the wire emitter works

For every TS-carrying output the edge spawns one `std::thread` (decoupled from the Tokio runtime so timing doesn't depend on the timer wheel). The thread reads each datagram from a 1024-deep `sync_channel`, computes a target wallclock instant in ns, and releases the packet via one of two paths:

- **`SO_TXTIME`** *(preferred)* — set per-packet target via `SCM_TXTIME` cmsg. Kernel `etf` qdisc + (on supported NICs) hardware tx scheduling honours the timestamp without further userspace wakeups.
- **`clock_nanosleep` fallback** — userspace thread sleeps to the target via `clock_nanosleep(CLOCK_TAI, TIMER_ABSTIME)`, then issues a blocking `send_to`.

The path is picked at spawn time by a one-shot probe — if `SO_TXTIME` setsockopt succeeds, the SO_TXTIME path activates; otherwise the thread falls back to `clock_nanosleep`. The active tier shows on every output's stats as `wire_pacing_tier`.

**All targets are computed in CLOCK_TAI** (Linux kernel `CLOCK_TAI` clockid). When `ptp4l` + `phc2sys` are running, CLOCK_TAI is PTP-disciplined system-wide and SO_TXTIME on `etf` aligns to the NIC's PTP PHY clock. Without those, CLOCK_TAI is just `system clock + leap seconds` — same precision floor as `CLOCK_MONOTONIC`, but the value the kernel `etf` qdisc accepts.

:::caution[Kernel ≥ 6.x: `SO_TXTIME(CLOCK_TAI)` needs `CAP_NET_ADMIN`]
Mainline Linux 6.x (and every recent Ubuntu / Debian / RHEL backport) restricts `setsockopt(SO_TXTIME)` with any non-`CLOCK_MONOTONIC` clockid to processes holding `CAP_NET_ADMIN`. Without the capability, the setsockopt returns `EPERM`, the SO_TXTIME probe fails silently, and the wire-emit thread drops to the `clock_nanosleep` tier. The shipped systemd unit grants the capability via `AmbientCapabilities=CAP_NET_ADMIN`; standalone (`cargo run`, direct `./bilbycast-edge`) invocations need a one-time `sudo setcap cap_net_admin,cap_sys_nice+ep ./bilbycast-edge`. See [CAP_NET_ADMIN grant](#cap_net_admin-grant) below for the verification commands.
:::

## The five capability tiers

The release path the edge actually uses depends on what the host can deliver. The five tiers are ordered from best to worst; the edge picks the highest one available at output startup, logs it (`wire-emit '<id>': starting (anchor=…, tier=…)`), and surfaces it on `OutputStats.wire_pacing_tier`.

| Tier | Active path | Typical inter-packet jitter | Requires |
|---|---|---|---|
| **1** | `SO_TXTIME` + ETF qdisc with `offload` on a PTP-disciplined NIC | **Sub-µs** | Linux ≥ 4.19, ETF qdisc on `clockid CLOCK_TAI`, NIC with PTP HW tx timestamping (Mellanox CX-6/7, Intel E810/I225/I226), `ptp4l` + `phc2sys` running |
| **2** | `SO_TXTIME` + software ETF qdisc | **~1–10 µs** | Linux ≥ 4.19, ETF qdisc on `clockid CLOCK_TAI`. No NIC offload (or `offload` requested but rejected). |
| **3** | `SO_TXTIME` accepted, ETF qdisc absent | **No-op (same as no pacing)** | Linux ≥ 4.19. Probe succeeds at the setsockopt level, but every datagram sends ASAP because the kernel silently ignores `SCM_TXTIME` without ETF. **Diagnose with `BILBYCAST_FORCE_NANOSLEEP=1` to compare against tier 4.** |
| **4** | `clock_nanosleep(CLOCK_TAI, TIMER_ABSTIME)` on a SCHED_FIFO thread | **~50–500 µs typical, ms-tail under load** | Linux + SCHED_FIFO grant. The shipped systemd unit ships `LimitRTPRIO=50` so this works out of the box on every Linux install. **This is what every default `install-edge.sh` install gets.** |
| **5** | `clock_nanosleep` at SCHED_OTHER, or `std::thread::sleep` on non-Linux | **~1–5 ms** | None. Last-resort fallback — only seen on macOS, BSD, or Linux installs that explicitly stripped `LimitRTPRIO`. |

**Tier 3 is the silent-failure trap.** When the edge logs `tier=so_txtime` but PCR_AC is still bad, the kernel accepted SO_TXTIME but no ETF qdisc is installed on the egress NIC — every datagram emits ASAP regardless of the `SCM_TXTIME` cmsg. Set `BILBYCAST_FORCE_NANOSLEEP=1` to drop into tier 4 and confirm: if PCR_AC improves, you were stuck at tier 3.

### What tier do I actually need?

| Use case | Minimum tier | Realistic setup |
|---|---|---|
| VLC / ffplay / OBS / web players / cloud receivers | Tier 4 | Default install (no extra setup). |
| Most professional decoders in standard tolerance mode | Tier 4 | Default install. |
| 2022-7 dual-leg hitless **on the same edge** | Tier 4 | Default install (legs share `MasterClock::now_27mhz()` in-process). |
| 2022-7 dual-leg hitless **across two edges** | Tier 1 | Both edges PTP-synced to the same grandmaster. |
| Broadcast-spec PCR_AC (T-STD ≤ 500 ns) | Tier 1 | ETF qdisc + `ptp4l` + `phc2sys` + HW-PTP NIC. |
| ST 2110-21 narrow-profile uncompressed video | Tier 1 | Same as above; receiver VRX bound is the binding constraint. |

p99 outliers track a similar pattern but worse — typically 50× the p50 figure for software paths and ~5× for the HW-PTP path. The p99 is what kills receivers before the p50 does.

## Three-step production setup

The shipped `packaging/provision-edge-node.sh` automates all three steps in one command — installs `linuxptp`, writes systemd units for `ptp4l@${MEDIA_IFACE}.service` + `phc2sys@${MEDIA_IFACE}.service`, lays down the ETF qdisc via a `bilbycast-etf@${MEDIA_IFACE}.service` boot unit, and enables everything. Idempotent and reboot-persistent. Run it once on a fresh box:

```bash
sudo MEDIA_IFACE=enp1s0 bash /opt/bilbycast/edge/current/packaging/provision-edge-node.sh
```

The manual three-step walkthrough below is the equivalent if you want to lay it down piece by piece, audit each step against your own setup, or you're integrating into an existing config-management system.

### 1. Pick a NIC with hardware TX timestamping

Run `ethtool -T <iface>`. The NIC qualifies if both lines below are present:

```text
PTP Hardware Clock: <numeric index, NOT "none">
Hardware Transmit Timestamp Modes: ... on
```

NICs that work:
- **Mellanox / NVIDIA ConnectX-5 / ConnectX-6** (mlx5 driver) — 25/100G SFP28/QSFP28
- **Intel E810-XXV** (ice driver) — 1 / 10 / 25G SFP28 (also accepts 1G SFP modules)
- **Intel I225 / I226** (igc driver) — 2.5G copper RJ45, the cheapest production option
- **Intel 82599** (ixgbe driver) — 10G SFP+
- **Intel X710 / X722** (i40e driver) — 10 / 40G

NICs that do **not** work for broadcast PCR_AC:
- **Realtek consumer NICs** (r8169) — `PTP Hardware Clock: none`
- Most onboard NICs on consumer motherboards
- WiFi adapters

The NIC matters even if you don't bring up `ptp4l` immediately — the kernel `etf` qdisc with software offload still benefits from the hardware path, and you avoid having to swap NICs later.

### 2. Install the `etf` qdisc on the egress interface

```bash
sudo tc qdisc replace dev <iface> root etf clockid CLOCK_TAI delta 100000 skip_sock_check
```

Verify:

```bash
tc qdisc show dev <iface>
# Should print: qdisc etf 1: root ... clockid TAI ...
```

Field-by-field:

- `clockid CLOCK_TAI` — required by the kernel etf implementation. The ice/igc drivers reject CLOCK_MONOTONIC. SO_TXTIME with the wrong clockid is silently degraded — the kernel accepts the setsockopt but ignores every cmsg, and tier still reports `so_txtime` while every datagram sends ASAP. Always use TAI.
- `delta 100000` — max permissible early-tx-by-kernel in ns. 100 µs is the standard tradeoff; higher allows more burst-smoothing, lower tightens the schedule.
- `skip_sock_check` — **non-negotiable** if you use the `mqprio` priomap from the shipped `setup-etf-qdisc.sh` (or any priomap that routes priority-0 traffic into the etf class). Default socket priority is 0 for every kernel-issued packet (ARP, ICMP, DHCP) and every UDP socket the edge opens without an explicit `SO_PRIORITY`. Without `skip_sock_check`, etf refuses any packet whose socket lacks SO_TXTIME and drops it at the qdisc — **including kernel-issued ARP solicitations**. Symptoms: `ip neigh show <peer>` reports `INCOMPLETE`, every `sendmsg` returns `ENETUNREACH` (errno 101), `tc -s qdisc show` reports 100 % drops on the etf class with zero packets sent. With `skip_sock_check`, non-SO_TXTIME packets fall through to FIFO release (they leave the box); SO_TXTIME packets still get hardware-scheduled. This is independent of `CAP_NET_ADMIN` — both are required for a working tier-1/2 setup.

To persist across reboot, drop a systemd-networkd or `/etc/network/interfaces.d/<iface>` snippet — same pattern as any other qdisc.

### 3. Run `ptp4l` (and `phc2sys`)

```bash
# Sync to a network grandmaster (typical):
sudo ptp4l -i <iface> -m -2 -H -s

# Or run as a master if you don't have a GM (lab / single-link demo):
sudo ptp4l -i <iface> -m -2 -H

# Discipline CLOCK_TAI from the NIC's PTP hardware clock:
sudo phc2sys -s <iface> -w -m
```

`-2` selects the L2 transport (IEEE 802.1AS / 802.3 Ethernet PTP, the SMPTE 2110-10 profile uses this). `-H` enables hardware timestamping.

`-w` makes `phc2sys` wait for `ptp4l` to be in sync, then auto-apply the TAI-UTC offset advertised in PTP announce TLVs. **Don't pass `-O 0`** — it overrides the auto-detected offset and either skews `CLOCK_REALTIME` by 37 s (UTC vs TAI) or leaves `CLOCK_TAI` 37 s ahead of the grandmaster, depending on phc2sys version. Either way, multi-edge coherence breaks. The `-w` form is the modern recipe.

The standard linuxptp configs ship with the package. Once `ptp4l` is steady-state synced, CLOCK_TAI on the box is PTP-disciplined and every wire-emit thread emits against PTP time — across multiple edges on the same GM, all of them agree to within sub-µs.

The edge polls `ptp4l`'s management socket independently for the per-flow `master_clock` integration (which controls **what time gets stamped INTO PCR**). See [PTP integration](/edge/ptp/) for that side.

## CAP_NET_ADMIN grant

Mainline Linux 6.x — and every recent Ubuntu / Debian / RHEL backport — restricts `setsockopt(SO_TXTIME)` with any non-`CLOCK_MONOTONIC` clockid to processes holding `CAP_NET_ADMIN`. Wire pacing uses `CLOCK_TAI` (the only clockid the etf qdisc on Intel ice / igc / igb and Mellanox mlx5 will accept), so on these kernels the cap is mandatory for **every** SO_TXTIME-based tier (1, 2, and 3).

Without the cap:

- The probe fails with `EPERM`, wire-emit logs `wire-emit: SO_TXTIME(clockid=11) setsockopt failed: Operation not permitted (kernel requires CAP_NET_ADMIN…) — falling back to clock_nanosleep tier` and degrades to tier 4.
- On any host where the etf qdisc has `skip_sock_check off` (the kernel default), tier-4 packets are then **also** dropped at the qdisc because they don't carry SO_TXTIME. The fallback path silently fails completely. Always set `skip_sock_check` on the etf qdisc — see step 2 above.

The capability does **not** let the edge install qdiscs (that path stays operator-side, in `setup-etf-qdisc.sh`). It only unlocks the per-socket setsockopt.

### Production (systemd)

The shipped systemd unit (`packaging/bilbycast-edge.service`, installed by `install-edge.sh`) already grants the cap:

```ini
CapabilityBoundingSet=CAP_NET_ADMIN
AmbientCapabilities=CAP_NET_ADMIN
```

No manual step required — `install-edge.sh` lays down the unit with these lines already set. Operators writing their own unit must add the same two lines.

### Dev / testbed (direct binary)

When running the binary without systemd (`cargo run`, `./target/release/bilbycast-edge`, ad-hoc test setups), apply file capabilities once after every build:

```bash
sudo setcap cap_net_admin,cap_sys_nice+ep ./target/release/bilbycast-edge
# (cap_sys_nice is optional — only needed if LimitRTPRIO=50 isn't set on the
#  shell. systemd's LimitRTPRIO covers it in production.)
```

File capabilities persist across reboots via filesystem xattrs but **are reset on every rebuild** (each `cargo build` writes a fresh binary with no caps). Add the `setcap` to your build script if you iterate often.

Verify:

```bash
getcap ./target/release/bilbycast-edge
# expected: cap_net_admin,cap_sys_nice=ep
```

Then on edge start:

```
wire-emit '<id>': starting (anchor=Pcr, tier=so_txtime)
```

`tier=so_txtime` confirms the path is live. `tier=clock_nanosleep` plus the `SO_TXTIME … Operation not permitted` warning means the cap is still missing.

## Verifying the result

The wire emitter records PCR_AC samples on every successful send. Read it via the per-output stats (Prometheus `/metrics`, JSON `/api/v1/stats`, manager UI Output card):

```text
output.pcr_trust:
  samples: 4096        # ring buffer depth
  p50_us: 0.4          # production target
  p95_us: 0.8
  p99_us: 1.2
  max_us: 5.7          # outliers
output.wire_pacing_tier: "so_txtime"
output.wire_pacing_late: 0
```

**`wire_pacing_late`** is the kernel's count of packets that missed their TX deadline (drained from the socket error queue). On a healthy production setup this stays at zero. Non-zero values mean the kernel had to drop or send late — investigate scheduler contention, IRQ pinning, or kernel preemption configuration.

**`wire_pacing_tier`** confirms which release path is actually live. If you installed the etf qdisc but tier still shows `clock_nanosleep`, the SO_TXTIME setsockopt failed — check `dmesg` for `tc-etf` rejections, verify the qdisc is on the correct interface, and confirm the kernel is ≥ 4.19.

## Operator escape hatch

```bash
BILBYCAST_FORCE_NANOSLEEP=1 ./bilbycast-edge --config config.json
```

Skips the SO_TXTIME probe entirely and forces the `clock_nanosleep` releaser. Use cases:

- **Diagnostic** — you suspect SO_TXTIME is silently degraded (tier reports `so_txtime` but PCR_AC is bad). Forcing `clock_nanosleep` gives you the predictable userspace baseline; if PCR_AC improves under nanosleep, SO_TXTIME isn't actually working (typically because the etf qdisc isn't installed or has the wrong clockid).
- **Workaround** — kernel or driver regressions where SO_TXTIME misbehaves under specific load. Set the env var until upstream fixes land.

Not a production setting. The clock_nanosleep tier is the fallback path; prefer fixing the SO_TXTIME setup so the env var never has to be set.

## Tuning Linux for low p99

Even on the full PTP path, p99 outliers can be driven by Linux scheduler contention. The wire-emit thread already sets SCHED_FIFO; the remaining knobs are kernel-side:

- **CPU isolation** — boot with `isolcpus=N,M` (and `nohz_full=N,M rcu_nocbs=N,M` for hard isolation) for the cores you'll pin wire-emit threads to. Combined with `taskset`, drops scheduler-induced p99 from ~5 ms to ~50 µs.
- **IRQ affinity** — pin the NIC's TX/RX IRQs off the wire-emit cores so qdisc dequeue and packet completion don't preempt the emitter.
- **`PREEMPT_RT` kernel** — cuts the worst-case scheduler latency by ~10× over a stock kernel. Worth it for tier-1 broadcast facilities.
- **`nice -20` / chrt** — irrelevant. The wire-emit thread is already SCHED_FIFO at a deliberate priority. Don't override.

These are operating-system-level concerns common to every real-time packet pacing system; nothing bilbycast-specific.

## Multi-edge coherence

Two edges feeding the same downstream (2022-7 dual-leg hitless, ST 2110 redundant flows, multi-camera contribution) need their PCR-stamped time **and** their wire-emit time to agree. With both running `ptp4l` against the same GM:

- Per-flow `master_clock = Ptp` ensures both stamp PCR from the PTP-disciplined master.
- Wire emit on PTP-disciplined CLOCK_TAI ensures both release at PTP-aligned wallclock.

Without PTP, both pieces drift independently per box — multi-edge hitless will see seq mismatches, audio out of phase, and lipsync skew across legs. PTP isn't optional for redundant production paths; it's the contract.

## Quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| Tier reports `so_txtime` but PCR_AC is bad | Kernel accepts SO_TXTIME setsockopt but the qdisc isn't honouring it | Install `etf` qdisc with `clockid CLOCK_TAI` |
| Tier reports `clock_nanosleep` + `SO_TXTIME … Operation not permitted` in log | Process lacks `CAP_NET_ADMIN` (kernel ≥ 6.x policy on non-MONOTONIC clockids) | systemd: `AmbientCapabilities=CAP_NET_ADMIN`. Standalone: `sudo setcap cap_net_admin,cap_sys_nice+ep <binary>`. See [CAP_NET_ADMIN grant](#cap_net_admin-grant). |
| Tier reports `clock_nanosleep` despite PTP setup, no cap warning | SO_TXTIME probe failed at spawn for a different reason | Check `etf` qdisc, kernel version (≥ 4.19), `ethtool -T` for hardware support |
| `tc -s qdisc show` shows etf with 100 % drops, zero sent; `ip neigh` is `INCOMPLETE`; sends return `ENETUNREACH` | Etf qdisc installed with `skip_sock_check off` and the priomap routes priority-0 (ARP, default UDP) into the etf class | Re-install etf with `skip_sock_check` flag — see step 2 above. The shipped `setup-etf-qdisc.sh` does this. |
| Tier reports `so_txtime`, etf shows 100 % drops, but `getcap` shows `cap_net_admin` is set | NIC PHC drifts ≥ 1–4 s from CLOCK_TAI — hardware launch register overflow | Verify `phc2sys` uses `-w` (not `-O 0`). `phc2sys -O 0` while kernel `tai_offset=37s` puts CLOCK_TAI 37 s ahead of the PHC and the NIC rejects every launch time. |
| `wire_pacing_late` is non-zero | Scheduler missed wire-emit deadlines | CPU isolation, IRQ pinning, `PREEMPT_RT` kernel |
| Multi-edge feeds drift apart | PTP not running or different GMs | One GM, all edges synced via `ptp4l`; flow `master_clock = Ptp` |
| Hardware NIC has `PTP Hardware Clock: none` | Consumer / Realtek NIC | Replace with Intel I226 / E810 / Mellanox ConnectX |
| Tier reports `so_txtime` and PCR_AC is fine in lab but broadcast hardware decoders complain | p99 outlier above ~5 ms | Verify `ptp4l` lock state (`ptp_state: locked`); look at scheduler tuning |
