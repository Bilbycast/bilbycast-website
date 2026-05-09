---
title: Install Edge as an Ubuntu Service
description: Run bilbycast-edge as a systemd service on Ubuntu so it survives reboots and restarts on failure.
sidebar:
  order: 3
---

This guide takes a freshly-extracted edge tarball and turns it into a proper systemd-managed service on Ubuntu (24.04 or newer). After this you'll have:

- The binary at `/opt/bilbycast-edge/bilbycast-edge`.
- The config at `/etc/bilbycast/edge.json`, owned by the service user.
- Persistent data dirs under `/var/lib/bilbycast/`.
- A systemd unit that auto-starts on boot and auto-restarts on crash.

If you haven't completed the [edge install + setup-wizard registration](/edge/getting-started/) yet, do that first — this guide picks up from there with a working `config.json` + `secrets.json` pair.

## 1. Create the service user

```bash
sudo useradd -r -s /sbin/nologin -d /var/lib/bilbycast bilbycast
```

`-r` makes a system user (no login, no home created). `/sbin/nologin` blocks interactive login. The home stub at `/var/lib/bilbycast` is just a sentinel — we'll create the real data dirs below.

## 2. Lay out the directories

```bash
sudo mkdir -p /opt/bilbycast-edge
sudo mkdir -p /etc/bilbycast
sudo mkdir -p /var/lib/bilbycast/replay
sudo mkdir -p /var/lib/bilbycast/media

sudo chown -R bilbycast:bilbycast /var/lib/bilbycast
sudo chmod 750 /var/lib/bilbycast
sudo chmod 750 /var/lib/bilbycast/replay
sudo chmod 750 /var/lib/bilbycast/media
```

Recordings (replay) and the media-player library can grow large — give them their own filesystem if you can.

## 3. Install the binary

From inside the extracted tarball directory:

```bash
sudo install -m 0755 -o bilbycast -g bilbycast bilbycast-edge /opt/bilbycast-edge/bilbycast-edge
```

If you'd like the licence files alongside the binary:

```bash
sudo install -m 0644 LICENSE NOTICE /opt/bilbycast-edge/
# Full variant only — the GPL'd component licences:
sudo install -m 0644 COPYING.GPL /opt/bilbycast-edge/ 2>/dev/null || true
```

## 4. Install the config

The setup wizard (or your manual config in step 5 of [Install an edge node](/edge/getting-started/)) wrote `config.json` and `secrets.json` next to the binary. Move them into the standard locations:

```bash
sudo install -m 0640 -o root -g bilbycast config.json /etc/bilbycast/edge.json
sudo install -m 0600 -o bilbycast -g bilbycast secrets.json /etc/bilbycast/edge.secrets.json
```

Also drop the matching pointer inside `/etc/bilbycast/edge.json` so the binary finds the secrets — open it with `sudoedit /etc/bilbycast/edge.json` and confirm any path references inside point at `/etc/bilbycast/edge.secrets.json`. Most installs don't need this — the edge auto-pairs `secrets.json` from the same directory as the config file.

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
WorkingDirectory=/var/lib/bilbycast
ExecStart=/opt/bilbycast-edge/bilbycast-edge --config /etc/bilbycast/edge.json
Restart=on-failure
RestartSec=2s

# File-descriptor headroom for SRT / RIST / RTP listeners
LimitNOFILE=65536

# Reserved for a future wire-pacing thread (engine::wire_emit, in
# tree but not currently wired in). Harmless today — no SCHED_FIFO
# threads are created on the current code path, so these lines are
# no-ops. Keeping them in the unit avoids needing a daemon-reload
# when wire_emit re-lands.
RestrictRealtime=false
LimitRTPRIO=50

# Logging + storage roots
Environment=RUST_LOG=info
Environment=BILBYCAST_REPLAY_DIR=/var/lib/bilbycast/replay
Environment=BILBYCAST_MEDIA_DIR=/var/lib/bilbycast/media

# Uncomment if your manager uses a self-signed certificate:
# Environment=BILBYCAST_ALLOW_INSECURE=1

# Hardening — sensible defaults that don't break anything the edge does
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/bilbycast /etc/bilbycast

[Install]
WantedBy=multi-user.target
```

The hardening block (`NoNewPrivileges`, `ProtectSystem=strict`, etc.) is optional but recommended. The edge only needs read-write access to `/var/lib/bilbycast/` and reads `/etc/bilbycast/`; everything else stays read-only.

No SCHED_FIFO threads run on the current code path — wire pacing for
compressed TS (`engine::wire_emit`) is in tree but not currently
wired in (a 2026-05-09 integration attempt was reverted; see
`bilbycast-edge/docs/wire-pacing.md`). PCR-arrival jitter at the
receiver is in the 5–50 ms band today, which most receivers (VLC,
Appear, Cisco TV, EVS) tolerate.

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

## 6. Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bilbycast-edge
```

Watch the first boot:

```bash
sudo systemctl status bilbycast-edge
sudo journalctl -u bilbycast-edge -f
```

You should see `manager: connected` within a few seconds, and the node should flip to **online** in the manager UI.

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

If you can't reach the manager UI, or you're upgrading the very first edge before the manager-driven path is wired up, you can still upgrade by hand:

```bash
sudo systemctl stop bilbycast-edge
# Re-download + extract the latest tarball (see step 1 of "Install an edge node")
sudo install -m 0755 -o bilbycast -g bilbycast bilbycast-edge /opt/bilbycast-edge/bilbycast-edge
sudo systemctl start bilbycast-edge
```

The config + secrets in `/etc/bilbycast/` carry across upgrades untouched.

## Common failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Failed to start bilbycast-edge` with `Permission denied` on `/var/lib/bilbycast` | The `bilbycast` user can't write to a path. | `sudo chown -R bilbycast:bilbycast /var/lib/bilbycast` |
| `bind: address already in use` on port 8080 | Something else is already on `:8080`. | Free the port, or override with `--port 8090` in the unit's `ExecStart`. |
| `auth_failed` events in the manager log, edge keeps re-trying | Registration token already used or expired, or the node was deleted from the manager. | Re-register: in the manager UI generate a fresh token, paste it into `/etc/bilbycast/edge.secrets.json`, restart the service. |
| Edge connects but `accept_self_signed_cert` is silently ignored | The `BILBYCAST_ALLOW_INSECURE=1` safety guard isn't set. | Uncomment the matching line in the unit, then `daemon-reload && restart`. |
| AppArmor blocks `/dev/dri` or ALSA on a display-output flow | Distribution AppArmor profile is too strict. | Add `/dev/dri/** rw,` and `/dev/snd/** rw,` to the profile, or run with hardening relaxed (`ProtectSystem=full`). |

## What about the manager?

The `bilbycast-manager init` flow (see [Install the manager](/manager/getting-started/#3-install--guided-recommended)) already drops a working systemd unit at `/etc/bilbycast-manager/bilbycast-manager.service` — there's no separate "manager Ubuntu service" guide because the installer is the guide. Inspect the generated unit, then `install` and `enable --now` it the same way you would the edge unit above.

## ST 2110-21 narrow profile pacing (uncompressed video, opt-in)

Skip this section unless you're sending **uncompressed ST 2110-20 / -23** to a narrow-profile receiver (Imagine, Lawo, EVS Xeebra, Grass Valley LDX, Bridge Tech VB330 in test mode). Compressed paths (SRT, RIST, RTP, UDP) are paced automatically by the SCHED_FIFO `wire-emit` thread you set up in step 5 — no extra work.

ST 2110-20 / -23 narrow-profile compliance at production rates (1080p50 ≈ 250 k pps; 4K60 ≈ 1 M pps) requires per-packet timing within microseconds of the frame raster. Userspace pacing can't hit that budget. The Linux solution is `SO_TXTIME` + the ETF qdisc, with HW offload on PTP-disciplined NICs.

This is a three-step setup, all operator-side.

### Step 1: install the ETF qdisc on the egress NIC

```bash
sudo bash /opt/bilbycast-edge/packaging/setup-etf-qdisc.sh enp1s0
```

Replace `enp1s0` with your actual broadcast egress NIC. The script installs `mqprio` at root (3 traffic classes, 3 hardware tx queues) and `etf clockid CLOCK_TAI delta 200000 offload` on the prioritized class. `offload` enables hardware tx pacing on supported NICs (Mellanox CX-6 / CX-7, Intel E810, Intel i210); silently degrades to software ETF on unsupported NICs (still 1–10 µs jitter).

Verify:

```bash
tc -s qdisc show dev enp1s0
```

should list `mqprio` at root and `etf` on the prioritized class — not the default `pfifo_fast`.

The `tc qdisc` install does not persist across reboots. Wrap the same `tc` calls in your own systemd unit, NetworkManager dispatch hook, or `ifupdown` post-up snippet — operator policy.

Removal: `sudo tc qdisc del dev enp1s0 root`.

### Step 2: confirm PTP discipline on the system clock

`SO_TXTIME` schedules transmission against `CLOCK_TAI`. Without `ptp4l` + `phc2sys` running, the kernel's TAI clock is just wall time + leap-second offset — sender and receiver drift relative to each other and the receiver's VRX bound fails. See [PTP integration](/edge/ptp/) for the full setup.

```bash
systemctl status ptp4l phc2sys
```

Both should be **active (running)**. The edge keeps emitting valid bytes without PTP, just not narrow-profile-aligned.

### Step 3: confirm the host advertises the capability

```bash
curl -k https://<edge>:8080/health | jq .capabilities
```

The list should include `"wire_pacing_txtime"`. The edge probes `setsockopt(SO_TXTIME)` once at startup; Linux ≥ 4.19 normally accepts. If absent, you're either on a too-old kernel, in a container without the right syscall permission, or on a non-Linux host. The manager UI hides the per-output `wire_pacing` knob automatically when this capability isn't advertised.

### Step 4: opt in per ST 2110-20 / -23 output

Add `wire_pacing` to the output config — either via the manager UI (the dropdown appears only when the capability above is present) or directly in JSON:

```json
{
  "type": "st2110_20",
  "id": "video-out-1",
  "wire_pacing": {
    "mode": "tx_time",
    "profile": "narrow"
  },
  ...
}
```

`profile` is one of `narrow` (default), `narrow_linear`, `wide`. Today's pacer treats all three as `narrow_linear` (even pacing across the active video period); classic gapped narrow is a follow-up if a specific receiver complains.

### What if any step is skipped?

| Skipped | Behaviour |
|---|---|
| Step 1 (no ETF qdisc) | `setsockopt(SO_TXTIME)` succeeds but the kernel's `pfifo_fast` queue ignores `SCM_TXTIME` — no actual pacing. Same observable behaviour as today's unpaced ST 2110 path; no regression, no narrow-profile compliance. |
| Step 2 (no PTP) | Pacer's TAI anchor is not GM-aligned. Output emits cleanly but VRX bound at the receiver may fail. |
| Step 3 (capability not advertised) | Edge can't accept the `wire_pacing` config — it logs a `wire_pacing_unavailable`-style WARN and the output falls back to plain `send_to`. |
| Step 4 (output not opted in) | ST 2110-20 / -23 sends as fast as the NIC accepts — the today-pre-wire-pacing default. Fine for dev / wide-profile receivers; fails narrow. |

For the architecture, full failure-mode matrix, and per-NIC notes, see [ST 2110](/edge/st2110/#st-2110-21-narrow-profile-pacing-uncompressed-video).

## Where to read next

- [Configuration reference](/edge/configuration/) — every input, output, and flow field.
- [ST 2110](/edge/st2110/) — uncompressed video / audio / ANC essence flows + narrow-profile pacing.
- [Display output](/edge/display/) — drive an HDMI / DisplayPort connector for confidence-monitor playout.
- [Replay](/edge/replay/) — continuous flow recording and clip playback.
- [Edge events and alarms](/edge/events-and-alarms/) — what shows up in `journalctl` and the manager events feed.
