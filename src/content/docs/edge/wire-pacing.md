---
title: Wire-Time Precision (PCR_AC)
description: How bilbycast-edge paces UDP / RTP / SRT / RIST / ST 2110 outputs to the wire. The default `clock_nanosleep` path needs no special setup; the kernel-paced `SO_TXTIME` + ETF qdisc tier is an opt-in upgrade for sub-µs PCR_AC.
sidebar:
  order: 10
---

Every TS-bearing output on bilbycast-edge — UDP / RTP / SRT / RIST / RTP audio / 302M, plus ST 2110-20 / -23 / -30 / -31 / -40 — runs each datagram through a dedicated **wire-emit thread** that schedules the packet's release against a target wallclock instant. The closer that release lands to the spec-correct instant, the lower the **PCR accuracy** error (`PCR_AC` in T-STD terms — `|ΔPCR_µs − Δwall_µs|`) seen at the receiver.

This page covers the two release paths, when each one applies, and how to enable the kernel-paced upgrade when you need it.

## Two paths, one default

The wire emitter has two release tiers and **defaults to userspace `clock_nanosleep(CLOCK_TAI, TIMER_ABSTIME)` on a SCHED_FIFO thread**. That path needs no special hardware, no PTP grandmaster, no ETF qdisc, no NIC-firmware capabilities — it just works on commodity Linux. Measured at 2 Gbps on a standard `igc` NIC (no ETF / no PTP / 36 parallel flows): p99 PCR_AC = 177 µs, max = 2.36 ms, zero packet drops across 17.7 M packets. **This is the path every operator should use unless they have an explicit reason to go to tier 1.**

The kernel-paced **`SO_TXTIME` + ETF qdisc** path is the opt-in upgrade for the small minority of deployments that genuinely need sub-µs PCR_AC — typically uncompressed ST 2110-20 contribution feeds, T-STD-strict broadcast contribution decoders (Appear X10, Cobalt 9202, Cisco D9824) running with PCR-error alarms, or per-flow rates where the inter-packet budget shrinks below 50 µs. Enabling it requires PTP + a HW-PTP NIC + an `etf` qdisc installed on the egress interface plus an explicit env-var opt-in on the edge — see [When to enable ETF qdisc](#when-to-enable-etf-qdisc) for the decision matrix, [Installing ETF qdisc](#installing-etf-qdisc) for the recipe, and [Booting ETF qdisc as a service](#booting-etf-qdisc-as-a-service) for the systemd unit that persists it across reboots.

## Why this matters

Receivers reconstruct their **System Time Clock (STC)** from the PCR field in the TS adaptation field. Audio and video presentation times are scheduled against that recovered STC. If the wallclock arrival of PCR-bearing packets jitters relative to the PCR values they carry, the receiver's STC inherits that jitter — manifesting as audio drift, lipsync drift, video frame drops, or full freeze on stricter decoders (broadcast-grade hardware decoders are tighter than VLC/ffplay).

ST 2110 has the same precision requirement framed slightly differently — the egress packet timestamp must align to the PTP-disciplined frame raster within a few hundred nanoseconds for ST 2110-21 narrow profile.

PCR_AC isn't a magic broadcast-only metric. **VLC's STC clock recovery breaks down somewhere around 1 ms p99 jitter**; once you cross that, you see audible / visible artefacts. The default `clock_nanosleep` tier sits well below that line on a normally-loaded box.

## How the wire emitter works

For every TS-carrying output the edge spawns one `std::thread` (decoupled from the Tokio runtime so timing doesn't depend on the timer wheel). The thread reads each datagram from a deep `sync_channel`, computes a target wallclock instant in ns, and releases the packet via one of two paths:

- **`clock_nanosleep(CLOCK_TAI, TIMER_ABSTIME)`** *(default)* — userspace thread sleeps to the target on a SCHED_FIFO thread, then issues a blocking `send_to`. No qdisc required, no PTP required, no NIC features required.
- **`SO_TXTIME`** *(opt-in)* — set per-packet target via `SCM_TXTIME` cmsg. Kernel `etf` qdisc + (on supported NICs) hardware tx scheduling honours the timestamp without further userspace wakeups.

The path is picked at spawn time based on the `BILBYCAST_ENABLE_TXTIME` env var. When unset (the default), the emitter stays on `clock_nanosleep` regardless of what the kernel reports. When set to `1`, the emitter probes `SO_TXTIME`; if the probe succeeds the SO_TXTIME path activates, otherwise it falls back to `clock_nanosleep`. The active tier shows on every output's stats as `wire_pacing_tier`.

**All targets are computed in CLOCK_TAI** (Linux kernel `CLOCK_TAI` clockid). When `ptp4l` + `phc2sys` are running, CLOCK_TAI is PTP-disciplined system-wide and SO_TXTIME on `etf` aligns to the NIC's PTP PHY clock. Without those, CLOCK_TAI is just `system clock + leap seconds` — same precision floor as `CLOCK_MONOTONIC`, but the value the kernel `etf` qdisc accepts.

:::caution[Why we no longer probe SO_TXTIME by default]
The pre-2026-05-16 default of "try SO_TXTIME first, fall back to clock_nanosleep" was reverted after a measured-on-hardware finding: on a host without the ETF qdisc installed, the kernel **accepts** `setsockopt(SO_TXTIME)` and silently accepts the `SCM_TXTIME` cmsg too — but with no qdisc to honour the launch time, every packet emits immediately on `sendmsg`. The wire-emit thread degenerated into a producer-paced loop and propagated any upstream burst straight to the wire while telemetry still cheerfully reported tier `so_txtime`. The inverted default removes that silent-degradation trap. Operators who actually have the ETF + PTP + HW-PTP stack opt in via `BILBYCAST_ENABLE_TXTIME=1`.
:::

## Capability tiers

The release path the edge actually uses depends on what's been enabled and what the host can deliver. The tiers below are ordered from best precision to worst; the edge picks the highest one available at output startup, logs it (`wire-emit '<id>': starting (anchor=…, tier=…)`), and surfaces it on `OutputStats.wire_pacing_tier`.

| Tier | Active path | Typical inter-packet jitter | Requires | When |
|---|---|---|---|---|
| **1** | `SO_TXTIME` + ETF qdisc with `offload` on a PTP-disciplined NIC | Sub-µs | Linux ≥ 4.19, ETF qdisc on `clockid CLOCK_TAI`, NIC with PTP HW tx timestamping (Mellanox CX-6/7, Intel E810/I225/I226), `ptp4l` + `phc2sys` running, `CAP_NET_ADMIN`, `BILBYCAST_ENABLE_TXTIME=1` | ST 2110-20 contribution, T-STD-strict receivers |
| **2** | `SO_TXTIME` + software ETF qdisc (no HW offload) | ~1–10 µs | Linux ≥ 4.19, ETF qdisc on `clockid CLOCK_TAI`, `CAP_NET_ADMIN`, `BILBYCAST_ENABLE_TXTIME=1` | Same as tier 1 — falls back automatically when the NIC lacks PHC HW tx |
| **4** ⭐ | `clock_nanosleep(CLOCK_TAI, TIMER_ABSTIME)` on a SCHED_FIFO thread | ~50–500 µs typical, ms-tail under load | Linux + SCHED_FIFO grant. The shipped systemd unit ships `LimitRTPRIO=99` so this works out of the box on every Linux install. **No qdisc. No PTP. No HW-PTP NIC.** | **Default.** Sufficient for compressed TS through at least 2 Gbps, A/V passthrough, transcoded outputs. |
| **5** | `clock_nanosleep` at SCHED_OTHER, or `std::thread::sleep` on non-Linux | ~1–5 ms typical | None. Last-resort fallback for non-Linux hosts, or Linux installs that explicitly stripped `LimitRTPRIO`. | Dev / testbed without the production systemd unit. Still tier-2-broadcast-envelope-compliant on a lightly-loaded box. |

`engine::wire_emit` always uses **`CLOCK_TAI`** for both `SO_TXTIME` setsockopt and `clock_nanosleep` — required by the kernel ETF qdisc on Intel ice/igc drivers (which reject CLOCK_MONOTONIC) and gives PTP discipline for free when `ptp4l` + `phc2sys` are running. The pacing math is purely ns-relative, so the absolute clock domain doesn't matter for the closed-loop rate-following — what matters is that the kernel and the operator's PTP stack agree on which clockid to use.

### Do I need to do anything for SCHED_FIFO / `LimitRTPRIO`?

**No, if you use the shipped systemd unit.** `install-edge.sh` lays down `packaging/bilbycast-edge.service` already containing:

```ini
RestrictRealtime=false
LimitRTPRIO=99
```

That's the entire grant. The kernel allows unprivileged `sched_setscheduler(SCHED_FIFO, prio)` whenever the requested priority is at or below `RLIMIT_RTPRIO` and systemd's `RestrictRealtime` seccomp filter isn't blocking it — no `CAP_SYS_NICE` needed. Wire-emit threads call `sched_setscheduler(SCHED_FIFO, 50)` themselves at spawn time and the kernel honours it because 50 ≤ 99.

You only need to touch `LimitRTPRIO` in three cases:

- **Writing your own systemd unit** (not using the shipped one): copy both lines above into your `[Service]` block. Skip them and every wire-emit thread silently falls from tier 4 (~50–500 µs jitter) to tier 5 (~1–5 ms) — bytes still flow, PCR_AC just degrades.
- **Running the binary directly without systemd** (`cargo run`, `./target/release/bilbycast-edge`): grant `CAP_SYS_NICE` once via `sudo setcap cap_sys_nice,cap_net_admin+ep <binary>` (the cap survives reboots but is wiped on every rebuild), or just run as root.
- **Containerised deployments**: the container runtime needs to permit RT scheduling. Docker: `--ulimit rtprio=99 --cap-add=sys_nice`. Kubernetes: `securityContext.capabilities.add: ["SYS_NICE"]` plus a node-level `rtprio` ulimit. Without these the wire-emit `sched_setscheduler` call returns `EPERM` and threads stay on `SCHED_OTHER`.

The output's startup log line tells you whether the grant landed: `wire-emit '<id>': starting (anchor=…, tier=clock_nanosleep_fifo)` is tier 4 (the `_fifo` suffix confirms the `SCHED_FIFO` grant got through); `tier=clock_nanosleep` (no suffix) is tier 5. Same data is on `OutputStats.wire_pacing_tier` for every UDP-socket-owning output.

### What tier do I actually need?

| Use case | Minimum tier | Realistic setup |
|---|---|---|
| VLC / ffplay / OBS / web players / cloud receivers | Tier 4 | Default install (no extra setup). |
| Most professional decoders in standard tolerance mode | Tier 4 | Default install. |
| Compressed TS contribution through 2 Gbps | Tier 4 | Default install. |
| 2022-7 dual-leg hitless **on the same edge** | Tier 4 | Default install (legs share `MasterClock::now_27mhz()` in-process). |
| 2022-7 dual-leg hitless **across two edges** | Tier 1 | Both edges PTP-synced to the same grandmaster. |
| Broadcast-spec PCR_AC (T-STD ≤ 500 ns) | Tier 1 | ETF qdisc + `ptp4l` + `phc2sys` + HW-PTP NIC + env-var opt-in. |
| ST 2110-21 narrow-profile uncompressed video | Tier 1 | Same as above; receiver VRX bound is the binding constraint. |

## When to enable ETF qdisc

**Default answer: don't.** The userspace tier handles compressed TS through at least 2 Gbps with sub-3 ms PCR_AC max on a normal NIC. ETF only earns its keep in three specific cases:

| Case | Reason | Action |
|---|---|---|
| Per-packet budget < 50 µs (typical: single-flow ST 2110-20 1080p ≈ 4 µs, ST 2110-20 4K ≈ 1 µs) | Userspace round-trip can't reach µs precision at that rate | Enable tier 1, accept the PTP + HW-PTP NIC + ETF dependency stack |
| Strict T-STD compliance for contribution-grade receivers (Appear X10, Cobalt 9202, Cisco D9824 with `PCR_AC` alarm enabled) | These reject streams with PCR jitter > 500 ns | Enable tier 1 |
| Sustained CPU contention pushing tier-4 p99 above ~30 ms (e.g. many transcoded outputs on a tight box) | Kernel ETF moves pacing off the SCHED_FIFO thread, so CPU contention no longer perturbs it | Enable tier 2 (software ETF, no HW-PTP NIC needed) |

If none of those apply — keep the default. Enabling ETF without the full prerequisite stack (PTP, `phc2sys -w`, the qdisc itself, `CAP_NET_ADMIN`) produces *silent degradation* worse than the default, not better. The most common silent-degradation failure modes are catalogued in [Quick reference](#quick-reference) at the bottom of this page.

## Installing ETF qdisc

The qdisc is installed by `packaging/setup-etf-qdisc.sh`, shipped with the edge. The edge **does not** install qdiscs itself — `tc qdisc` requires `CAP_NET_ADMIN` at install time, which is operator-policy, not application-policy.

```bash
# Identify the egress NIC (typically the one with the edge's UDP destinations
# reachable through it). One-shot install — qdisc applies immediately.
sudo bash /opt/bilbycast/edge/current/packaging/setup-etf-qdisc.sh enp1s0

# Verify
tc -s qdisc show dev enp1s0       # look for `etf` in output, zero drops once traffic flows
```

The script installs `mqprio` + `etf` with `clockid CLOCK_TAI` and `skip_sock_check on`. By default it uses **software ETF** (no HW offload, ~1–10 µs jitter, no PTP required). For sub-µs jitter (tier 1), set `BILBYCAST_ETF_OFFLOAD=1` — but only after PTP is running (`ptp4l` + `phc2sys` in TAI domain). Without PHC sync, HW offload silently drops every packet.

:::caution[`skip_sock_check on` is non-negotiable]
Without `skip_sock_check`, ETF refuses any packet whose socket lacks `SO_TXTIME` and drops it at the qdisc — **including kernel-issued ARP solicitations, DHCP, ssh, and every default UDP socket on the host**. Symptoms: `ip neigh show <peer>` reports `INCOMPLETE`, every `sendmsg` returns `ENETUNREACH` (errno 101), `tc -s qdisc show` reports 100 % drops on the etf class with zero packets sent. The shipped `setup-etf-qdisc.sh` always sets the flag — don't second-guess it.
:::

### Pick a NIC with hardware TX timestamping (tier 1 only)

Run `ethtool -T <iface>` and look for both lines:

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

NICs that do **not** work for tier 1:

- **Realtek consumer NICs** (r8169) — `PTP Hardware Clock: none`
- Most onboard NICs on consumer motherboards
- WiFi adapters

Tier 2 (software ETF, no HW offload) doesn't need any of the above — just the kernel ETF qdisc module — and is the realistic upgrade target for "I have CPU contention but no HW-PTP NIC" deployments.

## Booting ETF qdisc as a service

The one-shot `tc` call from `setup-etf-qdisc.sh` doesn't survive a reboot. For deployments that need ETF tier persistence, install the templated systemd unit `packaging/bilbycast-etf-qdisc@.service` that ships with the edge:

```bash
# Install + enable for the named NIC. The unit calls setup-etf-qdisc.sh at
# boot, after the NIC is up, before bilbycast-edge.service starts.
sudo install -m 0644 /opt/bilbycast/edge/current/packaging/bilbycast-etf-qdisc@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bilbycast-etf-qdisc@enp1s0

# Verify
systemctl status bilbycast-etf-qdisc@enp1s0
tc -s qdisc show dev enp1s0
```

The unit is **opt-in** — `install-edge.sh` lays the template file down but does not enable any instance of it. Enable it only after you've confirmed you actually need tier 1 / tier 2 (see [When to enable ETF qdisc](#when-to-enable-etf-qdisc)) and you have a HW-PTP NIC for tier 1.

The unit ordering is `After=network-online.target sys-subsystem-net-devices-<iface>.device` + `Before=bilbycast-edge.service` — so the qdisc is in place by the time the edge tries to use it. On teardown the unit runs `tc qdisc del dev <iface> root`; if the qdisc was already removed (exit code 2) systemd treats that as success.

To remove:

```bash
sudo systemctl disable --now bilbycast-etf-qdisc@enp1s0
# Optional manual teardown:
sudo tc qdisc del dev enp1s0 root
```

## Run `ptp4l` (and `phc2sys`) for tier 1

```bash
# Sync to a network grandmaster (typical):
sudo ptp4l -i <iface> -m -2 -H -s

# Or run as a master if you don't have a GM (lab / single-link demo):
sudo ptp4l -i <iface> -m -2 -H

# Discipline CLOCK_TAI from the NIC's PTP hardware clock:
sudo phc2sys -s <iface> -w -m
```

`-2` selects the L2 transport (IEEE 802.1AS / 802.3 Ethernet PTP, the SMPTE 2110-10 profile uses this). `-H` enables hardware timestamping.

`-w` makes `phc2sys` wait for `ptp4l` to be in sync, then auto-apply the TAI–UTC offset advertised in PTP announce TLVs. **Don't pass `-O 0`** — it overrides the auto-detected offset and either skews `CLOCK_REALTIME` by 37 s (UTC vs TAI) or leaves `CLOCK_TAI` 37 s ahead of the grandmaster, depending on phc2sys version. Either way, multi-edge coherence breaks and the NIC silently rejects every launch time. The `-w` form is the modern recipe.

The standard linuxptp configs ship with the package. Once `ptp4l` is steady-state synced, CLOCK_TAI on the box is PTP-disciplined and every wire-emit thread emits against PTP time — across multiple edges on the same GM, all of them agree to within sub-µs.

The edge also polls `ptp4l`'s management socket independently for the per-flow `master_clock` integration (which controls **what time gets stamped INTO PCR**). See [PTP integration](/edge/ptp/) for that side.

The shipped `packaging/provision-edge-node.sh` automates all of this in one command — installs `linuxptp`, writes systemd units for `ptp4l@${MEDIA_IFACE}.service` + `phc2sys@${MEDIA_IFACE}.service`, lays down the ETF qdisc via `bilbycast-etf-qdisc@${MEDIA_IFACE}.service`, and enables everything. Idempotent and reboot-persistent. Run it once on a fresh box:

```bash
sudo MEDIA_IFACE=enp1s0 bash /opt/bilbycast/edge/current/packaging/provision-edge-node.sh
```

## Enabling the SO_TXTIME tier on the edge

After the qdisc is in place + PTP is running, opt in to the SO_TXTIME release path by setting **one** of these env vars on the edge process:

```
BILBYCAST_ENABLE_TXTIME=1       # short form (preferred)
BILBYCAST_ENABLE_SO_TXTIME=1    # long form (accepted alias)
```

The installer's default `/etc/bilbycast/edge.env` ships with the variable commented out — uncomment it after the qdisc + PTP prerequisites are confirmed:

```bash
# /etc/bilbycast/edge.env
BILBYCAST_MLOCKALL=1
# Opt in to kernel-paced wire emission via SO_TXTIME. Requires the ETF
# qdisc on the egress NIC and ptp4l + phc2sys for tier-1 precision.
BILBYCAST_ENABLE_TXTIME=1
```

After `sudo systemctl restart bilbycast-edge`, the edge log shows `tier=so_txtime` on each output start:

```text
wire-emit '<id>': starting (anchor=Pcr, tier=so_txtime)
```

If the log shows `tier=clock_nanosleep` despite setting the env var, the setsockopt probe failed — typically because `CAP_NET_ADMIN` isn't granted. See [CAP_NET_ADMIN grant](#cap_net_admin-grant) below.

## CAP_NET_ADMIN grant

Mainline Linux 6.x — and every recent Ubuntu / Debian / RHEL backport — restricts `setsockopt(SO_TXTIME)` with any non-`CLOCK_MONOTONIC` clockid to processes holding `CAP_NET_ADMIN`. Wire pacing uses `CLOCK_TAI` (the only clockid the ETF qdisc on Intel ice / igc / igb and Mellanox mlx5 will accept), so on these kernels the cap is mandatory for **every** SO_TXTIME-based tier (1 and 2). It is **not** required for tier 4 — the default `clock_nanosleep` path needs no capabilities.

Without the cap, when `BILBYCAST_ENABLE_TXTIME=1` is set:

- The probe fails with `EPERM`. The edge logs `wire-emit: SO_TXTIME(clockid=11) setsockopt failed: Operation not permitted (kernel requires CAP_NET_ADMIN…) — falling back to clock_nanosleep tier` and degrades to tier 4.
- On any host where the etf qdisc has `skip_sock_check off` (the kernel default — not what the shipped script does, but worth knowing), tier-4 packets are then **also** dropped at the qdisc because they don't carry SO_TXTIME. Always keep `skip_sock_check on` — see [Installing ETF qdisc](#installing-etf-qdisc).

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
# (cap_sys_nice is optional — only needed if LimitRTPRIO=99 isn't set on the
#  shell. systemd's LimitRTPRIO covers it in production.)
```

File capabilities persist across reboots via filesystem xattrs but **are reset on every rebuild** (each `cargo build` writes a fresh binary with no caps). Add the `setcap` to your build script if you iterate often.

Verify:

```bash
getcap ./target/release/bilbycast-edge
# expected: cap_net_admin,cap_sys_nice=ep
```

## Verifying the result

The wire emitter records PCR_AC samples on every successful send. Read it via the per-output stats (Prometheus `/metrics`, JSON `/api/v1/stats`, manager UI Output card):

```text
output.pcr_trust:
  samples: 4096        # ring buffer depth
  p50_us: 0.4          # tier-1 production target
  p95_us: 0.8
  p99_us: 1.2
  max_us: 5.7          # outliers
output.wire_pacing_tier: "so_txtime"      # or "clock_nanosleep" on the default tier
output.wire_pacing_late: 0
```

**`wire_pacing_late`** is the kernel's count of packets that missed their TX deadline (drained from the socket error queue). Always 0 on the userspace-sleep tier (no errqueue). On the SO_TXTIME tier this stays at zero on a healthy production setup. Non-zero values mean the kernel had to drop or send late — investigate scheduler contention, IRQ pinning, or kernel preemption configuration.

**`wire_pacing_tier`** confirms which release path is actually live. If you enabled `BILBYCAST_ENABLE_TXTIME=1` but tier still shows `clock_nanosleep`, the SO_TXTIME setsockopt failed — check `dmesg` for `tc-etf` rejections, verify the qdisc is on the correct interface, confirm `CAP_NET_ADMIN` is granted, and confirm the kernel is ≥ 4.19.

### Acceptance targets per tier

| Tier | Realistic p99 PCR_AC | Use case envelope |
|---|---|---|
| Tier 1 | ≤ 500 ns | T-STD spec, ST 2110-21 narrow profile, multi-edge 2022-7 |
| Tier 2 | ≤ 30 ms | Compressed TS contribution with a CPU-loaded box, no HW-PTP NIC |
| Tier 4 (default) | ≤ 3 ms typical, ms-tail under heavy load | Compressed TS through 2 Gbps, transcoded outputs, every cloud/VPS deployment |
| Tier 5 | Best-effort | Dev / testbed only |

The default tier 4 is comfortably inside the broadcast tier-2 envelope (≤ 30 ms p99). Don't optimise above your actual requirement — the tier-1 stack costs significant operational complexity (PTP grandmaster, HW-PTP NIC, ETF qdisc, env var) and pays off only when the per-packet budget genuinely demands it.

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

Without PTP, both pieces drift independently per box — multi-edge hitless will see seq mismatches, audio out of phase, and lipsync skew across legs. PTP isn't optional for redundant tier-1 production paths; it's the contract.

## Quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| Tier reports `clock_nanosleep` on a freshly installed edge | This is the default and is correct for almost every deployment | No action needed. Verify against [What tier do I actually need?](#what-tier-do-i-actually-need) before chasing tier 1. |
| Set `BILBYCAST_ENABLE_TXTIME=1` but tier still reports `clock_nanosleep` + log shows `SO_TXTIME … Operation not permitted` | Process lacks `CAP_NET_ADMIN` (kernel ≥ 6.x policy on non-MONOTONIC clockids) | systemd: `AmbientCapabilities=CAP_NET_ADMIN`. Standalone: `sudo setcap cap_net_admin,cap_sys_nice+ep <binary>`. See [CAP_NET_ADMIN grant](#cap_net_admin-grant). |
| Set `BILBYCAST_ENABLE_TXTIME=1`, tier reports `so_txtime` but PCR_AC is no better than tier 4 | Kernel accepts SO_TXTIME setsockopt but no `etf` qdisc is honouring it | Install `etf` qdisc with `clockid CLOCK_TAI` via `setup-etf-qdisc.sh`. See [Installing ETF qdisc](#installing-etf-qdisc). |
| `tc -s qdisc show` shows etf with 100 % drops, zero sent; `ip neigh` is `INCOMPLETE`; sends return `ENETUNREACH` | Etf qdisc installed with `skip_sock_check off` and the priomap routes priority-0 (ARP, default UDP) into the etf class | Re-install etf with `skip_sock_check` flag — the shipped `setup-etf-qdisc.sh` does this. |
| Tier reports `so_txtime`, etf shows 100 % drops, but `getcap` shows `cap_net_admin` is set | NIC PHC drifts ≥ 1–4 s from CLOCK_TAI — hardware launch register overflow | Verify `phc2sys` uses `-w` (not `-O 0`). `phc2sys -O 0` while kernel `tai_offset=37s` puts CLOCK_TAI 37 s ahead of the PHC and the NIC rejects every launch time. |
| `wire_pacing_late` is non-zero on tier 1 | Scheduler missed wire-emit deadlines | CPU isolation, IRQ pinning, `PREEMPT_RT` kernel |
| Tier-4 p99 above ~30 ms on a contended box | Too many transcoded outputs competing for CPU; SCHED_FIFO grant absent | Verify systemd unit has `LimitRTPRIO=99`. Consider scaling out before reaching for tier 2. |
| Multi-edge feeds drift apart | PTP not running or different GMs | One GM, all edges synced via `ptp4l`; flow `master_clock = Ptp` |
| Hardware NIC has `PTP Hardware Clock: none` (tier 1 target) | Consumer / Realtek NIC | Replace with Intel I226 / E810 / Mellanox ConnectX |
| ETF systemd unit fails to start at boot | NIC name wrong, `iproute2` missing, kernel `sch_etf` module absent | `journalctl -u bilbycast-etf-qdisc@<iface>` — check for the underlying error. Don't re-enable until the root cause is fixed; the unit deliberately doesn't auto-restart. |
