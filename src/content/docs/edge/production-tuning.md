---
title: Production Tuning
description: The node-wide `tuning` config block, CPU affinity, memory locking, SCHED_FIFO wire emission and the ETF opt-in — what each knob does, its bounds, and whether it lands on a config push or needs a restart.
sidebar:
  order: 16
---

Tuning an edge node splits cleanly in two. Anything that changes how **media** is handled — de-jitter depth, playout pacing, whether the startup hardware probe runs — is a field in the node's `config.json`, pushed and audited through the manager like any other setting. Anything that describes the **machine** — which cores the hot-path threads sit on, whether pages are locked into RAM, whether the kernel paces the wire — stays in the host environment, because it is a property of the box and not of the stream.

This page covers both halves: the `tuning` block field by field, the host knobs that surround it, and — the part that most often trips operators up — which changes take effect on the push and which wait for a restart.

## What lives where

| Layer | Set in | Applies to | Examples |
|---|---|---|---|
| Media behaviour | `config.json` → `tuning` (Manager → node → **Configure** → **Tuning**) | One node, visible and audited fleet-wide | `ingress_dejitter_ms`, `probe_session_limits`, `media_player_pcr_deadlines` |
| Host / OS | `/etc/bilbycast/edge.env` (read by the systemd unit) | The machine | `BILBYCAST_MLOCKALL`, `BILBYCAST_WIRE_EMIT_CPUS`, `BILBYCAST_ENABLE_TXTIME` |
| Scheduler grants | The systemd unit itself | The machine | `LimitRTPRIO`, `LimitMEMLOCK`, `AmbientCapabilities` |

Every field in the first row was an environment variable until 2026-08. The migration was not cosmetic: an env-only knob cannot be shown in the UI, cannot be validated, cannot be compared across a fleet and leaves no audit trail. See [Deprecated environment variables](#deprecated-environment-variables) at the bottom for the mapping and what each old variable does now.

## The `tuning` block

Optional, top-level, and entirely `Option`-typed — an absent field means the built-in default, so an absent block changes nothing.

```json
{
  "version": 2,
  "tuning": {
    "ingress_dejitter_ms": 80,
    "ingress_residence_ms": 400,
    "probe_session_limits": true,
    "probe_4k": true,
    "media_player_controller": true,
    "media_player_pcr_deadlines": true
  }
}
```

| Field | Type | Range | Default | What it does |
|---|---|---|---|---|
| `ingress_dejitter_ms` | integer | 20–2000 | unset — no node-wide de-jitter | Default ingress de-jitter setpoint. Setting it both **switches the buffer on** and sizes it for every raw UDP / RTP input carrying no `ingress_dejitter_ms` of its own. A per-input value wins. |
| `ingress_residence_ms` | integer | `setpoint + 40` – 5000, where `setpoint` is `tuning.ingress_dejitter_ms` or the built-in 60 ms when that is unset | `max(4 × setpoint, 250)`, clamped to the 5000 ms ceiling (which bites above a 1250 ms setpoint) | Hard-shed residence cap for that buffer. A packet older than the cap is shed rather than released late, which is what bounds ingress latency when a burst outruns the servo's ±5 % rate authority. A per-input value wins. |
| `probe_session_limits` | boolean | — | `true` | Run the startup hardware encoder / decoder session-capacity probe. `false` disables **both** tiers and trades the manager's "sessions used *of* max" denominator for a faster boot. |
| `probe_4k` | boolean | — | `true` | Run the second-tier 4K session-capacity pass. Ignored entirely when `probe_session_limits` is `false`. |
| `media_player_controller` | boolean | — | `true` | Node default for media-player transport control. `false` selects the legacy sequential playout loop **and** withdraws the `media-player-control-v1` capability, so the manager's **Next** button disappears node-wide instead of being offered and refused. A per-input `operator_control` wins. |
| `media_player_pcr_deadlines` | boolean | — | `true` | Node default for PCR-anchored TS playout pacing. `false` selects the legacy byte-rate estimate, whose error integrates without bound on variable-bitrate assets. A per-input `pcr_deadlines` wins. |

Out-of-range values are rejected at config load with the offending field and its bounds named, and the manager's Tuning tab mirrors the same bounds client-side before it will let you save.

**Only raw UDP and RTP inputs enrol in the node-wide de-jitter default.** SRT already de-jitters at the transport layer (TSBPD), RTMP and RTSP synthesise their own clock, and a bonded input's reordering buffer would shed the bond's own bursts — those transports run ingress passthrough by design and `tuning.ingress_dejitter_ms` does not reach them. A per-input setpoint is still the only way to size one specific UDP or RTP feed differently from the rest.

**An `update_config` push that omits `tuning` preserves whatever the node already holds**, the same as `monitor`, `upgrades`, `resource_limits`, `nmos_registration` and `logging`. To clear the block back to built-in defaults, send it explicitly empty (`"tuning": {}`) — that is what the Tuning tab does when you blank every field.

**UI gating.** The Tuning tab is hidden unless the node advertises `node_tuning` on `HealthPayload.capabilities`; the **Media player** section of that tab is gated separately on `media_player_tuning`. The two bits are deliberately distinct: the media-player fields landed after `node_tuning` shipped, so an edge from that release advertises `node_tuning`, accepts the newer fields on a push and ignores them — the exact accept-and-ignore failure `node_tuning` exists to prevent.

### When a change takes effect

| Field | Lands on the config push? | What you have to do |
|---|---|---|
| `ingress_dejitter_ms` | Yes — re-installed as the node default immediately | Read when an input **spawns**, so restart the flow (or hot-swap the input) to apply it to something already running |
| `ingress_residence_ms` | Yes | Same — restart the flow |
| `media_player_controller` | Yes | Restart the flow; the capability change reaches the manager on the next health tick |
| `media_player_pcr_deadlines` | Yes | Restart the flow |
| `probe_session_limits` | No | **Restart the node.** The hardware probe runs once at startup and there is nothing to re-run |
| `probe_4k` | No | **Restart the node** |

Changing either probe switch raises a Warning [`tuning_requires_restart`](/edge/events-and-alarms/) event naming both fields, so you are told rather than left to infer it from an unchanged Resources card.

## Memory locking

`mlockall(MCL_CURRENT | MCL_FUTURE)` pins every current and future page into RAM, so a major page fault can never stall a wire-emit thread mid-pace. It is opt-in and the gate is strict — the literal string `1`, nothing else:

```bash
# /etc/bilbycast/edge.env
BILBYCAST_MLOCKALL=1
```

The shipped installer seeds exactly that line on a fresh install, and the shipped unit carries `LimitMEMLOCK=infinity` so the call succeeds without `CAP_IPC_LOCK`. On a hand-rolled unit, supply both yourself — the `BILBYCAST_MLOCKALL=1` line and `LimitMEMLOCK=infinity` (or `CAP_IPC_LOCK` in the limit's place). Without them `mlockall` fails `EPERM` or `ENOMEM`, and the edge logs the errno with the matching remedy rather than failing to start.

## SCHED_FIFO on the hot path

Hot-path threads are ordinary OS threads, not Tokio tasks, and each raises itself to `SCHED_FIFO` at spawn. The priorities are fixed in the binary and ordered so a downstream consumer can always preempt slower upstream work:

| Thread | Priority | Set by |
|---|---|---|
| Wire-emit (one per wire-pacing output), media-player playout, ST 2110 ingest | 50 | `engine::wire_emit`, `engine::input_media_player`, `engine::st2110` |
| Codec (encode / decode) | 40 | `engine::codec_thread` |
| PID-bus / TS assembler, PCR-ingress PLL sampler | 35 | `engine::dedicated_runtime` |

The grant needs nothing more than the shipped unit's two lines:

```ini
RestrictRealtime=false
LimitRTPRIO=99
```

The kernel allows an unprivileged `SCHED_FIFO` request at or below `RLIMIT_RTPRIO`, so 50 ≤ 99 is honoured without `CAP_SYS_NICE`. Strip those lines — or run the binary directly, or in a container without `--ulimit rtprio=99` — and every one of these threads silently falls back to `SCHED_OTHER`: bytes still flow, tail latency grows into the 1–5 ms band. The failure is logged per thread and latched onto the health tick; see [Verifying what took effect](#verifying-what-took-effect).

## CPU affinity

Four independent CPU sets pin the four thread families. All four take the same syntax — a single core, a comma list, a range, or any mix (`2`, `2,3,5`, `2-5`, `2,4-6,9`) — and each is parsed **once per process**, so a change needs a service restart. Invalid entries are logged and skipped rather than failing the boot; the parsed set is sorted and de-duplicated, and threads round-robin across it as they spawn.

| Variable | Pins |
|---|---|
| `BILBYCAST_WIRE_EMIT_CPUS` | Wire-emit releaser threads |
| `BILBYCAST_CODEC_CPUS` | Codec (encode / decode) threads |
| `BILBYCAST_PID_BUS_CPUS` | PID-bus / TS-assembler runtime |
| `BILBYCAST_PLL_CPUS` | PCR-ingress / PLL sampler |

Unset or empty means no pinning at all — the scheduler floats the thread, which is where contention with Tokio workers shows up under load.

Pinning is **per-thread**, so `taskset -p $(pidof bilbycast-edge)` still reports the full CPU mask; `ps -o pid,psr,comm -T -p $(pidof bilbycast-edge)` is what shows where each thread actually ran.

Pinning alone does not stop the kernel scheduling *other* work onto the same cores. To make them belong to the edge exclusively, isolate them at boot as well — append to `GRUB_CMDLINE_LINUX_DEFAULT` in `/etc/default/grub`, then `sudo update-grub && sudo reboot`:

```text
isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3
```

`isolcpus` removes the cores from the scheduler's load-balancing pool (tasks land there only by explicit affinity), `nohz_full` drops the 1 ms periodic tick when only one task is runnable, and `rcu_nocbs` moves RCU callbacks elsewhere. Use the same core numbers here as in the pinning sets, and prefer cores that do not share an SMT pair with a busy Tokio worker.

## The ETF / SO_TXTIME opt-in

The wire emitter defaults to `clock_nanosleep(CLOCK_TAI, TIMER_ABSTIME)` on a SCHED_FIFO thread and needs no PTP, no qdisc and no special NIC. Kernel-paced `SO_TXTIME` is an opt-in upgrade, and it has one hard prerequisite: **an `etf` qdisc must already be installed on the egress NIC.** Without it the kernel accepts `setsockopt(SO_TXTIME)`, ignores the per-packet launch time, sends everything immediately, and the telemetry still reports tier `so_txtime` — a silent degradation strictly worse than the default. Install the qdisc first (`packaging/setup-etf-qdisc.sh`), then set:

```bash
# /etc/bilbycast/edge.env
BILBYCAST_ENABLE_TXTIME=1
BILBYCAST_ETF_SO_PRIORITY=5
```

Two things to know before you turn it on:

- **It only moves ST 2110.** `SO_TXTIME` is taken only for an ETF-eligible output, and ST 2110-20 / -23 / -30 / -31 / -40 is the only egress built that way. Every compressed UDP / RTP / SMPTE 302M output stays on `clock_nanosleep` whatever this is set to — deliberately, because `etf` **drops** a packet whose launch time has passed, which is unrecoverable corruption on bare UDP with no ARQ behind it.
- **`BILBYCAST_ETF_SO_PRIORITY` is not optional on a host prepared by the shipped script.** The edge defaults it to `0`, but that script's `mqprio` map routes only socket priority **5** to the etf class and sends priority 0 to `fq_codel`. Leave it unset and the tier reports `so_txtime` while every packet rides the non-etf class with no launch-time pacing.

`setsockopt(SO_TXTIME)` with `CLOCK_TAI` also needs `CAP_NET_ADMIN` on recent kernels; the shipped unit grants it (`AmbientCapabilities=CAP_NET_ADMIN`). Without it the call fails `EPERM`, the emitter logs the errno and the remedy, and the output falls back to `clock_nanosleep`.

With `BILBYCAST_ENABLE_TXTIME=1` set, compressed outputs are additionally pinned to `BILBYCAST_LOSSLESS_SO_PRIORITY` (default `4`) to keep them off the etf class entirely. That pin is applied *only* when the opt-in is on — with no etf qdisc in play the DSCP-derived priority is left exactly as it was, and the on-wire DSCP byte (`IP_TOS`) is unaffected either way.

Full decision matrix, qdisc recipe, NIC selection and PTP prerequisites: [Wire-Time Precision](/edge/wire-pacing/).

## A worked example

A two-flow contribution node on an 8-core box: two raw UDP ingests off a lossy WAN, each transcoded to one UDP output, no ST 2110. Cores 2 and 3 are isolated for wire emission, 4 and 5 carry the encoders.

`/etc/bilbycast/edge.env` — host layer:

```bash
RUST_LOG=info

# Lock pages into RAM (unit ships LimitMEMLOCK=infinity).
BILBYCAST_MLOCKALL=1

# Wire-emit threads onto the isolated pair; encoders onto their own pair.
BILBYCAST_WIRE_EMIT_CPUS=2,3
BILBYCAST_CODEC_CPUS=4,5

# No ST 2110 on this node, so no ETF opt-in — the default
# clock_nanosleep tier is the right answer for compressed TS.
# BILBYCAST_ENABLE_TXTIME=1
```

`/etc/default/grub` — hand cores 2 and 3 to the edge:

```text
GRUB_CMDLINE_LINUX_DEFAULT="... isolcpus=2,3 nohz_full=2,3 rcu_nocbs=2,3"
```

The node's `tuning` block — media layer, pushed from the manager:

```json
{
  "tuning": {
    "ingress_dejitter_ms": 120,
    "ingress_residence_ms": 300,
    "probe_session_limits": true,
    "probe_4k": false
  }
}
```

120 ms of de-jitter on both UDP ingests without touching either input definition. The residence cap is pinned at 300 ms rather than left to derive as `max(4 × 120, 250)` = 480 ms, trading burst headroom for a tighter ingress-latency bound; anything below the 160 ms floor (`setpoint + 40`) is refused at config load. `probe_4k` is off because this node never encodes above 1080p, which shortens boot; `probe_session_limits` stays on so the Resources card keeps its "sessions used *of* max" denominator.

Applying it: the two ingress values land on the push and reach each input at its next spawn, so restart the two UDP flows. `probe_4k` needs a node restart, and the edge raises `tuning_requires_restart` to say so. The `edge.env` and GRUB changes need `sudo systemctl restart bilbycast-edge` and a reboot respectively.

## Verifying what took effect

**The boot log is the primary check.** Each wire-emit thread prints its tier, its scheduler grant and its pinning in one line:

```text
wire-emit '<id>': starting (anchor=Pcr, tier=clock_nanosleep_fifo, sched_fifo=true, pinned_cpu=Some(2))
```

`tier=clock_nanosleep_fifo` is the default path with the SCHED_FIFO grant; `tier=clock_nanosleep` (no `_fifo`) means the grant was refused and the thread is at `SCHED_OTHER`; `tier=so_txtime` is the kernel-paced tier. `pinned_cpu=None` means the CPU set was unset, empty, or the affinity call failed.

**Per-output, over the API.** `GET /api/v1/stats` on the node reports `wire_pacing_tier` for every output that owns a wire emitter, plus `wire_pacing_pinned_cpu` (omitted when the thread is unpinned) and `wire_pacing_late` (omitted while zero). `wire_pacing_late` counts datagrams the kernel rejected because their launch time had already passed — it only ever moves on the `so_txtime` tier, and is always zero on the userspace-sleep paths.

**Node-wide, on the health tick.** Every health payload carries `scheduling_status`:

```json
{
  "scheduling_status": {
    "mlockall": "locked",
    "sched_fifo_granted": true,
    "sched_fifo_failed": false,
    "rlimit_rtprio_max": 99
  }
}
```

`mlockall` is `"disabled"` (the env var was not set to `1`), `"locked"`, or a `failed` object carrying the raw `errno`. `sched_fifo_failed` is a **sticky latch** — one thread failing degrades the flow's timing, so it stays set once tripped even if every other thread was granted. No manager screen renders this block today; read it from the node's raw health payload or use the log line above.

## Deprecated environment variables

Each `tuning` field replaces an environment variable. On the edge **the config field always wins** — a legacy variable that is still read sits *below* it, never above, because an environment variable that outranked the UI would recreate the silent no-op this migration exists to close.

| Config field | Former variable | Status of the variable |
|---|---|---|
| `tuning.ingress_dejitter_ms` | `BILBYCAST_INGRESS_BUFFER_MS` | **Removed.** It never had any effect in any release — the node-wide setpoint was consulted only after the per-input one had already answered — so it was withdrawn rather than revived as a fallback |
| `tuning.ingress_residence_ms` | `BILBYCAST_INGRESS_RESIDENCE_MS` | Deprecated — still read below the config field |
| `tuning.probe_session_limits` | `BILBYCAST_PROBE_SESSION_LIMITS` | Deprecated — still read below the config field |
| `tuning.probe_4k` | `BILBYCAST_PROBE_4K` | Deprecated — still read below the config field |
| `tuning.media_player_controller` | `BILBYCAST_MEDIA_PLAYER_CONTROLLER` | Deprecated — still read below the config field |
| `tuning.media_player_pcr_deadlines` | `BILBYCAST_MEDIA_PLAYER_PCR_DEADLINES` | Deprecated — still read below the config field |

A node that still sets any of them — deprecated or removed — raises one Warning [`deprecated_env_var`](/edge/events-and-alarms/) event per variable at startup, carrying `env_var`, `replacement`, the `value` found, and a `status` of `"deprecated"` (honoured beneath the config field), `"removed"` (does nothing at all) or `"unparseable"` (read, but this host's value could not be parsed, so it was discarded and the layer below answered). A stale unit file therefore shows up on the manager's Events page instead of quietly stating an intent nothing applies.

The host-layer variables on this page — the CPU sets, `BILBYCAST_MLOCKALL`, `BILBYCAST_ENABLE_TXTIME` and the two `SO_PRIORITY` knobs — are **not** deprecated. They describe the machine, not the media, and correctly stay in the environment.

## Related pages

- [Wire-Time Precision (PCR_AC)](/edge/wire-pacing/) — the pacing tiers in full, the ETF qdisc recipe, NIC selection and acceptance targets.
- [Configuration Guide](/edge/configuration/) — the `tuning` block in the context of the whole config file, plus the per-input `ingress_dejitter_ms` / `ingress_residence_ms` / `operator_control` / `pcr_deadlines` overrides.
- [Environment Variables](/reference/environment-variables/) — every variable across every project, with the config field that replaces it where one exists.
- [Resources & Capacity](/edge/resources/) — what the startup probe the two `probe_*` switches control actually measures.
- [Master Clock & A/V Sync](/edge/clocking/) and [Time (PTP)](/edge/ptp/) — the clock the wire emitter paces against.
- [Install Edge as a Linux Service](/edge/install-ubuntu-service/) — the systemd unit that carries `LimitRTPRIO`, `LimitMEMLOCK` and the environment file.
