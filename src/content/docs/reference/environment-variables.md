---
title: Environment Variables
description: Environment variables used across bilbycast components.
sidebar:
  order: 1
---

## Manager Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BILBYCAST_JWT_SECRET` | Yes | 64-char hex string (32 bytes) for JWT signing |
| `BILBYCAST_MASTER_KEY` | Yes | 64-char hex string (32 bytes) for AES-256-GCM encryption at rest |
| `BILBYCAST_TLS_CERT` | Conditional | TLS certificate PEM path (file-based TLS mode) |
| `BILBYCAST_TLS_KEY` | Conditional | TLS private key PEM path (file-based TLS mode) |
| `BILBYCAST_TLS_MODE` | No | `"direct"` (default) or `"behind_proxy"` |
| `BILBYCAST_ACME_ENABLED` | No | Enable automatic Let's Encrypt certificates (`true`/`false`) |
| `BILBYCAST_ACME_DOMAIN` | Conditional | Domain for ACME certificate (required if ACME enabled) |
| `BILBYCAST_ACME_EMAIL` | No | Contact email for Let's Encrypt |
| `BILBYCAST_ACME_HTTP_PORT` | No | Port for HTTP-01 challenge (default: 80) |
| `BILBYCAST_PORT` | No | Override listen port (default: 8443) |
| `BILBYCAST_DATABASE_URL` | No | SQLite path override |

## Edge and Relay Variables

| Variable | Description |
|----------|-------------|
| `BILBYCAST_ALLOW_INSECURE` | Set to `"1"` to allow `accept_self_signed_cert` in manager connection config. Safety guard against accidental use in production. |
| `RUST_LOG` | Log level control (e.g., `bilbycast_edge=info`, `bilbycast_relay=debug`) |

## Generating Secrets

```bash
# Generate JWT secret (64-char hex = 32 bytes)
openssl rand -hex 32

# Generate master key (64-char hex = 32 bytes)
openssl rand -hex 32
```

Both secrets are validated at startup — weak or short values are rejected.
