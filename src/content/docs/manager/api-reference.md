---
title: API Reference
description: REST and WebSocket API reference for bilbycast-manager.
sidebar:
  order: 2
---

All endpoints except `/api/v1/auth/login` and `/health` require authentication via a session cookie (set automatically at login). API clients may alternatively use an `Authorization: Bearer <token>` header.

State-changing requests (POST, PUT, PATCH, DELETE) to authenticated endpoints also require an `X-CSRF-Token` header matching the `csrf_token` cookie value.

---

## Authentication

| Method | Path                    | Description              |
|--------|-------------------------|--------------------------|
| POST   | `/api/v1/auth/login`    | Log in, sets httpOnly session cookie and csrf_token cookie. Rate-limited: 5 attempts/60s per IP. |
| POST   | `/api/v1/auth/logout`   | Log out, revokes session token and clears cookies |

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
| GET    | `/api/v1/nodes`               | List all registered nodes (`?device_type=edge` or `?device_type=relay` to filter) |
| POST   | `/api/v1/nodes`               | Register a new node (set `device_type` to `"edge"` or `"relay"`, returns reg token) |
| GET    | `/api/v1/device-types`        | List all registered device drivers and their capabilities |
| GET    | `/api/v1/nodes/{id}`          | Get node by ID                           |
| PUT    | `/api/v1/nodes/{id}`          | Update node metadata                     |
| DELETE | `/api/v1/nodes/{id}`          | Delete node                              |
| POST   | `/api/v1/nodes/{id}/token`    | Regenerate registration token            |
| GET    | `/api/v1/nodes/{id}/config`   | Get cached config from connected node    |
| POST   | `/api/v1/nodes/{id}/command`  | Send a command to a connected node       |

---

## Events

| Method | Path                        | Description                        |
|--------|-----------------------------|------------------------------------|
| GET    | `/api/v1/events`            | List events (supports pagination)  |
| POST   | `/api/v1/events/{id}/ack`   | Acknowledge an event               |
| GET    | `/api/v1/events/count`      | Get unacknowledged event count     |

---

## Settings

| Method | Path                  | Description              |
|--------|-----------------------|--------------------------|
| GET    | `/api/v1/settings`    | Get current settings     |
| PUT    | `/api/v1/settings`    | Update settings          |
| GET    | `/api/v1/settings/tls` | Get TLS certificate info (subject, issuer, self-signed status) |
| POST   | `/api/v1/settings/tls/upload` | Upload new TLS certificate and key (PEM format, requires server restart) |

---

## Export / Import

| Method | Path                | Description                  |
|--------|---------------------|------------------------------|
| GET    | `/api/v1/export`    | Export all data as JSON      |
| POST   | `/api/v1/import`    | Import data from JSON        |

Note: Import is currently defined but not yet fully implemented.

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

### `POST /api/v1/ai/generate-config`

Request body: `{ "prompt": "...", "provider": "openai|anthropic|gemini", "node_id": "optional", "existing_flows": [] }`

The AI returns an action envelope in `config`:

```json
{ "success": true, "config": { "action": "<type>", ... }, "raw_response": "..." }
```

Supported action types: `create_flow`, `update_flow`, `delete_flow`, `add_output`, `remove_output`, `start_flow`, `stop_flow`, `restart_flow`, `info`, `multiple`.

If `node_id` is provided and the node is online, real flow configs are fetched from the hub cache for context. The user's stored `model_preference` is used when calling the AI provider.

---

## WebSocket Endpoints

### `/ws/dashboard`

Real-time updates for browser-based dashboards. Receives JSON messages containing aggregated node status, stats, and health data. Requires an authenticated session.

### `/ws/node`

Device node connection endpoint (edge nodes and relay servers). Nodes must send an `auth` message as the first WebSocket frame containing either:

- `registration_token` for first-time registration, or
- `node_id` + `node_secret` for reconnection

Message types from nodes: `stats`, `health`, `event`, `config_response`, `command_ack`, `pong`.

Message types from manager: `ping`, `command`, `register_ack`, `auth_ok`, `auth_error`.

**Edge commands** (via `POST /api/v1/nodes/{id}/command`): `get_config`, `update_config`, `create_flow`, `update_flow`, `delete_flow`, `start_flow`, `stop_flow`, `restart_flow`, `add_output`, `remove_output`.

**Relay commands** (via `POST /api/v1/nodes/{id}/command`): `get_config`, `disconnect_edge` (requires `edge_id`), `close_tunnel` (requires `tunnel_id`), `list_tunnels`, `list_edges`, `authorize_tunnel` (requires `tunnel_id`, `ingress_token`, `egress_token` — pre-authorizes HMAC-SHA256 bind tokens for a tunnel), `revoke_tunnel` (requires `tunnel_id` — removes bind authorization).

---

## Health

| Method | Path       | Description                          |
|--------|------------|--------------------------------------|
| GET    | `/health`  | Health check (no authentication)     |
