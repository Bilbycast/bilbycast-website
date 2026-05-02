---
title: Install the Manager
description: Download, install, and run bilbycast-manager.
sidebar:
  order: 2
---

The manager is the central control plane — a Postgres-backed Rust binary that serves the web UI, the REST API, and the WebSocket endpoint that edges and relays connect to. Deploy it first; everything else attaches to it.

## What you'll need

- A Linux host (Ubuntu 24.04 / Debian 12 or newer recommended).
- A reachable **Postgres 18** cluster.
- A DNS name or static IP your operators can hit on TCP 8443.
- About 10 minutes.

The manager binary is statically linked against musl, so the host distribution doesn't matter much beyond having a recent kernel. `x86_64` is the supported architecture today.

## 1. Download

```bash
curl -fsSL -o bilbycast-manager.tar.gz \
  https://github.com/Bilbycast/bilbycast-manager/releases/latest/download/bilbycast-manager-x86_64-linux.tar.gz
curl -fsSL -o bilbycast-manager.tar.gz.sha256 \
  https://github.com/Bilbycast/bilbycast-manager/releases/latest/download/bilbycast-manager-x86_64-linux.tar.gz.sha256
sha256sum -c bilbycast-manager.tar.gz.sha256
tar xzf bilbycast-manager.tar.gz
```

The tarball expands to a directory containing the `bilbycast-manager` binary, the `migrations-pg/` directory (applied automatically on first run), and `config/default.toml`.

## 2. Postgres

Pick one:

**Docker (fastest for evaluation)** — inside the extracted directory:

```bash
docker compose -f docker-compose.dev.yml up -d
```

This brings up Postgres 18 on `localhost:5433` with the default DSN.

**Existing cluster (production)**:

```bash
sudo -u postgres createuser --pwprompt bilbycast
sudo -u postgres createdb -O bilbycast bilbycast
```

Note the connection string — you'll need it in the next step:

```
postgres://bilbycast:<password>@<host>:5432/bilbycast
```

## 3. Install — guided (recommended)

The binary ships an `init` subcommand that does the work for you. It probes Postgres, generates `BILBYCAST_MASTER_KEY` and `BILBYCAST_JWT_SECRET` from the OS CSPRNG, generates a self-signed TLS cert under `/etc/bilbycast-manager/tls/`, writes `/etc/bilbycast-manager/manager.env` (mode `0640`), and drops a systemd unit stub at `/etc/bilbycast-manager/bilbycast-manager.service`:

```bash
cd bilbycast-manager-*/
sudo ./bilbycast-manager init \
  --mode solo \
  --database-url 'postgres://bilbycast:<password>@localhost:5432/bilbycast'
```

Review the generated unit, then install and enable it:

```bash
sudo install -m 0644 /etc/bilbycast-manager/bilbycast-manager.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bilbycast-manager
```

`init` does **not** call `systemctl` itself — you install the unit explicitly so you can review it first. On the first `serve`, the manager applies every migration in `migrations-pg/` automatically.

For active/active HA installs, use `--mode ha-primary` and `--mode ha-standby`. See [Active/Active HA](/manager/active-active-ha/) for the operational details.

## 4. First login

Open `https://<manager-host>:8443/` in a browser. The `init` flow prints the bootstrap super-admin credentials at the end — sign in with them. For the self-signed cert, your browser will warn once; accept it for your local box.

From here:

- **Add nodes** at `/admin/nodes` — each issues a one-shot **registration token** to paste into the matching edge / relay / sidecar setup wizard.
- **Create groups** at `/admin/groups` — multi-tenant Groups, optional but recommended if you have more than one team.
- **Apply a license** at `/admin/license` — free tier supports a small number of nodes. HA, SSO, Backup, and Replay are paid features. Contact `contact@bilbycast.com`.

## TLS

The `init` flow gives you a self-signed cert that works for evaluation. For production, switch to one of three modes by editing `/etc/bilbycast-manager/manager.env`:

- **ACME / Let's Encrypt** — set `BILBYCAST_ACME_ENABLED=true` plus `BILBYCAST_ACME_DOMAIN` and `BILBYCAST_ACME_EMAIL`. The manager auto-provisions and renews. Needs port 80 reachable from the public internet for HTTP-01 validation.
- **File-based cert** — set `BILBYCAST_TLS_CERT` and `BILBYCAST_TLS_KEY` to your PEM paths.
- **Behind a load balancer** — set `BILBYCAST_TLS_MODE=behind_proxy` and trust your LB's forwarded headers via `BILBYCAST_TRUST_PROXY_HEADER` + `BILBYCAST_TRUSTED_PROXIES`.

Full detail: [TLS deployment](/manager/tls-deployment/).

## Manual install (advanced)

If you don't want the `init` flow, set the same secrets and run `setup` + `serve` by hand. The detailed steps and every environment variable are in the in-repo guide at `bilbycast-manager/installer/README.md`.

## Where to read next

- [Multi-tenant Groups](/manager/multi-tenant-groups/) — isolation and quotas for multi-team installs.
- [Active/Active HA](/manager/active-active-ha/) — two-node manager cluster.
- [Backup & restore](/manager/backup/) — operator-initiated config + secrets backup.
- [Security](/manager/security/) — auth, MFA, OIDC SSO, and the threat model.
- [Install an edge](/edge/getting-started/) — the next step in a fresh deployment.
