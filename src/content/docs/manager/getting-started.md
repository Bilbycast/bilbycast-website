---
title: Install the Manager
description: Download, install, and run bilbycast-manager.
sidebar:
  order: 2
---

The manager is the central control plane — a Postgres-backed Rust binary that serves the web UI, the REST API, and the WebSocket endpoint that edges and relays connect to. Deploy it first; everything else attaches to it.

This page walks through a **single-host install** — manager + Postgres on one Linux box. That's the right shape for evaluation, lab / testbed work, and small single-tenant deployments. For production patterns (LB-terminated TLS, two-instance HA against shared Postgres, redundant Postgres), see [Going further](#going-further) at the end.

## What you'll need

- A Linux host (Ubuntu 24.04 / Debian 12 or newer recommended). A 2 vCPU / 4 GB RAM VM is plenty for evaluation.
- A reachable **Postgres 18** cluster — or just Docker on the same host (we'll bring one up in step 2).
- A DNS name or static IP your operators can hit on TCP 8443.
- About 10 minutes.

The manager binary is statically linked against musl, so the host distribution doesn't matter much beyond having a recent kernel. `x86_64` is the supported architecture today.

## Ports & firewall

The manager listens on a small fixed set of ports. Open these inbound on the manager host:

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| **8443** | TCP (HTTPS + WSS) | Operator browsers, every edge / relay / gateway site | Web UI, REST API, device WebSocket. Override port with `BILBYCAST_PORT`. |
| **80** | TCP (HTTP) | Public internet | Only when `BILBYCAST_ACME_ENABLED=true` — used for the ACME HTTP-01 challenge. Close it otherwise. |

All control connections from edges, relays, and gateway sidecars are **outbound to the manager** over `wss://`. Devices behind NAT or restrictive firewalls don't need any inbound port — that's the whole point of the design.

**Dual-stack (IPv4 + IPv6) is the default.** The manager binds `0.0.0.0` and `[::]` simultaneously on every listener (8443 plus the ACME challenge port). IPv6 entries get `IPV6_V6ONLY=1` so the two families coexist on the same port without colliding. Operators with v6 connectivity get it automatically — just point an AAAA record at the box alongside the A record. To restrict to one family, set `BILBYCAST_LISTEN_ADDRS=0.0.0.0` (v4 only) or `BILBYCAST_LISTEN_ADDRS=[::]` (v6 only); the ACME challenge listener has its own companion `BILBYCAST_ACME_LISTEN_ADDRS` with the same shape.

Postgres listens on **5432** (or `5433` if you use the Docker compose file below). Keep it firewalled to the manager host only — never expose Postgres to the public internet.

The full network map (edge ports, relay ports, ST 2110 multicast) is in [Deployment overview](/getting-started/deployment/).

## 1. Download

```bash
curl -fsSL -O https://github.com/Bilbycast/bilbycast-manager-releases/releases/latest/download/bilbycast-manager-x86_64-linux.tar.gz
curl -fsSL -O https://github.com/Bilbycast/bilbycast-manager-releases/releases/latest/download/bilbycast-manager-x86_64-linux.tar.gz.sha256
sha256sum -c bilbycast-manager-x86_64-linux.tar.gz.sha256
tar xzf bilbycast-manager-x86_64-linux.tar.gz
```

The tarball expands to a directory containing the `bilbycast-manager` binary, the `migrations-pg/` directory (applied automatically on first run), and `config/default.toml`.

### Verify the Sigstore signature (optional)

Every release ships a Sigstore-signed `manifest.json` alongside the tarball. The `sha256sum -c` step above catches mid-transfer corruption; verifying the signature additionally proves the manifest was published by the Bilbycast release workflow on a tagged commit.

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
curl -fsSL -O https://github.com/Bilbycast/bilbycast-manager-releases/releases/latest/download/manifest.json
curl -fsSL -O https://github.com/Bilbycast/bilbycast-manager-releases/releases/latest/download/manifest.sig.bundle

cosign verify-blob \
  --bundle manifest.sig.bundle \
  --certificate-identity-regexp 'https://github.com/Bilbycast/bilbycast-manager/.github/workflows/nightly-release.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  manifest.json
```

The bundled [`upgrade-manager.sh`](#upgrading) auto-installs cosign on demand with the same checksum verification — you only need to install it by hand when verifying the very first install.

A successful verify prints `Verified OK`. The manifest then carries the SHA-256 of the tarball — cross-check against your downloaded `.sha256` if you're being thorough. The same Sigstore-signed manifest drives the [upgrade flow](#upgrading) below, so this is the verifier's main checkpoint.

## 2. Postgres

Pick one:

**Docker (fastest for evaluation / local VM)** — inside the extracted directory, write a minimal compose file and bring it up:

```bash
cat > docker-compose.dev.yml <<'EOF'
services:
  postgres:
    image: postgres:18-alpine
    container_name: bilbycast-manager-pg
    restart: unless-stopped
    environment:
      POSTGRES_DB: bilbycast
      POSTGRES_USER: bilbycast
      POSTGRES_PASSWORD: bilbycast_dev
    ports:
      - "5433:5432"
    volumes:
      - bilbycast_pg_data:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U bilbycast -d bilbycast"]
      interval: 2s
      timeout: 5s
      retries: 10

volumes:
  bilbycast_pg_data:
EOF
docker compose -f docker-compose.dev.yml up -d
```

This brings up Postgres 18 on `localhost:5433` with the default DSN baked into `config/default.toml`. No further DB setup needed — `init` in step 3 will probe it automatically. This is the recommended path if you're spinning up a test VM, a lab box, or a small single-tenant deployment. **Dev-only credentials** — never expose this Postgres beyond localhost and never reuse `POSTGRES_PASSWORD: bilbycast_dev` for production.

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

## Upgrading

The manager ships an operator-run upgrade script. It downloads the latest signed `manifest.json` + `manifest.sig.bundle`, verifies the Sigstore signature against the publishing workflow's identity (auto-installing cosign with checksum verification if it isn't already on the host), pulls the matching tarball, verifies SHA-256 against the signed manifest, atomically swaps the binary with a `.previous` backup, restarts the systemd unit, polls `/health`, and **auto-rolls back** to the previous binary on a failed health probe.

The simplest path is curl-pipe-bash from the latest release:

```bash
curl -fsSL https://github.com/Bilbycast/bilbycast-manager-releases/releases/latest/download/upgrade-manager.sh \
    | sudo bash
```

Operators who'd rather review the script first can grab it once and re-run it as needed (it's the same script that ships in the source repo at `packaging/upgrade-manager.sh`):

```bash
curl -fsSL -o upgrade-manager.sh \
    https://github.com/Bilbycast/bilbycast-manager-releases/releases/latest/download/upgrade-manager.sh
chmod +x upgrade-manager.sh
sudo ./upgrade-manager.sh                        # apply latest stable
sudo ./upgrade-manager.sh --dry-run              # download + verify only; print plan
sudo ./upgrade-manager.sh --target-version 0.45.4
sudo ./upgrade-manager.sh --drain-secs 60        # HA pair: graceful drain via the
                                                 # `bilbycast-manager upgrade --drain-secs`
                                                 # CLI before the binary swap
```

Migrations apply automatically on every `serve` boot, so a successful binary swap + restart is a complete upgrade — no separate migration step. Pass `--help` for every flag, including `--service`, `--binary-path`, `--health-url`, `--health-timeout`, `--no-rollback`, and `--no-verify-cosign` (for air-gapped boxes that can't install cosign).

## Going further

The single-host install above is the right shape for evaluation, lab work, and small deployments. As your install grows, layer on these:

- [TLS deployment modes](/manager/tls-deployment/) — switch from the self-signed cert to **ACME / Let's Encrypt**, an operator-supplied PEM, or **behind-proxy** mode where a load balancer terminates TLS.
- [Active / Active HA](/manager/active-active-ha/) — run two manager instances against a **shared Postgres cluster** for zero-downtime failover, rolling deploys, and geographic redundancy. Assumes you've already provisioned a redundant Postgres (streaming replication, managed Postgres, Patroni, etc.) — that piece is out of scope for this guide but any standard Postgres 18 HA topology works.
- [Backup & restore](/manager/backup/) — operator-initiated encrypted backup of config + secrets, with an advisory-locked `pg_dump` that's safe across an HA pair.
- [Multi-tenant Groups](/manager/multi-tenant-groups/) — isolation and quotas for multi-team installs.
- [Security](/manager/security/) — auth, MFA, OIDC SSO, threat model.
- [Install an edge](/edge/getting-started/) — the next step in a fresh deployment.
