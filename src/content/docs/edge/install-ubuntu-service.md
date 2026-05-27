---
title: Install Edge as a Linux Service
description: Run bilbycast-edge as a systemd service on Linux so it survives reboots and restarts on failure.
sidebar:
  order: 3
---

This page is the **manual step-by-step** alternative to [the one-command `install-edge.sh` path on the Install an Edge Node page](/edge/getting-started/#3-install-and-register). Use it when you want full control over each piece, or when the script doesn't fit your distro.

:::note[Most operators don't need this page]
If you haven't installed yet, start at [Install an Edge Node](/edge/getting-started/) — the recommended `install-edge.sh` path there does everything below in one command, including PTP, systemd units, and manager registration.
:::

The walkthrough below produces the same layout `install-edge.sh` creates:

Both should be **active (running)**. The node should appear online in the manager within seconds.

The script is idempotent — re-running it on an existing install updates the binary and units in place without losing config or data.

:::tip[PTP after install]
PTP defaults to **Off**. To enable it, open the manager UI's per-node **Time (PTP)** page, pick a mode (Auto / Grandmaster / Slave only), and click Apply. The `bilbycast-ptp.service` picks up the change within ~1 second — no SSH or restart needed. See [Time (PTP)](/edge/ptp/) for the full reference.
:::

## Manual step-by-step install

If you prefer to control each step (or are on a non-standard distro where the script doesn't fit), the walkthrough below is the explicit equivalent of what `install-edge.sh` does.

## 1. Create the service user

```bash
# `|| true` — the bilbycast user may already exist from a manager or
# relay install on this box; useradd would otherwise exit non-zero.
sudo useradd -r -s /sbin/nologin -d /var/lib/bilbycast bilbycast || true
```

`-r` makes a system user (no login, no home created). `/sbin/nologin` blocks interactive login. The home stub at `/var/lib/bilbycast` is just a sentinel — we'll create the real data dirs below.

## 2. Lay out the directories

The install root holds the binary tree (`versions/<v>/` + `current` symlink, the same shape the upgrade module manipulates). The data root holds anything the edge writes at runtime (replay segments, media library, instance state). The bilbycast user owns both so it can write through.

```bash
# Pick the version you extracted in step 1 — listed at the top of the tarball
# path or in the binary itself (`./bilbycast-edge --version`).
VERSION=0.58.0

sudo mkdir -p /opt/bilbycast/edge/versions/${VERSION}
sudo mkdir -p /var/lib/bilbycast/edge/replay
sudo mkdir -p /var/lib/bilbycast/edge/media

sudo chown -R bilbycast:bilbycast /opt/bilbycast /var/lib/bilbycast
sudo chmod 0750 /opt/bilbycast/edge /var/lib/bilbycast/edge
sudo chmod 0750 /var/lib/bilbycast/edge/replay /var/lib/bilbycast/edge/media
```

Why bilbycast owns the install root: the upgrade module (`bilbycast-edge/src/upgrade/`) creates `versions/<new>/`, atomically swaps the `current` symlink, and prunes old versions — all running as the service user. Root-owned would block the swap silently.

Recordings (replay) and the media-player library can grow large — give them their own filesystem if you can.

## 3. Install the tarball into `versions/<v>/`

From inside the extracted tarball directory, copy the **whole tree** (binary + licence files + `packaging/` scripts) into the matching `versions/` subdirectory and atomically point `current` at it:

```bash
# `./* `expands to everything in the extracted tarball
sudo cp -r ./* /opt/bilbycast/edge/versions/${VERSION}/
sudo chown -R bilbycast:bilbycast /opt/bilbycast/edge/versions/${VERSION}
sudo chmod 0755 /opt/bilbycast/edge/versions/${VERSION}/bilbycast-edge

# Atomic symlink swap so `current` always points at a real version dir.
sudo -u bilbycast ln -sfn versions/${VERSION} /opt/bilbycast/edge/current.tmp
sudo -u bilbycast mv -Tf /opt/bilbycast/edge/current.tmp /opt/bilbycast/edge/current
```

Verify the symlink resolves:

```bash
ls -la /opt/bilbycast/edge/current/bilbycast-edge
# → /opt/bilbycast/edge/current -> versions/0.58.0
# → versions/0.58.0/bilbycast-edge (executable)
```

The `packaging/` scripts referenced later (`provision-edge-node.sh`, `setup-etf-qdisc.sh`) land under `/opt/bilbycast/edge/current/packaging/` automatically.

## 4. Install the config

The setup wizard (or your manual config in step 5 of [Install an edge node](/edge/getting-started/)) wrote `config.json` and `secrets.json` next to the binary. Move them into the install root so they sit alongside the `current` symlink — both the running edge and any future-installed version reference the same files:

```bash
sudo install -m 0640 -o bilbycast -g bilbycast \
  config.json  /opt/bilbycast/edge/config.json
sudo install -m 0600 -o bilbycast -g bilbycast \
  secrets.json /opt/bilbycast/edge/secrets.json
```

`config.json` is bilbycast-owned (not root) because the edge writes back to it when the manager pushes `UpdateConfig` / Create-/Update-/Delete-Input/Output/Flow/Tunnel commands (`config/persistence.rs::save_config_split`). Root-owned would block the persistence silently — every UI-driven config change would disappear on the next restart. The edge auto-pairs `secrets.json` from the same directory as the config, so no path reference is required inside `config.json`.

## 5. Drop the systemd unit

Write `/etc/systemd/system/bilbycast-edge.service`:

```ini
[Unit]
Description=bilbycast-edge media transport gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bilbycast
Group=bilbycast
WorkingDirectory=/var/lib/bilbycast/edge

# ExecStart resolves through the `current` symlink, so a successful
# manager-driven upgrade lands automatically when the old binary exits.
ExecStart=/opt/bilbycast/edge/current/bilbycast-edge --config /opt/bilbycast/edge/config.json
Restart=on-failure
RestartSec=2s

# File-descriptor headroom for SRT / RIST / RTP listeners
LimitNOFILE=65536

# Required by engine::wire_emit, which spawns one SCHED_FIFO std::thread
# per UDP-socket-owning output (UDP, RTP, ST 2110-*, 302M) on the
# default clock_nanosleep tier. The kernel allows unprivileged
# SCHED_FIFO whenever LimitRTPRIO is non-zero and RestrictRealtime is
# off, so no capability grant is required for the scheduling-class
# change itself.
RestrictRealtime=false
LimitRTPRIO=99

# Permits BILBYCAST_MLOCKALL=1 in /etc/bilbycast/edge.env — see below.
LimitMEMLOCK=infinity

# CAP_NET_ADMIN — required by mainline kernel ≥ 6.x (and every recent
# Ubuntu / RHEL backport) for setsockopt(SO_TXTIME) with any non-
# CLOCK_MONOTONIC clockid. Wire pacing uses CLOCK_TAI, the only
# clockid the etf qdisc on Intel ice / igc / igb and Mellanox mlx5
# accepts. Required when BILBYCAST_ENABLE_TXTIME=1 opts in to the
# SO_TXTIME release tier (tiers 1–2). Without this cap the probe
# returns EPERM, wire-emit silently falls back to the clock_nanosleep
# tier (tier 4 — the default), and on any host whose etf qdisc has
# `skip_sock_check off` (the kernel default) those fallback packets
# are then also dropped at the qdisc. The cap is NOT required for
# the default tier-4 path and does NOT let the edge install qdiscs —
# qdisc install stays operator-side via `setup-etf-qdisc.sh`.
CapabilityBoundingSet=CAP_NET_ADMIN
AmbientCapabilities=CAP_NET_ADMIN

# Logging + storage roots. The defaults below put the edge on the
# clock_nanosleep tier with no qdisc / no PTP required — the right
# choice for every deployment that doesn't need sub-µs PCR_AC. To opt
# in to the SO_TXTIME release tier, see "Optional: enable SO_TXTIME"
# below (this requires the ETF qdisc + PTP).
Environment=RUST_LOG=info
Environment=BILBYCAST_REPLAY_DIR=/var/lib/bilbycast/edge/replay
Environment=BILBYCAST_MEDIA_DIR=/var/lib/bilbycast/edge/media

# Uncomment if your manager uses a self-signed certificate:
# Environment=BILBYCAST_ALLOW_INSECURE=1
# Uncomment after installing the ETF qdisc + PTP to enable SO_TXTIME:
# Environment=BILBYCAST_ENABLE_TXTIME=1

# Hardening — sensible defaults that don't break anything the edge does.
# ReadWritePaths covers both the install root (for upgrades + config
# persistence) and the data root (replay / media / instance state).
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/bilbycast/edge /var/lib/bilbycast/edge

[Install]
WantedBy=multi-user.target
```

The hardening block (`NoNewPrivileges`, `ProtectSystem=strict`, etc.) is optional but recommended. `ReadWritePaths` allows writes to the install root (so the upgrade module can manipulate `versions/` and the edge can persist `config.json`) and the data root (so replay / media / instance state can land).

**Wire pacing runs automatically on every UDP-socket-owning output**
(UDP, RTP including FEC and 2022-7 dual-leg, 302M, ST 2110-20/-23/-30/-31/-40).
SRT, RIST, RTMP, HLS, CMAF, and WebRTC are paced internally by their
own protocol layers and need no extra setup.

**The default release tier is `clock_nanosleep` on a SCHED_FIFO thread
(tier 4 in the table below) — no qdisc, no PTP, no HW-PTP NIC, no env
var required.** That path comfortably handles compressed TS through
2 Gbps with sub-3 ms PCR_AC max on commodity Linux. The kernel-paced
`SO_TXTIME` upgrade (tiers 1–2) is opt-in via `BILBYCAST_ENABLE_TXTIME=1`
and only worth enabling when the per-flow rate or receiver strictness
genuinely demands sub-µs precision — see [Wire-Time Precision](/edge/wire-pacing/).

The edge picks the highest pacing tier the host can deliver at output
startup and logs the choice (`wire-emit '<id>': starting (anchor=…, tier=…)`).
The active tier is also surfaced in `OutputStats.wire_pacing_tier` for
the manager UI.

| Tier | Mechanism | Inter-packet jitter envelope | Requires |
|---|---|---|---|
| 1 | `SO_TXTIME` + ETF qdisc with `offload` on a PTP-disciplined NIC | Sub-µs | ETF qdisc + HW-PTP NIC + `ptp4l + phc2sys` + `CAP_NET_ADMIN` + `BILBYCAST_ENABLE_TXTIME=1` |
| 2 | `SO_TXTIME` + software ETF qdisc | ~1–10 µs | ETF qdisc + `CAP_NET_ADMIN` + `BILBYCAST_ENABLE_TXTIME=1` |
| 4 ⭐ | `clock_nanosleep` on SCHED_FIFO | ~50–500 µs typical, ms-tail under load | systemd unit's `LimitRTPRIO=99` (already set above). **Default — no setup required.** |
| 5 | `clock_nanosleep` on SCHED_OTHER | ~1–5 ms | None — non-Linux, or Linux without RT grant |

For tier-1 broadcast PCR_AC compliance (T-STD ≤ 500 ns), install the
ETF qdisc on the egress NIC, install the boot-time `bilbycast-etf-qdisc@.service`
to persist it, set up PTP, and opt in via `BILBYCAST_ENABLE_TXTIME=1`.
**The edge does not install the qdisc itself** — `tc qdisc` requires
`CAP_NET_ADMIN`, deliberately operator-side. See [ETF qdisc setup](#etf-qdisc-setup-opt-in-for-tier-1-pcr-accuracy-and-st-2110-21-narrow-profile)
below — the same chain gives every output (TS as well as ST 2110) tier-1
PCR_AC. **The default `clock_nanosleep` tier is the right choice unless
you have a measured reason to upgrade**; enabling SO_TXTIME without the
full prerequisite stack produces *silent degradation* worse than the
default.

## 5b. Hardware-encoder runtime (only if you'll use NVENC or QSV)

The `*-full` binary compiles in the FFmpeg → NVENC and FFmpeg → QSV bridges, but the actual GPU encoder *implementation* lives in vendor-shipped runtime libraries that are not bundled with the bilbycast tarball. If your flows only use software encoders (`x264` / `x265`) you can skip this section entirely.

**Intel QuickSync (QSV) — x86_64 only:**

```bash
sudo apt update
sudo apt install libvpl2 libmfx-gen1.2 intel-media-va-driver-non-free
sudo usermod -aG render bilbycast    # service user needs /dev/dri/renderD* access
```

| Package | Role |
| --- | --- |
| `libvpl2` | oneVPL dispatcher (`libvpl.so.2`). bilbycast links to this. |
| **`libmfx-gen1.2`** | Intel VPL **GPU runtime** (`libmfx-gen.so.1.2`) — the actual hardware encoder. **The package most installs miss.** Without it, `MFXLoad` returns `MFX_ERR_NOT_FOUND` and `h264_qsv` / `hevc_qsv` fail to open. |
| `intel-media-va-driver-non-free` | VAAPI driver (`iHD_drv_video.so`). Required for some pixel-format and zero-copy paths inside `libmfx-gen`. The `intel-media-va-driver` upstream package works too. |

QSV needs Broadwell (5th gen) or newer for H.264; HEVC needs Kaby Lake (7th gen) or newer.

**NVIDIA NVENC:**

```bash
# Ubuntu 22.04 / 24.04 — auto-pick recommended branch:
sudo ubuntu-drivers autoinstall
# Or pin a specific branch (e.g. 580 LTS):
sudo apt install nvidia-driver-580          # workstation
sudo apt install nvidia-driver-580-server   # headless servers
sudo reboot

# Debian 12+ — non-free repo must be enabled:
sudo apt install nvidia-driver
sudo reboot
```

The proprietary NVIDIA driver bundles `libnvidia-encode.so.1` and `libcuda.so.1`, both of which bilbycast `dlopen`s at flow start. The Nouveau open-source driver does **not** expose NVENC.

After install, verify the GPU is visible to the service user:

```bash
sudo -u bilbycast nvidia-smi          # NVENC: must list the GPU
ls -l /dev/dri/                       # QSV: bilbycast must be in render group; renderD128 should be readable
```

If you skip this step but still configure a `video_encode` block with `h264_qsv` / `h264_nvenc`, the encoder will fail to open at flow start and the edge will surface a Critical event under category `video_encode`. Software encoders (`x264`, `x265`) keep working regardless because they're statically linked into the `*-full` binary.

## 5c. Install PTP support (required for ST 2110 / MXL)

PTP is managed by a small companion daemon (`bilbycast-ptp-helper`) that watches a config file and starts/stops `ptp4l` + `phc2sys` when the operator changes the PTP mode from the manager UI. Skip this step only if you will never use ST 2110 or MXL flows on this node.

**Install `linuxptp`:**

```bash
# Debian / Ubuntu
sudo apt update && sudo apt install -y linuxptp

# RHEL / Fedora
sudo dnf install -y linuxptp
```

**Install the PTP script and config template:**

```bash
sudo install -d -m 0755 /opt/bilbycast/bin
sudo install -m 0755 \
  /opt/bilbycast/edge/current/packaging/bilbycast-ptp-gm.sh \
  /opt/bilbycast/bin/bilbycast-ptp-gm.sh
sudo install -m 0644 \
  /opt/bilbycast/edge/current/packaging/bilbycast-ptp-gm.conf \
  /opt/bilbycast/bin/bilbycast-ptp-gm.conf
```

**Seed the default PTP config** (`mode = off` — operator enables via the manager UI):

```bash
sudo install -d -o bilbycast -g bilbycast -m 0755 /var/lib/bilbycast
cat <<'EOF' | sudo tee /var/lib/bilbycast/ptp.conf > /dev/null
mode = off
iface =
domain = 127
priority1 =
scan_timeout = 5
EOF
sudo chown bilbycast:bilbycast /var/lib/bilbycast/ptp.conf
```

**Create the runtime directories:**

```bash
sudo install -d -o bilbycast -g bilbycast -m 0755 /var/run/bilbycast-ptp
sudo install -d -o bilbycast -g bilbycast -m 0755 /var/log/bilbycast-ptp
sudo install -d -m 0755 /etc/linuxptp
```

**Install the systemd unit:**

```bash
sudo install -m 0644 \
  /opt/bilbycast/edge/current/packaging/bilbycast-ptp.service \
  /etc/systemd/system/bilbycast-ptp.service
```

On Ubuntu with AppArmor, `ptp4l` may be confined. Install the shipped local override so it can read the staged config:

```bash
if [ -d /etc/apparmor.d/local ] && [ -f /opt/bilbycast/edge/current/packaging/apparmor-local-ptp4l ]; then
  sudo install -m 0644 \
    /opt/bilbycast/edge/current/packaging/apparmor-local-ptp4l \
    /etc/apparmor.d/local/usr.sbin.ptp4l
  sudo apparmor_parser -r /etc/apparmor.d/usr.sbin.ptp4l 2>/dev/null || true
fi
```

## 6. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bilbycast-edge
sudo systemctl enable --now bilbycast-ptp
```

Watch the first boot:

```bash
sudo systemctl status bilbycast-edge
sudo systemctl status bilbycast-ptp
sudo journalctl -u bilbycast-edge -f
```

You should see `manager: connected` within a few seconds, and the node should flip to **online** in the manager UI. The PTP helper will be running but idle (mode = off) until you pick a PTP mode from the manager's Time page.

## 7. Day-2 operations

**Restart after a config change:**

```bash
sudo systemctl restart bilbycast-edge
```

**Tail recent logs:**

```bash
sudo journalctl -u bilbycast-edge -f
```

**Bump log level temporarily** (no restart of any in-flight flows — the env var only takes effect on a fresh start):

```bash
sudo systemctl edit bilbycast-edge
# Add under [Service]:
#   Environment=RUST_LOG=debug
sudo systemctl restart bilbycast-edge
```

**Upgrade to a new release (recommended — from the manager UI):**

Once the edge has registered with the manager and shows up in `/admin/nodes`, every subsequent upgrade can be driven from the browser:

1. Go to **Managed Nodes**, click **Upgrade…** on the row.
2. Pick a `(version, channel)` and click **Stage upgrade**.
3. The edge fetches the Sigstore-signed manifest, verifies it against its compiled-in allowlist, downloads the tarball, atomically swaps a `current` symlink, and respawns under systemd. A boot watchdog automatically rolls back if the new binary fails to come up healthy.

See [Remote Upgrade](/manager/remote-upgrade/) for the full operator runbook (per-node, group bulk rollout, automatic rollback, troubleshooting).

**Upgrade manually (fallback):**

If you can't reach the manager UI, or you're upgrading the very first edge before the manager-driven path is wired up, you can still upgrade by hand. Drop the new binary next to the old one under `versions/`, then atomically swap the `current` symlink:

```bash
NEW_VERSION=0.59.0   # the version you just downloaded

# Re-run step 1 of "Install an edge node" to fetch + extract the new tarball.

sudo systemctl stop bilbycast-edge

sudo mkdir -p /opt/bilbycast/edge/versions/${NEW_VERSION}
sudo install -m 0755 -o bilbycast -g bilbycast \
  bilbycast-edge /opt/bilbycast/edge/versions/${NEW_VERSION}/bilbycast-edge

# Atomic symlink swap. Old version stays in versions/ for instant rollback.
sudo ln -sfn versions/${NEW_VERSION} /opt/bilbycast/edge/current.tmp
sudo mv -Tf /opt/bilbycast/edge/current.tmp /opt/bilbycast/edge/current

sudo systemctl start bilbycast-edge

# Rollback (if the new version misbehaves): point current at the old version dir.
#   sudo ln -sfn versions/0.58.0 /opt/bilbycast/edge/current.tmp
#   sudo mv -Tf /opt/bilbycast/edge/current.tmp /opt/bilbycast/edge/current
#   sudo systemctl restart bilbycast-edge
```

The config + secrets at `/opt/bilbycast/edge/{config.json,secrets.json}` carry across upgrades untouched.

## Common failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Failed to start bilbycast-edge` with `Permission denied` on `/var/lib/bilbycast/edge` or `/opt/bilbycast/edge` | The `bilbycast` user can't write to a path. | `sudo chown -R bilbycast:bilbycast /var/lib/bilbycast /opt/bilbycast` |
| `bind: address already in use` on port 8080 | Something else is already on `:8080`. | Free the port, or override with `--port 8090` in the unit's `ExecStart`. |
| `auth_failed` events in the manager log, edge keeps re-trying | Registration token already used or expired, or the node was deleted from the manager. | Re-register: in the manager UI generate a fresh token, paste it into `/opt/bilbycast/edge/secrets.json`, restart the service. |
| Edge connects but `accept_self_signed_cert` is silently ignored | The `BILBYCAST_ALLOW_INSECURE=1` safety guard isn't set. | Uncomment the matching line in the unit, then `daemon-reload && restart`. |
| AppArmor blocks `/dev/dri` or ALSA on a display-output flow | Distribution AppArmor profile is too strict. | Add `/dev/dri/** rw,` and `/dev/snd/** rw,` to the profile, or run with hardening relaxed (`ProtectSystem=full`). |

## What about the manager?

The manager install guide's [Production — systemd block](/manager/getting-started/#production--systemd) walks through the same pattern for the manager (service user, `/opt/bilbycast-manager/`, `/etc/bilbycast-manager/manager.env`, hardened unit with `ProtectSystem=strict`). There's no separate "manager Ubuntu service" guide because the install guide already covers it inline.

## ETF qdisc setup (opt-in) for tier-1 PCR accuracy and ST 2110-21 narrow profile

**You only need this section if you have a concrete reason to leave the
default `clock_nanosleep` tier.** Three cases earn the upgrade:

- **ST 2110-20 / -23 narrow profile** (Imagine, Lawo, EVS Xeebra, Grass
  Valley LDX, Bridge Tech VB330 in test mode) — at 1080p50 (~ 250 k pps)
  and 4K60 (~ 1 M pps), per-packet timing must be within microseconds of
  the frame raster. Userspace pacing can't hit that budget.
- **T-STD-compliant PCR_AC (≤ 500 ns)** on compressed TS over UDP / RTP —
  required by contribution-grade decoders with `PCR_AC` alarms enabled
  (Appear X10, Cobalt 9202, Cisco D9824).
- **Sustained CPU contention** pushing tier-4 p99 above ~30 ms (many
  transcoded outputs on a tight box) — kernel ETF moves pacing off the
  SCHED_FIFO thread so CPU contention no longer perturbs it. Tier 2
  (software ETF, no HW-PTP NIC) is enough here.

If none of those apply, **skip this section**. The default tier-4 path
handles compressed TS through 2 Gbps on a standard NIC with sub-3 ms
PCR_AC max — fine for VLC, ffplay, OBS, web players, cloud receivers,
and most professional decoders in standard tolerance mode.

:::caution[Enabling SO_TXTIME without the full prerequisite stack is *worse* than the default]
The pre-2026-05-16 edge defaulted to SO_TXTIME and silently degraded on
hosts without an ETF qdisc — every packet emitted ASAP while telemetry
still reported tier `so_txtime`. The current edge defaults to
`clock_nanosleep` and only attempts SO_TXTIME when you set
`BILBYCAST_ENABLE_TXTIME=1`. **Don't set the env var until every step
below is in place.**
:::

### One-shot: `provision-edge-node.sh`

The shipped wrapper does all four steps below in one idempotent,
reboot-persistent run — installs `linuxptp`, writes systemd units for
`ptp4l@${MEDIA_IFACE}.service` + `phc2sys@${MEDIA_IFACE}.service`, lays
down the ETF qdisc via the `bilbycast-etf-qdisc@${MEDIA_IFACE}.service`
boot unit, and (optionally) static ARP for known peers:

```bash
sudo MEDIA_IFACE=enp1s0 \
     bash /opt/bilbycast/edge/current/packaging/provision-edge-node.sh
```

Optional flags:
- `PTP_ONLY=1` — install only `ptp4l` + `phc2sys`, no ETF, no ARP. Safe to run on a NIC that also carries SSH / management.
- `PEERS="10.0.0.5=00:0e:c6:4a:53:06 10.0.0.10=00:11:22:33:44:55"` — pin known peers to static ARP entries, eliminating ARP refresh stalls on low-latency unicast.

The script is idempotent — re-running it updates the systemd units in place. Everything it writes is a systemd unit with `enable --now`, so the config survives reboots without further action. If the NIC name changes (for instance, because of a kernel/driver upgrade renaming `eno4` → `enp1s0`), re-run with the new `MEDIA_IFACE`.

After the wrapper finishes, you still need to opt the edge in by uncommenting `BILBYCAST_ENABLE_TXTIME=1` in `/etc/bilbycast/edge.env` and restarting the service — see step 4 below.

If you'd rather lay each piece down by hand, the manual four-step walkthrough below is the equivalent.

### Step 1: install the ETF qdisc on the egress NIC

```bash
sudo bash /opt/bilbycast/edge/current/packaging/setup-etf-qdisc.sh enp1s0
```

Replace `enp1s0` with your actual broadcast egress NIC. The script installs `mqprio` at root (3 traffic classes, 3 hardware tx queues) and `etf clockid CLOCK_TAI delta 200000 offload skip_sock_check on` on the prioritized class. `offload` enables hardware tx pacing on supported NICs (Mellanox CX-6 / CX-7, Intel E810, Intel i210); silently degrades to software ETF on unsupported NICs (still 1–10 µs jitter). `skip_sock_check on` is non-negotiable — without it ARP, DHCP, ssh, and every default UDP socket on the host get dropped at the qdisc.

Verify:

```bash
tc -s qdisc show dev enp1s0
```

should list `mqprio` at root and `etf` on the prioritized class — not the default `pfifo_fast`.

### Step 2: install the boot-time systemd unit so the qdisc survives reboots

The one-shot `tc` call from step 1 doesn't survive a reboot. Install the templated `bilbycast-etf-qdisc@.service` unit that ships with the edge:

```bash
sudo install -m 0644 \
  /opt/bilbycast/edge/current/packaging/bilbycast-etf-qdisc@.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bilbycast-etf-qdisc@enp1s0
```

The unit ordering is `After=network-online.target sys-subsystem-net-devices-<iface>.device` + `Before=bilbycast-edge.service`, so the qdisc is in place by the time the edge starts. Verify:

```bash
systemctl status bilbycast-etf-qdisc@enp1s0
tc -s qdisc show dev enp1s0
```

Removal: `sudo systemctl disable --now bilbycast-etf-qdisc@enp1s0`. (Optional manual teardown: `sudo tc qdisc del dev enp1s0 root`.)

### Step 3: confirm PTP discipline on the system clock (tier 1 only)

Tier 1 needs `ptp4l` + `phc2sys` running against a PTP grandmaster. Tier 2 (software ETF, no HW-PTP NIC, no PTP) works without this step but caps out around 1–10 µs jitter.

`SO_TXTIME` schedules transmission against `CLOCK_TAI`. Without `ptp4l` + `phc2sys` running, the kernel's TAI clock is just wall time + leap-second offset — sender and receiver drift relative to each other and the receiver's VRX bound fails.

**Don't start ptp4l/phc2sys by hand.** Open the manager UI's per-node **Time (PTP)** page and pick **Slave only** (or **Auto** if you don't know yet). The `bilbycast-ptp-helper` daemon shipped with `install-edge.sh` will start the right `ptp4l@<iface>` + `phc2sys` services for you within ~1 s and re-apply on every config change — no `sudo` from the operator at runtime. Full operator runbook + role decision tree: [Time (PTP)](/edge/ptp/).

Verify both daemons are alive afterwards:

```bash
systemctl status ptp4l@<iface>.service phc2sys@<iface>.service
```

Both should be **active (running)**. The edge keeps emitting valid bytes without PTP, just not narrow-profile-aligned.

### Step 4: opt the edge in to SO_TXTIME and restart

The edge defaults to the `clock_nanosleep` release tier regardless of whether ETF is installed. To use the SO_TXTIME tier, set `BILBYCAST_ENABLE_TXTIME=1` in the env file:

```bash
sudo tee -a /etc/bilbycast/edge.env > /dev/null <<'EOF'
BILBYCAST_ENABLE_TXTIME=1
EOF
sudo systemctl restart bilbycast-edge
```

(Use whichever env-file mechanism your unit uses — `EnvironmentFile=/etc/bilbycast/edge.env` if you adopted `install-edge.sh`, otherwise inline `Environment=BILBYCAST_ENABLE_TXTIME=1` in the unit's `[Service]` block.)

### Step 5: confirm the active tier on the edge

```bash
sudo journalctl -u bilbycast-edge --since "5 minutes ago" | grep wire-emit
```

You should see a line like `wire-emit '<output-id>': starting (anchor=Pcr, tier=so_txtime)` for every output that owns a UDP socket. With ETF qdisc + PTP from steps 1–3 and the env var from step 4, the host is running tier 1 or 2 (sub-µs to ~10 µs jitter). If the line shows `tier=clock_nanosleep` despite the env var, the SO_TXTIME setsockopt failed — typically because `CAP_NET_ADMIN` isn't granted on the unit, see step 5 of the unit block above.

You can also check via the manager UI's per-output card or directly:

```bash
curl -k https://<edge>:8080/api/v1/stats | jq '.data.flows[].outputs[] | {id: .output_id, tier: .wire_pacing_tier, late: .wire_pacing_late}'
```

`wire_pacing_late` should stay at 0 — non-zero means the kernel rejected datagrams as "target tx time in the past", typically because of a transient host-clock or scheduling stall.

### What if any step is skipped?

| Skipped | Behaviour |
|---|---|
| Step 4 (`BILBYCAST_ENABLE_TXTIME=1` not set) | Edge runs at tier 4 — the default. Compressed TS through 2 Gbps with sub-3 ms PCR_AC max. ST 2110-21 narrow profile fails the receiver-side VRX bound. |
| Step 1 + 2 (no ETF qdisc) but env var set | The SO_TXTIME setsockopt succeeds but the kernel's default qdisc ignores `SCM_TXTIME` — silent degradation, worse than the default. Always install the qdisc before setting the env var. |
| Step 3 (no PTP) but ETF installed | Tier 2 jitter (~ 1–10 µs) is achievable, but the pacer's TAI anchor isn't GM-aligned — multi-edge 2022-7 across hosts and ST 2110-21 narrow profile both fail. |
| Step 1–4 all skipped | Edge runs at tier 4 (`clock_nanosleep` on SCHED_FIFO) — the default. Fine for VLC / ffplay / OBS / cloud receivers / standard professional gear up through 2 Gbps. |

For the architecture, full failure-mode matrix, and per-NIC notes, see [Wire-Time Precision](/edge/wire-pacing/) and [ST 2110](/edge/st2110/#st-2110-21-narrow-profile-pacing-uncompressed-video).

## Where to read next

- [Configuration reference](/edge/configuration/) — every input, output, and flow field.
- [ST 2110](/edge/st2110/) — uncompressed video / audio / ANC essence flows + narrow-profile pacing.
- [Display output](/edge/display/) — drive an HDMI / DisplayPort connector for confidence-monitor playout.
- [Replay](/edge/replay/) — continuous flow recording and clip playback.
- [Edge events and alarms](/edge/events-and-alarms/) — what shows up in `journalctl` and the manager events feed.
