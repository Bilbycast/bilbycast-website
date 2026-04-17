---
title: Security
description: Authentication, encryption, and deployment security for bilbycast-manager.
sidebar:
  order: 3
---

## Architecture Overview

bilbycast-manager handles several categories of sensitive data:

- **User passwords** -- hashed with Argon2id, never stored in plaintext
- **JWT session tokens** -- signed with HMAC-SHA256 using `BILBYCAST_JWT_SECRET`
- **Node secrets** -- encrypted at rest using envelope encryption (AES-256-GCM with per-secret DEKs wrapped by domain-specific KEKs derived from `BILBYCAST_MASTER_KEY`)
- **AI API keys** -- encrypted at rest using envelope encryption (same scheme, separate domain key)
- **Configuration** -- non-secret settings stored in plaintext TOML

All cryptographic secrets are loaded from environment variables at startup. The server refuses to start if secrets are missing, empty, too short (< 16 characters), or contain known weak/default values.

---

## Secrets Management

### Environment Variables

Two secrets are **required** and must be set before starting the server:

| Variable              | Purpose                                           |
|-----------------------|---------------------------------------------------|
| `BILBYCAST_JWT_SECRET`| HMAC key for signing/verifying JWT session tokens  |
| `BILBYCAST_MASTER_KEY`| Passphrase for deriving domain-specific encryption keys (envelope encryption) |

Generate them with:

```bash
openssl rand -hex 32
```

These must **never** appear in `config/default.toml` or be committed to version control.

### Key Derivation

The `BILBYCAST_MASTER_KEY` passphrase is run through HKDF-SHA256 to produce domain-specific Key Encryption Keys (KEKs):

1. **Extract**: `HMAC-SHA256(salt, passphrase)` where salt = `bilbycast-manager-master-key-v1`
2. **Expand**: `HMAC-SHA256(PRK, domain_info || 0x01)` — one per domain

Four domains are used for key separation: `kek:node-secret`, `kek:ai-key`, `kek:tunnel`, `hmac:registration-token`. A compromised key in one domain does not affect others.

### Stored Secrets Encryption (Envelope Encryption)

All secrets are encrypted using **envelope encryption** before storage:

1. A random 32-byte Data Encryption Key (DEK) is generated per encryption operation
2. The plaintext is encrypted with the DEK using AES-256-GCM
3. The DEK is wrapped (encrypted) with the domain-specific KEK using AES-256-GCM
4. Both are stored together: `"v1:" + Base64(dek_nonce || encrypted_dek || data_nonce || ciphertext)`

**Key versioning**: The `"v1:"` prefix identifies the envelope format. Legacy data (no prefix) from before envelope encryption is decrypted transparently for backward compatibility.

### Master Key Rotation

The master encryption key can be rotated via the CLI without data loss:

```bash
BILBYCAST_NEW_MASTER_KEY=$(openssl rand -hex 32) bilbycast-manager rotate-master-key
```

This re-encrypts all secrets in the database under the new key in a single atomic transaction. The server must be stopped during rotation. After rotation, update `BILBYCAST_MASTER_KEY` to the new value and restart.

### .env File Permissions

The `.env` file contains the two master secrets and should be restricted:

```bash
chmod 600 .env
```

Ensure it is listed in `.gitignore`.

---

## User Authentication

### Password Hashing

User passwords are hashed with **Argon2id** (the default parameters from the `argon2` crate). Plaintext passwords are never stored or logged.

Password requirements:
- Minimum 8 characters, maximum 128 characters
- Must contain at least one uppercase letter, one lowercase letter, and one digit

### JWT Session Tokens

After successful login, the server issues a JWT containing:

| Claim | Content                          |
|-------|----------------------------------|
| `sub` | User ID                          |
| `role`| User role (e.g., `super_admin`)  |
| `jti` | Session ID (for revocation)      |
| `iat` | Issued-at timestamp              |
| `exp` | Expiration timestamp             |
| `iss` | `bilbycast-manager`              |

Tokens are signed with HMAC-SHA256 using `BILBYCAST_JWT_SECRET`. The issuer is validated on decode.

### Session Token Storage

The JWT is delivered **exclusively** via a `Set-Cookie` response header with the following flags:

```
session=<JWT>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400
```

- **HttpOnly** — prevents JavaScript from accessing the session token, mitigating XSS-based token theft
- **Secure** — cookie is only sent over HTTPS (omitted in `behind_proxy` mode since the LB handles TLS)
- **SameSite=Lax** — provides baseline CSRF protection at the browser level

The JWT is **never** included in the JSON response body. A separate non-httpOnly `csrf_token` cookie is set alongside it for CSRF protection (see below).

### Failed Login Auditing

Failed login attempts are logged to the audit trail with the attempted username and client IP address, enabling detection of brute-force and credential-stuffing attacks.

### Session Revocation

Logout invalidates the session server-side by adding the JWT's `jti` to the `revoked_sessions` table in SQLite. The auth middleware checks this table on every authenticated request, rejecting revoked tokens even if they have not yet expired. Expired revocation entries are periodically cleaned up.

### Login Rate Limiting

Login attempts are rate-limited per client IP address:

- **Threshold**: 5 attempts within a 60-second window
- **Response**: HTTP 429 Too Many Requests when exceeded
- **Recovery**: The window resets after 60 seconds

### Role-Based Access Control (RBAC)

Four roles are defined, in ascending privilege order:

| Role          | Level | Typical Permissions                                |
|---------------|-------|----------------------------------------------------|
| `viewer`      | 0     | Read-only access to dashboards and node status      |
| `operator`    | 1     | Start/stop flows, acknowledge events                |
| `admin`       | 2     | Create/delete nodes and users, manage settings      |
| `super_admin` | 3     | Full access including managing other admins          |

Permission checks enforce that the user's role level is >= the required level for the operation.

### Temporary Users

Users can be marked as temporary with an `expires_at` timestamp. Expired accounts are denied access at permission check time.

### CSRF Protection

CSRF tokens are generated as 32-character hex strings (128 bits of randomness). Verification uses constant-time comparison to prevent timing attacks.

At login, a CSRF token is set as a non-httpOnly `csrf_token` cookie with `Secure; SameSite=Lax` (so JavaScript can read it for the double-submit pattern). For all state-changing requests (POST, PUT, PATCH, DELETE) to authenticated endpoints, the auth middleware requires an `X-CSRF-Token` header whose value matches the `csrf_token` cookie.

The `logout` endpoint is in the authenticated router and therefore also requires a valid CSRF token.

### Username Enumeration Protection

The login endpoint always runs an Argon2id verification (against a dummy hash when the user doesn't exist) to equalize response timing, preventing attackers from discovering valid usernames via timing differences.

---

## Node Authentication

### Two-Stage Registration

Edge nodes authenticate with the manager using a two-stage process:

1. **Registration**: The manager administrator creates a node entry via the API, which generates a one-time registration token. The edge node connects to `/ws/node` and sends an `auth` message containing `registration_token`. On success, the manager responds with `register_ack` containing a permanent `node_id` and `node_secret`. The registration token is consumed and cannot be reused.

2. **Reconnection**: On subsequent connections, the edge node sends `node_id` and `node_secret` in the `auth` message. The manager decrypts the stored node secret and compares.

### Credential Transport

Node credentials are sent via the first WebSocket text frame after the connection is established -- **not** in URL query parameters. This prevents secrets from appearing in server access logs, proxy logs, or browser history.

### Rate Limiting

Failed authentication attempts are tracked per identifier (node_id or token prefix):

- **Threshold**: 5 failed attempts within a 60-second window
- **Lockout**: The identifier is locked out for the remainder of the 60-second window
- **Recovery**: Successful authentication clears the failure counter
- **Cleanup**: Expired tracking entries are periodically removed

### Node Secrets at Rest

Node secrets are encrypted using envelope encryption (random DEK wrapped with the `node-secret` domain KEK) before storage in the database. See "Stored Secrets Encryption" above for details.

---

## Transport Security

### TLS (HTTPS/WSS)

The manager supports two TLS modes, configured via `tls_mode` in the TOML config or `BILBYCAST_TLS_MODE` environment variable:

#### Direct Mode (`tls_mode = "direct"`, default)

The manager handles TLS itself. Requires a TLS certificate and private key:

```bash
BILBYCAST_TLS_CERT=/path/to/cert.pem
BILBYCAST_TLS_KEY=/path/to/key.pem
```

Or in TOML:

```toml
[tls]
cert_path = "certs/server.crt"
key_path = "certs/server.key"
```

TLS is provided by **rustls**. The server will refuse to start without valid TLS configuration in direct mode. Cookies include the `Secure` flag, and HSTS headers are sent on all responses.

#### Behind Proxy Mode (`tls_mode = "behind_proxy"`)

A load balancer or reverse proxy terminates TLS in front of the manager. The manager listens on plain HTTP/WS:

```toml
tls_mode = "behind_proxy"
```

Or via environment variable:

```bash
BILBYCAST_TLS_MODE=behind_proxy
```

In this mode:
- No TLS certificate or key is needed
- Cookies do **not** include the `Secure` flag (the LB's HTTPS ensures browser security)
- HSTS headers are **not** sent (the LB should handle HSTS)
- Edge/relay nodes still use `wss://` to connect to the load balancer's public address

**Security requirement:** The connection between the load balancer and the manager must be on a trusted network (localhost, private VLAN, Kubernetes pod network). Credentials and session tokens transit this link in plaintext.

### Self-Signed Certificate Detection

At startup, the manager parses the TLS certificate and detects whether it is self-signed (issuer == subject). If so:

- A warning is logged at startup
- The `/health` endpoint includes `"self_signed_cert": true`
- All UI pages display an amber warning banner linking to the Settings page
- The Settings page shows the certificate status with a "Self-Signed" badge

### Certificate Management

Three methods are available for TLS certificates, from most to least recommended:

**1. ACME / Let's Encrypt (recommended)** -- Automatic certificate provisioning and renewal. Private keys are generated on-server and never transmitted over the network. Requires port 80 accessible from the internet for HTTP-01 challenge validation. Configure via the TLS Settings page (`/admin/settings/tls`) or environment variables (`BILBYCAST_ACME_ENABLED`, `BILBYCAST_ACME_DOMAIN`, etc.). Certificates are hot-reloaded without server restart.

**2. File-based (certbot)** -- Manual certificate management via external tools like certbot. Configure cert/key paths via `BILBYCAST_TLS_CERT`/`BILBYCAST_TLS_KEY` environment variables. Server restart required to apply new certificates.

**3. Behind proxy** -- Load balancer terminates TLS. Set `BILBYCAST_TLS_MODE=behind_proxy`. No certificates needed on the manager.

API endpoints:
- **`GET /api/v1/settings/tls`** -- Returns current certificate info (subject, issuer, path, source, self-signed status)
- **`GET /api/v1/settings/acme`** -- Returns ACME status (enabled, domain, last error, cert expiry)
- **`POST /api/v1/settings/acme/configure`** -- Configure and enable ACME (domain, email, staging)
- **`POST /api/v1/settings/acme/renew`** -- Manually trigger certificate renewal
- **`POST /api/v1/settings/acme/disable`** -- Disable ACME

ACME security properties:
- Private keys generated on-server using ECDSA P-256, never transmitted
- ACME account key and domain key stored with 0600 permissions in `data/acme/`
- HTTP-01 challenge listener serves only `/.well-known/acme-challenge/` (no cookies, no auth)
- Atomic file writes prevent serving partial certificates
- Exponential backoff prevents Let's Encrypt rate limit exhaustion

### Edge and Relay Node Connections

Edge and relay nodes **must** connect using `wss://` URLs. Both clients enforce this at connection time and reject plaintext `ws://` URLs with a clear error message. This ensures all credentials and stats data are encrypted in transit.

### Self-Signed Certificate Acceptance (Development)

Edge and relay nodes can be configured to accept self-signed TLS certificates from the manager by setting `accept_self_signed_cert: true` in the `manager` section of their config files. This should **only** be used for development and testing -- it disables TLS certificate validation, making the connection vulnerable to MITM attacks.

```json
{
  "manager": {
    "enabled": true,
    "url": "wss://manager-host:8443/ws/node",
    "accept_self_signed_cert": true
  }
}
```

---

## API Security

### Authentication Requirements

All authenticated API endpoints require a valid JWT session cookie. The JWT is automatically sent by the browser as an httpOnly cookie. API clients may alternatively use an `Authorization: Bearer <token>` header.

State-changing requests (POST, PUT, PATCH, DELETE) also require a valid `X-CSRF-Token` header matching the `csrf_token` cookie.

Unauthenticated endpoints:

- `POST /api/v1/auth/login` -- obtain a session (rate-limited: 5 attempts/60s per IP)
- `POST /api/v1/auth/login-form` -- form-based login with redirect (rate-limited)
- `GET /health` -- health check

All other endpoints, including `POST /api/v1/auth/logout`, require authentication.

### UI Page Protection

All UI pages (except `/login`) are protected by a server-side auth guard middleware. Unauthenticated requests to any protected page are redirected to `/login?next=<original_path>`. The `next` parameter is validated against a strict character whitelist to prevent open redirect attacks.

### WebSocket Authentication

- **`/ws/node`** -- authenticated via a custom two-stage protocol (registration token or node credentials)
- **`/ws/dashboard`** -- requires a valid session cookie before the WebSocket upgrade is accepted

### Security Response Headers

All responses include the following security headers:

- `X-Content-Type-Options: nosniff` -- prevents MIME-type sniffing
- `X-Frame-Options: DENY` -- prevents clickjacking via iframes
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` -- enforces HTTPS for subsequent visits

### CORS

CORS is restricted to same-origin only. No CORS headers are sent, so cross-origin API requests are blocked by the browser.

### Tunnel Endpoint Authorization

Tunnel management endpoints enforce role-based access:

- `list_tunnels`, `get_tunnel`, `list_node_tunnels` -- require Operator role
- `create_tunnel`, `update_tunnel`, `delete_tunnel` -- require Admin role
- `list_node_tunnels` additionally checks node-level access via `allowed_node_ids`

### Tunnel End-to-End Encryption

Tunnel data is encrypted between edge nodes using ChaCha20-Poly1305 (AEAD) with a 32-byte shared key. The manager generates a random `tunnel_encryption_key` per tunnel, encrypts it at rest using envelope encryption (tunnel domain KEK), and pushes it to both edge nodes. The relay server is stateless and has no access to encryption keys -- it forwards opaque encrypted traffic by tunnel UUID. Even if an attacker connects to the relay and guesses a tunnel UUID, they cannot decrypt traffic or inject valid packets (AEAD authentication tag verification will fail).

### Node API Data Protection

The `registration_token` field is excluded from all node API responses to prevent credential exposure. It is only used internally during the registration flow.

---

## AI API Key Storage

AI provider API keys (OpenAI, Anthropic, etc.) are:

- Encrypted using envelope encryption (AI key domain KEK) before storage in the database
- Displayed as masked values (asterisks) in the UI
- Decrypted only when needed to make API calls to the provider

---

## What Is NOT Yet Implemented

The following security features are not currently present:

- **Mutual TLS (mTLS)** for node authentication -- nodes authenticate via WebSocket message, not client certificates
- **Hardware Security Module (HSM) support** -- master keys are stored in environment variables or `.env` files
- **Audit log signing** -- events are logged to the database but not cryptographically signed
- **IP allowlisting** for node connections -- any IP can attempt to connect to `/ws/node`
- **Content-Security-Policy (CSP) header** -- not yet configured; would further mitigate XSS risks
- **API rate limiting** -- only login and node auth endpoints are rate-limited; authenticated API endpoints are not
- **Import functionality** -- the `import` CLI command is defined but not yet implemented

---

## Recommendations for Production Deployment

1. **Provide TLS certificates** -- TLS is mandatory. Provide valid PEM certificate and key via `BILBYCAST_TLS_CERT` and `BILBYCAST_TLS_KEY`, or upload via the Settings page. Use `wss://` URLs for all edge and relay node connections (enforced by clients). Replace any self-signed certificates with CA-signed ones for production.

2. **Restrict `.env` permissions** -- `chmod 600 .env` and ensure it is owned by the service user.

3. **Use a reverse proxy** -- place the server behind nginx or similar for additional protection (request size limits, IP filtering).

4. **Rotate secrets periodically** -- generate new `BILBYCAST_JWT_SECRET` and `BILBYCAST_MASTER_KEY` values. Rotating `JWT_SECRET` invalidates all active sessions. Rotating `MASTER_KEY` is done via `bilbycast-manager rotate-master-key` (set `BILBYCAST_NEW_MASTER_KEY` in the environment, run the command, then update `BILBYCAST_MASTER_KEY` to the new value). This re-encrypts all stored secrets atomically.

5. **Back up the database** -- the SQLite database contains encrypted secrets, user accounts, and event history.

6. **Monitor logs** -- watch for repeated authentication failures, which may indicate brute-force attempts. Login rate limiting (5 attempts/60s per IP) provides automatic protection.

7. **Run as a non-root user** -- create a dedicated service account with minimal filesystem permissions.
