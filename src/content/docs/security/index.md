---
title: Security Architecture
description: Comprehensive security architecture across all bilbycast components.
sidebar:
  order: 1
---

This document describes the security model, cryptographic choices, and threat mitigations across the bilbycast system.

## Overview

Bilbycast uses defense-in-depth with multiple independent security layers:

- **TLS 1.3 or TLS 1.2** (Rustls) for all manager connections — no legacy protocol versions, no weak cipher suites
- **End-to-end encryption** (ChaCha20-Poly1305) for tunnel traffic — relay is zero-knowledge
- **Encryption at rest** (AES-256-GCM) for all secrets on manager and edge nodes
- **Role-based access control** on the manager — a two-value platform role plus per-group member roles
- **Audit logging** for all security-relevant operations
- **Certificate pinning** to protect against compromised CAs
- **Secret rotation** for node authentication credentials

## Transport Security

### TLS Enforcement

Edge and relay nodes **enforce `wss://`** (TLS) for all manager connections. Plaintext `ws://` URLs are rejected at connection time. The TLS implementation uses Rustls, which negotiates TLS 1.3 or TLS 1.2 — rustls implements neither TLS 1.0/1.1 nor any weak cipher suite, so there is no fallback below that. QUIC tunnels are TLS 1.3 by construction.

### Manager TLS Modes

| Mode | Config | Description |
|------|--------|-------------|
| **Direct** (default) | `BILBYCAST_TLS_MODE=direct` | Manager handles TLS. Three cert sources, tried in that order: an ACME/Let's Encrypt certificate (`BILBYCAST_ACME_ENABLED=true` + `BILBYCAST_ACME_DOMAIN`, recommended), a file-based pair (`BILBYCAST_TLS_CERT` + `BILBYCAST_TLS_KEY`), or a self-signed fallback generated while ACME is still issuing. Sets `Secure` cookie flag and sends HSTS headers. See [TLS deployment](/manager/tls-deployment/). |
| **Behind Proxy** | `BILBYCAST_TLS_MODE=behind_proxy` | Load balancer terminates TLS. Manager listens on plain HTTP. Omits `Secure` flag and HSTS (LB handles these). Only safe on trusted networks between LB and manager. |

### Certificate Pinning

Edge and relay nodes support optional **SHA-256 certificate fingerprint pinning** via the `cert_fingerprint` config field:

```json
"manager": {
  "urls": ["wss://manager:8443/ws/node"],
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
| **Session revocation** | Logout inserts `jti` into `revoked_sessions`, evicts the session-cache entry on the serving instance, and broadcasts `SESSION_INVALIDATE` to peer instances. Authenticated requests are served from a 5-minute session cache, so the table is re-read on a cache miss and whenever a cached entry has aged past `session_cache_freshness_secs` (Settings → Advanced, default 60 s; `0` disables the floor). If an HA peer misses the broadcast, that floor bounds how long the revoked session stays live there |
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

| Data | DB Column | Algorithm | KEK domain |
|------|-----------|-----------|------------|
| Node auth secrets | `auth_client_secret_enc` | AES-256-GCM | `kek:node-secret` |
| Tunnel encryption keys | `tunnel_key_enc` | AES-256-GCM | `kek:tunnel` |
| Tunnel bind secrets | `tunnel_bind_secret_enc` | AES-256-GCM | `kek:tunnel` |
| Tunnel PSKs | `tunnel_psk_enc` | AES-256-GCM | `kek:tunnel` |
| AI API keys | `api_key_enc` | AES-256-GCM | `kek:ai-key` |
| MFA TOTP secrets | `totp_secret_enc` | AES-256-GCM | `kek:user-mfa` |
| MFA recovery codes | `mfa_recovery_codes_enc` | AES-256-GCM | `kek:user-mfa` |
| Node config snapshots (config history) | `config_json_enc` | AES-256-GCM | `kek:config-history` |
| Visual-editor draft base configs | `base_config_enc` | AES-256-GCM | `kek:config-history` |
| Visual-editor deployment configs | `desired_config_enc` | AES-256-GCM | `kek:config-history` |
| AI Configurator thread messages | `content_json_enc` | AES-256-GCM | `kek:ai-thread` |
| Registration tokens | `registration_token` | HMAC-SHA256 hash (one-way) | `hmac:registration-token` |

The three `kek:config-history` blobs each hold a captured node configuration, which carries flow credentials (SRT passphrases, RTSP/RTMP credentials) inside the blob — that is what the domain is for.

**Envelope encryption**: Each secret is encrypted with a random 32-byte Data Encryption Key (DEK) using AES-256-GCM. The DEK is then wrapped with a domain-specific Key Encryption Key (KEK), also via AES-256-GCM. This limits the blast radius if any single key is compromised.

**Domain separation**: KEKs are derived via HKDF-SHA256 from `BILBYCAST_MASTER_KEY` (salt: `"bilbycast-manager-master-key-v1"`) with domain-specific info strings — seven of them: `kek:node-secret`, `kek:ai-key`, `kek:tunnel`, `hmac:registration-token`, `kek:user-mfa`, `kek:config-history`, `kek:ai-thread`. A compromised key in one domain does not affect others.

**Key versioning**: Ciphertext is prefixed with `"v1:"` to identify the envelope format. Legacy blobs (no prefix) from pre-envelope versions are decrypted transparently using an undifferentiated legacy key.

**Storage format**: `"v1:" + Base64(dek_nonce[12] || encrypted_dek[48] || data_nonce[12] || ciphertext)`. The master key must be a 64-character hex string (32 bytes). Weak values are rejected at startup.

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

### Node Secret Rotation

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

### Master Key Rotation

The master encryption key can be rotated using the CLI:

```bash
BILBYCAST_NEW_MASTER_KEY=$(openssl rand -hex 32) bilbycast-manager rotate-master-key
```

**Flow**:
1. Stop the manager server
2. Set `BILBYCAST_NEW_MASTER_KEY` in the environment
3. Run `bilbycast-manager rotate-master-key`
4. All encrypted secrets (node secrets, AI API keys, tunnel keys/PSKs/bind secrets, MFA TOTP secrets, recovery code blobs) are decrypted with the old key and re-encrypted with the new key in a single atomic Postgres transaction
5. Update `BILBYCAST_MASTER_KEY` to the new value in your `.env` file
6. Remove `BILBYCAST_NEW_MASTER_KEY` from the environment
7. Restart the server

**Note**: Pending registration tokens (HMAC hashes) are invalidated during rotation because the HMAC key changes. Regenerate tokens for any pending nodes after rotation.

## Access Control

### Role-Based Access Control (RBAC)

Access control runs on two orthogonal axes, not one ladder.

**Platform role** is global and has exactly two values. `super_admin` is the company running the manager: it bypasses every group filter and is the only role allowed to touch platform-only chokepoints (creating and deleting groups, user accounts, TLS, SSO, licensing, backup export/import, master-key rotation). `user` is every other account and confers no intrinsic rights — all authority comes from its group memberships. This is the value carried in the JWT `role` claim.

**Member role** is held per group membership, in ascending order:

| Role | Level | Capabilities |
|------|-------|-------------|
| `viewer` | 0 | Read-only access to dashboards and node status |
| `operator` | 1 | Create, edit and delete flows, inputs and outputs; start/stop flows; activate inputs; acknowledge events |
| `admin` | 2 | Operator + create, edit and delete nodes, and manage the group's membership |

One user can hold different member roles in different groups — Admin in one, Viewer in another.

A membership can optionally carry an `allowed_node_ids` list restricting *that* membership to specific nodes. Unset means the membership reaches every node in its group; an empty list admits none. The list lives on `group_members`, not on the user.

Full detail: [Manager security](/manager/security/) and [Multi-tenant Groups](/manager/multi-tenant-groups/).

## Rate Limiting

| Target | Limit | Window | Key | Response |
|--------|-------|--------|-----|----------|
| Login attempts | 5 failures | 60 seconds | IP address | HTTP 429 |
| Node auth attempts | 5 failures | 60 seconds | node_id or token prefix | WebSocket auth error + lockout message |
| MFA (TOTP) verification | 5 failures | 60 seconds | user ID | HTTP 429 |

All three limiters keep their sliding windows in Postgres — login in `login_auth_failures`, node auth in `node_auth_failures`, MFA in `user_mfa_attempts` — so a lockout survives a restart and applies across every instance sharing that database. A brute-forcer cannot multiply the budget by round-robining instances.

What differs is the failure mode when Postgres itself is unreachable. The login and node-auth limiters **fail open**: the attempt is allowed, or the identifier is treated as not locked out, so a database blip cannot brick the auth path. On the login side the per-account backstop (`users.failed_login_count` + `locked_until`) still applies on the slower path. The MFA limiter **fails closed** — if the lookup errors the attempt is refused, rather than being treated as zero recent failures. It is the only brute-force brake on the second factor: `/api/v1/auth/mfa/verify` is the step that completes a login and so is reachable without a session, where the per-IP login limiter does not cover it, and a wrong TOTP code does not increment the account's failed-login count.

## Security Headers

All manager HTTP responses include:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevents MIME-type sniffing |
| `X-Frame-Options` | `DENY` | Prevents clickjacking (iframe embedding) |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | Forces HTTPS for 2 years, and is eligible for the browser preload list (direct TLS mode only — behind a proxy the load balancer sends it) |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'; report-uri /api/v1/csp-report` | **Enforcing**, not report-only. `script-src 'self'` with no `unsafe-inline` blocks inline script and inline event handlers; `connect-src 'self'` blocks cross-origin fetch and WebSocket. Violations are still posted to the built-in collector |

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

## Release integrity

Binaries are trusted by **Sigstore keyless signing**, not by a long-lived signing key. The release workflow signs each `manifest.json` — which binds `(version, channel, sequence)` to a `(arch, variant) → url + sha256` table — with an ephemeral key; a Fulcio certificate binds that signature to the workflow run, and the signing event is recorded in the public Rekor transparency log.

Before installing anything, a node chains the certificate to a Fulcio root, checks the Rekor inclusion proof, matches the certificate's workflow identity against its own compiled-in `ALLOWED_SIGNERS` allowlist (per binary, so one product's release workflow cannot sign another's), verifies the signature over the manifest bytes, and only then downloads the tarball and rechecks the SHA-256 the verified manifest names. A fully compromised manager can schedule an upgrade but cannot choose what code runs.

See [Remote upgrade — trust model](/manager/remote-upgrade/) for the full chain, and [Verify the Sigstore signature](/edge/getting-started/#verify-the-sigstore-signature-optional) for the manual `cosign verify-blob` recipe.

## Threat Model

| Threat | Mitigation | Status |
|--------|-----------|--------|
| Network MITM (standard) | TLS 1.3 or 1.2 via Rustls on all connections (QUIC tunnels are TLS 1.3) | Protected |
| Compromised CA | Certificate pinning (`cert_fingerprint`) | Protected (when configured) |
| Stolen DB backup | All secrets encrypted with AES-256-GCM | Protected |
| Compromised edge host | `secrets.json` encrypted at rest with machine-specific key | Protected |
| Compromised relay | Zero-knowledge — ChaCha20-Poly1305 E2E encryption | Protected |
| Token replay | Registration tokens are single-use, consumed on first auth | Protected |
| Tampered or substituted release binary | Sigstore keyless manifest signature verified against the per-binary compiled-in `ALLOWED_SIGNERS` allowlist (Fulcio workflow identity + Rekor inclusion), then the SHA-256 taken from the signed manifest | Protected |
| Brute force login | Argon2id + rate limiting (5/60s) + lockout | Protected |
| Brute force node auth | Rate limiting (5/60s) + lockout per node_id | Protected |
| Session hijacking | HttpOnly+Secure cookies, CSRF double-submit, JWT revocation | Protected (revocation is immediate on the serving instance; an HA peer that misses the broadcast is bounded by `session_cache_freshness_secs`) |
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
- [ ] Verify the release manifest signature with `cosign` before a manual install
- [ ] Review audit logs regularly (`GET /api/v1/audit-log`, or the Audit Log page at `/admin/audit-log`)
- [ ] Restrict user permissions with appropriate RBAC roles
- [ ] Use a group membership's `allowed_node_ids` to limit operator access to relevant nodes only

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BILBYCAST_JWT_SECRET` | Yes (manager) | 64-char hex string for JWT HMAC-SHA256 signing |
| `BILBYCAST_MASTER_KEY` | Yes (manager) | 64-char hex string for AES-256-GCM encryption at rest |
| `BILBYCAST_TLS_CERT` | Conditional (direct mode, file-based certs only) | Path to TLS certificate PEM file. Must be set together with `BILBYCAST_TLS_KEY` — half a pair is refused at startup. Not needed when ACME is enabled |
| `BILBYCAST_TLS_KEY` | Conditional (direct mode, file-based certs only) | Path to TLS private key PEM file. Must be set together with `BILBYCAST_TLS_CERT` |
| `BILBYCAST_TLS_MODE` | No | `"direct"` (default) or `"behind_proxy"` |
| `BILBYCAST_ALLOW_INSECURE` | No | Set to `"1"` to allow `accept_self_signed_cert` (dev/testing only) |
| `BILBYCAST_PORT` | No | Override manager listen port (default 8443) |
