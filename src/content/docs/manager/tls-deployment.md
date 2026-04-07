---
title: TLS Deployment
description: How to run bilbycast-manager behind TLS — ACME / Let's Encrypt, file-based certs, and behind-proxy mode where a load balancer terminates TLS.
sidebar:
  order: 9
---

bilbycast-manager supports three TLS deployment modes. Pick the one that matches your environment:

| Mode | Who handles TLS | Best for |
|---|---|---|
| **ACME** (`direct` mode + `BILBYCAST_ACME_ENABLED=true`) | Manager — automatic Let's Encrypt | Public-internet manager with a stable DNS name |
| **File-based** (`direct` mode + `BILBYCAST_TLS_CERT`/`KEY`) | Manager — operator-supplied PEM files | Internal CAs, certbot-managed certs, hardware security modules |
| **Behind-proxy** (`BILBYCAST_TLS_MODE=behind_proxy`) | Load balancer / reverse proxy | Cloud deployments where the LB already terminates TLS |

All three modes serve the same ports and APIs — the only difference is *who* terminates TLS. Edge nodes always connect over `wss://` regardless of which mode you pick; plaintext `ws://` is rejected at the edge.

## ACME / Let's Encrypt (recommended)

The simplest path for any manager that has a stable public DNS name. The manager handles certificate issuance, renewal, and hot-reload internally — no certbot, no cron jobs, no operator action required after initial setup.

### Setup

```bash
export BILBYCAST_ACME_ENABLED=true
export BILBYCAST_ACME_DOMAIN=manager.example.com
export BILBYCAST_ACME_EMAIL=ops@example.com
export BILBYCAST_ACME_HTTP_PORT=80   # Default: 80; only needed if non-standard

# Standard secrets
export BILBYCAST_JWT_SECRET=$(openssl rand -hex 32)
export BILBYCAST_MASTER_KEY=$(openssl rand -hex 32)

bilbycast-manager serve
```

Requirements:

- Port **80** must be reachable from the internet for the HTTP-01 challenge. The manager spins up a temporary HTTP listener on this port for the duration of the challenge.
- Port **8443** (or whatever `BILBYCAST_PORT` is set to) must be reachable for the actual HTTPS service.
- The DNS name in `BILBYCAST_ACME_DOMAIN` must resolve to the manager's public IP.

### Renewal and hot-reload

The manager checks the cert for renewal needs daily. When the cert is within 30 days of expiry, it triggers a renewal in the background. **The new cert is hot-reloaded without restarting the manager** — active WebSocket connections stay up, and new connections immediately use the new cert.

Renewal failures are logged as `tls.renewal_failed` events. If renewal fails repeatedly and the cert reaches its expiry, new connections will fail; the manager keeps trying to renew until it succeeds.

### Backups

The ACME state — including the account key, the issued cert, and the renewal metadata — is stored under the manager's data directory (alongside the SQLite DB). Back this up if you don't want to re-issue from scratch after a manager rebuild.

## File-based certificates

Use this when:

- Your CA is internal (not Let's Encrypt).
- You're already using certbot or cert-manager and want to keep that workflow.
- You're behind an HSM or other key-storage mechanism that produces PEM files on disk.

### Setup

```bash
export BILBYCAST_TLS_CERT=/etc/bilbycast/manager.crt
export BILBYCAST_TLS_KEY=/etc/bilbycast/manager.key

# Standard secrets
export BILBYCAST_JWT_SECRET=$(openssl rand -hex 32)
export BILBYCAST_MASTER_KEY=$(openssl rand -hex 32)

bilbycast-manager serve
```

Both files must exist and be readable by the manager process. The manager validates them at startup and refuses to start if they're missing or unreadable.

### Renewal

bilbycast-manager **does not** watch the cert file for changes in this mode (yet). When you renew the cert, restart the manager process — for example, via your certbot deploy hook:

```bash
# /etc/letsencrypt/renewal-hooks/deploy/bilbycast-manager.sh
#!/bin/bash
systemctl restart bilbycast-manager
```

Active WebSocket connections will reconnect after the restart.

## Behind-proxy mode

Use this when a load balancer, reverse proxy, or service mesh is already terminating TLS for you and the manager just needs to listen on plain HTTP. Common in cloud deployments (AWS ALB, GCP HTTPS LB, nginx, Traefik, Envoy, etc.).

### Setup

```bash
export BILBYCAST_TLS_MODE=behind_proxy
export BILBYCAST_PORT=8080            # Plain HTTP port the manager listens on
# Do NOT set BILBYCAST_TLS_CERT or BILBYCAST_ACME_ENABLED in this mode

# Standard secrets
export BILBYCAST_JWT_SECRET=$(openssl rand -hex 32)
export BILBYCAST_MASTER_KEY=$(openssl rand -hex 32)

bilbycast-manager serve
```

The manager listens on plain HTTP. Your proxy is responsible for:

1. Terminating TLS with whatever cert the proxy uses.
2. Forwarding `wss://` upgrades correctly (the `Upgrade` and `Connection` headers must be passed through).
3. Setting `X-Forwarded-Proto: https` so the manager knows the original request was HTTPS (used for cookie `Secure` flag enforcement).
4. **Not** modifying the auth payload on the WebSocket upgrade.

### nginx example

```nginx
upstream bilbycast_manager {
  server 127.0.0.1:8080;
}

server {
  listen 443 ssl http2;
  server_name manager.example.com;

  ssl_certificate     /etc/letsencrypt/live/manager.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/manager.example.com/privkey.pem;

  location / {
    proxy_pass http://bilbycast_manager;
    proxy_http_version 1.1;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        "upgrade";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout                 3600s;
  }
}
```

The long `proxy_read_timeout` is important: WebSocket connections are long-lived and shouldn't be killed by the proxy mid-session.

## Self-signed certs in development

Self-signed certs are supported in **direct** mode for development only. When the manager detects it is serving a self-signed cert, the UI shows a banner warning operators and linking to **Settings → TLS** so they can replace it.

Edge nodes connecting to a self-signed manager need to explicitly opt in:

```json
// edge config.json
{
  "manager": {
    "url": "wss://manager.example.com",
    "accept_self_signed_cert": true
  }
}
```

And the edge process needs the `BILBYCAST_ALLOW_INSECURE=1` env var set, otherwise the config is rejected at load time. This is a deliberate safety guard against accidentally shipping self-signed mode to production.

**Better than self-signed in dev**: use cert pinning. Set `accept_self_signed_cert: false` and provide `cert_fingerprint` (the SHA-256 fingerprint of the manager's cert) on the edge side. The edge will validate the exact cert without trusting the system CA store.

## Security headers

All three modes serve the same security headers on every response:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |

In behind-proxy mode, you may also want to add HSTS at the proxy level to ensure browsers see it on all responses (including any served directly by the proxy).

## Migration between modes

You can switch between modes by changing env vars and restarting the manager. The data directory and SQLite DB are mode-independent — only the listener configuration changes. Edge nodes will automatically reconnect after the manager restart and continue using their existing credentials.

## Choosing a mode

| If... | Use |
|---|---|
| You have a public DNS name and don't want to think about renewal | **ACME** |
| You already manage certs with certbot, cert-manager, or an HSM | **File-based** |
| You're deploying in a cloud with an existing load balancer | **Behind-proxy** |
| You're running locally for development | Self-signed (`direct` mode without `BILBYCAST_TLS_CERT`) |
