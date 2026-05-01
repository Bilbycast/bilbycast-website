---
title: Deployment Guide
description: Step-by-step deployment of the full bilbycast stack.
sidebar:
  order: 2
---

This guide covers deploying the full bilbycast stack: manager, relay, and edge nodes.

## Download Pre-built Binaries

Pre-built Linux binaries are available for x86_64 and aarch64 (ARM64). The relay, manager, and Appear X gateway are statically linked against musl and have no runtime dependencies. The **edge** is built dynamically against glibc on Ubuntu 24.04 (so it can link the optional video encoder + display libraries) — see [Optional system dependencies for the edge](#optional-system-dependencies-for-the-edge) below for the runtime packages each variant needs.

All download URLs below use GitHub's `releases/latest/download/` redirect, so they always resolve to the most recent published release.

### Edge (Media Gateway)

The edge ships in **two variants** per architecture on every release:

| Tarball                                       | Includes                                            | Binary licence                                        |
|-----------------------------------------------|-----------------------------------------------------|-------------------------------------------------------|
| `bilbycast-edge-$(uname -m)-linux.tar.gz`      | Default — no software video encoders                | AGPL-3.0-or-later                                     |
| `bilbycast-edge-$(uname -m)-linux-full.tar.gz` | x264 + x265 + NVENC (+ QSV on x86_64)               | AGPL-3.0-or-later combined work bundling GPL-2.0-or-later libx264 / libx265 (see `NOTICE` inside the tarball) |

`$(uname -m)` auto-detects the host architecture (`x86_64` or `aarch64`).

**Default variant** — pass-through only, no software transcoding (smaller download, AGPL-only):

```bash
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux.tar.gz"
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux.tar.gz.sha256"
sha256sum -c "bilbycast-edge-$(uname -m)-linux.tar.gz.sha256"
tar xzf "bilbycast-edge-$(uname -m)-linux.tar.gz"
```

**Full variant** — bundles libx264 + libx265 + NVENC (+ QSV on x86_64) for in-process H.264 / H.265 transcoding (AGPL-3.0-or-later combined work with GPL-2.0-or-later libx264 / libx265):

```bash
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux-full.tar.gz"
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-edge/releases/latest/download/bilbycast-edge-$(uname -m)-linux-full.tar.gz.sha256"
sha256sum -c "bilbycast-edge-$(uname -m)-linux-full.tar.gz.sha256"
tar xzf "bilbycast-edge-$(uname -m)-linux-full.tar.gz"
```

Each tarball expands to a directory containing `bilbycast-edge`, `LICENSE`, `LICENSE.commercial`, `NOTICE` (plus `COPYING.GPL` for the full variant), `README.md`, and `config_examples/`. Remember to install the runtime apt packages from [Optional system dependencies for the edge](#optional-system-dependencies-for-the-edge) before running the binary — the full variant needs `libx264-dev libx265-dev libnuma1` (and `libvpl2 intel-media-va-driver-non-free` for QSV on x86_64); the default variant only needs the baseline `libdrm2 libasound2 libudev1`.

### Relay (NAT Traversal)

```bash
curl -fsSL -o bilbycast-relay \
  https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/bilbycast-relay-$(uname -m)-linux
chmod +x bilbycast-relay
```

Verify checksum:
```bash
curl -fsSL -o bilbycast-relay.sha256 \
  https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/bilbycast-relay-$(uname -m)-linux.sha256
sha256sum -c bilbycast-relay.sha256
```

### Manager (Control Plane)

The manager is distributed as a tarball containing the binary, database migrations, and default configuration. Currently available for x86_64 only.

```bash
curl -fsSL -o bilbycast-manager.tar.gz \
  https://github.com/Bilbycast/bilbycast-manager/releases/latest/download/bilbycast-manager-x86_64-linux.tar.gz
tar xzf bilbycast-manager.tar.gz
```

Verify checksum:
```bash
curl -fsSL -o bilbycast-manager.tar.gz.sha256 \
  https://github.com/Bilbycast/bilbycast-manager/releases/latest/download/bilbycast-manager-x86_64-linux.tar.gz.sha256
sha256sum -c bilbycast-manager.tar.gz.sha256
```

### Appear X API Gateway

```bash
curl -fsSL -o bilbycast-appear-x-api-gateway \
  https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/releases/latest/download/bilbycast-appear-x-api-gateway-$(uname -m)-linux
chmod +x bilbycast-appear-x-api-gateway
```

Verify checksum:
```bash
curl -fsSL -o bilbycast-appear-x-api-gateway.sha256 \
  https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/releases/latest/download/bilbycast-appear-x-api-gateway-$(uname -m)-linux.sha256
sha256sum -c bilbycast-appear-x-api-gateway.sha256
```

## Build from Source (Alternative)

The edge has several path-dependency sibling crates that must be present in the same parent directory before it can compile. Clone everything first:

```bash
git clone https://github.com/Bilbycast/bilbycast-libsrt-rs.git           # default SRT backend
git clone https://github.com/Bilbycast/bilbycast-fdk-aac-rs.git --recurse-submodules
git clone https://github.com/Bilbycast/bilbycast-ffmpeg-video-rs.git --recurse-submodules
git clone https://github.com/Bilbycast/bilbycast-rist.git
git clone https://github.com/Bilbycast/bilbycast-bonding.git
git clone https://github.com/Bilbycast/bilbycast-edge.git
git clone https://github.com/Bilbycast/bilbycast-manager.git
git clone https://github.com/Bilbycast/bilbycast-relay.git
```

Install the build-time apt packages (Linux):

```bash
sudo apt update
sudo apt install build-essential cmake make clang libclang-dev pkg-config \
                 libssl-dev g++ libdrm-dev libasound2-dev libudev-dev
# For the edge `*-linux-full` variant:
sudo apt install libx264-dev libx265-dev libnuma-dev
# x86_64 only (QSV):
sudo apt install libvpl-dev
```

Install the Rust toolchain via [rustup.rs](https://rustup.rs/), then build:

```bash
# Edge (default — AGPL-only, no software video encoders)
cd bilbycast-edge && cargo build --release && cd ..
# OR edge full (matches the *-linux-full release)
cd bilbycast-edge && cargo build --release --features video-encoders-full && cd ..

# Manager (requires Postgres at runtime — see below)
cd bilbycast-manager && cargo build --release && cd ..

# Relay
cd bilbycast-relay && cargo build --release && cd ..
```

Cargo resolves `bilbycast-libsrt-rs`, `bilbycast-fdk-aac-rs`, `bilbycast-ffmpeg-video-rs`, `bilbycast-rist`, and `bilbycast-bonding` automatically via the path-dependency entries in `bilbycast-edge/Cargo.toml`.

## 1. Deploy the Manager

The manager is the central control plane and depends on **Postgres 18**. Deploy it first; edges and relays connect outbound to it once it is online.

The downloaded tarball expands to a directory containing:

```
bilbycast-manager-<version>/
├── bilbycast-manager           # binary
├── migrations-pg/              # Postgres 18 migrations (applied automatically on first serve)
└── config/default.toml         # default configuration
```

### Prerequisite: Postgres 18

The manager needs a reachable Postgres 18 cluster. Two options:

**Option A — Docker (easiest for evaluation):**

```bash
# Inside the bilbycast-manager source tree:
docker compose -f docker-compose.dev.yml up -d
# Brings up Postgres 18 on localhost:5433 with the default DSN
# postgres://bilbycast:bilbycast_dev@localhost:5433/bilbycast
```

**Option B — Existing Postgres 18 cluster (production):**

```bash
sudo -u postgres createuser --pwprompt bilbycast
sudo -u postgres createdb -O bilbycast bilbycast
# Then point the manager at it via BILBYCAST_DATABASE_URL (see below)
```

### Easiest path — guided install via `bilbycast-manager init`

The manager binary ships an `init` subcommand that probes Postgres, generates `BILBYCAST_MASTER_KEY` + `BILBYCAST_JWT_SECRET` via the OS CSPRNG, generates a self-signed TLS cert under `/etc/bilbycast-manager/tls/`, writes `/etc/bilbycast-manager/manager.env` (0640), and writes a systemd unit stub to `/etc/bilbycast-manager/bilbycast-manager.service`. Use `--mode solo` for a single-instance deployment:

```bash
cd bilbycast-manager-<version>
sudo ./bilbycast-manager init \
  --mode solo \
  --database-url 'postgres://bilbycast:<password>@localhost:5432/bilbycast'

# Inspect the generated unit, then install + enable it:
sudo install -m 0644 /etc/bilbycast-manager/bilbycast-manager.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bilbycast-manager
```

`init` does **not** call `systemctl` itself — you install the unit explicitly so you can review it first. On first `serve`, the manager applies every migration in `migrations-pg/` automatically.

For active/active HA installs (`--mode ha-primary` / `--mode ha-standby`), see the operator runbook in the source tree at `bilbycast-manager/installer/README.md`.

### Manual path — step-by-step

If you don't want the `init` flow, set the same secrets and run `setup` + `serve` by hand:

```bash
cd bilbycast-manager-<version>

# 1. Required secrets (export them or put them in a 0600 .env file)
export BILBYCAST_JWT_SECRET=$(openssl rand -hex 32)
export BILBYCAST_MASTER_KEY=$(openssl rand -hex 32)

# 2. Optional — point at an external Postgres (default targets localhost:5433)
export BILBYCAST_DATABASE_URL='postgres://bilbycast:<password>@db.internal:5432/bilbycast'

# 3. TLS — pick exactly one of the three options in "TLS Configuration" below

# 4. Apply migrations and create the first super_admin user (interactive)
./bilbycast-manager setup --config config/default.toml
# Prompts: username, password, display name, email
# (or pass --non-interactive --admin-username … --admin-password … --admin-display-name … --admin-email …)

# 5. Start the server (foreground)
./bilbycast-manager serve --config config/default.toml
```

The manager listens on **port 8443** (HTTPS) by default — override with `BILBYCAST_PORT` or `--port`.

### TLS Configuration

Pick one of the three modes by exporting environment variables before `serve`. The same vars work in the `init`-generated `manager.env` file.

**ACME / Let's Encrypt (recommended for production):** the manager auto-provisions and renews the certificate. Requires port 80 reachable from the internet for HTTP-01 validation; private keys are generated on-server and never leave it.

```bash
export BILBYCAST_ACME_ENABLED=true
export BILBYCAST_ACME_DOMAIN=manager.example.com
export BILBYCAST_ACME_EMAIL=admin@example.com
```

**File-based certificates:**

```bash
export BILBYCAST_TLS_CERT=/etc/bilbycast-manager/tls/server.crt
export BILBYCAST_TLS_KEY=/etc/bilbycast-manager/tls/server.key
```

**Behind a load balancer (LB terminates TLS):**

```bash
export BILBYCAST_TLS_MODE=behind_proxy
# If you set this, you MUST also set the trust-proxy headers, otherwise login
# rate limiting will be controllable by the client. See the manager TLS docs.
export BILBYCAST_TRUST_PROXY_HEADER=1
export BILBYCAST_TRUSTED_PROXIES=10.0.0.0/8           # adjust for your LB subnet
```

### First login

Open `https://<manager-host>:8443/` in a browser and sign in with the super_admin credentials you created in step 4 (or were prompted for during `init`). For self-signed certs the browser will warn — accept once for your local box. From the UI you can now:

- **Add nodes** at `/admin/nodes` — each issues a one-shot **registration token**. Copy the token; you'll paste it into the edge / relay / sidecar config below.
- **Create groups** at `/admin/groups` (Multi-tenant Groups, optional).
- **Apply a license** at `/admin/license` (free tier: up to a small number of nodes; HA / SSO / Backup are paid features — contact `contact@bilbycast.com`).

## 2. Deploy the Relay

The relay is a stateless QUIC forwarder for NAT traversal between edges. It needs no configuration for basic operation; binding addresses default to `0.0.0.0:4433` (QUIC) and `0.0.0.0:4480` (REST API). Skip this component entirely if your edges can reach each other directly.

**Zero-config standalone:**

```bash
./bilbycast-relay
# Override binds via flags if needed:
./bilbycast-relay --quic-addr 0.0.0.0:4433 --api-addr 0.0.0.0:4480
```

**Attached to the manager (recommended for production):** create a node entry in the manager UI at `/admin/nodes` (device type: **relay**), copy the registration token, then write `relay.json` next to the binary:

```json
{
  "quic_addr": "0.0.0.0:4433",
  "api_addr": "0.0.0.0:4480",
  "require_bind_auth": true,
  "manager": {
    "enabled": true,
    "url": "wss://manager.example.com:8443/ws/node",
    "registration_token": "<token-from-manager>"
  }
}
```

Launch with `--config`:

```bash
./bilbycast-relay --config relay.json
```

For a self-signed manager cert, add `"accept_self_signed_cert": true` inside the `manager` block **and** export `BILBYCAST_ALLOW_INSECURE=1` before launching.

On first connect the relay swaps the registration token for a permanent `node_id` + `node_secret`, persists them locally, and reconnects on its own going forward.

## 3. Deploy Edge Nodes

### Optional system dependencies for the edge

The edge is dynamically linked against glibc 2.39+ (Ubuntu 24.04 / Debian 12+). Thumbnail generation, AAC, Opus, MP2, and AC-3 audio encoding are all done **in-process** by default — there is no `ffmpeg` subprocess and no `ffmpeg` binary requirement. The packages below cover the local-display output (which is on by default in every release variant), the optional video encoders bundled into the `*-linux-full` variant, and PTP for ST 2110 essence flows.

#### Default variant (`*-linux`) — runtime

```bash
sudo apt install libdrm2 libasound2 libudev1
```

These three are part of every modern Linux base install and back the local-display output (HDMI / DisplayPort + ALSA confidence monitor playout). On a strictly headless box they cause no side effects — the edge simply doesn't advertise the `display` capability.

#### Full variant (`*-linux-full`) — runtime

Everything from the default variant, plus libx264 + libx265 for software transcoding:

```bash
sudo apt install libx264-dev libx265-dev libnuma1
```

The `-dev` metapackages depend on the matching runtime `.so` packages and pin the version the binary was built against. Substitute the versioned names (`libx264-164`, `libx265-199` on Ubuntu 24.04) if you want runtime-only.

**x86_64 only — Intel QuickSync (QSV):**

```bash
sudo apt install libvpl2 intel-media-va-driver-non-free   # or intel-media-driver
sudo usermod -aG render "$USER"                           # log out + back in
```

QSV needs a 5th-gen (Broadwell) or newer Intel Core CPU for H.264; HEVC needs 7th-gen (Kaby Lake) or newer. The `*-aarch64-linux-full` build does not include QSV — Intel iGPU is x86_64-only.

**NVIDIA NVENC (any architecture, both variants ignore it if no driver):**

No apt packages required. The binary `dlopen`s `libnvidia-encode.so.1`, which ships with the proprietary NVIDIA driver — install via your distribution's standard mechanism (e.g. `nvidia-driver-550` on Ubuntu) and reboot.

#### PTP — only for ST 2110-30 / -31 / -40 essence flows

| Tool | Required for | Without it |
|---|---|---|
| `linuxptp` (`ptp4l`) | SMPTE ST 2110-30 / -31 / -40 essence flows that need PTP timing. The edge polls `ptp4l`'s management socket (default `/var/run/ptp4l`) — it does **not** run a PTP slave in-process. See [PTP Integration](/edge/ptp/) for the operational details. | Any flow with `clock_domain` set still starts, but reports `ptp_state: "unavailable"` and the NMOS IS-04 `/self` clock resource shows `locked: false`. Receivers that require PTP lock will reject connections. Skip entirely if you're not running ST 2110 essence flows — `rtp_audio`, SRT, RTP/MP2T, RTMP, RTSP, HLS, WebRTC, and the `audio_302m` transport mode have no PTP requirement. |

```bash
sudo apt install linuxptp        # Debian / Ubuntu
sudo dnf install linuxptp        # RHEL / Fedora
```

If you're running ST 2110, also configure `ptp4l` with your domain and NIC, then start it as a systemd service. A worked example is in [PTP Integration](/edge/ptp/#wiring-it-up).

For the full per-package matrix (including building from source), see the edge installation guide shipped at `bilbycast-edge/docs/installation.md`.

### Configure the edge

Create a node entry in the manager UI at `/admin/nodes` (device type: **edge**) and copy the registration token. Then write two files next to the extracted `bilbycast-edge` binary. Config v2 has independent top-level `inputs`, `outputs`, and `flows` arrays — flows reference inputs and outputs by ID.

**config.json:**
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

**secrets.json** (must be `chmod 600`):
```json
{
  "version": 2,
  "manager_registration_token": "<token-from-manager>"
}
```

```bash
chmod 600 secrets.json
```

For a self-signed manager certificate (lab / on-prem with no public DNS), add `"accept_self_signed_cert": true` inside the `manager` block **and** export `BILBYCAST_ALLOW_INSECURE=1` before launching the edge — the env var is a deliberate safety guard that prevents the field being honoured by accident in production.

If you only want to confirm the binary launches without attaching to a manager, drop the `manager` block entirely and run with empty `inputs`, `outputs`, `flows` arrays — the edge will start in standalone mode and expose its REST API on `:8080`.

### Start the edge

```bash
./bilbycast-edge --config config.json
```

What success looks like on first boot:

- The first-boot setup-token banner appears once on stdout — copy it down if you plan to use the browser setup wizard from a non-loopback machine. Re-print later with `./bilbycast-edge --config config.json --print-setup-token`.
- The edge connects to the manager (look for `manager: connected` in the log). On first connect it exchanges the registration token for a permanent `node_id` + `node_secret`, persists them into `config.json` + `secrets.json`, and clears the registration token — every subsequent restart reconnects automatically.
- The node appears in the manager dashboard at `/admin/nodes` and starts streaming stats / health. If it doesn't, watch the manager log for an auth-failure event under category `connection`.
- `curl http://localhost:8080/health` should return `{"status":"healthy"}`.

CLI flags (`./bilbycast-edge --help`):

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
| `BILBYCAST_REPLAY_DIR=/var/lib/bilbycast/replay` | Storage root for the replay-server (recordings + clip metadata). Defaults to XDG → `$HOME/.bilbycast/replay/` → `./replay/` |
| `BILBYCAST_MEDIA_DIR=/var/lib/bilbycast/media` | Media-player library directory. Defaults to XDG → `$HOME/.bilbycast/media/` → `./media/`. 4 GiB per file, 16 GiB total |
| `RUST_LOG=info` | Log level (also configurable via `--log-level`) |

#### systemd unit (production)

Drop into `/etc/systemd/system/bilbycast-edge.service`, then `systemctl daemon-reload && systemctl enable --now bilbycast-edge`:

```ini
[Unit]
Description=bilbycast-edge media transport gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bilbycast
Group=bilbycast
WorkingDirectory=/opt/bilbycast-edge
ExecStart=/opt/bilbycast-edge/bilbycast-edge --config /etc/bilbycast/edge.json
Restart=on-failure
RestartSec=2s
LimitNOFILE=65536
Environment=RUST_LOG=info
# Uncomment if your manager uses a self-signed cert:
# Environment=BILBYCAST_ALLOW_INSECURE=1

[Install]
WantedBy=multi-user.target
```

### Browser-Based Setup (Field Deployment)

For hardware deployed at venues where SSH is impractical:

1. Start the edge with a minimal config (no `manager` block needed).
2. Open `http://<edge-ip>:8080/setup` in a browser. From the local console (`http://localhost:8080/setup`) the wizard accepts requests directly; from any other IP you must paste the first-boot setup token printed on stdout into the **Setup Token** field.
3. Fill in device name, manager URL, registration token, and (optionally) `accept_self_signed_cert`.
4. Save and restart the service (`systemctl restart bilbycast-edge`).

The wizard auto-disables itself the moment the node successfully registers with a manager — `/setup` then returns the disabled-page on subsequent boots.

## Default Ports

| Service | Port | Protocol | Notes |
|---------|------|----------|-------|
| Manager Web UI / REST / WS | 8443 | HTTPS / WSS | Override via `BILBYCAST_PORT` |
| Manager ACME HTTP-01 challenge | 80 | HTTP | Only when `BILBYCAST_ACME_ENABLED=true`; override via `BILBYCAST_ACME_HTTP_PORT` |
| Edge REST API + setup wizard + NMOS IS-04/05/08 | 8080 | HTTP / HTTPS | Override via `--port` / `--bind` |
| Edge embedded monitor dashboard | 9090 | HTTP | Override via `--monitor-port` |
| Edge Prometheus `/metrics` | 8080 | HTTP / HTTPS | Same as REST API |
| Edge mDNS-SD (`_nmos-node._tcp`) | 5353 | UDP | Best-effort, not required |
| Edge media-protocol bind ports | _flow-config_ | varies | SRT / RIST / RTP / UDP / RTMP / RTSP / HLS / WebRTC / ST 2110 — set per input/output |
| Relay QUIC | 4433 | QUIC/UDP (TLS 1.3) | Override via `--quic-addr` |
| Relay REST API | 4480 | HTTP | Override via `--api-addr` |

## Firewall / Network Flows

All control connections are **outbound from edges and relays to the manager** (on `wss://`), so devices behind NAT / restrictive firewalls don't need any inbound port — this is the whole point of the design.

```
                       ┌──────────────────────┐
                       │   bilbycast-manager   │  TCP 8443 (WSS, HTTPS)
                       └─▲──────────▲─────────┘
                         │          │
                  outbound│          │outbound
                    WSS   │          │ WSS
                         │          │
   ┌─────────────────────┴──┐    ┌──┴────────────────────┐
   │ bilbycast-edge (Site A) │    │ bilbycast-edge (Site B) │
   └──────────┬──────────────┘    └─┬─────────────────────┘
              │                     │
              │ QUIC (UDP 4433)     │ QUIC (UDP 4433)
              │ outbound to relay   │ outbound to relay
              ▼                     ▼
            ┌────────────────────────┐
            │ bilbycast-relay         │ UDP 4433 (QUIC)
            └────────────────────────┘
```

Open these in your firewall:

- **Manager host**: TCP 8443 inbound from operators' browsers and from every edge / relay site. TCP 80 inbound from the public internet only if using ACME.
- **Relay host**: UDP 4433 inbound from every edge that pairs through it. TCP 4480 only if you want to query its REST stats from the manager / your monitoring host.
- **Edge host**: typically only outbound — TCP 443/8443 to the manager and UDP 4433 to the relay. **Inbound** ports are needed only for media protocols you've configured as listeners (e.g. SRT listener, RTSP server, WHIP server).

## Verification

After everything is up, confirm the stack end-to-end:

```bash
# Manager health
curl -k https://<manager-host>:8443/health

# Edge health (locally)
curl http://<edge-host>:8080/health

# Relay health
curl http://<relay-host>:4480/health
```

In the manager UI:

- `/admin/nodes` — every edge / relay should show **online** with a recent `last_seen`.
- The node detail page surfaces **capabilities** the edge advertised (`replay`, `display`, `st2110-30`, etc.) and a **Resources** card with the per-host hardware probe.
- For a quick smoke test, create a flow that loops localhost UDP back to itself; you should see live stats and a thumbnail in the manager UI within ~10 s.

## Optional: PTP for ST 2110 essence flows

```bash
sudo apt install linuxptp        # Debian / Ubuntu
sudo dnf install linuxptp        # RHEL / Fedora
```

Configure `ptp4l` with your domain and NIC, then start it as a systemd service. The edge polls `ptp4l`'s management socket (default `/var/run/ptp4l`) — it does not run a PTP slave in-process. A worked example is in [PTP Integration](/edge/ptp/#wiring-it-up). Skip this entirely if you're not running ST 2110.
