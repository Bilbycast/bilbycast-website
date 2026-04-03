---
title: Security Architecture
description: Comprehensive security architecture across all bilbycast components.
sidebar:
  order: 1
---

This document describes the security model, cryptographic choices, and threat mitigations across the bilbycast system.

## Overview

Bilbycast uses defense-in-depth with multiple independent security layers:

- **TLS 1.3** (Rustls) for all manager connections — no legacy cipher suites
- **End-to-end encryption** (ChaCha20-Poly1305) for tunnel traffic — relay is zero-knowledge
- **Encryption at rest** (AES-256-GCM) for all secrets on manager and edge nodes
- **Role-based access control** (4-level RBAC) on the manager
- **Audit logging** for all security-relevant operations
- **Certificate pinning** to protect against compromised CAs
- **Secret rotation** for node authentication credentials

## Transport Security

### TLS Enforcement

Edge and relay nodes **enforce `wss://`** (TLS) for all manager connections. Plaintext `ws://` URLs are rejected at connection time. The TLS implementation uses Rustls with TLS 1.3 only — no fallback to older protocols or weak cipher suites.

### Manager TLS Modes

| Mode | Config | Description |
|------|--------|-------------|
| **Direct** (default) | `BILBYCAST_TLS_MODE=direct` | Manager handles TLS. Requires `BILBYCAST_TLS_CERT` and `BILBYCAST_TLS_KEY`. Sets `Secure` cookie flag and sends HSTS headers. |
| **Behind Proxy** | `BILBYCAST_TLS_MODE=behind_proxy` | Load balancer terminates TLS. Manager listens on plain HTTP. Omits `Secure` flag and HSTS (LB handles these). Only safe on trusted networks between LB and manager. |

### Certificate Pinning

Edge and relay nodes support optional **SHA-256 certificate fingerprint pinning** via the `cert_fingerprint` config field:

```json
"manager": {
  "url": "wss://manager:8443/ws/node",
  "cert_fingerprint": "ab:cd:ef:01:23:45:67:89:..."
}
```

When configured, connections are rejected if the server presents a certificate with a different fingerprint — even if that certificate has a valid CA signature. This protects against compromised Certificate Authorities and targeted MITM attacks.

The pinning verifier performs **both** standard CA chain validation **and** fingerprint verification.

### Self-Signed Certificate Mode

For development/testing, nodes can set `accept_self_signed_cert: true`. This mode **completely disables** all certificate validation and is protected by a dual safety mechanism:

1. **Environment variable guard**: Requires `BILBYCAST_ALLOW_INSECURE=1` to be set — without it, the connection fails with a clear error
2. **Startup warning**: Logs a prominent `SECURITY WARNING` on every connection

This prevents accidental production use when the flag is left in a config file from testing.

## Authentication

### Manager UI Authentication

| Aspect | Implementation |
|--------|---------------|
| **Password hashing** | Argon2id (via `argon2` crate) |
| **Password requirements** | 8-128 chars, must contain uppercase + lowercase + digit |
| **Session tokens** | JWT with HMAC-SHA256, 24-hour expiry |
| **JWT claims** | `sub` (user ID), `role`, `jti` (session ID), `iat`, `exp`, `iss` ("bilbycast-manager") |
| **Session delivery** | `HttpOnly` + `Secure` + `SameSite=Lax` cookie |
| **Session revocation** | Logout inserts `jti` into `revoked_sessions` table; checked on every request |
| **CSRF protection** | Double-submit cookie pattern with constant-time comparison; header-only fallback for self-signed cert environments |
| **Timing safety** | Dummy Argon2id hash computed on unknown usernames to prevent user enumeration |

### Node Authentication (Edge/Relay to Manager)

Two-phase authentication over WebSocket:

**Phase 1 — Registration** (one-time):
1. Admin creates a node in the manager UI, receives a registration token
2. Token is stored in the DB as an **HMAC-SHA256 hash** (never plaintext)
3. Edge/relay sends the token as the first WebSocket frame
4. Manager verifies by computing HMAC and comparing to stored hash
5. Manager generates a UUID node secret, encrypts with AES-256-GCM, stores in DB
6. Manager sends `register_ack` with `node_id` + `node_secret`
7. Token is consumed (set to NULL) — single-use, cannot be replayed

**Phase 2 — Reconnection** (ongoing):
1. Edge/relay sends `node_id` + `node_secret` as first WebSocket frame
2. Manager decrypts stored secret, compares
3. Returns `auth_ok` on match

### Relay REST API Authentication

Optional Bearer token auth via `api_token` config field (32-128 characters). When configured, all API endpoints except `/health` require `Authorization: Bearer <token>`. If absent, the API is open (backwards compatible; warning logged at startup).

### Edge REST API Authentication

OAuth 2.0 `client_credentials` grant at `/oauth/token`. Returns JWT (HMAC-SHA256) with configurable expiry (default 1 hour). Used by external systems integrating with the edge's REST API.

## Encryption at Rest

### Manager Database

All sensitive data is encrypted before storage using **AES-256-GCM**:

| Data | DB Column | Algorithm |
|------|-----------|-----------|
| Node auth secrets | `auth_client_secret_enc` | AES-256-GCM |
| Tunnel encryption keys | `tunnel_key_enc` | AES-256-GCM |
| Tunnel bind secrets | `tunnel_bind_secret_enc` | AES-256-GCM |
| Tunnel PSKs | `tunnel_psk_enc` | AES-256-GCM |
| AI API keys | `api_key_enc` | AES-256-GCM |
| Registration tokens | `registration_token` | HMAC-SHA256 hash (one-way) |

**Key derivation**: HKDF-SHA256 from `BILBYCAST_MASTER_KEY` with salt `"bilbycast-manager-master-key-v1"`. The master key must be a 64-character hex string (32 bytes). Weak values are rejected at startup.

**Nonce management**: 12 random bytes per encryption operation, prepended to ciphertext.

### Edge Node Secrets

Edge nodes store infrastructure secrets (node credentials, tunnel encryption keys, TLS/auth config) in a separate `secrets.json` file, **encrypted at rest** using AES-256-GCM with a machine-specific key. Flow-level user parameters (SRT passphrases, RTSP credentials, RTMP keys, bearer tokens) remain in `config.json` for manager UI visibility.

| Priority | Key Source | Availability |
|----------|-----------|--------------|
| 1 | `/etc/machine-id` | All systemd-based Linux (Ubuntu, Debian, RHEL, Fedora, Arch) |
| 2 | `/var/lib/dbus/machine-id` | Older Linux without systemd |
| 3 | Generated `.secrets_key` file | macOS (development), containers, other environments |

**Key derivation**: HKDF-SHA256 with salt `"bilbycast-edge-secrets-v1"`.

**File format**: `v1:` prefix + Base64(nonce + ciphertext). The version prefix enables future format changes. Files written with Unix mode `0600` (owner read/write only).

**Backward compatibility**: Existing unencrypted `secrets.json` files are auto-detected and re-encrypted on the next save.

## Tunnel Security

### End-to-End Encryption

All tunnel traffic between edge nodes is encrypted with **ChaCha20-Poly1305** (AEAD):

- **Key size**: 256 bits (32 bytes), generated by the manager
- **Nonce**: 12 random bytes per packet
- **Auth tag**: 16 bytes (128 bits)
- **Overhead**: 28 bytes per packet (12 nonce + 16 tag)

The relay server **cannot decrypt tunnel traffic** — it only sees encrypted payloads. This is a zero-knowledge relay architecture.

### Relay Tunnel Authentication

Optional per-tunnel HMAC-SHA256 bind tokens:

1. Manager generates a `tunnel_bind_secret` (32 random bytes)
2. Computes directional tokens: `HMAC-SHA256(secret, "tunnel_id:ingress")` and `HMAC-SHA256(secret, "tunnel_id:egress")`
3. Sends tokens to relay via `authorize_tunnel` command
4. Edge nodes include their bind token in `TunnelBind` messages
5. Relay validates with constant-time comparison

### Direct Mode QUIC Authentication

Direct mode tunnels (edge-to-edge, no relay) use a per-tunnel PSK (pre-shared key) for QUIC transport authentication. The PSK is 32 random bytes, generated by the manager and distributed to both edges.

## Secret Rotation

Node authentication secrets can be rotated via the manager API:

```
POST /api/v1/nodes/{id}/rotate-secret
```

**Flow**:
1. Manager generates a new UUID secret
2. Sends `RotateSecret` command to node via active WebSocket
3. Node stores new secret locally (persisted to encrypted `secrets.json`)
4. Node sends `command_ack`
5. Manager updates DB with new encrypted secret
6. Old secret is immediately invalidated

**Requirements**: The node must have an active WebSocket connection. The endpoint requires Admin role.

## Access Control

### Role-Based Access Control (RBAC)

4-level permission hierarchy:

| Role | Level | Capabilities |
|------|-------|-------------|
| **Viewer** | 0 | Read-only access to dashboards and node status |
| **Operator** | 1 | Viewer + manage flows, send commands to nodes |
| **Admin** | 2 | Operator + manage nodes, users, and system settings |
| **SuperAdmin** | 3 | Admin + manage other admins, full system control |

Each user can optionally have an `allowed_node_ids` list restricting access to specific nodes. If null/empty, the user can access all nodes within their role permissions.

## Rate Limiting

| Target | Limit | Window | Key | Response |
|--------|-------|--------|-----|----------|
| Login attempts | 5 failures | 60 seconds | IP address | HTTP 429 |
| Node auth attempts | 5 failures | 60 seconds | node_id or token prefix | WebSocket auth error + lockout message |

Rate limiters use in-memory sliding windows (DashMap). Windows expire automatically after the cooldown period.

## Security Headers

All manager HTTP responses include:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing |
| `X-Frame-Options` | `DENY` | Prevents clickjacking (iframe embedding) |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Forces HTTPS (direct TLS mode only) |

Session cookies use `HttpOnly` (no JavaScript access), `Secure` (HTTPS only, in direct mode), and `SameSite=Lax`.

## Input Validation

All entry points validate inputs before processing:

| Category | Limits |
|----------|--------|
| **String fields** | IDs: 64 chars, names: 256 chars, URLs: 2048 chars, tokens: 4096 chars |
| **API payloads** | Config: 100 KB, commands/flows: 50 KB |
| **WebSocket messages** | 5 MB per node message |
| **Event fields** | Message: 10K chars, category: 256 chars |
| **Network addresses** | Socket address format validation, URL scheme validation |
| **SRT parameters** | Range checks on all advanced params (overhead, buffer sizes, etc.) |

SQL injection is prevented by using parameterized queries (SQLx `.bind()`) throughout — no string interpolation in SQL statements.

## Audit Logging

All security-relevant mutations are logged to the `audit_log` table:

- User authentication (login, logout, failed login)
- Node operations (create, delete, config update, secret rotation)
- Flow management (create, update, delete)
- User management (create, update role, delete)
- Settings changes

Each entry records: timestamp, user ID, action, target type, target ID, optional details, and IP address.

## Threat Model

| Threat | Mitigation | Status |
|--------|-----------|--------|
| Network MITM (standard) | TLS 1.3 via Rustls on all connections | Protected |
| Compromised CA | Certificate pinning (`cert_fingerprint`) | Protected (when configured) |
| Stolen DB backup | All secrets encrypted with AES-256-GCM | Protected |
| Compromised edge host | `secrets.json` encrypted at rest with machine-specific key | Protected |
| Compromised relay | Zero-knowledge — ChaCha20-Poly1305 E2E encryption | Protected |
| Token replay | Registration tokens are single-use, consumed on first auth | Protected |
| Brute force login | Argon2id + rate limiting (5/60s) + lockout | Protected |
| Brute force node auth | Rate limiting (5/60s) + lockout per node_id | Protected |
| Session hijacking | HttpOnly+Secure cookies, CSRF double-submit, JWT revocation | Protected |
| User enumeration | Constant-time dummy hash on unknown usernames | Protected |
| Stale credentials | Secret rotation API (`rotate-secret`) | Mitigatable |
| Self-signed cert MITM | `BILBYCAST_ALLOW_INSECURE=1` env var guard + startup warning | Guarded |
| Behind-proxy interception | Internal LB-to-manager link is HTTP | Risk accepted (trusted network assumption) |

## Production Security Checklist

- [ ] Set `BILBYCAST_JWT_SECRET` to a unique 64-char hex string (`openssl rand -hex 32`)
- [ ] Set `BILBYCAST_MASTER_KEY` to a unique 64-char hex string (`openssl rand -hex 32`)
- [ ] Use CA-signed TLS certificates (not self-signed)
- [ ] Remove `accept_self_signed_cert: true` from all production configs
- [ ] Do **not** set `BILBYCAST_ALLOW_INSECURE=1` in production
- [ ] Configure `cert_fingerprint` on edge and relay nodes for certificate pinning
- [ ] Set `api_token` on relay servers (32-128 char Bearer token)
- [ ] Configure `auth` section on edge nodes if they expose a REST API
- [ ] Use `direct` TLS mode unless behind a trusted load balancer
- [ ] Rotate node secrets periodically via `POST /api/v1/nodes/{id}/rotate-secret`
- [ ] Set node expiry times (`expires_at`) for temporary deployments
- [ ] Review audit logs regularly (`GET /api/v1/audit`)
- [ ] Restrict user permissions with appropriate RBAC roles
- [ ] Use `allowed_node_ids` to limit operator access to relevant nodes only

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BILBYCAST_JWT_SECRET` | Yes (manager) | 64-char hex string for JWT HMAC-SHA256 signing |
| `BILBYCAST_MASTER_KEY` | Yes (manager) | 64-char hex string for AES-256-GCM encryption at rest |
| `BILBYCAST_TLS_CERT` | Yes (direct mode) | Path to TLS certificate PEM file |
| `BILBYCAST_TLS_KEY` | Yes (direct mode) | Path to TLS private key PEM file |
| `BILBYCAST_TLS_MODE` | No | `"direct"` (default) or `"behind_proxy"` |
| `BILBYCAST_ALLOW_INSECURE` | No | Set to `"1"` to allow `accept_self_signed_cert` (dev/testing only) |
| `BILBYCAST_PORT` | No | Override manager listen port (default 8443) |
