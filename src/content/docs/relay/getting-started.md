---
title: Install the Relay
description: Download, install, and run bilbycast-relay.
sidebar:
  order: 2
---

The relay is a stateless QUIC forwarder for NAT traversal between edges. It carries opaque ciphertext only — relay operators can't see your media. **You only need a relay if your edge sites can't reach each other directly** (different ASNs, double-NAT, restrictive firewalls). Two edges on the same LAN, or edges connected over a site-to-site VPN, don't need it.

## What you'll need

- A Linux host on a public IP, or behind a static port-forward of UDP 4433.
- About 5 minutes.

The relay is statically linked against musl, has no runtime dependencies, and runs on `x86_64` and `aarch64`.

## 1. Download

```bash
curl -fsSL -o bilbycast-relay \
  https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/bilbycast-relay-$(uname -m)-linux
chmod +x bilbycast-relay
```

Verify the checksum:

```bash
curl -fsSL -o bilbycast-relay.sha256 \
  https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/bilbycast-relay-$(uname -m)-linux.sha256
sha256sum -c bilbycast-relay.sha256
```

## 2. Standalone (zero config)

The simplest deployment — useful for testing or when you don't need the relay reporting back to the manager:

```bash
./bilbycast-relay
```

Defaults: QUIC on `0.0.0.0:4433`, REST on `0.0.0.0:4480`. Override with `--quic-addr` or `--api-addr`.

## 3. Attached to the manager (recommended)

In the manager UI:

1. Go to **Admin → Nodes**, click **+ Add Node**, pick device type **Relay**.
2. Copy the one-shot registration token.

Next to the relay binary, write `relay.json`:

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

Launch:

```bash
./bilbycast-relay --config relay.json
```

For a self-signed manager cert, add `"accept_self_signed_cert": true` inside the `manager` block **and** export `BILBYCAST_ALLOW_INSECURE=1` before launching. The env var is a deliberate safety guard.

On first connect the relay swaps the registration token for a permanent `node_id` plus `node_secret`, persists them locally, and reconnects automatically going forward.

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
sudo useradd -r -s /sbin/nologin bilbycast
sudo mkdir -p /opt/bilbycast-relay /etc/bilbycast
sudo install -m 0755 -o bilbycast -g bilbycast bilbycast-relay /opt/bilbycast-relay/
sudo install -m 0640 -o root -g bilbycast relay.json /etc/bilbycast/relay.json
sudo systemctl daemon-reload
sudo systemctl enable --now bilbycast-relay
```

Verify with `systemctl status bilbycast-relay` and `journalctl -u bilbycast-relay -f`.

## Where to read next

- [Relay architecture](/relay/architecture/) — internal design and stateless forwarding.
- [Relay security](/relay/security/) — bind tokens, end-to-end tunnel encryption, why operators can't see media.
- [Relay events and alarms](/relay/events-and-alarms/) — what's emitted when tunnels go up or down.
- [Relay stats reference](/relay/stats-reference/) — Prometheus metrics.
