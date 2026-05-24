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
2. **MXL (Media eXchange Layer)** flows — PTP-mandatory at validation
   time. The `mxl-video` / `mxl-audio` / `mxl-anc` capabilities are
   only advertised when the helper can probe a usable PTP lock.

PTP is **not required** for compressed TS over UDP / RTP / SRT / RIST
/ RTMP, including 2022-7 dual-leg hitless on a single edge. The
default wire-pacing tier handles those workloads with sub-3 ms PCR
accuracy on commodity Linux. If you're not running ST 2110 or MXL
flows, leave PTP **Off** (the install default) and skip the rest of
this page.

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

Both endpoints require an admin-role JWT. The PUT side validates the
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
```

Unknown keys are tolerated (forward-compat). Blank lines and `#`
comments are ignored.

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
│  ─ systemctl restart ptp4l@<iface>.service + phc2sys             │
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
| Script → ptp4l/phc2sys | The script | Inherits the helper's caps | `systemctl restart ptp4l@<iface>.service` + phc2sys |

### Defended attack vectors

- **Config-file forging via `iface`.** A `\n` in iface could append a
  spurious `mode = …` line and override the operator's chosen mode.
  Mitigation: iface must match `[A-Za-z0-9._-]+`, 1..=15 bytes,
  enforced on both the manager (HTTP 400) and the edge
  (`error_code: invalid_value`). Unit-tested in
  `util::ptp_config::tests::validate_rejects_*`.
- **Shell injection via `iface` to the privileged script.** The
  helper uses `Command::args` (no shell), but the script does
  `systemctl restart "ptp4l@$iface"`. The same iface validator
  blocks every shell metachar.
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

The "Live status" card on the manager Time page (and `GET /api/v1/ptp`
on the edge) surfaces one of four states:

| State | Meaning |
|---|---|
| `locked` | `ptp4l` reports the port is in `SLAVE` state and the offset is below threshold |
| `locked_holdover` | Recently locked but the master has gone away; the edge still trusts the local clock for a configurable holdover window |
| `free_run` | No master has ever been seen since startup, or holdover has expired — the local clock is running free |
| `unavailable` | The management socket is missing or unresponsive — the edge cannot determine state |

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
| `lock_state: unavailable` on every flow | `ptp4l` not running. Check the Time page mode; if it shows `Off`, switch to a real mode. If it shows the right mode, check `journalctl -u bilbycast-ptp.service` for the helper's last apply log. |
| `lock_state: free_run` | No master visible. On Auto mode this means no Announce was heard in `scan_timeout` seconds and we became the master with `clockClass=248`. Real lock requires a peer with a better clock. |
| Receivers reject ST 2110 connections | NMOS Node API isn't advertising a `ptp` clock entry — confirm at least one flow has `clock_domain` set, then check `/x-nmos/node/v1.3/self`. |
| HTTP 400 / `invalid_value` on Apply | Most often: iface name has a typo or non-permitted character. Iface must be `[A-Za-z0-9._-]+`, 1..=15 bytes. |

For deeper troubleshooting (helper-side logs, `pmc` queries, the
exec'd script's per-mode rendering) see the edge repo's
[`docs/ptp.md`](https://github.com/bilbycast/bilbycast-edge/blob/main/docs/ptp.md).

## Migration from older edges

If you're upgrading from an edge build before 0.92.0 that had you
managing `ptp4l@…` units by hand: stop those units once, then let
the helper take over via the Time page. The helper installs as
`bilbycast-ptp.service`; it does **not** clobber your existing
`/etc/linuxptp/ptp4l.conf` — it writes its own
`/tmp/bilbycast-ptp-<iface>.conf` and points `ptp4l@<iface>.service`
at that.

```bash
# One-time cleanup of the old manual setup
sudo systemctl disable --now ptp4l@<iface>.service phc2sys@<iface>.service
# Then flip the Time page to Slave-only / Grandmaster / Auto
```

After that point all role changes go through the UI. The old
`provision-edge-node.sh` wrapper still works for fresh installs but
is no longer the primary path — `install-edge.sh` provisions the
helper directly.
