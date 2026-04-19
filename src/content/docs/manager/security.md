---
title: Security
description: Authentication, encryption, and deployment security for bilbycast-manager.
sidebar:
  order: 3
---

## Architecture Overview

bilbycast-manager handles several categories of sensitive data:

- **User passwords** — hashed with Argon2id, never stored in plaintext
- **JWT session tokens** — signed with HMAC-SHA256 using `BILBYCAST_JWT_SECRET`
- **Node secrets** — encrypted at rest with authenticated envelope encryption
- **AI API keys** — encrypted at rest with authenticated envelope encryption
- **Tunnel keys** — encrypted at rest, never exposed to the relay
- **Configuration** — non-secret settings stored in plaintext TOML

All cryptographic secrets are loaded from environment variables at startup. The server refuses to start if secrets are missing, empty, too short (< 16 characters), or contain known weak/default values.

Full cryptographic design details — key derivation, domain separation, envelope formats, backup file layout — are provided to commercial licensees under NDA.

---

## Secrets Management

### Environment Variables

Two secrets are **required** and must be set before starting the server:

| Variable              | Purpose                                           |
|-----------------------|---------------------------------------------------|
| `BILBYCAST_JWT_SECRET`| HMAC key for signing/verifying JWT session tokens  |
| `BILBYCAST_MASTER_KEY`| Root secret from which per-domain encryption keys are derived |

Generate them with:

```bash
openssl rand -hex 32
```

These must **never** appear in `config/default.toml` or be committed to version control.

### Stored Secrets Encryption

All stored secrets (node credentials, tunnel keys, AI provider keys, MFA material) are encrypted with authenticated encryption using per-domain keys derived from the master secret. Each secret is wrapped with its own per-record data key so compromise of any individual record does not affect others. Different classes of secret use distinct derived keys so a breach in one domain cannot decrypt another. Ciphertexts carry a version prefix so the format can evolve without breaking existing deployments.

### Master Key Rotation

The master encryption key can be rotated via the CLI without data loss:

```bash
BILBYCAST_NEW_MASTER_KEY=$(openssl rand -hex 32) bilbycast-manager rotate-master-key
```

This re-encrypts all secrets in the database under the new key in a single atomic transaction. The server must be stopped during rotation.

### .env File Permissions

The `.env` file contains the master secrets and should be restricted:

```bash
chmod 600 .env
```

Ensure it is listed in `.gitignore`.

---

## User Authentication

### Password Hashing

User passwords are hashed with **Argon2id**. Plaintext passwords are never stored or logged.

Password requirements:
- Minimum 8 characters, maximum 128 characters
- Must contain at least one uppercase letter, one lowercase letter, and one digit

### Self-Service Password Change

Authenticated users can change their own password via the "My Account" page. The endpoint verifies the current password before accepting the new one, re-runs the complexity rules, and re-issues a fresh session cookie so the caller stays signed in. Changing a password instantly signs the user out of every other browser session.

### Per-Account Login Lockout

In addition to the per-IP rate limiter, each user account has its own failed-login counter: 5 consecutive failed password attempts trigger a 15-minute lockout. While locked, login is rejected with identical response timing to a normal failure, so the lock status is not observable to attackers.

### JWT Session Tokens

After successful login, the server issues a JWT signed with HMAC-SHA256. The token is delivered **exclusively** via an `HttpOnly; Secure; SameSite=Lax` cookie — never in the response body. A separate non-httpOnly `csrf_token` cookie is set alongside it for CSRF protection.

### Session Revocation

Logout invalidates the session server-side so revoked tokens are rejected on every subsequent request even before their natural expiration.

### Login Rate Limiting

Login attempts are rate-limited per client IP address: 5 attempts within a 60-second window, then HTTP 429 until the window resets.

### Role-Based Access Control (RBAC)

Four roles are defined, in ascending privilege order:

| Role          | Level | Typical Permissions                                |
|---------------|-------|----------------------------------------------------|
| `viewer`      | 0     | Read-only access to dashboards and node status      |
| `operator`    | 1     | Start/stop flows, acknowledge events                |
| `admin`       | 2     | Create/delete nodes and users, manage settings      |
| `super_admin` | 3     | Full access including managing other admins          |

### Temporary Users

Users can be marked as temporary with an `expires_at` timestamp. Expired accounts are denied access at permission check time.

### CSRF Protection

CSRF tokens are 128 bits of randomness and compared in constant time. State-changing requests must include an `X-CSRF-Token` header matching the `csrf_token` cookie that is set at login.

### Username Enumeration Protection

The login endpoint always runs an Argon2id verification (against a dummy hash when the user doesn't exist) to equalize response timing, preventing attackers from discovering valid usernames via timing differences.

---

## Multi-Factor Authentication (TOTP)

Users can enroll a TOTP (RFC 6238) second factor compatible with any authenticator app. TOTP is implemented in pure Rust — no C dependencies.

Enrollment is a two-step flow: generate a fresh secret and scan the QR code, then confirm with a 6-digit code to finalise. On success the server returns 10 single-use recovery codes, shown exactly once; only hashes are persisted.

When an MFA-enrolled user signs in with password, the server returns a short-lived challenge token rather than a session. The client completes login by posting the challenge plus a TOTP (or recovery) code. Per-user TOTP verification is rate-limited independently of the IP-based login limiter.

Disabling MFA requires **both** the current password and a valid TOTP (or recovery code), so neither a stolen cookie alone nor a stolen password alone can turn it off.

When a user logs in via OIDC SSO, the IdP is responsible for enforcing MFA — the bilbycast TOTP step is skipped.

---

## Single Sign-On (OIDC)

bilbycast-manager supports SSO via OpenID Connect Authorization Code flow with PKCE. Verified against Keycloak, Authentik, Okta, Auth0, Azure AD, and Google Workspace. Local password login continues to work alongside SSO (hybrid mode) so admins always have a break-glass path.

> **SSO is a licensed feature.** A valid SSO configuration without an SSO-granting license logs a warning and disables SSO without failing startup, so a license downgrade cannot brick the server.

The flow is:

1. User clicks **Sign in with SSO** on `/login` (only rendered when SSO is enabled on the server).
2. The manager starts a PKCE-protected OIDC flow with the configured IdP.
3. On callback, the ID token is fully validated (signature, issuer, audience, expiration, nonce).
4. Strict provisioning — the manager **does not auto-create users from SSO**. An admin must pre-create a local user whose email matches the IdP's verified email claim; the first SSO login binds the IdP identity to that user row.
5. On success, the same session cookie + CSRF cookie used by local login are issued.

Optional role sync maps IdP group claims onto local roles on every login.

---

## License and Paid Features

The manager has a signed-license model used for both hard limits (maximum node count) and for enabling optional paid features (such as SSO and Encrypted Backup & Restore). Licenses are cryptographically signed; the manager detects and refuses tampered or forged tokens. License state is refreshed periodically so a license that expires while the server is running takes effect automatically.

Gated endpoints return machine-readable errors that the UI uses to render a uniform upgrade banner. Rotating or removing a license never bricks a running install.

Signing-key handling, token format, and tamper-detection mechanics are intentionally not documented publicly.

---

## Encrypted Backups

Encrypted backup and restore is available under the `backup` commercial feature.

- **Full fidelity.** Every persisted table round-trips, including users, nodes, tunnels, managed flows, AI keys, settings, audit logs, events, topology positions, and UI preferences.
- **Cross-machine portable.** Secrets are unsealed on the source and resealed on the destination so the backup file is bound only to the operator-supplied passphrase, not to any one machine.
- **Confidential at rest.** Sealed with authenticated encryption and a memory-hard key derivation function applied to the operator-supplied passphrase. Passphrases must be at least 12 characters; lost passphrases mean lost data.
- **Safe restore.** Runs in a single atomic transaction — any failure leaves the destination untouched. Refuses a non-empty destination by default.

Ephemeral runtime state (sessions, PTP cache, OIDC login state, etc.) is intentionally never exported.

Operators can export / restore from `/admin/settings` in the UI or via the `bilbycast-manager export` / `import` CLI commands.

---

## Node Authentication

### Two-Stage Registration

Managed devices (edge nodes, relay servers, API gateways) authenticate using a two-stage process:

1. **Registration**: The administrator creates a node entry, which generates a one-time registration token. The device presents the token on `/ws/node` and receives a permanent identifier + secret.
2. **Reconnection**: On subsequent connections, the device presents its stored identifier and secret.

Credentials are sent inside the authenticated WebSocket channel, never in URL query parameters. Failed attempts are rate-limited per identifier and node secrets are encrypted at rest. Registration tokens are never stored in plaintext.

---

## Transport Security

### TLS (HTTPS/WSS)

The manager supports two TLS modes:

#### Direct Mode (default)

The manager handles TLS itself via **rustls** (pure Rust). Requires a TLS certificate and private key (`BILBYCAST_TLS_CERT` / `BILBYCAST_TLS_KEY`). Cookies include the `Secure` flag and HSTS headers are sent on all responses.

#### Behind Proxy Mode

A load balancer terminates TLS in front of the manager. The manager listens on plain HTTP/WS. Cookies do **not** include the `Secure` flag and HSTS is not sent (the LB is expected to provide them). The LB-to-manager link must be on a trusted network.

### Self-Signed Certificate Detection

At startup, the manager detects self-signed certificates and surfaces a warning banner in the UI and in the `/health` endpoint.

### Certificate Management

Three methods are available, from most to least recommended:

1. **ACME / Let's Encrypt** — automatic provisioning and renewal. Private keys generated on-server using ECDSA P-256 and never transmitted. HTTP-01 challenge on port 80. Certificates hot-reload without restart.
2. **File-based (certbot)** — manual management via `BILBYCAST_TLS_CERT` / `BILBYCAST_TLS_KEY`.
3. **Behind proxy** — LB terminates TLS; no certificates needed on the manager.

### Edge and Relay Node Connections

Edge and relay nodes **must** connect using `wss://` URLs. Both clients enforce this and reject plaintext `ws://` URLs.

### Self-Signed Certificate Acceptance (Development)

Edge and relay nodes can accept self-signed TLS certificates by setting `accept_self_signed_cert: true` in their config. This should **only** be used for development — it disables certificate validation.

---

## API Security

- **Authentication**: All authenticated API endpoints require a valid JWT session cookie. Bearer tokens accepted as an alternative. State-changing requests require a matching CSRF header.
- **UI page protection**: Unauthenticated requests are redirected to `/login?next=<path>`, with `next` strictly validated to prevent open redirects.
- **WebSockets**: `/ws/node` uses the two-stage node protocol; `/ws/dashboard` requires a valid session before upgrade.
- **Security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and 2-year HSTS are sent on all responses.
- **CORS**: same-origin only.
- **Tunnel confidentiality**: end-to-end authenticated encryption between edge nodes. The relay never sees plaintext.
- **Registration token protection**: the `registration_token` field is excluded from all node API responses.

---

## AI API Key Storage

AI provider API keys are encrypted at rest with authenticated envelope encryption, displayed as masked values in the UI, and decrypted only when needed to call the provider.

---

## What Is NOT Yet Implemented

- **WebAuthn / passkey support** — only TOTP is available today.
- **Mutual TLS (mTLS)** for node authentication — nodes authenticate via WebSocket message, not client certificates.
- **Hardware Security Module (HSM) support** — master keys are stored in environment variables.
- **Audit log signing** — events are logged but not cryptographically signed.
- **IP allowlisting** for node connections.
- **Content-Security-Policy (CSP) header**.
- **API rate limiting** on authenticated endpoints.
- **SAML SSO** — only OIDC is supported.

---

## Recommendations for Production Deployment

1. **Provide TLS certificates** — TLS is mandatory. Use ACME or CA-signed certificates for production.
2. **Restrict `.env` permissions** — `chmod 600 .env`.
3. **Use a reverse proxy** — for request size limits and IP filtering.
4. **Rotate secrets periodically** — `bilbycast-manager rotate-master-key` handles master-key rotation without data loss.
5. **Back up regularly** — use the built-in encrypted backup (if licensed) to produce portable, passphrase-sealed snapshots.
6. **Monitor logs** — watch for repeated authentication failures.
7. **Run as a non-root user** — create a dedicated service account with minimal filesystem permissions.
