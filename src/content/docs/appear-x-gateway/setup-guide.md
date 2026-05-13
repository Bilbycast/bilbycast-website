---
title: Setup Guide
description: Deploying and configuring the Appear X API gateway.
sidebar:
  order: 2
---

## Prerequisites

- A running [bilbycast-manager](/manager/getting-started/) instance.
- Network access from the gateway host to both the manager and the Appear X unit.
- An Appear X unit with the JSON-RPC API enabled (HTTPS).

## Step 1: Register the node in the manager

1. Sign in to the manager UI as an Admin.
2. Go to **Admin → Nodes** (`/admin/nodes`).
3. Click **+ Add Node**.
4. Fill in:
   - **Name** — descriptive (e.g. `Appear X - Studio A`).
   - **Device Type** — `appear_x` (Appear X Encoder / Gateway).
   - **Description** — optional.
   - **Expiry** — optional.
5. Click **Create** — copy the registration token shown in the modal.

## Step 2: Install the gateway

Two paths, same outcome.

### Recommended — curl-pipe-bash installer

The installer downloads the Sigstore-signed manifest, verifies it against the gateway's compiled-in allowlist, downloads the matching tarball, lays out `/opt/bilbycast/appear-x-gateway/{current,versions/<v>/,…}` with a `current` symlink the upgrade machinery atomically swaps, creates a `bilbycast-gateway` system user, writes `config.toml`, and installs + enables the systemd unit.

**Replace the four `REPLACE_*` values below with your own before running** — the placeholders are intentional all-caps so bash doesn't interpret them as shell redirection (e.g. `<token>` would treat the angle bracket as input redirection):

```bash
curl -fsSL https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/releases/latest/download/install-appear-x-gateway.sh \
  | sudo bash -s -- \
      --manager 'wss://REPLACE_WITH_YOUR_MANAGER_HOSTNAME:8443/ws/node' \
      --registration-token 'REPLACE_WITH_REGISTRATION_TOKEN_FROM_STEP_1' \
      --appear-x-address 'REPLACE_WITH_CHASSIS_IP' \
      --appear-x-username 'REPLACE_WITH_CHASSIS_USERNAME' \
      --appear-x-password 'REPLACE_WITH_CHASSIS_PASSWORD'
```

The installer is idempotent — re-running with `--upgrade-installer` refreshes the systemd unit + install script without touching config or staged versions.

:::caution[No published release yet?]
If the curl above 404s, this repo hasn't cut its first tagged release yet — the release workflow is wired up but waiting for a `vX.Y.Z` tag push. Check [`Bilbycast/bilbycast-appear-x-api-gateway/releases`](https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/releases). Until a release ships, use the from-source path below.
:::

After install, the sidecar runs as a systemd service (`bilbycast-appear-x-gateway`):

```bash
sudo systemctl status bilbycast-appear-x-gateway
sudo journalctl -u bilbycast-appear-x-gateway -f
```

Skip to [Step 3 — Verify](#step-3-verify-in-manager).

### Alternative — build and run from source

Clone the repo, install Rust stable, then build:

```bash
git clone https://github.com/Bilbycast/bilbycast-appear-x-api-gateway.git
cd bilbycast-appear-x-api-gateway
cargo build --release
```

Copy `config/example.toml` to `config.toml` next to the binary, then edit. The minimal shape:

```toml
[manager]
# Ordered list of bilbycast-manager WebSocket URLs (each wss://, 1–16 entries).
# For a single-instance manager use a one-element array — there is no scalar
# `url` field.
urls = [
    "wss://your-manager-host:8443/ws/node",
]
registration_token = "paste-your-token-from-step-1"
credentials_file = "credentials.json"

# For a self-signed manager cert (dev/testing only):
# accept_self_signed_cert = true
# Requires the BILBYCAST_ALLOW_INSECURE=1 env var as a safety guard.

# For production with cert pinning instead of accept_self_signed_cert:
# cert_fingerprint = "ab:cd:ef:..."

[appear_x]
address = "192.168.1.100"
username = "admin"
password = "your-password"
accept_self_signed_cert = true   # Appear X units typically use self-signed HTTPS

# Optional — how many consecutive failed alarm polls before the manager
# dashboard renders the third "Target down" amber state. Default 2.
# reachability_failure_threshold = 2

# Optional — minimum dwell in the new reachability state before firing
# target_unreachable / target_recovered events (defeats slow-flap noise on
# degraded uplinks). Default 60.
# reachability_event_dwell_secs = 60

[polling]
alarms_interval_secs = 10
chassis_interval_secs = 30
inputs_interval_secs = 15
outputs_interval_secs = 15
cards_interval_secs = 30

# Periodic re-emission of every currently-active alarm as a fresh event,
# in seconds (default 1800 — 30 minutes). Without this, chronic alarms
# emit once on first observation and never again; setting 0 disables.
alarms_refresh_interval_secs = 1800

# MMI interface versions for chassis-level endpoints. These vary across
# Appear firmware versions; the gateway logs "Method '...' was not found"
# if the configured version is wrong. Known-working values for the
# X5 / X20 demo firmware tested 2026-04: 2.8 / 4.1 / 2.8.
alarms_mmi_version  = "2.8"
chassis_mmi_version = "4.1"
cards_mmi_version   = "2.8"
```

**There is no `[[polling.boards]]` section** — the gateway runs a capability-discovery pass at startup (`src/appear_x/capabilities.rs`), reads `cards/GetChassisInfo` to learn the chassis type and per-slot card identities, and probes the registry in `src/appear_x/probe_registry.rs` to find which JSON-RPC interface families this firmware actually exposes. Polling tasks are spawned only for what discovery confirmed works.

Launch:

```bash
./target/release/bilbycast-appear-x-api-gateway --config config.toml
```

On first launch the gateway connects to the manager, presents the registration token, receives the permanent `node_id` + `node_secret`, **persists them to `credentials.json`**, and starts polling. Subsequent launches reuse the credentials — the registration token is one-shot.

For a permanent install, follow the systemd pattern in [`packaging/`](https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/tree/main/packaging) — same shape as the edge install: `bilbycast-gateway` system user, `/opt/bilbycast/appear-x-gateway/{current,versions/<v>/}` symlink-based install root, `ReadWritePaths` on the install root so the upgrade module can swap binaries.

## Step 3: Verify in the manager

1. The node should appear as **online** on the manager dashboard within ~10 seconds.
2. Stats (inputs, outputs, alarms, chassis) populate within the configured polling intervals (10–30 s).
3. The **AI Assistant** can target the Appear X node — select it from the dropdown to query state or configure inputs / outputs in natural language.
4. The node detail page's **Gateway Module** header shows the sidecar version, the gateway host, the polled Appear X address, and a **reachable** / **target down** badge driven by the alarm-poll heartbeat.

## Upgrades

The gateway accepts `upgrade_binary` WS commands from the manager — the same Sigstore-signed manifest pipeline the edge uses. **Once installed via the systemd path, every subsequent upgrade is driven from the manager UI**:

1. **Admin → Managed Nodes**, click **Upgrade…** on the gateway's row.
2. Pick a `(version, channel)` and click **Stage upgrade**.
3. The gateway fetches the signed `manifest.json` + `manifest.sig.bundle`, verifies the Sigstore signature against its compiled-in allowlist (`src/upgrade_profile.rs` pins `Bilbycast/bilbycast-appear-x-api-gateway/.github/workflows/nightly-release.yml @ refs/tags/v*`), downloads the matching arch-specific tarball, verifies SHA-256 against the signed manifest, atomically swaps `/opt/bilbycast/appear-x-gateway/current` → `versions/<new>/`, drains for 5 seconds, and exits for systemd respawn.
4. A boot watchdog auto-rolls back if the new binary fails to come up healthy within `boot_health_window_secs` (default 90s).

No operator action required on the sidecar host — no shell access, no manual `systemctl restart`. Multi-gateway fleets can be upgraded in groups via **Admin → Groups → Upgrade**.

Full runbook: [Remote Upgrade](/manager/remote-upgrade/).

## Logging

Control verbosity with `RUST_LOG`. For the systemd install, edit the service drop-in:

```bash
sudo systemctl edit bilbycast-appear-x-gateway
# Add under [Service]:
#   Environment=RUST_LOG=info,bilbycast_appear_x_api_gateway=debug
sudo systemctl restart bilbycast-appear-x-gateway
```

For the from-source launch:

```bash
# Default (info level)
RUST_LOG=info ./target/release/bilbycast-appear-x-api-gateway --config config.toml

# Debug output for the gateway
RUST_LOG=info,bilbycast_appear_x_api_gateway=debug ./target/release/bilbycast-appear-x-api-gateway --config config.toml

# Trace-level for JSON-RPC payloads (verbose)
RUST_LOG=info,bilbycast_appear_x_api_gateway=trace ./target/release/bilbycast-appear-x-api-gateway --config config.toml
```

## Security notes

- The gateway enforces `wss://` for manager connections — plaintext `ws://` is rejected at connection time.
- Self-signed cert acceptance for the manager link requires `BILBYCAST_ALLOW_INSECURE=1` as an explicit safety guard.
- For production, use certificate pinning (`manager.cert_fingerprint`) instead of `accept_self_signed_cert`.
- `credentials.json` is written `0600` (owner read/write only).
- The Appear X HTTPS connection has its own `accept_self_signed_cert` — independent of manager TLS settings, since Appear chassis typically ship with self-signed certs.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `Manager URL must use wss://` | Config has `ws://` URL or `urls = ["ws://..."]` | Change to `wss://` |
| `manager.urls is empty` | `urls = []` or the key is missing entirely | Provide at least one entry in `urls = [...]` |
| `BILBYCAST_ALLOW_INSECURE=1 is not set` | `accept_self_signed_cert = true` set without the env-var safety guard | `export BILBYCAST_ALLOW_INSECURE=1` (or remove the cert override) |
| `Authentication failed` | Registration token already consumed or wrong | Generate a fresh token in the manager UI; delete `credentials.json` if you want to start over |
| `BeginSession failed` | Wrong Appear X username / password | Verify `appear_x.username` and `appear_x.password` |
| Node shows offline in manager | Network or firewall issue | `curl -k https://<appear-x>/mmi/api/jsonrpc` from the gateway host; check outbound `8443` to the manager |
| Many `Method '...' was not found` warnings | Wrong MMI version | Set the right `alarms_mmi_version` / `chassis_mmi_version` / `cards_mmi_version` for your firmware (the gateway logs the firmware it sees at startup) |
| No stats for one card | Card family not in `src/appear_x/probe_registry.rs` | Discovery has nothing to spawn — the chassis-level polls (alarms / chassisModel / cards) still surface stats. Open an issue with the card's `software_id` so the registry can be extended |
