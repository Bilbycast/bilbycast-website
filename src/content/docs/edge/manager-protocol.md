---
title: Manager Protocol
description: WebSocket commands the bilbycast-manager sends to bilbycast-edge nodes — diff-based config updates, secret rotation, atomic flow groups, and the GetConfig secret-stripping contract.
sidebar:
  order: 11
---

bilbycast-edge connects outbound to its bilbycast-manager via a persistent WebSocket. The manager pushes commands; the edge pushes stats, health, thumbnails, and operational events. This page documents the **command set** the edge accepts from the manager — the corresponding REST endpoints (when there is one) are documented in the [API Reference](/edge/api-reference/).

The wire format is a JSON envelope:

```json
{
  "type": "command",
  "timestamp": "2026-04-07T12:34:56Z",
  "payload": {
    "command": "create_flow",
    ...
  }
}
```

The edge replies with a `command_ack` envelope on success or a `command_ack` with an error field on failure.

## Command summary

| Command | Effect | Diff-aware | Atomic |
|---|---|---|---|
| `get_config` | Snapshot of current config (with secrets stripped) | n/a | n/a |
| `update_config` | Replace global config | Yes — only changed flows are restarted | n/a |
| `create_flow` | Create and start a new flow | n/a | n/a |
| `update_flow` | Update a single flow | Yes — output-only changes are hot-applied | n/a |
| `delete_flow` | Stop and remove a flow | n/a | n/a |
| `start_flow` / `stop_flow` | Toggle a single flow's runtime state | n/a | n/a |
| `add_output` / `remove_output` | Hot-add or hot-remove a single output | n/a | n/a |
| `start_flow_group` | Start every member of a flow group | n/a | **Yes** — rolls back on partial failure |
| `stop_flow_group` | Stop every member of a flow group | n/a | Best-effort parallel stop |
| `create_tunnel` / `delete_tunnel` | Tunnel lifecycle | n/a | n/a |
| `start_tunnel` / `stop_tunnel` | Tunnel runtime state | n/a | n/a |
| `rotate_secret` | Replace the node's authentication secret over the live WebSocket | n/a | n/a |

## `get_config` — secret stripping contract

`get_config` returns the running `AppConfig` to the manager. **Infrastructure secrets are removed before serialization** — the manager never sees them, never stores them, and cannot leak them via UI or audit logs. Specifically:

- `manager.node_secret` (the edge ↔ manager auth secret)
- `manager.registration_token`
- `server.tls.cert_path` / `key_path` / inline PEMs
- `server.auth.jwt_secret` and OAuth client credentials
- Per-tunnel `tunnel_encryption_key`, `tunnel_bind_secret`, `tunnel_psk`
- Per-tunnel `tls_cert_pem` / `tls_key_pem`

**Flow-level user credentials are preserved** so the manager UI can show them and round-trip them through `update_config`:

- SRT `passphrase`
- RTSP `username` / `password`
- RTMP `stream_key`
- WebRTC `bearer_token`
- HLS `auth_token`

This split exists because flow-level credentials are *operator-visible* by design — the operator typed them into the manager UI in the first place — while infrastructure secrets are device-bound and must never leave the node.

## `update_config` and `update_flow` — diff-based updates

`update_config` is **not** a destructive replace. The edge compares the incoming config against the running `AppConfig` field-by-field (`PartialEq`) and:

1. **Restarts a flow** only when its `input` block, flow-level metadata, or any output's identity-defining fields have changed.
2. **Hot-adds / hot-removes outputs** when only the output set has changed — running outputs (including live SRT connections) are not disturbed.
3. **Skips entirely** any flow whose serialized form is byte-identical to the running version.
4. **Merges in local infrastructure secrets** — since the manager-supplied config has secrets stripped (see above), the edge re-injects its locally-stored `node_secret`, `tunnel_encryption_key`, etc. before applying.

`update_flow` is the same behaviour scoped to a single flow.

The practical effect: an operator can edit any non-input field on any output without taking down the rest of the flow's outputs, and the manager UI doesn't need to know which fields are "hot" and which are not — the edge does the right thing.

### What counts as a restart-triggering change?

| Change | Action |
|---|---|
| `input` block (any field) | Restart whole flow |
| Flow `enabled` toggled | Start or stop |
| Flow `name` only | Hot-applied (no restart) |
| Output added | Hot-add |
| Output removed | Hot-remove (TCP outputs gracefully drained) |
| Output `enabled` toggled | Toggle just that output |
| Output identity-defining fields (e.g., SRT `address`, `mode`) changed | Restart just that output |
| Output cosmetic fields (`name`, `description`) changed | Hot-applied |

## `start_flow_group` / `stop_flow_group` — atomic multi-essence groups

Multi-essence broadcast bundles (e.g., a single program with separate ST 2110-30 audio + ST 2110-31 transparent + ST 2110-40 ANC essence flows) live on a single edge as several flows that share a `flow_group_id`. The manager treats them as one logical unit.

`start_flow_group` brings up every member of a group **in parallel**. If any member fails to start, the edge rolls back the others — the group is either fully running or fully stopped, with no partial state. This is the all-or-nothing guarantee multi-essence bundles need so a receiver never sees ANC without its corresponding audio (or vice versa).

```json
{
  "command": "start_flow_group",
  "flow_group_id": "studio-1-program"
}
```

Reply:

```json
{
  "command_ack": "start_flow_group",
  "flow_group_id": "studio-1-program",
  "started": ["audio-flow", "anc-flow", "video-flow"],
  "failed": []
}
```

On partial failure:

```json
{
  "command_ack": "start_flow_group",
  "flow_group_id": "studio-1-program",
  "started": [],
  "failed": ["video-flow"],
  "rolled_back": ["audio-flow", "anc-flow"],
  "error": "video-flow: input bind failed: address already in use"
}
```

`stop_flow_group` is best-effort parallel stop — it tears down every member and reports any individual failures, but does not roll back stops that succeeded.

## `rotate_secret` — live secret rotation

The manager can replace the node's auth secret on a running connection without dropping the WebSocket. The flow:

1. Manager generates a new 32-byte secret.
2. Manager sends `rotate_secret { new_secret: "..." }` over the live WebSocket.
3. Edge writes the new secret to `secrets.json` (encrypted at rest), atomically.
4. Edge replies with `command_ack`.
5. Manager records the new secret in its envelope-encrypted DB. Old secret is invalidated.

If the edge crashes after step 3 but before the manager records the new secret in step 5, the next reconnect will fail auth and the operator can re-issue a registration token to re-onboard the node. This window is minimised by the atomic file write on the edge side.

## Auth payload — protocol versioning and software version

When the edge connects, the first frame is an auth payload that includes:

```json
{
  "node_id": "edge-syd-1",
  "node_secret": "...",
  "protocol_version": 1,
  "software_version": "0.7.1"
}
```

The manager records `protocol_version` per connection and logs a warning event on mismatch. Older edges that don't include the field are accepted (`#[serde(default)]` keeps the protocol backward-compatible). New WebSocket message types are added with string-based dispatch on both sides — unknown types are logged and ignored, never crash the connection.

This is the same pattern used on the [edge ↔ relay tunnel protocol](/relay/architecture/), where `read_message_resilient()` returns `ParsedMessage::Unknown { msg_type }` for unrecognised frames so that newer edges and older relays (or vice versa) can coexist.

## Stats, health, thumbnails, events

In addition to handling commands, the edge pushes four kinds of unsolicited messages to the manager:

| Message type | Cadence | Contents |
|---|---|---|
| `stats` | Every 1 s | Per-flow input/output bitrates, packet counts, FEC stats, TR-101290, IAT/PDV |
| `health` | Every 15 s | Node-level health summary, software version, capability list |
| `thumbnail` | Every 10 s (per flow with thumbnails enabled) | 320×180 JPEG, base64-encoded, optional `thumbnail_program_number` selector for MPTS |
| `event` | On state change | Operational events with `severity`, `category`, `message`, optional `flow_id` and `details`. See [Events & Alarms](/edge/events-and-alarms/) |

Events are deduplicated on the edge — they fire on state transitions, not periodically — and queued when the manager is disconnected so a reconnect delivers the backlog.
