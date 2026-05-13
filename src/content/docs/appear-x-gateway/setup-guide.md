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

The installer downloads the Sigstore-signed manifest, verifies it against the gateway's compiled-in allowlist, downloads the matching arch-specific tarball (x86_64 or aarch64), verifies SHA-256 against the signed manifest, lays out `/opt/bilbycast/appear-x-gateway/{current,versions/<v>/}` with a `current` symlink the upgrade machinery atomically swaps, creates a `bilbycast-gateway` system user, writes `config.toml`, and installs + enables the systemd unit. Auto-installs `cosign` (with its own checksum verified against the upstream release) if it isn't already on the host.

**Replace the five `REPLACE_*` values below with your own before running** — the placeholders are intentional all-caps so bash doesn't interpret them as shell redirection (e.g. `<token>` would treat the angle bracket as input redirection). Each value is single-quoted so URLs / passwords with special characters don't trip word-splitting:

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

After install, the sidecar runs as a systemd service (`bilbycast-appear-x-gateway`):

```bash
sudo systemctl status bilbycast-appear-x-gateway
sudo journalctl -u bilbycast-appear-x-gateway -f
```

The installer wrote `/opt/bilbycast/appear-x-gateway/config.toml` for you with the values you passed plus sensible polling-interval defaults. To tune polling cadence, MMI versions, reachability thresholds, or add a manager-cluster URL list, edit that file (the schema is documented in [`config/example.toml`](https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/blob/main/config/example.toml)) and `sudo systemctl restart bilbycast-appear-x-gateway`.

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
