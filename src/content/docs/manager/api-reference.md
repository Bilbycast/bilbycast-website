---
title: API Reference
description: REST and WebSocket API reference for bilbycast-manager.
sidebar:
  order: 2
---

This page lists the public-facing HTTP endpoints exposed by bilbycast-manager and their purpose at a high level. It is **not** a complete integration reference — full request/response schemas, WebSocket command enumerations, backup file format, and internal protocol details are provided to commercial licensees under NDA.

Most endpoints require authentication via a session cookie (set automatically at login). API clients may alternatively use an `Authorization: Bearer <token>` header.

State-changing requests (POST, PUT, PATCH, DELETE) to authenticated endpoints also require an `X-CSRF-Token` header matching the `csrf_token` cookie value.

---

## Authentication

| Method | Path                                   | Description                                                           |
|--------|----------------------------------------|-----------------------------------------------------------------------|
| POST   | `/api/v1/auth/login`                   | Password login. Rate-limited per IP.                                  |
| POST   | `/api/v1/auth/login-form`              | Form-based login with redirect.                                       |
| POST   | `/api/v1/auth/logout`                  | Log out and clear session.                                            |
| GET    | `/api/v1/auth/me`                      | Return the current user's profile.                                    |
| PUT    | `/api/v1/auth/me`                      | Self-service profile edit.                                            |
| POST   | `/api/v1/auth/change-password`         | Self-service password change.                                         |

### MFA (TOTP)

| Method | Path                                    | Description                                    |
|--------|-----------------------------------------|------------------------------------------------|
| POST   | `/api/v1/auth/mfa/totp/setup`           | Start TOTP enrollment.                         |
| POST   | `/api/v1/auth/mfa/totp/confirm`         | Finalise enrollment and return recovery codes. |
| POST   | `/api/v1/auth/mfa/totp/disable`         | Turn MFA off (requires password + code).       |
| POST   | `/api/v1/auth/mfa/verify`               | Complete login after the MFA challenge.        |

### SSO (OIDC)

| Method | Path                                 | Description                                   |
|--------|--------------------------------------|-----------------------------------------------|
| GET    | `/api/v1/auth/oidc/status`           | Public probe — is SSO enabled on this server? |
| GET    | `/api/v1/auth/oidc/login`            | Start the OIDC authorisation flow.            |
| GET    | `/api/v1/auth/oidc/callback`         | IdP callback.                                 |

SSO is a commercially licensed feature. See the [SSO setup guide](/manager/security/#single-sign-on-oidc) for per-IdP configuration.

---

## Users

| Method | Path                    | Description              |
|--------|-------------------------|--------------------------|
| GET    | `/api/v1/users`         | List all users           |
| POST   | `/api/v1/users`         | Create a new user        |
| GET    | `/api/v1/users/{id}`    | Get user by ID           |
| PUT    | `/api/v1/users/{id}`    | Update user              |
| DELETE | `/api/v1/users/{id}`    | Delete user              |

---

## Nodes

| Method | Path                          | Description                              |
|--------|-------------------------------|------------------------------------------|
| GET    | `/api/v1/nodes`               | List all registered nodes (filter by `?device_type=`) |
| POST   | `/api/v1/nodes`               | Register a new node                      |
| GET    | `/api/v1/device-types`        | List registered device drivers           |
| GET    | `/api/v1/nodes/{id}`          | Get node by ID                           |
| PUT    | `/api/v1/nodes/{id}`          | Update node metadata                     |
| DELETE | `/api/v1/nodes/{id}`          | Delete node                              |
| POST   | `/api/v1/nodes/{id}/token`    | Regenerate registration token            |
| GET    | `/api/v1/nodes/{id}/config`   | Get cached config from a connected node  |
| POST   | `/api/v1/nodes/{id}/command`  | Send a command to a connected node       |

The set of valid commands and their payload schemas is specific to each device driver. The list of supported commands per driver is returned by `/api/v1/device-types` and documented in full in the commercial integration reference.

---

## SMPTE ST 2110 (Phase 1)

ST 2110 controls are available only on nodes whose health capabilities advertise ST 2110 support. Older edges transparently hide these controls in the UI.

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/v1/nodes/{id}/ptp` | Cached PTP state. |
| GET    | `/api/v1/nodes/{id}/nmos` | Live NMOS state. |
| GET    | `/api/v1/nodes/{id}/flows/{flow_id}/sdp/{essence}` | SDP document for one essence of a ST 2110 flow. |
| GET / PUT  | `/api/v1/nodes/{id}/flows/{flow_id}/channel-map` | Read or stage + activate an IS-08 channel map. |
| GET / POST / PUT / DELETE | `/api/v1/nodes/{id}/flow-groups[/{gid}]` | Manage flow groups (essence bundles). |

Mutating endpoints require the Operator role and the usual CSRF + node-access checks. Full payload schemas are provided in the commercial integration reference.

---

## Events

| Method | Path                        | Description                        |
|--------|-----------------------------|------------------------------------|
| GET    | `/api/v1/events`            | List events (supports pagination)  |
| POST   | `/api/v1/events/{id}/ack`   | Acknowledge an event               |
| GET    | `/api/v1/events/count`      | Get unacknowledged event count     |

---

## Settings

| Method | Path                            | Description                                                |
|--------|---------------------------------|------------------------------------------------------------|
| GET    | `/api/v1/settings`              | Get current settings                                       |
| PUT    | `/api/v1/settings`              | Update settings                                            |
| GET    | `/api/v1/settings/tls`          | Get TLS certificate info                                   |
| POST   | `/api/v1/settings/tls/upload`   | Upload a new TLS certificate and key (PEM, requires restart) |

---

## License

| Method | Path                  | Description                                                |
|--------|-----------------------|------------------------------------------------------------|
| GET    | `/api/v1/license`     | Current license status (Admin+).                           |
| PUT    | `/api/v1/license`     | Apply or replace a license key (SuperAdmin).               |
| DELETE | `/api/v1/license`     | Remove the installed license key (SuperAdmin).             |

The free tier supports a limited number of managed nodes. Commercial licenses unlock higher node limits and advanced features. Endpoints gated by paid features return a machine-readable error that the UI uses to render an upgrade prompt.

---

## Backup & Restore

Encrypted backup and restore is a commercially licensed feature available to SuperAdmins.

| Method | Path              | Description                                                                      |
|--------|-------------------|----------------------------------------------------------------------------------|
| POST   | `/api/v1/export`  | Download an encrypted backup of the manager's state.                             |
| POST   | `/api/v1/import`  | Restore from an encrypted backup (destructive).                                  |

Backups are sealed with a user-supplied passphrase using authenticated encryption and a memory-hard key derivation function. Secret fields are portable across deployments with different master keys. File format details are provided to commercial licensees.

---

## AI

| Method | Path                           | Description                          |
|--------|--------------------------------|--------------------------------------|
| POST   | `/api/v1/ai/generate-config`   | AI flow management (action-based)    |
| POST   | `/api/v1/ai/analyze`           | AI-powered anomaly analysis          |
| POST   | `/api/v1/ai/query`             | Natural language query about nodes   |
| GET    | `/api/v1/ai/keys`              | List stored AI provider keys         |
| POST   | `/api/v1/ai/keys`              | Store an AI provider API key         |
| DELETE | `/api/v1/ai/keys`              | Delete an AI provider API key        |

The AI assistant calls back to the manager using the same driver action system exposed through the UI. Prompt construction, per-driver action schemas, and credential-stripping behaviour are documented in the commercial integration reference.

---

## WebSocket Endpoints

### `/ws/dashboard`

Real-time updates for browser-based dashboards. Receives aggregated node status, stats, and health data. Requires an authenticated session.

### `/ws/node`

Authenticated connection endpoint for managed devices (edge nodes, relay servers, and third-party API gateways). Devices connect outbound to the manager, enabling management of devices behind firewalls and NAT.

The node protocol is an authenticated JSON message channel with backward-compatible versioning. The full message schema, command set per device driver, and protocol extension rules are provided to commercial licensees and integration partners under NDA.

---

## Health

| Method | Path       | Description                          |
|--------|------------|--------------------------------------|
| GET    | `/health`  | Health check (no authentication)     |
