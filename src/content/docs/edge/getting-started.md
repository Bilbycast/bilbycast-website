---
title: Install an Edge Node
description: Download, install, and register a bilbycast-edge node with the manager.
sidebar:
  order: 2
---

An edge node is the box that actually moves your media — receives a stream on one protocol and re-emits it on another. Each edge registers itself with the manager via a **browser-based setup wizard**, so you don't hand-edit JSON config files unless you want to.

## What you'll need

- A Linux host (Ubuntu 24.04 or Debian 12+ recommended). The binary is dynamically linked against glibc 2.39+ so it can use the optional video encoders and the local-display output.
- The manager already running and reachable on `wss://`. If you haven't done that yet, see [Install the manager](/manager/getting-started/).
- About 10 minutes.

`x86_64` and `aarch64` builds are published.

## 1. Pick a variant

Each release ships in **two variants** per architecture:

| Tarball | Includes | Binary licence |
|---------|----------|----------------|
| `bilbycast-edge-$(uname -m)-linux.tar.gz` | Default — pass-through plus AAC, Opus, MP2, AC-3, JPEG, video decode and thumbnails. **No software video encoders.** | AGPL-3.0-or-later |
| `bilbycast-edge-$(uname -m)-linux-full.tar.gz` | Adds **libx264 + libx265 + NVENC** software/hardware video transcoding (plus QSV on x86_64) | AGPL-3.0-or-later combined work bundling GPL-2.0-or-later libx264 / libx265 (see `NOTICE` inside the tarball) |

Pick **default** if you only need to bridge protocols (SRT in, RTP out, etc.) — smaller download, AGPL-only. Pick **full** if you need to transcode H.264 / H.265.

## 2. Download

**Default variant:**

```bash
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux.tar.gz"
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux.tar.gz.sha256"
sha256sum -c "bilbycast-edge-$(uname -m)-linux.tar.gz.sha256"
tar xzf "bilbycast-edge-$(uname -m)-linux.tar.gz"
```

**Full variant:**

```bash
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux-full.tar.gz"
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux-full.tar.gz.sha256"
sha256sum -c "bilbycast-edge-$(uname -m)-linux-full.tar.gz.sha256"
tar xzf "bilbycast-edge-$(uname -m)-linux-full.tar.gz"
```

Each tarball expands to a directory containing `bilbycast-edge`, the licence files, a `README.md`, and `config_examples/` with a starter config.

## 3. Install runtime dependencies

The edge has no `ffmpeg` subprocess requirement — AAC, Opus, MP2, AC-3, video decode, JPEG thumbnail, and the local-display output are all in-process. The apt packages below back the local-display output (HDMI / DisplayPort + ALSA confidence monitor playout), the optional video encoders, and PTP for ST 2110.

**Default variant — runtime:**

```bash
sudo apt update
sudo apt install libdrm2 libasound2t64 libudev1
```

On Ubuntu 22.04 / Debian 12 the ALSA package is plain `libasound2`; on Ubuntu 24.04+ it was renamed to `libasound2t64` (the `t64` time_t transition). Both ship the same `libasound.so.2` runtime — pick whichever your distro provides.

These three packages are in every modern Linux base install. On a strictly headless box they cause no side effects — the edge simply doesn't advertise the `display` capability.

**Full variant — runtime (in addition to the above):**

```bash
sudo apt update
sudo apt install libx264-dev libx265-dev libnuma1
```

The `-dev` metapackages depend on the matching runtime `.so` packages and pin the version the binary was built against. Substitute the versioned names (`libx264-164`, `libx265-199` on Ubuntu 24.04) if you want runtime-only.

**x86_64 only — Intel QuickSync (QSV):**

```bash
sudo apt update
sudo apt install libvpl2 intel-media-va-driver-non-free
sudo usermod -aG render "$USER"   # log out + back in after this
```

QSV needs a 5th-gen (Broadwell) Intel Core or newer for H.264; HEVC needs 7th-gen (Kaby Lake) or newer.

**NVIDIA NVENC:** no apt packages required. The binary `dlopen`s `libnvidia-encode.so.1`, which ships with the proprietary NVIDIA driver. Install via your distribution's standard mechanism (e.g. `nvidia-driver-550` on Ubuntu) and reboot.

## 4. Register the node in the manager

Before launching the edge, create its node entry in the manager:

1. Sign in to the manager UI.
2. **Admin → Nodes**, click **+ Add Node**.
3. Pick device type **Edge**, give it a name, click **Save**.
4. Copy the one-shot **registration token** the modal shows. You'll paste it into the setup wizard in the next step.

## 5. Run the edge — and finish setup in the browser

Inside the extracted tarball directory:

```bash
./bilbycast-edge --config config_examples/minimal.json
```

Two things happen on first boot:

- The edge prints a **setup token** to stdout. Copy it down if you'll be using the wizard from a different machine — from the local console (`http://localhost:8080/setup`) the wizard accepts requests directly without it.
- The REST API and setup wizard come up on **port 8080**.

Open the wizard:

```
http://EDGE-IP:8080/setup
```

The wizard guides you through:

- **Device name** — appears in the manager UI.
- **Manager URL** — the `wss://` endpoint of your manager (e.g. `wss://manager.example.com:8443/ws/node`).
- **Registration token** — paste the value you copied from the manager.
- **Accept self-signed certificate** — tick this only if your manager uses a self-signed cert (lab / on-prem with no public DNS).

Click **Save**. The wizard writes `config.json` and `secrets.json` for you, registers the node with the manager, and **auto-disables itself** — `/setup` returns a "wizard disabled" page on every subsequent boot.

If you ticked the self-signed-cert option, also export `BILBYCAST_ALLOW_INSECURE=1` before re-launching the edge — the env var is a deliberate safety guard so the cert check can't be skipped by accident in production.

## 6. Verify

What success looks like:

- The edge log shows `manager: connected`.
- The node appears in the manager dashboard at `/admin/nodes` with status **online** and a recent `last_seen`.
- The node detail page surfaces the **capabilities** the edge advertised (`replay`, `display`, `st2110-30`, …) and a **Resources** card with the per-host hardware probe.
- `curl http://localhost:8080/health` returns `{"status":"healthy"}`.

If the node doesn't show up, check the manager log for an `auth_failed` event under category `connection`.

## 7. Run as a service

The manual launch above is fine for testing. For production, install the edge as a systemd service so it survives reboots and crashes — see [Install edge as an Ubuntu service](/edge/install-ubuntu-service/).

## Where to read next

- [Your first flow](/getting-started/first-flow/) — point-and-click an SRT-to-RTP path through the manager UI.
- [Configuration reference](/edge/configuration/) — every input, output, and flow field.
- [Display output](/edge/display/) — drive a local HDMI / DisplayPort connector for confidence-monitor playout.
- [Replay](/edge/replay/) — continuous flow recording and clip playback.
- [Setup wizard](/edge/setup-wizard/) — full reference for the `/setup` page, including how to re-enable it for re-registration.

<details>
<summary>Advanced — manual config without the wizard</summary>

If you'd rather skip the wizard and write the config files by hand, create two files next to the binary:

`config.json`:

```json
{
  "version": 2,
  "server": { "listen_addr": "0.0.0.0", "listen_port": 8080 },
  "manager": {
    "enabled": true,
    "url": "wss://manager.example.com:8443/ws/node"
  },
  "inputs": [],
  "outputs": [],
  "flows": []
}
```

`secrets.json` (must be `chmod 600`):

```json
{
  "version": 2,
  "manager_registration_token": "<token-from-manager>"
}
```

```bash
chmod 600 secrets.json
./bilbycast-edge --config config.json
```

For a self-signed manager cert, add `"accept_self_signed_cert": true` inside the `manager` block **and** export `BILBYCAST_ALLOW_INSECURE=1` before launching.

If you only want to confirm the binary launches without attaching to a manager at all, drop the `manager` block entirely and run with empty `inputs` / `outputs` / `flows` arrays. The edge will start in standalone mode and expose its REST API on `:8080`.

CLI flags worth knowing:

| Flag | Purpose |
|------|---------|
| `-c, --config <PATH>` | Path to config (default `./config.json`) |
| `-p, --port <PORT>` | Override REST API listen port |
| `-b, --bind <ADDR>` | Override REST API listen address |
| `--monitor-port <PORT>` | Override embedded dashboard port (default 9090) |
| `-l, --log-level <LEVEL>` | `trace` / `debug` / `info` / `warn` / `error` |
| `--print-setup-token` | Print the first-boot setup token without launching |

Useful environment variables:

| Variable | Purpose |
|----------|---------|
| `BILBYCAST_ALLOW_INSECURE=1` | Required to honour `accept_self_signed_cert: true` (safety guard) |
| `BILBYCAST_REPLAY_DIR=/var/lib/bilbycast/replay` | Storage root for the replay-server (recordings + clip metadata) |
| `BILBYCAST_MEDIA_DIR=/var/lib/bilbycast/media` | Media-player library directory (4 GiB per file, 16 GiB total) |
| `RUST_LOG=info` | Log level (also configurable via `--log-level`) |

</details>
