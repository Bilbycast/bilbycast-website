---
title: Install an Edge Node
description: Download, install, and register a bilbycast-edge node with the manager.
sidebar:
  order: 2
---

An edge node is the box that actually moves your media — receives a stream on one protocol and re-emits it on another. This page covers everything from download to a running, registered node.

There are two install paths:

- **Production install** (recommended) — one command (`install-edge.sh`) that sets up the binary, systemd services, PTP support, and registers with the manager. No browser needed. Jump to [step 1](#1-download).
- **Dev / testing** — run the binary directly and register via a browser-based setup wizard. Jump to [dev / testing install](#dev--testing-install).

## What you'll need

- A Linux host (Ubuntu 24.04, Debian 12+, RHEL 9+, or any systemd-based distro). x86_64 and aarch64 builds are published.
- The manager already running and reachable on `wss://`. If you haven't done that yet, see [Install the manager](/manager/getting-started/).
- About 5 minutes.

---

## Production install

### 1. Download

```bash
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux-full.tar.gz"
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux-full.tar.gz.sha256"
sha256sum -c "bilbycast-edge-$(uname -m)-linux-full.tar.gz.sha256"
tar xzf "bilbycast-edge-$(uname -m)-linux-full.tar.gz"
cd bilbycast-edge-*
```

### 2. Create the node in the manager

1. Sign in to the manager UI.
2. **Admin → Nodes**, click **+ Add Node**.
3. Pick device type **Edge**, give it a name, click **Save**.
4. Copy the one-shot **registration token** the modal shows.

### 3. Install and register

From inside the extracted tarball directory:

```bash
sudo bash packaging/install-edge.sh \
  --manager wss://YOUR_MANAGER:8443/ws/node \
  --registration-token <token>
```

This single command does everything:

- Creates the `bilbycast` service user.
- Installs the binary under `/opt/bilbycast/edge/` with a `current` symlink (the layout the manager's remote-upgrade feature expects).
- Writes `config.json` and `secrets.json` with the manager URL and registration token.
- Installs `linuxptp` (`ptp4l`, `phc2sys`, `pmc`) for PTP / ST 2110 support.
- Installs and enables `bilbycast-ptp.service` (the PTP helper daemon, defaults to `mode=off`).
- Installs and enables `bilbycast-edge.service` (auto-starts on boot, auto-restarts on crash).
- Registers the node with the manager automatically — no setup wizard or browser needed.

Works on x86_64 and aarch64 Linux. Uses `apt` on Debian/Ubuntu or `dnf` on RHEL/Fedora.

**Optional flags:**

```bash
sudo bash packaging/install-edge.sh \
  --manager wss://YOUR_MANAGER:8443/ws/node \
  --registration-token <token> \
  --output-nics enp1s0           # enable SO_TXTIME wire pacing on this NIC
```

| Flag | Purpose |
|------|---------|
| `--output-nics <nic1,nic2>` | Enable kernel-paced wire emission (SO_TXTIME) on the listed NICs. Installs a boot-persistent ETF qdisc on each NIC and sets `BILBYCAST_ENABLE_TXTIME=1` in the environment file. Each NIC must have >= 3 hardware tx queues (validated). Omit to stay on the default `clock_nanosleep` tier — fine for most deployments. See [ETF qdisc setup](/edge/install-ubuntu-service/#etf-qdisc-setup-opt-in-for-tier-1-pcr-accuracy-and-st-2110-21-narrow-profile) for when you need this. |
| `--channel <name>` | Release channel (`stable` / `nightly` / `beta`). Default `stable`. |
| `--variant <name>` | Binary variant (`default` / `full`). Default `full` on Linux. |
| `--allow-insecure` | Allow connecting to a manager with a self-signed certificate. |
| `--upgrade-installer` | Refresh the service unit and install script without touching config or versions. |

If your manager uses a self-signed certificate:

```bash
sudo bash packaging/install-edge.sh \
  --manager wss://YOUR_MANAGER:8443/ws/node \
  --registration-token <token> \
  --allow-insecure
```

### 4. Verify

```bash
sudo systemctl status bilbycast-edge
sudo systemctl status bilbycast-ptp
```

Both should be **active (running)**. Then check the manager:

- The node appears at **Admin → Nodes** with status **online**.
- The node detail page shows the **capabilities** the edge advertised (`replay`, `display`, `st2110-30`, ...) and a **Resources** card with the hardware probe results.

If the node doesn't show up, check the manager log for an `auth_failed` event under category `connection`, or tail the edge journal:

```bash
sudo journalctl -u bilbycast-edge -f
```

### 5. Next steps

**PTP (for ST 2110 / MXL):** The installer already set up the PTP service — it's running but idle (`mode=off`). To enable it, open the manager UI's per-node **Time (PTP)** page, pick a mode (Auto / Grandmaster / Slave only), and click Apply. The change takes effect within ~1 second. No SSH needed. See [Time (PTP)](/edge/ptp/) for the full reference.

**Hardware video encoders (NVENC / QSV):** If you plan to use hardware video transcoding, install the vendor runtime libraries — see [Hardware encoder runtime](#hardware-encoder-runtime-nvenc--qsv) below.

**Wire pacing** runs automatically on every UDP output. The default tier handles compressed TS through 2 Gbps with sub-3 ms PCR accuracy — no extra setup needed. For sub-us pacing (ST 2110-21 narrow profile, T-STD-strict contribution decoders), pass `--output-nics <nic>` during install or follow the manual steps at [ETF qdisc setup](/edge/install-ubuntu-service/#etf-qdisc-setup-opt-in-for-tier-1-pcr-accuracy-and-st-2110-21-narrow-profile). Full reference: [Wire-Time Precision](/edge/wire-pacing/).

**Subsequent upgrades** can be driven from the manager UI (no SSH): **Admin → Nodes → Upgrade**. See [Remote Upgrade](/manager/remote-upgrade/). If remote upgrade isn't available, see [Manual upgrade](#manual-upgrade) below.

---

## Manual upgrade

Use this when the manager's remote upgrade isn't an option — the node is too old to have the upgrade module, the manager is unreachable, or something else is blocking the remote path.

### Prerequisites

The install script needs `jq` and `curl`:

```bash
# Debian / Ubuntu
sudo apt install -y jq curl

# RHEL / Fedora
sudo dnf install -y jq curl
```

### Run the upgrade

```bash
curl -fsSL https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/install-edge.sh \
  | sudo bash -s -- --upgrade-installer
```

This downloads the latest release, verifies the Sigstore signature, swaps the `current` symlink to the new version, and refreshes the systemd unit. Your existing `config.json` and `secrets.json` are not touched.

Then restart the service:

```bash
sudo systemctl daemon-reload
sudo systemctl restart bilbycast-edge
```

Verify:

```bash
/opt/bilbycast/edge/current/bilbycast-edge --version
sudo systemctl status bilbycast-edge
```

### Upgrading to a specific version

By default the script installs the latest stable release. To pin a version:

```bash
curl -fsSL https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/install-edge.sh \
  | sudo bash -s -- --upgrade-installer --target-version 0.92.1
```

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `jq is required but not installed` | Missing prerequisite | `sudo apt install -y jq` |
| Exit code 226/NAMESPACE after upgrade | The systemd unit has sandbox directives (`ProtectSystem`, `ProtectHome`, `PrivateTmp`, `LockPersonality`, `RestrictNamespaces`) that some kernels don't support (Raspberry Pi, minimal ARM boards, older kernels) | Strip the sandbox block: `sudo sed -i '/^ProtectSystem=/d; /^ReadWritePaths=/d; /^ProtectHome=/d; /^PrivateTmp=/d; /^LockPersonality=/d; /^RestrictNamespaces=/d' /etc/systemd/system/bilbycast-edge.service && sudo systemctl daemon-reload && sudo systemctl reset-failed bilbycast-edge && sudo systemctl start bilbycast-edge`. This is safe — the edge runs as an unprivileged user, which is the real security boundary. Newer versions of the install script ship a unit without these directives. |
| Service running but manager UI still shows old version | Service wasn't restarted after the symlink swap | `sudo systemctl restart bilbycast-edge` |
| Upgrade button missing in manager UI | Node predates the remote upgrade module (typically v0.58 and earlier) | Run the manual upgrade above. Once on a current version, the button appears and all future upgrades work from the UI. |

After a successful manual upgrade, all future upgrades can be done from the manager UI — see [Remote Upgrade](/manager/remote-upgrade/).

---

## Dev / testing install

Use this path when you want to test locally, don't need systemd, or want to use the browser-based setup wizard. This does **not** install PTP or systemd services — for production, use the [production install](#production-install) above.

### 1. Download

Same as the [production download step](#1-download) above.

### 2. Install runtime dependencies

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install libdrm2 libasound2t64 libudev1 libx264-dev libx265-dev libnuma1

# RHEL / Fedora
sudo dnf install libdrm alsa-lib systemd-libs x264-libs x265-libs numactl-libs
```

On Ubuntu 22.04 / Debian 12 the ALSA package is `libasound2` (not `libasound2t64`).

### 3. Create the node in the manager

Same as the [production step](#2-create-the-node-in-the-manager) above — create the node in the manager UI and copy the registration token.

### 4. Run the edge and complete the setup wizard

```bash
./bilbycast-edge --config config.json
```

The config file doesn't have to exist yet — the edge creates it. Two things happen on first boot:

- The edge prints a **setup token** to stdout (needed only when reaching the wizard from a different machine — loopback callers bypass it).
- The REST API and setup wizard come up on **port 8080**.

Open the wizard in a browser:

```
http://EDGE-IP:8080/setup
```

The wizard guides you through:

- **Device name** — appears in the manager UI.
- **Manager URL** — the `wss://` endpoint of your manager (e.g. `wss://manager.example.com:8443/ws/node`).
- **Registration token** — paste the value you copied from the manager.
- **Accept self-signed certificate** — tick this only if your manager uses a self-signed cert.

Click **Save**. The wizard writes `config.json` and `secrets.json`, registers the node with the manager, and auto-disables itself.

If you ticked the self-signed-cert option, also set `BILBYCAST_ALLOW_INSECURE=1` before re-launching:

```bash
BILBYCAST_ALLOW_INSECURE=1 ./bilbycast-edge --config config.json
```

### 5. Verify

- The edge log shows `manager: connected`.
- The node appears online in the manager at **Admin → Nodes**.
- `curl http://localhost:8080/health` returns `{"status":"healthy"}`.

### Moving to production later

When you're ready to move this node to production, run `install-edge.sh` from the [production install](#3-install-and-register) — it will pick up your existing `config.json` and `secrets.json` and install the systemd services around them.

---

## Hardware encoder runtime (NVENC / QSV)

The `*-full` binary compiles in NVENC and QSV bridges, but the actual GPU encoder runs in vendor-shipped runtime libraries. If you only use software encoders (`x264` / `x265`), skip this section.

**x86_64 only — Intel QuickSync (QSV):**

```bash
sudo apt update
sudo apt install libvpl2 libmfx-gen1.2 intel-media-va-driver-non-free
sudo usermod -aG render bilbycast    # service user needs /dev/dri/renderD* access
```

| Package | Role |
| --- | --- |
| `libvpl2` | oneVPL dispatcher (`libvpl.so.2`). |
| **`libmfx-gen1.2`** | Intel VPL **GPU runtime** — the actual encoder. **Most-commonly-missed package.** |
| `intel-media-va-driver-non-free` | VAAPI driver (`iHD_drv_video.so`). |

QSV needs Broadwell (5th gen) for H.264; HEVC needs Kaby Lake (7th gen) or newer.

**NVIDIA NVENC:**

```bash
# Ubuntu 22.04 / 24.04:
sudo ubuntu-drivers autoinstall
sudo reboot

# Debian 12+:
sudo apt install nvidia-driver
sudo reboot
```

Verify:

```bash
sudo -u bilbycast nvidia-smi          # NVENC: must list the GPU
ls -l /dev/dri/                       # QSV: renderD128 must be readable by bilbycast
```

---

## Verify the Sigstore signature (optional)

Every release ships a Sigstore-signed `manifest.json`. The `sha256sum -c` step catches corruption; verifying the signature proves the manifest was published by the Bilbycast release workflow.

Install [cosign](https://github.com/sigstore/cosign):

```bash
COSIGN_VERSION=v2.4.1
case "$(uname -m)" in
    x86_64)  COSIGN_ARCH=amd64 ;;
    aarch64) COSIGN_ARCH=arm64 ;;
    *) echo "Unsupported architecture: $(uname -m)"; exit 1 ;;
esac
COSIGN_ASSET="cosign-linux-${COSIGN_ARCH}"
curl -fsSL -o /tmp/cosign \
  "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/${COSIGN_ASSET}"
expected="$(curl -fsSL "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign_checksums.txt" | awk -v a="${COSIGN_ASSET}" '$2 == a {print $1}')"
got="$(sha256sum /tmp/cosign | awk '{print $1}')"
[[ -n "${expected}" && "${got}" == "${expected}" ]] || { echo "cosign checksum mismatch"; exit 1; }
sudo install -m 0755 /tmp/cosign /usr/local/bin/cosign && rm /tmp/cosign
```

Then verify:

```bash
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/manifest.json"
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/manifest.sig.bundle"

cosign verify-blob \
  --bundle manifest.sig.bundle \
  --certificate-identity-regexp 'https://github.com/Bilbycast/bilbycast-edge/.github/workflows/nightly-release.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  manifest.json
```

---

## Where to read next

- [Your first flow](/getting-started/first-flow/) — point-and-click an SRT-to-RTP path through the manager UI.
- [Install edge as a Linux service](/edge/install-ubuntu-service/) — manual step-by-step alternative to `install-edge.sh`.
- [Time (PTP)](/edge/ptp/) — configure PTP mode from the manager UI.
- [Configuration reference](/edge/configuration/) — every input, output, and flow field.
- [ST 2110](/edge/st2110/) — uncompressed video / audio / ANC essence flows.
- [Display output](/edge/display/) — local HDMI / DisplayPort confidence-monitor playout.
- [Replay](/edge/replay/) — continuous flow recording and clip playback.
- [Setup wizard](/edge/setup-wizard/) — full reference for the `/setup` page.

<details>
<summary>Advanced — manual config without the wizard</summary>

If you'd rather skip both `install-edge.sh` and the wizard and write the config files by hand:

`config.json`:

```json
{
  "version": 2,
  "server": { "listen_addr": "0.0.0.0", "listen_port": 8080 },
  "manager": {
    "enabled": true,
    "urls": ["wss://manager.example.com:8443/ws/node"]
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

For a self-signed manager cert, add `"accept_self_signed_cert": true` inside the `manager` block **and** export `BILBYCAST_ALLOW_INSECURE=1`.

CLI flags:

| Flag | Purpose |
|------|---------|
| `-c, --config <PATH>` | Path to config (default `./config.json`) |
| `-p, --port <PORT>` | Override REST API listen port |
| `-b, --bind <ADDR>` | Override REST API listen address |
| `--monitor-port <PORT>` | Override embedded dashboard port (default 9090) |
| `-l, --log-level <LEVEL>` | `trace` / `debug` / `info` / `warn` / `error` |
| `--print-setup-token` | Print the first-boot setup token without launching |

Environment variables:

| Variable | Purpose |
|----------|---------|
| `BILBYCAST_ALLOW_INSECURE=1` | Required to honour `accept_self_signed_cert: true` |
| `BILBYCAST_REPLAY_DIR` | Storage root for replay recordings |
| `BILBYCAST_MEDIA_DIR` | Media-player library directory (4 GiB per file, 16 GiB total) |
| `RUST_LOG=info` | Log level (also configurable via `--log-level`) |

</details>
