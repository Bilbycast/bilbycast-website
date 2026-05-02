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

**Upgrade to a new release:**

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

## Where to read next

- [Configuration reference](/edge/configuration/) — every input, output, and flow field.
- [Display output](/edge/display/) — drive an HDMI / DisplayPort connector for confidence-monitor playout.
- [Replay](/edge/replay/) — continuous flow recording and clip playback.
- [Edge events and alarms](/edge/events-and-alarms/) — what shows up in `journalctl` and the manager events feed.
