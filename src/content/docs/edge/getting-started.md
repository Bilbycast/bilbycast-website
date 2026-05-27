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

## 1. Download

```bash
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux-full.tar.gz"
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux-full.tar.gz.sha256"
sha256sum -c "bilbycast-edge-$(uname -m)-linux-full.tar.gz.sha256"
tar xzf "bilbycast-edge-$(uname -m)-linux-full.tar.gz"
```

The tarball expands to a directory containing the `bilbycast-edge` binary, the licence files (`LICENSE`, `LICENSE.commercial`, `NOTICE`, `COPYING.GPL`), `README.md`, and a `packaging/` directory with optional systemd unit, sysusers config, ETF qdisc and PTP provisioning scripts, and the `install-edge.sh` one-shot installer.

The release binary is AGPL-3.0-or-later — a combined work bundling GPL-2.0-or-later libx264 / libx265 for software H.264 / H.265 transcoding. NVIDIA NVENC + NVDEC, Intel QSV (x86_64), and VAAPI are also compiled in; the runtime probe auto-detects which the host can actually open. See `NOTICE` inside the tarball for the full bundled-library inventory.

### Verify the Sigstore signature (optional)

Every release ships a Sigstore-signed `manifest.json` alongside the tarballs. The `sha256sum -c` step above catches mid-transfer corruption; verifying the signature additionally proves the manifest was published by the Bilbycast release workflow on a tagged commit, defending against a compromised GitHub release upload swapping the binary post-publish.

Install [cosign](https://github.com/sigstore/cosign) — on Ubuntu / Debian the simplest path is the upstream static binary with SHA-256 verification:

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

Then verify the manifest:

```bash
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/manifest.json"
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/manifest.sig.bundle"

cosign verify-blob \
  --bundle manifest.sig.bundle \
  --certificate-identity-regexp 'https://github.com/Bilbycast/bilbycast-edge/.github/workflows/nightly-release.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  manifest.json
```

A successful verify prints `Verified OK`. The verified `manifest.json` then carries the SHA-256 of every per-arch tarball — cross-check against your downloaded `.sha256` if you're being thorough. The same pipeline gates manager-driven [Remote Upgrade](/manager/remote-upgrade/) automatically, so verifying at first install is purely belt-and-suspenders.

## 2. Install runtime dependencies

The edge has no `ffmpeg` subprocess requirement — AAC, Opus, MP2, AC-3, video decode, JPEG thumbnail, and the local-display output are all in-process. The apt packages below back the local-display output (HDMI / DisplayPort + ALSA confidence monitor playout), the software video encoders, and PTP for ST 2110.

```bash
sudo apt update
sudo apt install libdrm2 libasound2t64 libudev1 libx264-dev libx265-dev libnuma1
```

On Ubuntu 22.04 / Debian 12 the ALSA package is plain `libasound2`; on Ubuntu 24.04+ it was renamed to `libasound2t64` (the `t64` time_t transition). Both ship the same `libasound.so.2` runtime — pick whichever your distro provides.

`libdrm2` / `libasound2t64` / `libudev1` are in every modern Linux base install — on a strictly headless box they cause no side effects (the edge simply doesn't advertise the `display` capability). The `libx264-dev` / `libx265-dev` metapackages depend on the matching runtime `.so` packages and pin the version the binary was built against. Substitute the versioned names (`libx264-164`, `libx265-199` on Ubuntu 24.04) if you want runtime-only.

**x86_64 only — Intel QuickSync (QSV):**

QSV uses Intel's oneVPL stack, which is a thin **dispatcher** plus a **GPU runtime backend** plus a **VAAPI driver**. All three components must be installed; the dispatcher alone contains no encoding code.

```bash
sudo apt update
sudo apt install libvpl2 libmfx-gen1.2 intel-media-va-driver-non-free
sudo usermod -aG render "$USER"   # log out + back in after this
```

| Package | Role |
| --- | --- |
| `libvpl2` | oneVPL dispatcher (`libvpl.so.2`) — what the bilbycast binary links against. |
| **`libmfx-gen1.2`** | Intel VPL **GPU runtime** (`libmfx-gen.so.1.2`) — the actual hardware encoder. **Most-commonly-missed package.** Without it the dispatcher returns `MFX_ERR_NOT_FOUND` and `h264_qsv` fails to open. |
| `intel-media-va-driver-non-free` | VAAPI driver (`iHD_drv_video.so`) used by `libmfx-gen` for some pixel-format conversions and zero-copy frame paths. The `intel-media-va-driver` package is the upstream open-source variant and is also acceptable. |

Verify after install:

```bash
ls /usr/lib/x86_64-linux-gnu/libmfx-gen.so.1.2     # must exist
ls /usr/lib/x86_64-linux-gnu/dri/iHD_drv_video.so  # must exist
ls /dev/dri/                                       # card* + renderD*
```

QSV needs a 5th-gen (Broadwell) Intel Core or newer for H.264; HEVC needs 7th-gen (Kaby Lake) or newer.

**NVIDIA NVENC:**

NVENC also uses a dispatcher-style architecture: bilbycast `dlopen`s `libnvidia-encode.so.1` and `libcuda.so.1`, both of which ship inside the NVIDIA proprietary driver. The Nouveau open-source driver does **not** expose NVENC.

```bash
# Ubuntu 22.04 / 24.04 — recommended branch (auto-detect):
sudo ubuntu-drivers autoinstall
# Or pin a specific branch (e.g. 580 LTS):
sudo apt install nvidia-driver-580          # workstation
sudo apt install nvidia-driver-580-server   # headless servers
sudo reboot
```

```bash
# Debian 12+ — non-free repo must be enabled:
sudo apt install nvidia-driver
sudo reboot
```

Verify after install:

```bash
nvidia-smi                                          # lists the GPU
ldconfig -p | grep -E 'libnvidia-encode|libcuda\.'  # both must appear
```

**Why the runtime libraries are mandatory.** Both NVENC and QSV are *dispatcher architectures*: the actual encoder kernels that program the GPU live in vendor-shipped runtime libraries (`libnvidia-encode.so.1` for NVENC, `libmfx-gen.so.1.2` for QSV). bilbycast cannot statically link them in — they are GPU-architecture-specific binaries Intel and NVIDIA distribute as part of their driver stacks, the same way every other QSV/NVENC consumer (OBS, FFmpeg CLI, GStreamer, HandBrake) requires them. If you skip the runtime install, hardware encoding fails at session creation; CPU encoding (`x264` / `x265`) keeps working because those libraries are statically linked into the binary.

## 3. Register the node in the manager

Before launching the edge, create its node entry in the manager:

1. Sign in to the manager UI.
2. **Admin → Nodes**, click **+ Add Node**.
3. Pick device type **Edge**, give it a name, click **Save**.
4. Copy the one-shot **registration token** the modal shows. You'll paste it into the setup wizard in the next step.

## 4. Run the edge — and finish setup in the browser

Inside the extracted tarball directory:

```bash
./bilbycast-edge --config config.json
```

The file doesn't have to exist yet — pointing `--config` at a path whose **parent directory exists** (the tarball directory, in this case) is enough. The edge starts with an empty in-memory config, generates a `node_id`, writes `config.json` itself, then waits for the wizard. (Pointing `--config` at a path with a missing parent directory fails immediately because the edge can't write its `.tmp` file there.)

Two things happen on first boot:

- The edge prints a **setup token** to stdout. Copy it down if you'll be using the wizard from a different machine — the LAN-side `/setup` form has a **Setup Token** field that requires this value. **Loopback callers** (`http://localhost:8080/setup` or `http://127.0.0.1:8080/setup`) bypass the token check entirely, so you only need it when reaching the wizard from a separate machine. If you missed the banner, re-print it without restarting the wizard:

  ```bash
  ./bilbycast-edge --config config.json --print-setup-token
  ```

  This prints the same token and exits; the persistent value stays valid until you complete registration with the manager.

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

## 5. Verify

What success looks like:

- The edge log shows `manager: connected`.
- The node appears in the manager dashboard at `/admin/nodes` with status **online** and a recent `last_seen`.
- The node detail page surfaces the **capabilities** the edge advertised (`replay`, `display`, `st2110-30`, …) and a **Resources** card with the per-host hardware probe.
- `curl http://localhost:8080/health` returns `{"status":"healthy"}`.

If the node doesn't show up, check the manager log for an `auth_failed` event under category `connection`.

## 6. Run as a service

The manual launch above is fine for testing. For production, install the edge as a systemd service so it survives reboots and crashes.

### Recommended: one-command install

From inside the extracted tarball directory:

```bash
sudo bash packaging/install-edge.sh \
  --manager wss://YOUR_MANAGER:8443/ws/node \
  --registration-token <token>
```

This single command handles everything: creates the `bilbycast` service user, lays out `/opt/bilbycast/edge/` with the `current` symlink, installs and enables the `bilbycast-edge.service` and `bilbycast-ptp.service` systemd units, installs `linuxptp` for PTP support, seeds the default PTP config, and starts the edge. Works on x86_64 and aarch64 Linux (Debian, Ubuntu, RHEL, Fedora — any systemd-based distro with `apt` or `dnf`).

After it finishes, the node should appear online in the manager UI within seconds.

### Alternative: manual step-by-step

If you prefer to lay each piece down by hand (or are on a non-standard distro where the script doesn't fit), the full manual walkthrough is at [Install edge as a Linux service](/edge/install-ubuntu-service/).

### Wire pacing

Wire pacing runs automatically on every UDP-socket-owning output (UDP, RTP, ST 2110-*, 302M). The default release tier is `clock_nanosleep` on a SCHED_FIFO thread — sub-3 ms PCR_AC max through 2 Gbps on commodity Linux, no qdisc / no PTP / no special NIC required. That covers VLC, ffplay, OBS, cloud receivers, and most professional decoders in standard tolerance mode. The kernel-paced `SO_TXTIME` upgrade (tier 1 — sub-µs PCR_AC) is opt-in via `BILBYCAST_ENABLE_TXTIME=1` and only worth enabling for ST 2110-21 narrow profile or T-STD-strict contribution receivers. Setup: [Install edge as a Linux service → ETF qdisc setup](/edge/install-ubuntu-service/#etf-qdisc-setup-opt-in-for-tier-1-pcr-accuracy-and-st-2110-21-narrow-profile); full reference [Wire-Time Precision](/edge/wire-pacing/).

## Where to read next

- [Your first flow](/getting-started/first-flow/) — point-and-click an SRT-to-RTP path through the manager UI.
- [Configuration reference](/edge/configuration/) — every input, output, and flow field.
- [ST 2110](/edge/st2110/) — uncompressed video / audio / ANC essence flows + narrow-profile pacing.
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
