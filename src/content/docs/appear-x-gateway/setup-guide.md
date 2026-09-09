---
title: Setup Guide
description: Deploying and configuring the Appear X API gateway.
sidebar:
  order: 2
---

The Appear X gateway is a sidecar that bridges an Appear X chassis to bilbycast-manager. This guide walks through a manual systemd install — each step is visible and inspectable, the same shape as the edge and relay install guides.

## Prerequisites

- A running [bilbycast-manager](/manager/getting-started/) instance, reachable from the gateway host over `wss://`.
- Network access from the gateway host to the Appear X chassis (HTTPS / JSON-RPC).
- A Linux host (Ubuntu 24.04 / Debian 12 or newer recommended) with systemd. `x86_64` and `aarch64` are both supported.
- About 5 minutes.

## Step 1: Register the node in the manager

1. Sign in to the manager UI as an Admin.
2. Go to **Admin → Nodes** (`/admin/nodes`).
3. Click **+ Add Node**.
4. Fill in:
   - **Name** — descriptive (e.g. `Appear X - Studio A`).
   - **Device Type** — `appear_x` (Appear X Encoder / Gateway).
5. Click **Create** — copy the registration token shown in the modal.

## Step 2: Download

```bash
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/releases/latest/download/bilbycast-appear-x-api-gateway-$(uname -m)-linux.tar.gz"
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/releases/latest/download/bilbycast-appear-x-api-gateway-$(uname -m)-linux.tar.gz.sha256"
sha256sum -c "bilbycast-appear-x-api-gateway-$(uname -m)-linux.tar.gz.sha256"
tar xzf "bilbycast-appear-x-api-gateway-$(uname -m)-linux.tar.gz"
cd bilbycast-appear-x-api-gateway-*/
```

You'll see `bilbycast-appear-x-api-gateway-x86_64-linux.tar.gz: OK` (or `aarch64`). The extracted directory contains the binary, the example `config/example.toml`, the bundled systemd unit at `packaging/bilbycast-appear-x-gateway.service`, and the licence files.

### Verify the Sigstore signature (optional)

Every release ships a Sigstore-signed `manifest.json`. The `sha256sum -c` step catches mid-transfer corruption; verifying the signature additionally proves the manifest was published by the Bilbycast release workflow on a tagged commit.

Install [cosign](https://github.com/sigstore/cosign) (arch-aware so it works on both x86_64 and aarch64 hosts):

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
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/releases/latest/download/manifest.json"
curl -fsSL -O "https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/releases/latest/download/manifest.sig.bundle"

cosign verify-blob \
  --bundle manifest.sig.bundle \
  --certificate-identity-regexp 'https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/.github/workflows/nightly-release.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  manifest.json
```

A successful verify prints `Verified OK`. The manifest then carries the SHA-256 of every per-arch tarball.

## Step 3: Create the service user

```bash
# `|| true` — the bilbycast-gateway user may already exist from a
# prior gateway install on this host.
sudo useradd --system --no-create-home --shell /usr/sbin/nologin bilbycast-gateway || true
```

The gateway runs as `bilbycast-gateway` — a distinct user from edge's `bilbycast` and relay's `bilbycast-relay`, so all three services can coexist on one host without filesystem-permission collisions.

## Step 4: Lay out the directories

```bash
VERSION=0.11.0   # whichever you just extracted

sudo mkdir -p /opt/bilbycast/appear-x-gateway/versions/${VERSION}
sudo mkdir -p /var/lib/bilbycast/appear-x-gateway

sudo chown -R bilbycast-gateway:bilbycast-gateway /opt/bilbycast/appear-x-gateway /var/lib/bilbycast/appear-x-gateway
sudo chmod 0750 /opt/bilbycast/appear-x-gateway /var/lib/bilbycast/appear-x-gateway
```

Why `bilbycast-gateway` owns the install root: the upgrade module (`src/upgrade/`) manipulates `versions/` and the `current` symlink at runtime under the service user. Root-owned would block that silently.

## Step 5: Install the binary into `versions/<v>/`

From inside the extracted tarball directory:

```bash
sudo cp -r ./* /opt/bilbycast/appear-x-gateway/versions/${VERSION}/
sudo chown -R bilbycast-gateway:bilbycast-gateway /opt/bilbycast/appear-x-gateway/versions/${VERSION}
sudo chmod 0755 /opt/bilbycast/appear-x-gateway/versions/${VERSION}/bilbycast-appear-x-api-gateway

# Atomic symlink — `current` always points at a real version dir.
sudo -u bilbycast-gateway ln -sfn versions/${VERSION} /opt/bilbycast/appear-x-gateway/current.tmp
sudo -u bilbycast-gateway mv -Tf /opt/bilbycast/appear-x-gateway/current.tmp /opt/bilbycast/appear-x-gateway/current
```

Verify:

```bash
sudo ls -la /opt/bilbycast/appear-x-gateway/current/bilbycast-appear-x-api-gateway
# → current -> versions/0.11.0
# → versions/0.11.0/bilbycast-appear-x-api-gateway (executable)
```

## Step 6: Write `config.toml`

```bash
sudo tee /opt/bilbycast/appear-x-gateway/config.toml > /dev/null <<EOF
[manager]
# Ordered list of bilbycast-manager WebSocket URLs (each wss://, 1-16 entries).
# For a single-instance manager use a one-element array.
urls = [
    "wss://REPLACE_WITH_YOUR_MANAGER_HOSTNAME:8443/ws/node",
]
registration_token = "REPLACE_WITH_REGISTRATION_TOKEN_FROM_STEP_1"
credentials_file = "/opt/bilbycast/appear-x-gateway/credentials.json"

[appear_x]
address = "REPLACE_WITH_CHASSIS_IP"
username = "admin"
password = "REPLACE_WITH_CHASSIS_PASSWORD"
accept_self_signed_cert = true   # Appear X units typically use self-signed HTTPS
# Stronger posture — pin the chassis leaf cert instead (see Security notes):
# cert_fingerprint = "aa:bb:cc:dd:..."

[polling]
alarms_interval_secs = 10
chassis_interval_secs = 30
inputs_interval_secs = 15
outputs_interval_secs = 15
cards_interval_secs = 30
card_status_interval_secs = 5
xger_config_interval_secs = 30
uptime_interval_secs = 60
alarms_refresh_interval_secs = 1800
alarms_mmi_version  = "2.8"
chassis_mmi_version = "4.1"
cards_mmi_version   = "2.8"
uptime_mmi_version  = "5.6"
sfp_low_rx_dbm_threshold = -18.0
sfp_high_temp_c_threshold = 70.0

# Required for manager-driven Remote Upgrade. enabled defaults to false,
# so the section without it behaves exactly like no section at all.
[upgrade]
enabled = true
allowed_channels = ["stable"]
install_root = "/opt/bilbycast/appear-x-gateway"
EOF
sudo chown root:bilbycast-gateway /opt/bilbycast/appear-x-gateway/config.toml
sudo chmod 0640 /opt/bilbycast/appear-x-gateway/config.toml
```

Replace the four `REPLACE_*` values with your real ones before continuing. There's no `[[polling.boards]]` block — the gateway auto-discovers cards at startup via the capability-discovery pass in `src/appear_x/capabilities.rs`.

`card_status_interval_secs` drives the manager's **Card Health** panel — keep it at or below 5 s so a PTP drop or SFP RX-power loss surfaces promptly. The two `sfp_*` thresholds are the trigger points for the Minor `sfp_low_rx_power` and `sfp_high_temperature` events; the defaults shown are the code defaults, so you can omit any line you don't want to change.

The `[upgrade]` block is what makes manager-driven [Remote Upgrade](/manager/remote-upgrade/) actually work. `enabled = true` is mandatory — it defaults to `false`, so a block without it is refused with the same `upgrade_disabled` error as omitting the section entirely. `install_root` must be an absolute path and `allowed_channels` must be non-empty with alphanumeric / dash / underscore entries, or the gateway refuses to start rather than degrading.

`config.toml` is read once at startup and never written back, so it is root-owned with group `bilbycast-gateway` — readable by the service, not writable by it, since it holds the chassis password and the registration token. It is `credentials.json` (the `credentials_file` path) that the service user must be able to write: the SDK creates it on first registration and chmods it `0600`.

## Step 7: Drop the systemd unit

Write `/etc/systemd/system/bilbycast-appear-x-gateway.service`:

```bash
sudo tee /etc/systemd/system/bilbycast-appear-x-gateway.service > /dev/null <<'EOF'
[Unit]
Description=bilbycast Appear X API gateway sidecar
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bilbycast-gateway
Group=bilbycast-gateway

# ExecStart resolves through `current` so manager-driven Remote Upgrade
# lands automatically when systemd respawns the process.
ExecStart=/opt/bilbycast/appear-x-gateway/current/bilbycast-appear-x-api-gateway --config /opt/bilbycast/appear-x-gateway/config.toml

Restart=always
RestartSec=3
StartLimitInterval=300
StartLimitBurst=10

KillSignal=SIGTERM
TimeoutStopSec=20

# Hardening
ProtectSystem=strict
ReadWritePaths=/opt/bilbycast/appear-x-gateway /var/lib/bilbycast/appear-x-gateway
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictNamespaces=true
RestrictRealtime=true
LockPersonality=true
SystemCallArchitectures=native

LimitNOFILE=4096
MemoryMax=1G

# Optional operator env file (RUST_LOG, BILBYCAST_ALLOW_INSECURE, etc.)
EnvironmentFile=-/etc/bilbycast/appear-x-gateway.env

[Install]
WantedBy=multi-user.target
EOF
```

### Verify chassis credentials and firmware interface versions

Before starting the service, exercise the chassis link once with the `probe` subcommand:

```bash
sudo -u bilbycast-gateway /opt/bilbycast/appear-x-gateway/current/bilbycast-appear-x-api-gateway \
  --config /opt/bilbycast/appear-x-gateway/config.toml probe
```

`probe` talks only to the Appear X unit — it never connects to the manager, and it skips the manager-URL validation entirely, so it works before the node has registered. It authenticates, then calls `alarms/GetActiveAlarms`, `chassisModel/GetGraph`, `cards/GetChassisInfo` and `cards/GetCardStates` once each at the `mmi:` versions your `[polling]` block configures, printing `PASS` / `FAIL` plus a truncated response per call. A `FAIL` line names the exact `mmi:<version>/...` method your firmware rejected, which is how you pick the right `*_mmi_version` values. A sample probe-only config ships as `config/probe-x5.toml`.

## Step 8: Enable and start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bilbycast-appear-x-gateway
sudo systemctl status bilbycast-appear-x-gateway --no-pager
```

Expected: `active (running)`. Tail the logs:

```bash
sudo journalctl -u bilbycast-appear-x-gateway -f
```

You should see `manager: connected` within a few seconds, then the polling tasks start within ~10s.

## Step 9: Verify in the manager

1. The node should appear as **online** on the manager dashboard.
2. Stats (inputs, outputs, alarms, chassis) populate within the configured polling intervals (10–30s).
3. The **AI Assistant** can target the Appear X node — pick it from the dropdown.
4. The node detail page's **Gateway Module** header shows the sidecar version, gateway host, polled chassis address, and a **reachable** / **target down** badge driven by the alarm-poll heartbeat.

Two `[appear_x]` keys tune that badge. `reachability_failure_threshold` (default `2`) is how many consecutive failed alarm polls flip it to **target down** — roughly 20 s at the default 10 s alarms cadence; lower it for an inline broadcast path, raise it for a flaky remote uplink. `reachability_event_dwell_secs` (default `60`) is how long the badge must stay down before a `target_unreachable` event fires, which damps slow flap. Recovery is not dwell-gated — `target_recovered` fires on the first successful poll after the streak.

## Upgrades

The gateway supports two upgrade paths.

**Manager-driven Remote Upgrade (recommended).** Requires the `[upgrade]` block from Step 6. The gateway advertises the `upgrade` capability unconditionally, so the manager shows **Stage upgrade** even on a gateway with no `[upgrade]` section at all — the button's presence is not evidence the feature is wired, and clicking it on an unconfigured gateway returns `upgrade_disabled`. With the block in place and `enabled = true`, every subsequent upgrade is driven from the manager UI:

1. **Admin → Managed Nodes**, click **Upgrade…** on the gateway's row.
2. Pick a `(version, channel)` and click **Stage upgrade**.
3. The gateway fetches the signed `manifest.json` + `manifest.sig.bundle`, verifies the Sigstore signature against its compiled-in allowlist, downloads the matching arch-specific tarball, verifies SHA-256, atomically swaps `/opt/bilbycast/appear-x-gateway/current` → `versions/<new>/`, drains for 5 seconds, and exits for systemd respawn. A boot watchdog auto-rolls back if the new binary fails the health probe within 90s.

Full runbook: [Remote Upgrade](/manager/remote-upgrade/).

**Manual fallback.** When you can't reach the manager UI:

```bash
NEW_VERSION=0.12.0   # the version you downloaded

# Re-run step 2 to fetch + extract the new tarball.

sudo systemctl stop bilbycast-appear-x-gateway

sudo mkdir -p /opt/bilbycast/appear-x-gateway/versions/${NEW_VERSION}
sudo cp -r ./* /opt/bilbycast/appear-x-gateway/versions/${NEW_VERSION}/
sudo chown -R bilbycast-gateway:bilbycast-gateway /opt/bilbycast/appear-x-gateway/versions/${NEW_VERSION}
sudo chmod 0755 /opt/bilbycast/appear-x-gateway/versions/${NEW_VERSION}/bilbycast-appear-x-api-gateway

sudo -u bilbycast-gateway ln -sfn versions/${NEW_VERSION} /opt/bilbycast/appear-x-gateway/current.tmp
sudo -u bilbycast-gateway mv -Tf /opt/bilbycast/appear-x-gateway/current.tmp /opt/bilbycast/appear-x-gateway/current

sudo systemctl start bilbycast-appear-x-gateway

# Rollback (revert the symlink to the previous version dir):
#   sudo -u bilbycast-gateway ln -sfn versions/0.11.0 /opt/bilbycast/appear-x-gateway/current.tmp
#   sudo -u bilbycast-gateway mv -Tf /opt/bilbycast/appear-x-gateway/current.tmp /opt/bilbycast/appear-x-gateway/current
#   sudo systemctl restart bilbycast-appear-x-gateway
```

Config + credentials at `/opt/bilbycast/appear-x-gateway/{config.toml,credentials.json}` carry across upgrades untouched.

## Logging

Edit the systemd unit's environment file to bump log verbosity:

```bash
sudo mkdir -p /etc/bilbycast
echo 'RUST_LOG=info,bilbycast_appear_x_api_gateway=debug' \
  | sudo tee /etc/bilbycast/appear-x-gateway.env
sudo systemctl restart bilbycast-appear-x-gateway
```

Trace-level (very verbose, includes JSON-RPC payloads):

```bash
echo 'RUST_LOG=info,bilbycast_appear_x_api_gateway=trace' \
  | sudo tee /etc/bilbycast/appear-x-gateway.env
sudo systemctl restart bilbycast-appear-x-gateway
```

## Security notes

- The gateway enforces `wss://` for manager connections — plaintext `ws://` is rejected.
- Self-signed manager cert acceptance requires `BILBYCAST_ALLOW_INSECURE=1` (set via the env file above) as an explicit safety guard.
- For production, use certificate pinning (`manager.cert_fingerprint`) instead of `accept_self_signed_cert`.
- `credentials.json` is written `0600` by the gateway.
- The Appear X HTTPS connection has its own independent `accept_self_signed_cert` (Appear chassis typically ship with self-signed certs) — and its own pin, `appear_x.cert_fingerprint`. When the pin is set, full CA-chain validation runs **and** the leaf's SHA-256 must match; it takes precedence over `accept_self_signed_cert` whatever that is set to, and unlike the manager's self-signed path it needs no `BILBYCAST_ALLOW_INSECURE`, because pinning is strictly stronger. Colon-separated and bare hex are both accepted; a malformed value aborts startup rather than degrading. Use it as the production posture instead of `accept_self_signed_cert = true`.
- `config.toml` is read once at startup and never rewritten, so it does not need to be writable by the service account — see Step 6.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Manager URL must use wss://` in journalctl | Config has `ws://` URL | Edit `/opt/bilbycast/appear-x-gateway/config.toml`, change to `wss://`, restart |
| `manager.urls is empty` | `urls = []` or the key is missing | At least one entry in `urls = [...]` |
| `BILBYCAST_ALLOW_INSECURE=1 is not set` | `accept_self_signed_cert = true` set without the env-var safety guard | Add `RUST_LOG=info` + `BILBYCAST_ALLOW_INSECURE=1` to `/etc/bilbycast/appear-x-gateway.env`, restart |
| `Authentication failed` (manager) | Registration token already consumed | Generate a fresh token in the manager UI; if `credentials.json` exists already, delete it to force re-registration |
| `BeginSession failed` (Appear X) | Wrong chassis username / password | Verify `appear_x.username` and `appear_x.password` in config.toml |
| Many `Method '...' was not found` warnings | Wrong MMI version | Run the `probe` subcommand (before Step 8) to see which interface versions this firmware answers, then set `alarms_mmi_version` / `chassis_mmi_version` / `cards_mmi_version` accordingly |
| `Permission denied` writing `credentials.json` | File or its directory owned by root | `sudo chown bilbycast-gateway:bilbycast-gateway /opt/bilbycast/appear-x-gateway/credentials.json` |
| `command_ack` returns `upgrade_disabled` after **Stage upgrade** | No `[upgrade]` block in `config.toml`, or the block omits `enabled = true` | Add the Step 6 `[upgrade]` block with `enabled = true`, then restart the service |
