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

## SMPTE ST 2110 (Phase 1)

All endpoints require an authenticated session and are gated per-node by the `HealthPayload.capabilities` advertisement — older edges that don't ship ST 2110 simply leave the field absent and the manager UI hides the controls. Mutating endpoints require the `Operator` role plus `auth.can_access_node()` and CSRF.

| Method | Path | Role | Description |
|--------|------|------|-------------|
| GET    | `/api/v1/nodes/{id}/ptp` | any auth | Cached PTP state from `ptp_state_cache`. Returns `{"lock_state":"unavailable"}` when no row exists. |
| GET    | `/api/v1/nodes/{id}/nmos` | any auth | Live NMOS state via WS `get_nmos_state` command. |
| GET    | `/api/v1/nodes/{id}/flows/{flow_id}/sdp/{essence}` | any auth | SDP document for one essence (`audio`, `video`, `anc`) of a ST 2110 flow. |
| GET    | `/api/v1/nodes/{id}/flows/{flow_id}/channel-map` | any auth | IS-08 active audio channel map. |
| PUT    | `/api/v1/nodes/{id}/flows/{flow_id}/channel-map` | Operator | Stage + activate a new channel map (50 KB payload limit). |
| GET    | `/api/v1/nodes/{id}/flow-groups` | any auth | List flow groups (essence bundles) tracked for the node. |
| POST   | `/api/v1/nodes/{id}/flow-groups` | Operator | Create a flow group (50 KB limit, push status tracked). |
| PUT    | `/api/v1/nodes/{id}/flow-groups/{gid}` | Operator | Update an existing flow group. |
| DELETE | `/api/v1/nodes/{id}/flow-groups/{gid}` | Operator | Delete a flow group. |

### Error responses

| Status | When |
|--------|------|
| 400 | Validation failure (missing `flow_group.id`, oversized `essence`/`flow_id`) |
| 401 | No valid session |
| 403 | Insufficient role, missing CSRF on a mutating call, or no node access |
| 413 | Payload exceeds size limit |
| 422 | Edge rejected the underlying WebSocket command |
| 502 | Node not currently connected |
| 504 | WebSocket command timed out |

All mutating endpoints fire-and-forget audit log via `db::audit::log_audit()` matching the existing pattern. Stats ingestion in `ws/node_hub.rs` writes inbound `FlowStats.ptp_state` to the `ptp_state_cache` table on receipt so the PTP card renders immediately on page load.

See `bilbycast-manager/docs/st2110.md` for the full operator guide.

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

**Edge commands** (via `POST /api/v1/nodes/{id}/command`): `get_config`, `update_config`, `create_flow`, `update_flow`, `delete_flow`, `start_flow`, `stop_flow`, `restart_flow`, `add_output`, `remove_output`. **SMPTE ST 2110 (Phase 1):** `get_nmos_state`, `get_ptp_state`, `get_sdp_document`, `add_flow_group`, `update_flow_group`, `remove_flow_group`, `add_essence_flow`, `remove_essence_flow`, `get_audio_channel_map`, `set_audio_channel_map`. The new variants are dispatched via the existing string-based match — older edges fall through to the catch-all `Unknown command` arm and the manager surfaces the failure as a 422. NO `WS_PROTOCOL_VERSION` bump.

**Relay commands** (via `POST /api/v1/nodes/{id}/command`): `get_config`, `disconnect_edge` (requires `edge_id`), `close_tunnel` (requires `tunnel_id`), `list_tunnels`, `list_edges`, `authorize_tunnel` (requires `tunnel_id`, `ingress_token`, `egress_token` — pre-authorizes HMAC-SHA256 bind tokens for a tunnel), `revoke_tunnel` (requires `tunnel_id` — removes bind authorization).

---

## Health

| Method | Path       | Description                          |
|--------|------------|--------------------------------------|
| GET    | `/health`  | Health check (no authentication)     |
