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

Postgres listens on **5433** when you use the Docker compose below, or **5432** when you point at an existing cluster. Keep Postgres firewalled to the manager host only — never expose it to the public internet.

The full network map (edge ports, relay ports, ST 2110 multicast) is in [Deployment overview](/getting-started/deployment/).

## 1. Download

```bash
curl -fsSL -O https://github.com/Bilbycast/bilbycast-manager-releases/releases/latest/download/bilbycast-manager-x86_64-linux.tar.gz
curl -fsSL -O https://github.com/Bilbycast/bilbycast-manager-releases/releases/latest/download/bilbycast-manager-x86_64-linux.tar.gz.sha256
sha256sum -c bilbycast-manager-x86_64-linux.tar.gz.sha256
tar xzf bilbycast-manager-x86_64-linux.tar.gz
cd bilbycast-manager-*/
```

The tarball expands to a directory containing the `bilbycast-manager` binary, the `migrations-pg/` directory (applied automatically on first run), and `config/default.toml`. **The rest of this page assumes you're inside that directory.**

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

A successful verify prints `Verified OK`. The manifest then carries the SHA-256 of the tarball — cross-check against your downloaded `.sha256` if you're being thorough.

## 2. Bring up Postgres

Pick one path. The Docker path is fastest for evaluation; the existing-cluster path is the production pattern.

### Path A — Docker (recommended for evaluation)

If Docker isn't installed yet:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
```

You can either run `docker` via `sudo` (used throughout this page) or add yourself to the `docker` group: `sudo usermod -aG docker $USER` then log out + back in.

Pick a Postgres password for this install. The doc threads it through the compose file (step 2), the verify step (step 2), and the manager DSN (step 3) — change it once and everything downstream uses your value. **Never use this password outside localhost or for production.**

```bash
# Either pick one yourself, or generate a strong random one:
PG_PASSWORD="bilbycast_dev"                 # ← edit to whatever you want
# PG_PASSWORD="$(openssl rand -hex 16)"     # ← uncomment for a random 32-hex-char password
echo "Postgres password for this install: ${PG_PASSWORD}"
```

Write the compose file (unquoted `EOF` so `${PG_PASSWORD}` substitutes in), then bring Postgres up:

```bash
cat > docker-compose.dev.yml <<EOF
services:
  postgres:
    image: postgres:18-alpine
    container_name: bilbycast-manager-pg
    restart: unless-stopped
    environment:
      POSTGRES_DB: bilbycast
      POSTGRES_USER: bilbycast
      POSTGRES_PASSWORD: ${PG_PASSWORD}
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

# Full reset — removes any leftover container, every bilbycast_pg_data
# volume (regardless of which compose project created it), and the
# stale manager.env. Safe to run on a fresh VM (all lines no-op when
# nothing exists). REQUIRED on a retry — see note below.
sudo docker rm -f bilbycast-manager-pg 2>/dev/null || true
sudo docker compose -p bilbycast -f docker-compose.dev.yml down -v 2>/dev/null || true
sudo docker volume ls -q | grep bilbycast_pg_data | xargs -r sudo docker volume rm 2>/dev/null || true
rm -f manager.env

sudo docker compose -p bilbycast -f docker-compose.dev.yml up -d

# Wait (up to 60s) for the healthcheck to go green.
for i in $(seq 1 30); do
    state="$(sudo docker inspect --format='{{.State.Health.Status}}' bilbycast-manager-pg 2>/dev/null || echo missing)"
    [ "$state" = "healthy" ] && echo "Postgres healthy" && break
    sleep 2
done
[ "$state" = "healthy" ] || echo "WARNING: Postgres did not become healthy within 60s. Run 'sudo docker logs bilbycast-manager-pg' before continuing."
```

Confirm the container is up **and** the password actually works over TCP. A `psql` connection without `-h` would use the Unix socket — postgres:alpine maps that to `trust` auth, so it returns rows even on a wrong password. Forcing `-h localhost -p 5432` inside the container exercises the real TCP/`scram-sha-256` path the manager uses:

```bash
sudo docker ps --filter "name=bilbycast-manager-pg" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
sudo docker exec -e PGPASSWORD="${PG_PASSWORD}" bilbycast-manager-pg \
    psql -h localhost -p 5432 -U bilbycast -d bilbycast -c "SELECT 'ok' AS password_check;"
```

Expected: one row showing `bilbycast-manager-pg` `Up ... (healthy)`, ports `0.0.0.0:5433->5432/tcp`, and a `psql` row of `password_check | ok`.

> **If `psql` says `password authentication failed`** — a leftover Postgres volume from an earlier attempt got reused. The `POSTGRES_PASSWORD` env var is only honoured on **first** initialization of an empty data directory; reused volumes keep their original password. Re-run the teardown block above (the `docker volume ls ... grep bilbycast_pg_data ... volume rm` sweep is the line that fixes it) and then the `up -d`.

Your DSN is `postgres://bilbycast:${PG_PASSWORD}@localhost:5433/bilbycast`. You'll add it to `manager.env` in step 3 — keep this terminal open so `PG_PASSWORD` carries over.

### Path B — Existing Postgres cluster

Create a database and a role on your Postgres 18 cluster:

```bash
sudo -u postgres createuser --pwprompt bilbycast      # set a strong password
sudo -u postgres createdb -O bilbycast bilbycast
```

Then set a shell variable holding the full DSN — step 3 reads it:

```bash
MANAGER_DATABASE_URL="postgres://bilbycast:YOUR_PASSWORD@YOUR_HOST:5432/bilbycast"   # ← fill in
```

(Path A users skip this — step 3 builds the DSN from `PG_PASSWORD` automatically.)

## 3. Configure secrets and TLS

The manager needs two random 32-byte secrets in its environment:

- `BILBYCAST_JWT_SECRET` — signs session JWTs.
- `BILBYCAST_MASTER_KEY` — derives KEKs that encrypt every node secret, AI key, and tunnel key stored in the database.

Plus a TLS cert/key pair for `https://` on 8443. For evaluation we generate a self-signed cert; switch to ACME or a file-based cert from a real CA for production (see the [TLS](#tls) section below).

Generate everything into a `manager.env` file in the current directory:

```bash
# Self-signed TLS cert for evaluation.
# Optional: set MANAGER_HOSTNAME to the domain you'll use in your browser
# (e.g. "manager.example.com") so the cert covers it and Chrome doesn't
# complain about NET::ERR_CERT_COMMON_NAME_INVALID on top of the
# self-signed warning. Leave empty to omit.
mkdir -p certs
HOST_IP="$(hostname -I | awk '{print $1}')"
MANAGER_HOSTNAME=""   # set to "manager.example.com" etc. if you have one
SAN="DNS:localhost,IP:127.0.0.1,IP:${HOST_IP}${MANAGER_HOSTNAME:+,DNS:${MANAGER_HOSTNAME}}"
openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt \
  -days 365 -nodes -subj "/CN=${MANAGER_HOSTNAME:-${HOST_IP}}" \
  -addext "subjectAltName=${SAN}"
chmod 600 certs/server.key

# Resolve the DSN. Path A built PG_PASSWORD in step 2; Path B built
# MANAGER_DATABASE_URL directly. If only PG_PASSWORD is set, assume
# the Docker localhost:5433 shape.
: "${MANAGER_DATABASE_URL:=postgres://bilbycast:${PG_PASSWORD}@localhost:5433/bilbycast}"

# manager.env — secrets + DSN + cert paths, sourced before setup / serve
cat > manager.env <<EOF
BILBYCAST_JWT_SECRET=$(openssl rand -hex 32)
BILBYCAST_MASTER_KEY=$(openssl rand -hex 32)
BILBYCAST_DATABASE_URL=${MANAGER_DATABASE_URL}
BILBYCAST_TLS_CERT=$(pwd)/certs/server.crt
BILBYCAST_TLS_KEY=$(pwd)/certs/server.key
EOF
chmod 600 manager.env
```

### Load the env into your shell

So the next commands (setup, serve) see the secrets and the cert paths:

```bash
set -a; . ./manager.env; set +a
```

> **Don't lose `BILBYCAST_MASTER_KEY`.** It's what decrypts every node secret, AI key, and tunnel key in your database. If you lose it, those rows become unreadable. Back up `manager.env` to a secure location (password manager, sealed secret, etc.) before going further.

## 4. Create the database schema + first admin

The `setup` subcommand applies every migration in `migrations-pg/` and then prompts you for the first super-admin user.

```bash
# Reload manager.env defensively in case you opened a new shell between steps —
# setup reads BILBYCAST_DATABASE_URL/_JWT_SECRET/_MASTER_KEY from the environment.
set -a; . ./manager.env; set +a

# Bail out loudly if any required env var is empty rather than failing
# inside setup with a generic database/JWT error.
for v in BILBYCAST_DATABASE_URL BILBYCAST_JWT_SECRET BILBYCAST_MASTER_KEY; do
    if [ -z "${!v}" ]; then
        echo "ERROR: $v is empty after sourcing manager.env."
        echo "       Re-run step 3 (Configure secrets and TLS) so manager.env gets regenerated."
        return 1 2>/dev/null || exit 1
    fi
done
echo "Connecting as: $BILBYCAST_DATABASE_URL"

./bilbycast-manager setup --config config/default.toml
```

You'll see this prompt sequence:

```
=== bilbycast-manager Setup ===

Super admin username:        # what you'll log in with (e.g. admin)
Display name:                # shown in the UI (e.g. Operations)
Email (optional):            # press Enter to skip
Password:                    # 8–128 chars, must mix upper, lower, and digit
Confirm password:            # re-type the same password
```

On success, the binary prints:

```
Super admin user 'admin' created successfully (ID: ...).
Enrolled 'admin' in the default group as Admin.
You can now start the server with: bilbycast-manager serve
```

> **Re-running `setup`** is a no-op — it prints `Database already has 1 user(s).` and exits. To recover from a forgotten admin password, use `./bilbycast-manager reset-password --username <name>` instead.

## 5. Start the manager

Two ways to run — pick one. The foreground path is right for evaluation; the systemd path is right for any host you want to keep running across reboots.

### Quick — foreground

Useful for evaluation, demos, and debugging. Runs in your terminal; Ctrl-C to stop:

```bash
# Reload manager.env defensively in case you opened a new shell
set -a; . ./manager.env; set +a

./bilbycast-manager serve --config config/default.toml
```

The first boot applies any migrations the binary added since the tarball was built (no-op on a fresh install — setup already did them). You should see a line like `listening on 0.0.0.0:8443 and [::]:8443` once it's ready.

To run it in the background across SSH disconnects, use `tmux` or `screen`. For a real production install, use systemd (next section).

### Production — systemd

The doc-quality systemd setup creates a dedicated service user, copies the binary out of your home directory, and locks down filesystem access. Run from inside the extracted tarball directory:

```bash
# 1. Service user + install paths
sudo useradd --system --no-create-home --shell /usr/sbin/nologin bilbycast || true
sudo mkdir -p /opt/bilbycast-manager /var/lib/bilbycast-manager /etc/bilbycast-manager
sudo cp -r ./* /opt/bilbycast-manager/
sudo chown -R bilbycast:bilbycast /opt/bilbycast-manager /var/lib/bilbycast-manager

# 2. Move the secrets file under /etc with root:bilbycast 0640,
#    then rewrite the TLS paths to point at the /opt copy
#    (the originals are under your home dir, which the service user can't read).
sudo install -m 0640 -o root -g bilbycast manager.env /etc/bilbycast-manager/manager.env
sudo sed -i \
  -e 's|^BILBYCAST_TLS_CERT=.*|BILBYCAST_TLS_CERT=/opt/bilbycast-manager/certs/server.crt|' \
  -e 's|^BILBYCAST_TLS_KEY=.*|BILBYCAST_TLS_KEY=/opt/bilbycast-manager/certs/server.key|' \
  /etc/bilbycast-manager/manager.env

# 3. Systemd unit
sudo tee /etc/systemd/system/bilbycast-manager.service > /dev/null <<'EOF'
[Unit]
Description=Bilbycast Manager
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=bilbycast
Group=bilbycast
EnvironmentFile=/etc/bilbycast-manager/manager.env
WorkingDirectory=/opt/bilbycast-manager
ExecStart=/opt/bilbycast-manager/bilbycast-manager serve --config /opt/bilbycast-manager/config/default.toml
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/var/lib/bilbycast-manager
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
EOF

# 4. Enable + start, then verify
sudo systemctl daemon-reload
sudo systemctl enable --now bilbycast-manager
sudo systemctl status bilbycast-manager --no-pager
```

`systemctl status` should show `active (running)`. If it's `failed`, the most likely causes are:

- **Postgres unreachable** — confirm the DSN in `/etc/bilbycast-manager/manager.env` matches the running Postgres. For Docker users: container started after the manager? `sudo systemctl restart bilbycast-manager`.
- **Permission on TLS cert** — the service runs as `bilbycast`, so `BILBYCAST_TLS_CERT` / `_KEY` must be readable by that user. The `cp -r ./* /opt/bilbycast-manager/` + `chown` above handles this for the self-signed cert under `certs/`.
- **Port 8443 already bound** — `sudo ss -ltnp | grep 8443` will show the conflict.

Logs: `sudo journalctl -u bilbycast-manager -f`.

## 6. First login

Open the manager in a browser:

- On the box itself: `https://localhost:8443/`
- From elsewhere: `https://<box-ip-or-dns>:8443/`

Browsers will warn on the self-signed cert. In Chrome / Chromium / Edge, click **Advanced → Proceed anyway**, or — if the warning page has no "Proceed" link (a recent Chrome quirk) — focus the page and type `thisisunsafe` (it doesn't show up; just press the letters). In Firefox, click **Advanced → Accept the Risk and Continue**.

Sign in with the admin credentials you set in step 4. From here:

- **Add nodes** at `/admin/nodes` — each issues a one-shot **registration token** to paste into the matching edge / relay / sidecar setup wizard.
- **Create groups** at `/admin/groups` — multi-tenant Groups, optional but recommended if you have more than one team.
- **Apply a license** at `/admin/license` — free tier supports a small number of nodes. HA, SSO, Backup, and Replay are paid features. Contact `contact@bilbycast.com`.

## TLS

The self-signed cert from step 3 works for evaluation. For production, switch to a real cert in one of three modes:

- **ACME / Let's Encrypt** — recommended for any public-internet manager with a stable DNS name. Configure from the **manager UI** (Settings → TLS / ACME — see the [ACME walkthrough](#acme--lets-encrypt-walkthrough) below) or via env vars for declarative provisioning. The manager auto-issues and auto-renews. Needs a public DNS record + inbound TCP 80 reachable.
- **File-based cert** — set `BILBYCAST_TLS_CERT` and `BILBYCAST_TLS_KEY` to PEM paths from your own CA (internal PKI, manual certbot, HSM-backed keys).
- **Behind a load balancer** — set `BILBYCAST_TLS_MODE=behind_proxy` and your LB terminates TLS.

Full detail (including the file-based and behind-proxy setup blocks): [TLS deployment](/manager/tls-deployment/).

### ACME / Let's Encrypt walkthrough

Replaces the self-signed cert from step 3 with a real Let's Encrypt cert that browsers trust out of the box. Once enabled, the manager auto-renews ~30 days before expiry — set and forget.

**Prerequisites** — all four must be true; otherwise issuance fails and the manager keeps serving the self-signed fallback.

1. The manager is already running on `https://<vm-ip>:8443/` and you can log in (step 6 completed).
2. A public **DNS A record** (and ideally AAAA for IPv6) for the hostname you'll request — e.g. `manager.example.com` → your VM's public IP. Verify with `dig +short manager.example.com` against `curl -s https://api.ipify.org` from the VM; they must match. If your DNS is behind a CDN/proxy (Cloudflare's orange cloud, etc.), set it to "DNS only" or Let's Encrypt's challenge won't reach the manager.
3. **Inbound TCP port 80** reachable from the public internet (Let's Encrypt's HTTP-01 challenge connects on 80). Check the cloud provider's security group / firewall. From your laptop: `curl -v http://manager.example.com/ --max-time 5` — `308 Permanent Redirect` from the manager is fine; a *timeout* means the firewall is blocking.
4. An **email address** for the Let's Encrypt account (renewal failure alerts).

#### Recommended — UI

Easiest for one-off installs and the only path that lets you watch ACME status live without tailing the journal.

1. Sign in to the manager at `https://<vm-ip>:8443/` (or `https://localhost:8443/` if you SSH-tunnelled).
2. Go to **Settings → TLS / ACME** (under the admin area).
3. Tick **Enable Let's Encrypt**.
4. Fill in **Domain** (the FQDN you set up DNS for) and **Contact email**.
5. Leave **Use staging environment** unticked unless you're testing the plumbing (staging certs are valid but not trusted by browsers — see [TLS deployment](/manager/tls-deployment/) for when to use it).
6. Click **Save**.

The manager kicks off issuance immediately. Status flips to **Requesting → Active** in the UI within ~10 seconds when issuance succeeds. The new cert hot-reloads into the TLS listener — no restart, no operator action.

Verify the live cert from the VM:

```bash
echo | openssl s_client -servername <your-domain> -connect <your-domain>:8443 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates
```

`issuer=… O = Let's Encrypt, CN = E…` confirms the real cert is being served. Then in your browser open `https://<your-domain>:8443/` in a **private window** (your earlier session may have cached the self-signed cert exception) — you should see the green lock.

#### Alternative — declarative env vars

For Ansible / Terraform / Docker-Compose / CI provisioning where the manager should boot straight into ACME with no UI step. Same outcome as the UI path; you're setting the same DB-backed fields, just from the environment instead.

Pick the block for your install mode in step 5:

##### Foreground install

```bash
# 1. Stop the foreground serve (Ctrl-C in its terminal).
# 2. Drop self-signed cert lines, add ACME lines to the manager.env in your tarball dir.
sed -i '/^BILBYCAST_TLS_CERT=/d; /^BILBYCAST_TLS_KEY=/d' manager.env
cat >> manager.env <<'EOF'
BILBYCAST_ACME_ENABLED=true
BILBYCAST_ACME_DOMAIN=REPLACE_WITH_YOUR_DOMAIN   # e.g. manager.acme-corp.com
BILBYCAST_ACME_EMAIL=REPLACE_WITH_YOUR_EMAIL     # e.g. ops@acme-corp.com
BILBYCAST_ACME_DIR=/var/lib/bilbycast-manager/acme
EOF

sudo mkdir -p /var/lib/bilbycast-manager/acme
sudo chown -R "$USER":"$USER" /var/lib/bilbycast-manager/acme

set -a; . ./manager.env; set +a
sudo -E ./bilbycast-manager serve --config config/default.toml   # sudo -E to bind port 80
```

##### Systemd install

```bash
sudo systemctl stop bilbycast-manager
sudo sed -i '/^BILBYCAST_TLS_CERT=/d; /^BILBYCAST_TLS_KEY=/d' /etc/bilbycast-manager/manager.env
sudo tee -a /etc/bilbycast-manager/manager.env > /dev/null <<'EOF'
BILBYCAST_ACME_ENABLED=true
BILBYCAST_ACME_DOMAIN=REPLACE_WITH_YOUR_DOMAIN
BILBYCAST_ACME_EMAIL=REPLACE_WITH_YOUR_EMAIL
BILBYCAST_ACME_DIR=/var/lib/bilbycast-manager/acme
EOF

sudo mkdir -p /var/lib/bilbycast-manager/acme
sudo chown -R bilbycast:bilbycast /var/lib/bilbycast-manager/acme

sudo systemctl start bilbycast-manager
sudo journalctl -u bilbycast-manager -f
```

#### UI vs env vars — pick one source of truth

Env vars **override** the UI for `_ENABLED` / `_DOMAIN` / `_EMAIL` / `_STAGING` at boot. If you set both, the UI form appears to do nothing — silently. If you started with env vars and want to switch to UI-managed (so the form is live), remove **only those four** env lines:

```bash
# Systemd
sudo sed -i '/^BILBYCAST_ACME_ENABLED=/d; /^BILBYCAST_ACME_DOMAIN=/d; /^BILBYCAST_ACME_EMAIL=/d; /^BILBYCAST_ACME_STAGING=/d' /etc/bilbycast-manager/manager.env
sudo systemctl restart bilbycast-manager

# Foreground: same sed against `manager.env`, then re-run serve
```

**Keep `BILBYCAST_ACME_DIR`** in the env file. That one's env-only — there's no DB fallback for it — and the systemd unit's hardened filesystem (`ProtectSystem=strict`) makes the default location (`data/acme` under the working dir) read-only. Removing `BILBYCAST_ACME_DIR` makes the manager forget where the cert lives and fall back to self-signed at next boot.

The cert files themselves live in `BILBYCAST_ACME_DIR` (`/var/lib/bilbycast-manager/acme/`) and survive the env cleanup — you're only changing where future config (domain/email/etc.) comes from.

**Watch for these log lines** to confirm issuance:

```
ACME enabled for domain manager.example.com
Listening on 0.0.0.0:80 (ACME HTTP-01 challenge)
Listening on 0.0.0.0:8443 and [::]:8443
ACME challenge received from <let's-encrypt-ip>
ACME certificate issued, valid until <date>
```

Then open `https://manager.example.com:8443/` from a browser — you should see a valid green-lock cert with no self-signed warning. The cert renews automatically; you don't have to touch this again.

**If issuance fails** the manager logs the precise error from the ACME challenge and falls back to the self-signed cert so you can still log in and debug. The most common causes are: DNS A record not yet propagated, port 80 still blocked by the security group, or Let's Encrypt's rate limit hit (5 duplicate certs per 7 days — use the staging environment by setting `BILBYCAST_ACME_STAGING=true` while iterating).

## Upgrading

The manager ships an operator-run upgrade script. It downloads the latest signed `manifest.json` + `manifest.sig.bundle`, verifies the Sigstore signature against the publishing workflow's identity (auto-installing cosign with checksum verification if it isn't already on the host), pulls the matching tarball, verifies SHA-256 against the signed manifest, atomically swaps the binary with a `.previous` backup, restarts the systemd unit, polls `/health`, and **auto-rolls back** to the previous binary on a failed health probe.

The simplest path is curl-pipe-bash from the latest release:

```bash
curl -fsSL https://github.com/Bilbycast/bilbycast-manager-releases/releases/latest/download/upgrade-manager.sh \
    | sudo bash
```

Operators who'd rather review the script first can grab it once and re-run it as needed:

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

The script expects the systemd path from step 5 (`bilbycast-manager.service`, binary at `/opt/bilbycast-manager/`). For a foreground install, just download a fresh tarball, replace the old `bilbycast-manager` binary in place, and restart `serve` — migrations apply automatically on the next boot. Don't re-run `setup` on an existing install (it bails when users exist; use `reset-password` or `rotate-master-key` for those workflows).

Pass `--help` for every flag, including `--service`, `--binary-path`, `--health-url`, `--health-timeout`, `--no-rollback`, and `--no-verify-cosign` (for air-gapped boxes that can't install cosign).

## Going further

The single-host install above is the right shape for evaluation, lab work, and small deployments. As your install grows, layer on these:

- [TLS deployment modes](/manager/tls-deployment/) — switch from the self-signed cert to **ACME / Let's Encrypt**, an operator-supplied PEM, or **behind-proxy** mode where a load balancer terminates TLS.
- [Active / Active HA](/manager/active-active-ha/) — run two manager instances against a **shared Postgres cluster** for zero-downtime failover, rolling deploys, and geographic redundancy. Assumes you've already provisioned a redundant Postgres (streaming replication, managed Postgres, Patroni, etc.) — that piece is out of scope for this guide but any standard Postgres 18 HA topology works.
- [Backup & restore](/manager/backup/) — operator-initiated encrypted backup of config + secrets, with an advisory-locked `pg_dump` that's safe across an HA pair.
- [Multi-tenant Groups](/manager/multi-tenant-groups/) — isolation and quotas for multi-team installs.
- [Security](/manager/security/) — auth, MFA, OIDC SSO, threat model.
- [Install an edge](/edge/getting-started/) — the next step in a fresh deployment.
