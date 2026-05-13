---
title: Install the Relay
description: Download, install, and run bilbycast-relay.
sidebar:
  order: 2
---

The relay is a stateless QUIC forwarder for NAT traversal between edges. It carries opaque ciphertext only — relay operators can't see your media. **You only need a relay if your edge sites can't reach each other directly** (different ASNs, double-NAT, restrictive firewalls). Two edges on the same LAN, or edges connected over a site-to-site VPN, don't need it.

## What you'll need

- A Linux host on a public IP, or behind a static port-forward of UDP 4433. Can share a box with the manager — the relay installs alongside under different paths (`/opt/bilbycast-relay/`, `/etc/bilbycast/`) so the two coexist cleanly.
- About 5 minutes.

The relay is statically linked against musl, has no runtime dependencies, and runs on `x86_64` and `aarch64`.

## Ports & firewall

The relay listens on two ports:

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| **4433** | UDP (QUIC / TLS 1.3) | Every edge that pairs through this relay | Tunnel data plane. Override with `--quic-addr`. |
| **4480** | TCP (HTTP) | Manager host, your monitoring host | REST stats + `/health`. Optional — close it if you don't query stats remotely. Override with `--api-addr`. |

The relay itself connects **outbound** to the manager on TCP 8443 (`wss://`), so no inbound port is needed for control. If you front the relay with a load balancer (multiple relay instances for HA), the LB needs UDP/QUIC pass-through on 4433 — not TLS termination, since QUIC carries its own TLS 1.3.

Full network map: [Deployment overview](/getting-started/deployment/).

## 1. Download

```bash
curl -fsSL -O https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/bilbycast-relay-$(uname -m)-linux
curl -fsSL -O https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/bilbycast-relay-$(uname -m)-linux.sha256
sha256sum -c bilbycast-relay-$(uname -m)-linux.sha256

# Rename to bilbycast-relay so subsequent commands are arch-agnostic
mv bilbycast-relay-$(uname -m)-linux bilbycast-relay
chmod +x bilbycast-relay
```

You should see `bilbycast-relay-x86_64-linux: OK` (or `aarch64`). The rename keeps the rest of this page concise; the canonical name is what the `.sha256` file expects, so we verify under that name before moving.

### Verify the Sigstore signature (optional)

Every release ships a Sigstore-signed `manifest.json` alongside the bare binaries. The `sha256sum -c` step above catches mid-transfer corruption; verifying the signature additionally proves the manifest was published by the Bilbycast release workflow on a tagged commit.

Install [cosign](https://github.com/sigstore/cosign) — on Ubuntu / Debian the simplest path is the upstream static binary with SHA-256 verification:

```bash
COSIGN_VERSION=v2.4.1
curl -fsSL -o /tmp/cosign \
  "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64"
expected="$(curl -fsSL "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign_checksums.txt" | awk '$2 == "cosign-linux-amd64" {print $1}')"
got="$(sha256sum /tmp/cosign | awk '{print $1}')"
[[ -n "${expected}" && "${got}" == "${expected}" ]] || { echo "cosign checksum mismatch"; exit 1; }
sudo install -m 0755 /tmp/cosign /usr/local/bin/cosign && rm /tmp/cosign
```

Then verify the manifest:

```bash
curl -fsSL -O https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/manifest.json
curl -fsSL -O https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/manifest.sig.bundle

cosign verify-blob \
  --bundle manifest.sig.bundle \
  --certificate-identity-regexp 'https://github.com/Bilbycast/bilbycast-relay/.github/workflows/nightly-release.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  manifest.json
```

A successful verify prints `Verified OK`. The same Sigstore-signed manifest drives the [upgrade flow](#upgrading) below, so this is the verifier's main checkpoint.

## 2. Standalone (zero config)

The simplest deployment — useful for testing or when you don't need the relay reporting back to the manager:

```bash
./bilbycast-relay
```

Defaults: QUIC on `0.0.0.0:4433`, REST on `0.0.0.0:4480`. Override with `--quic-addr` or `--api-addr`. Ctrl-C to stop.

## 3. Attached to the manager (recommended)

In the manager UI:

1. Go to **Admin → Nodes**, click **+ Add Node**, pick device type **Relay**.
2. Copy the one-shot registration token.

Next to the relay binary, write `relay.json` (replace `REPLACE_WITH_YOUR_MANAGER_HOSTNAME` and `<token-from-manager>` with the real values — don't paste this verbatim):

```json
{
  "quic_addr": "0.0.0.0:4433",
  "api_addr": "0.0.0.0:4480",
  "require_bind_auth": true,
  "manager": {
    "enabled": true,
    "urls": [
      "wss://REPLACE_WITH_YOUR_MANAGER_HOSTNAME:8443/ws/node"
    ],
    "registration_token": "<token-from-manager>"
  }
}
```

`urls` is an array (1-16 entries, each must be `wss://`). For a single manager that's one entry; for an HA-paired manager cluster you'd list both hostnames — the relay tries them in order and rotates on WebSocket close with a 5-second backoff.

Launch:

```bash
./bilbycast-relay --config relay.json
```

For a self-signed manager cert (only relevant if you skipped ACME / Let's Encrypt on the manager), add `"accept_self_signed_cert": true` inside the `manager` block **and** export `BILBYCAST_ALLOW_INSECURE=1` before launching. The env var is a deliberate safety guard.

On first connect the relay swaps the registration token for a permanent `node_id` + `node_secret`, **rewrites `relay.json` in place** with those values (removing the now-spent registration token), and reconnects automatically going forward. Don't be surprised when your `relay.json` looks different after the first boot — that's the credential persistence working as intended. The file's runtime user (`bilbycast` on the systemd install in step 4) must therefore be able to write it; step 4 sets the ownership accordingly.

## 4. systemd service

For production, run the relay as a systemd service. Drop into `/etc/systemd/system/bilbycast-relay.service`:

```ini
[Unit]
Description=bilbycast-relay QUIC NAT traversal
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bilbycast
Group=bilbycast
WorkingDirectory=/opt/bilbycast-relay
ExecStart=/opt/bilbycast-relay/bilbycast-relay --config /etc/bilbycast/relay.json
Restart=on-failure
RestartSec=2s
LimitNOFILE=65536
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
```

Then:

```bash
# `|| true` — bilbycast user may already exist from a manager install on this box
sudo useradd -r -s /sbin/nologin bilbycast || true
sudo mkdir -p /opt/bilbycast-relay /etc/bilbycast
sudo install -m 0755 -o bilbycast -g bilbycast bilbycast-relay /opt/bilbycast-relay/
# relay.json: bilbycast OWNS it (not root) — the relay rewrites this file on
# first connect to swap the registration_token for the permanent node_id +
# node_secret. Root-owned 0640 would block that write and you'd be stuck on
# next restart with a spent registration token.
sudo install -m 0640 -o bilbycast -g bilbycast relay.json /etc/bilbycast/relay.json
sudo systemctl daemon-reload
sudo systemctl enable --now bilbycast-relay
sudo systemctl status bilbycast-relay --no-pager
```

Expected: `active (running)`. Logs: `sudo journalctl -u bilbycast-relay -f`.

### Co-existing with the manager on the same box

If this box also runs the manager, the two installs occupy separate trees so they don't collide:

| | Manager | Relay |
|---|---|---|
| Binary | `/opt/bilbycast-manager/bilbycast-manager` | `/opt/bilbycast-relay/bilbycast-relay` |
| Config + secrets | `/etc/bilbycast-manager/manager.env` | `/etc/bilbycast/relay.json` |
| Systemd unit | `bilbycast-manager.service` | `bilbycast-relay.service` |
| Service user | `bilbycast` (shared) | `bilbycast` (shared) |

Same `bilbycast` user owns both — `useradd ... \|\| true` above is idempotent.

## Upgrading

The relay ships an operator-run upgrade script. It downloads the latest signed `manifest.json` + `manifest.sig.bundle`, verifies the Sigstore signature against the publishing workflow's identity (auto-installing cosign with checksum verification if it isn't already on the host), pulls the matching arch-specific binary (x86_64 / aarch64), verifies SHA-256 against the signed manifest, atomically swaps the binary with a `.previous` backup, restarts the systemd unit, polls `/health`, and **auto-rolls back** to the previous binary on a failed health probe.

The simplest path is curl-pipe-bash from the latest release:

```bash
curl -fsSL https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/upgrade-relay.sh \
    | sudo bash
```

Operators who'd rather review the script first can grab it once and re-run it as needed:

```bash
curl -fsSL -o upgrade-relay.sh \
    https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/upgrade-relay.sh
chmod +x upgrade-relay.sh
sudo ./upgrade-relay.sh                         # apply latest stable
sudo ./upgrade-relay.sh --dry-run               # download + verify only; print plan
sudo ./upgrade-relay.sh --target-version 0.7.0  # pin to a specific tag
```

The relay is stateless — a restart drops connected edges, which all reconnect automatically. For zero-disruption upgrades, run multiple relay instances behind a load balancer and roll through them one at a time. Pass `--help` for every flag, including `--service`, `--binary-path`, `--health-url`, `--health-timeout`, `--no-rollback`, and `--no-verify-cosign` (for air-gapped boxes that can't install cosign).

The script **requires** the systemd unit from step 4 — it reads `systemctl cat bilbycast-relay` to auto-detect the binary path. On a foreground-only install it errors out with `systemd unit 'bilbycast-relay' not found`. For a foreground install, do the swap by hand:

```bash
# 1. Stop the foreground ./bilbycast-relay process (Ctrl-C in its terminal).

# 2. Backup the running binary so you can roll back if needed.
rm -f bilbycast-relay.previous
mv bilbycast-relay bilbycast-relay.previous

# 3. Re-run step 1's download block to fetch + verify the new binary
#    into CWD (the final `mv … bilbycast-relay && chmod +x` lands it
#    next to the .previous backup).

# 4. Restart.
./bilbycast-relay --config relay.json

# Rollback (if the new version misbehaves):
#   mv bilbycast-relay.previous bilbycast-relay
```

## Going further

The single-host systemd install above is the right shape for most deployments. For larger or more redundant setups:

- **Multiple relays behind a load balancer** — the relay is stateless, so an LB doing UDP/QUIC pass-through on 4433 across several relay instances gives you horizontal scale + zero-disruption upgrades. Roll one relay at a time using the upgrade script above; edges reconnect transparently.
- **Geographic redundancy** — run a relay in each region; edges can be configured with multiple relay candidates and will fail over on tunnel loss.
- [Relay security](/relay/security/) — bind tokens, end-to-end tunnel encryption, why operators can't see media.

## Where to read next

- [Relay architecture](/relay/architecture/) — internal design and stateless forwarding.
- [Relay events and alarms](/relay/events-and-alarms/) — what's emitted when tunnels go up or down.
- [Relay stats reference](/relay/stats-reference/) — Prometheus metrics.
