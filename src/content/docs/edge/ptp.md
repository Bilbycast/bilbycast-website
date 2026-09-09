---
title: Time (PTP)
description: Pick a node's PTP role — Auto, Grandmaster, Slave-only, Off — from the manager UI. No sudo, no systemctl, no ptp4l.conf editing.
sidebar:
  order: 11
---

bilbycast-edge handles PTP (Precision Time Protocol, IEEE 1588-2008)
the way an operator would actually want to handle it: pick a role
from a dropdown, click Apply, done. No SSH, no `sudo`, no `systemctl`
restarts, no hand-edited `ptp4l.conf`.

This page covers when PTP matters, the four roles and when to pick
each, where to click in the manager, and the security model that
makes the whole thing safe to expose to non-root operators.

## When PTP matters

PTP is required (or strongly recommended) in two cases:

1. **SMPTE ST 2110 essence flows** (ST 2110-30/-31/-40 audio + data,
   ST 2110-20/-23 uncompressed video) — receivers expect the sender
   to be locked to a shared PTP grandmaster, and the NMOS IS-04 Node
   API advertises a `ptp` clock entry whenever any flow declares a
   `clock_domain`.
2. **MXL (Media eXchange Layer)** flows — every `mxl_*` input runs on
   the PTP master clock (`engine::master_clock` pins
   `MasterClockKind::Ptp` on the input's `clock_domain`, default 0), so
   an MXL flow degrades if the node never locks. The `mxl-video` /
   `mxl-audio` / `mxl-anc` capabilities are **not** gated on PTP,
   though — a node advertises them when its binary was built with the
   `mxl` Cargo feature *and* the boot probe successfully `dlopen`ed
   `libmxl.so` (from `/usr/local/lib`, `/usr/lib/x86_64-linux-gnu`,
   `/opt/bilbycast/lib`, or `BILBYCAST_LIBMXL_SO`). If the MXL options
   are missing from the manager UI, look for `libmxl.so` on the host
   first; PTP lock will not bring them back.

PTP is **not required** for compressed TS over UDP / RTP / SRT / RIST
/ RTMP, including 2022-7 dual-leg hitless on a single edge. The
default wire-pacing tier handles those workloads with sub-3 ms PCR
accuracy on commodity Linux. If you're not running ST 2110 or MXL
flows, leave PTP **Off** (the install default) and skip the rest of
this page.

## Prerequisites

Two things must be in place before PTP can work:

1. **`linuxptp`** — the IEEE 1588 daemon suite (`ptp4l`, `phc2sys`,
   `pmc`). Install it on the edge host:

   ```bash
   # Debian / Ubuntu
   sudo apt update && sudo apt install linuxptp

   # RHEL / Fedora
   sudo dnf install linuxptp
   ```

2. **`bilbycast-ptp-helper`** — a small companion daemon that watches
   `/var/lib/bilbycast/ptp.conf` and starts/stops `ptp4l` +
   `phc2sys` automatically when you change the PTP mode. It is
   installed and enabled by the standard `install-edge.sh` installer.
   If you installed the edge manually, ensure the
   `bilbycast-ptp.service` systemd unit is running:

   ```bash
   sudo systemctl enable --now bilbycast-ptp.service
   ```

Once both are in place, pick a PTP mode from the manager UI (see
below) and the helper takes care of the rest — no manual `ptp4l`
configuration needed.

For the wallclock / PCR side of the same story see
[Wire-Time Precision](/edge/wire-pacing/). For the deeper flow-level
master-clock picture see the edge repo's
[`docs/clocking.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/clocking.md).

## The four modes

| Mode | Use when | Behind the scenes |
|---|---|---|
| **Auto** | Mixed sites — you don't know in advance whether a grandmaster is on the LAN | Listen for a PTP Announce for `scan_timeout` seconds (default 5). If heard, become a slave; otherwise become the grandmaster. **The plug-and-play default for unknown sites.** |
| **Grandmaster** | You control the LAN and want this node to provide time | `priority1=128`, `masterOnly=1`, `clockClass=248` |
| **Slave only** | The customer requires we never be the time source | `priority1=255`, `slaveOnly=1`, `clockClass=255`. Refuses to ever become master under BMCA, even if every other clock vanishes. |
| **Off** | Not using ST 2110 / MXL | No `ptp4l` / `phc2sys` running. ST 2110 / MXL flows refuse to start. TS-class flows run on the system wallclock. |

**Slave only hands `CLOCK_REALTIME` to the PTP fabric.** Entering it
stops any active `chrony` / `chronyd` / `systemd-timesyncd`, and leaving
it starts them again. Under the unprivileged production unit that stop
can fail with nothing louder than a log warning — two servos then fight
over the system clock. The opt-outs (`BILBYCAST_PTP_KEEP_NTP=1`, and
`BILBYCAST_PTP_SYSCLOCK=ntp` to leave NTP owning the system clock while
`ptp4l` still slaves the NIC PHC) are covered in the edge repo's
[`docs/ptp.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/ptp.md#system-clock-ownership-ptp-vs-ntpchrony).

**Default on a fresh install is Off.** Operators opt in explicitly via
the UI; PTP packets on the wire at a customer site without their
knowledge would be surprising and noisy.

## Picking a role in the manager UI

1. Open the manager and navigate to the node.
2. Click **Time (PTP)** in the top-right action row (alongside
   *Node Bus* and *Configure*).
3. Pick a mode card (Auto / Grandmaster / Slave only / Off).
4. Optionally set the interface, domain, priority1, or auto scan
   timeout.
5. Click **Apply**.

The change applies within ~1 second. The "Live status" card on the
same page polls the edge's runtime PTP lock state every 5 s — once
the node locks you'll see `lock_state: locked`, the grandmaster
clock identity, and the current offset in nanoseconds.

## Direct REST against the edge

For automation / Ansible / Terraform integration:

```bash
# Read current settings
curl https://edge:8443/api/v1/ptp \
     -H "Authorization: Bearer $TOKEN"

# Switch to slave-only on eno4 with SMPTE domain 127
curl -X PUT https://edge:8443/api/v1/ptp \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"mode":"slave-only","iface":"eno4","domain":127}'
```

Both endpoints require a valid Bearer JWT, but neither checks the
role. Unlike the inputs / outputs / flows / config write handlers,
`get_ptp` and `put_ptp` don't ask for the `RequireAdmin` extractor — and
the auth middleware only validates the token, it never branches on role
— so any valid token, monitor included, can read *and change* the
node's PTP settings. The PUT side validates the
payload before persisting — `iface` must be 1..=15 ASCII bytes
matching `[A-Za-z0-9._-]+`, `domain` must be in 0..=127, `scan_timeout`
must be in 1..=60.

## Hand-editing the config file

`/var/lib/bilbycast/ptp.conf` is a plain KEY=VALUE file. SSH in,
edit with vi, save — the helper picks the change up within 1 second:

```ini
# bilbycast PTP helper config — managed by the bilbycast-edge
# manager UI Time page. Hand-edits are picked up on the next
# 1 Hz mtime poll.

mode         = auto
iface        = eno4
domain       = 127
priority1    =
scan_timeout = 5
offset_warn_ns =
path_delay_warn_ns =
```

Unknown keys are tolerated (forward-compat). Blank lines and `#`
comments are ignored. A blank or `0` on either threshold disables it;
when set, crossing it raises a Warning `ptp_offset_high` /
`ptp_path_delay_high` and falling back under 80 % of it raises an Info
`ptp_offset_recovered` / `ptp_path_delay_recovered`. For the full
monitoring picture see the edge repo's
[`docs/ptp.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/ptp.md#monitoring-ptp-health-over-time).

## How it works under the hood

```
┌──────────────────────────────────────────────────────────────────┐
│  Manager UI                                                      │
│  ─ /nodes/{id}/time picks mode → PUT /api/v1/nodes/{id}/ptp/mode │
└─────────────────────────┬────────────────────────────────────────┘
                          │ HTTPS
┌─────────────────────────▼────────────────────────────────────────┐
│  Manager                                                         │
│  ─ proxy_set_ptp_mode forwards over WS as set_ptp_mode           │
└─────────────────────────┬────────────────────────────────────────┘
                          │ WSS
┌─────────────────────────▼────────────────────────────────────────┐
│  Edge (bilbycast-edge process, no extra capabilities)            │
│  ─ atomic write+rename → /var/lib/bilbycast/ptp.conf             │
└─────────────────────────┬────────────────────────────────────────┘
                          │ filesystem mtime
┌─────────────────────────▼────────────────────────────────────────┐
│  bilbycast-ptp-helper (separate process, separate systemd unit)  │
│  ─ 1 Hz mtime poll, owns CAP_NET_RAW + CAP_NET_ADMIN + CAP_SYS_TIME │
│  ─ on change: read config, exec /opt/bilbycast/bin/bilbycast-ptp-gm.sh │
└─────────────────────────┬────────────────────────────────────────┘
                          │ exec (Command::args, no shell)
┌─────────────────────────▼────────────────────────────────────────┐
│  bilbycast-ptp-gm.sh                                             │
│  ─ stage_conf renders per-mode ptp4l options                     │
│  ─ nohup ptp4l -f <staged conf> -i <iface> (+ phc2sys),          │
│    PIDs in /var/run/bilbycast-ptp                                │
└──────────────────────────────────────────────────────────────────┘
```

### Why a separate helper?

The PTP daemons (`ptp4l`, `phc2sys`) need three Linux capabilities:

- `CAP_NET_RAW` — raw sockets for IEEE 1588 frames
- `CAP_SYS_TIME` — phc2sys adjusts the system clock from the PHC
- `CAP_NET_ADMIN` — PHC settings, hardware timestamping flags

Keeping the helper separate from `bilbycast-edge` means the main edge
binary itself runs with **no extra capabilities**. Only this small
~200-line helper holds the ambient caps, and it does nothing on the
data path — it watches one file and execs one script.

### Why a file the helper polls, not RPC?

- **No new IPC surface.** Manager writes a file, edge reads it back,
  helper polls it. Everything is over channels the platform already
  trusts.
- **Atomic** — manager writes `.tmp` then `rename(2)`s. The helper's
  `read_to_string` can never see a torn write.
- **Hand-editable** — operator on the box can drop into
  `/var/lib/bilbycast/ptp.conf` with vi and the same 1 Hz poll applies
  the change. No `systemctl reload`, no manager round-trip needed.
- **No dbus / polkit dependency** — works in minimal container images
  and stripped-down distros where dbus isn't installed.

## Security analysis

The PTP UX moves a previously root-only workflow (`sudo systemctl
restart ptp4l@…`) into a daemon driven by manager-UI input. The
threat model + mitigations:

### Trust boundaries

| Step | Who acts | Privilege held | What it can do |
|---|---|---|---|
| Operator → Manager | Authenticated user with `Operate` role on this node | Group-scoped session JWT + CSRF | Submit `SetPtpModePayload` to `PUT /api/v1/nodes/{id}/ptp/mode` |
| Manager → Edge | Manager process | Authenticated WS to the edge | Send the `set_ptp_mode` command |
| Edge → Disk | `bilbycast-edge` user | File write to `/var/lib/bilbycast/ptp.conf` | Persist mode + iface + domain |
| Helper → Script | `bilbycast-ptp-helper` (separate process, `bilbycast` user) | `CAP_NET_RAW`, `CAP_NET_ADMIN`, `CAP_SYS_TIME` ambient caps | Exec `/opt/bilbycast/bin/bilbycast-ptp-gm.sh` with ~6 argv entries |
| Script → ptp4l/phc2sys | The script | Inherits the helper's caps | Launch/kill `ptp4l` + `phc2sys` directly (`nohup`, PID files under `/var/run/bilbycast-ptp`); stop/start `chrony`, `chronyd`, `systemd-timesyncd` |

### Defended attack vectors

- **Config-file forging via `iface`.** A `\n` in iface could append a
  spurious `mode = …` line and override the operator's chosen mode.
  Mitigation: iface must match `[A-Za-z0-9._-]+`, 1..=15 bytes,
  enforced on both the manager (HTTP 400) and the edge
  (`error_code: invalid_value`). Unit-tested in
  `util::ptp_config::tests::validate_rejects_*`.
- **Shell metacharacters in `iface`.** No shell is ever involved: the
  helper uses `Command::args`, and the script hands the name to `ptp4l`
  as an `execve` argv entry (`-i "$iface"`). The validator's real job is
  the line above — stopping a newline from forging a `mode = …` line in
  `ptp.conf`.
- **Path traversal via `BILBYCAST_PTP_SCRIPT` env override.** In
  production the systemd unit `bilbycast-ptp.service` runs with a
  clean environment, so the compiled-in default path is what gets
  exec'd. The script + helper binary are both root-owned mode 0755;
  the `bilbycast` user cannot replace them.
- **Torn writes / TOCTOU between edge and helper.** Edge uses atomic
  `write(.tmp)` + `rename(2)`. The helper's poll re-reads on every
  observed mtime change.

### Residual capabilities held by the helper

The helper holds `CAP_NET_RAW + CAP_NET_ADMIN + CAP_SYS_TIME` even
when idle — exactly what `ptp4l`/`phc2sys` need. The main edge
process holds **none** of those. If the helper itself were
compromised, an attacker would inherit only those three caps —
`CAP_SETUID`, `CAP_SYS_ADMIN`, and root file write are NOT in the
set. The systemd unit also sets `ProtectSystem=strict` +
`ReadWritePaths=` to the four paths ptp4l/phc2sys actually need.

### Operator awareness

- An operator with `Operate` on the node can take the time source
  offline by flipping to **Off**. This is by design — the same role
  can already stop flows or force `master_clock = wallclock` on an
  ST 2110 flow. Worth knowing for group permission design.
- The PTP file is **node-wide**. In a multi-tenant deployment where
  one node is shared between groups, an `Operate`-role user from
  Group A can change the PTP role for flows belonging to Group B.
  Per-tenant scoping of the helper's input is tracked as future work.

### Audit trail

Every successful `set_ptp_mode` writes a `node.command` row to the
manager's audit log with the requested mode + iface in the payload.
Failed validation logs at `warn` on both sides with the rejecting
rule and surfaces as HTTP 400 / `command_ack.error_code:
invalid_value`.

## Lock states

The "Live status" card on the manager Time page surfaces one of six
states. `GET /api/v1/ptp` is **not** where it comes from — that endpoint
returns only the configured mode / iface / domain / thresholds. On the
edge itself the lock state rides on the health tick's node-level
`ptp_state` block, on the `bilbycast_edge_ptp_state` /
`bilbycast_edge_ptp_locked` gauges in `/metrics`, and per-flow on
`GET /api/v1/stats` as `ptp_state.lock_state` (present on any flow whose
master clock resolves to PTP — ST 2110, MXL, or an explicit
`master_clock.kind = "ptp"`).

| State | Meaning |
|---|---|
| `unavailable` | No PTP daemon reachable — `ptp4l`'s management socket is missing, or the poll failed outright (no answer, undecodable reply) |
| `acquiring` | `ptp4l` is running but the port is `LISTENING` / `UNCALIBRATED` / `PRE_MASTER` (or another transient state) — no usable lock yet. A slave-only node whose grandmaster is switched off sits here |
| `locked` | `ptp4l` reports the port is in `SLAVE` state and the absolute master offset is below tolerance. Counted healthy |
| `holdover` | The port is still `SLAVE`, but the master offset has drifted past tolerance. Raises a Warning PTP event on entry |
| `master` | The port is `MASTER` — BMCA picked this node as the grandmaster, so it is definitionally locked to its own reference. Counted healthy, but unusual enough in a broadcast plant that entering it raises a Warning event |
| `unknown` | The daemon answered, but not the port-state query — so the reporter refuses to guess. Not healthy, raises a Warning, and stays distinct from `unavailable` so the UI can say "unknown ptp4l state" rather than "no daemon" |

The state is sampled on a low-frequency timer (~1 s) and cached.
Reading it from the data path is a single atomic load — there is
zero per-packet PTP work.

## Verified NIC families

PTP precision is dominated by the NIC's hardware timestamping support.
The following NIC families have been verified with `linuxptp` and the
bilbycast helper:

| Vendor | Family | Notes |
|---|---|---|
| Intel | i210, i350, X710, E810 | All support hardware tx/rx timestamping; X710/E810 recommended for high-density plants |
| Mellanox / NVIDIA | ConnectX-5, ConnectX-6, ConnectX-7 | Hardware timestamping verified; pair with `mlx5_core` driver |

Other PTP-capable NICs should work — the requirement is hardware
tx/rx timestamping support exposed via `SO_TIMESTAMPING`. Confirm
with `ethtool -T <iface>`.

## Operator rule of thumb

- Don't know if there's a GM? → **Auto**. Right answer 95% of the time.
- You run the LAN and want a known time source? → **Grandmaster**.
- Customer says "we provide PTP, you slave"? → **Slave only**.
- Not using ST 2110 / MXL at this site? → **Off** (the install default).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `lock_state: unavailable` on every flow | `ptp4l` not running. Check the Time page mode; if it shows `Off`, switch to a real mode. If it shows the right mode, run `sudo /opt/bilbycast/bin/bilbycast-ptp-gm.sh status`, read `/var/log/bilbycast-ptp/ptp4l.log`, and check `journalctl -u bilbycast-ptp.service` for the helper's last apply log. |
| `lock_state: master` | No peer master was visible. On Auto mode this means no Announce was heard in `scan_timeout` seconds and we became the grandmaster with `clockClass=248`. It counts as healthy; slaving to someone else needs a peer with a better clock. |
| `lock_state: acquiring` that never becomes `locked` | `ptp4l` is up and listening but hasn't calibrated. Watch it live with `sudo /opt/bilbycast/bin/bilbycast-ptp-gm.sh logs`, and check the domain matches the fabric's — `ptp4l` silently drops mismatched-domain traffic. |
| Receivers reject ST 2110 connections | NMOS Node API isn't advertising a `ptp` clock entry — confirm at least one flow has `clock_domain` set, then check `/x-nmos/node/v1.3/self`. |
| HTTP 400 / `invalid_value` on Apply | Most often: iface name has a typo or non-permitted character. Iface must be `[A-Za-z0-9._-]+`, 1..=15 bytes. |

`ptp4l` and `phc2sys` are **not** systemd units here — the script
`nohup`s them itself and records the PIDs under `/var/run/bilbycast-ptp`,
so `journalctl -u ptp4l@<iface>`, `systemctl status ptp4l@<iface>` and
`systemctl list-units 'ptp4l*'` come back empty on a perfectly healthy
node. Use `bilbycast-ptp-gm.sh status` (which also runs live `pmc`
queries) and `bilbycast-ptp-gm.sh logs` instead.

For deeper troubleshooting (helper-side logs, `pmc` queries, the
exec'd script's per-mode rendering) see the edge repo's
[`docs/ptp.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/ptp.md).

## Migration from older edges

If you're upgrading from an edge build before 0.92.0 that had you
managing `ptp4l@…` units by hand: stop those units once, then let
the helper take over via the Time page. The helper installs as
`bilbycast-ptp.service`; it does **not** clobber your existing
`/etc/linuxptp/ptp4l.conf`. On every start it regenerates one staged
file at `/etc/linuxptp/bilbycast-ptp-gm.conf` (override with
`BILBYCAST_PTP_STAGED_CONF`) and hands it to `ptp4l` as `-f`. There is
no per-iface file and nothing is written under `/tmp`. The
`/etc/linuxptp` location is load-bearing: the distro AppArmor profile
for `/usr/sbin/ptp4l` only permits reads under `@{etc_ro}/linuxptp/**`.

If you previously ran the stock units by hand:

```bash
# One-time cleanup of the old manual setup
sudo systemctl disable --now ptp4l@<iface>.service phc2sys@<iface>.service
# Then flip the Time page to Slave-only / Grandmaster / Auto
```

After that point all role changes go through the UI. The old
`provision-edge-node.sh` wrapper still works for fresh installs but
is no longer the primary path — `install-edge.sh` provisions the
helper directly.
