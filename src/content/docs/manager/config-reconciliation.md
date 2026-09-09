---
title: Config Reconciliation
description: How the bilbycast-manager keeps its database in sync with the actual config on each node — push status tracking, ghost cleanup, drift detection, and config_sync events.
sidebar:
  order: 8
---

The bilbycast-manager treats **the node's local config file as the ground truth**. The manager stores its own view of what each node *should* be running (in its database) and reconciles that view against what each node *actually* runs whenever they reconnect. This page documents that reconciliation pipeline — push status, ghost cleanup, drift detection, and `config_sync` events — so operators can understand why entries appear, disappear, or change state in the UI.

## Why this exists

Without reconciliation, three failure modes are easy to hit:

1. **Lost updates** — manager pushes a flow create, the node is offline, the manager forgets, the flow never lands.
2. **Phantom resources** — manager thinks a flow exists, the operator deleted it directly on the node via REST, the manager keeps showing it forever.
3. **External edits** — operator SSHs into the node and edits `config.json` by hand, the manager has no idea.

The reconciliation pipeline fixes all three.

## Push status

Every manager-initiated change to a node is tracked in the database with a **push status** that records whether the change has actually landed. There are several status columns:

| Table | Column(s) | Tracks |
|---|---|---|
| `managed_flows` | `push_status` | Per-flow create/update/delete |
| `managed_inputs` | `push_status` | Per-input create/update/delete |
| `managed_outputs` | `push_status` | Per-output create/update/delete |
| `tunnels` | `ingress_push_status` | The ingress edge's leg of the tunnel |
| `tunnels` | `egress_push_status` | The egress edge's leg |
| `tunnels` | `relay_push_status` | The relay's leg (relay-mode tunnels only) |
| `tunnels` | `secondary_relay_push_status` | The backup relay's leg (dual-relay tunnels only) |
| `flow_groups` | `push_status` | ST 2110 essence groups. Reset on disconnect, then re-pushed by the 30 s retry task rather than by the reconnect replay below |
| `service_steps` | `push_status` | One row per step of a deployed service |

Each column moves through these states:

| State | Meaning |
|---|---|
| `pending` | Manager has recorded the desired state but has not yet pushed it (or the node was offline at push time) |
| `pushed` | Push succeeded; the node acknowledged it |
| `failed` | Push failed; the manager has the error in `push_error` and will retry on the next reconnect |

There is no in-flight state — a push is `pending` until the node answers, then `pushed` or `failed`. When a node disconnects the manager resets that node's `managed_flows`, `managed_inputs`, `managed_outputs` and `flow_groups` rows from `pushed` back to `pending`, and its tunnel legs back to `pending` from whatever they held, so a reconnect always re-asserts the manager's view; `service_steps` rows are left where they are. `service_steps` is also the one table with a fourth value, `drifted`, written by the services reconciler when a step that was pushed no longer matches the node's config.

The UI shows these states as small badges next to each flow/tunnel so operators can see at a glance whether the manager's view matches reality.

## Reconnection workflow

When a node reconnects to the manager (after a network blip, restart, or first-ever connection), the manager runs the reconciliation pipeline:

1. **Replay pending pushes** — every `managed_flows`, `managed_inputs` and `managed_outputs` row and every tunnel leg with `push_status = "pending"` or `"failed"` is re-pushed. Successes flip to `pushed`; persistent failures stay in `failed` and surface as an event. Flow groups are not part of this replay — the 30 s retry task re-pushes every `pending` or `failed` group instead.
2. **Wait a settle delay** (~5 s) — gives the node time to apply the pushes and stabilise.
3. **Fetch the node's actual config** — the manager calls `get_config` on the node. The response has infrastructure secrets stripped (see [Manager Protocol — secret boundaries](/edge/manager-protocol/#secret-boundaries)).
4. **Compare against the database** — the manager diffs the returned config against its `managed_flows` and `tunnels` tables.
5. **Detect and report drift** — anything in the database that isn't in the config (or vice versa) becomes a drift event.

The whole pipeline runs on a per-node basis whenever the WebSocket transitions from disconnected to connected. The retry interval for transient failures is 30 seconds.

## Ghost cleanup

Sometimes a manager-pushed flow ends up in a state that nobody wants:

- The push failed at create time (validation error, address conflict, etc.).
- The manager retried for several minutes.
- The operator gave up, removed the flow from the manager UI.
- The DB row got stuck in `failed` because the deletion never made it to the (offline) node.

These are **ghost entries**: rows in the manager DB that don't correspond to anything on the node and aren't progressing. The reconciliation pipeline cleans them up automatically:

> **Ghost rule (flows, inputs, outputs, flow groups)**: a `managed_flows`, `managed_inputs`, `managed_outputs` or `flow_groups` row in `push_status = "failed"` and untouched for **5 minutes or more**, where the target node is currently online, is auto-deleted. The retry path rewrites `updated_at`, so the countdown restarts on every retry — only a row that stops progressing dies. An input or output still referenced by a managed flow on the same node is skipped: that is user data the flow needs, not a ghost.

> **Ghost rule (tunnels)**: a `tunnels` row is deleted only when **both** `ingress_push_status` and `egress_push_status` are `failed`, the row has been untouched for **5 minutes or more**, its `status` is `pending` or `active`, and **both** the ingress and egress nodes are currently connected. One failed leg, or one node offline, is not enough.

Tunnel ghost cleanup does not stop at the database row. Dropping the row alone would leave a stale half in each edge's `config.json` and a stale bind on the relays, so the manager also enqueues a durable teardown: `delete_tunnel` to both edges, and `revoke_tunnel` + `close_tunnel` to the primary and secondary relays. Targets that are offline keep their teardown queued until they reconnect; anything still undelivered after 24 hours is purged.

Every auto-delete is logged as a `config_sync` event so operators have a record of what happened.

## Drift detection

A **drift** is anything the manager finds in the node's actual config that doesn't match the database. There are three drift categories:

| Category | Meaning |
|---|---|
| `extraneous` | Flow / tunnel exists on the node but not in the manager DB. Usually means an operator created it locally via REST or `config.json` edit |
| `missing` | Flow / tunnel exists in the manager DB (with `push_status = "pushed"`) but isn't on the node. Usually means the node was rebuilt without restoring `config.json`, or someone deleted it locally |
| `mismatched` | Flow / tunnel exists on both sides but the field values differ |

Drift is **logged but not automatically corrected**. Auto-correcting drift would mean the manager could silently overwrite an operator's local edits, which is the opposite of "node is the ground truth". Instead, drift events surface in the **Events** page and the operator decides whether to:

- Re-push from the manager (drops the local edit)
- Ingest the local change into the manager DB (preserves it)
- Delete the offending resource from one side or the other

Two writes do happen, and both are worth knowing about. Neither rewrites the node from a drift finding, and neither ingests a node-side value into the manager's tables:

- **`missing` demotes the manager's own row.** A flow, input, output, tunnel leg or flow group the DB holds as `pushed` but which is absent from the node is written back to `failed` with `push_error = "… not found in node config during reconciliation"`. That demotion is exactly what arms the 5-minute ghost-cleanup countdown above, so a resource that stays missing eventually has its manager record deleted.
- **`extraneous` tunnels can be torn down, if you opt in.** The `tunnel_orphan_auto_cleanup` setting **defaults to off**, and with it off an untracked tunnel found on a node is only an Info event. Turn it on and the same finding queues a `delete_tunnel` teardown against that edge, removing the orphaned half from its `config.json`.

## `config_sync` events

Reconciliation activity is reported via `config_sync` operational events on the manager's events stream. There are no sub-kinds: every one of these events is filed under the single flat category `config_sync`, and the specific condition — ghost deleted, resource missing from the node, untracked tunnel found, tunnel edited locally — is carried in the free-text message. The Events page therefore filters on `category = config_sync` and nothing finer.

Every `config_sync` event carries the affected `node_id`. Some also carry a resource id: flow-added and flow-removed drift and a failed group bundle set `flow_id`, and a stale audio-PID override sets `input_id`. Tunnel drift and every ghost-cleanup event carry none, and the `events` table has no `tunnel_id` column at all — so tunnel events cannot be narrowed to a single tunnel from the Events page.

## Operator workflow

The whole pipeline is designed to fade into the background. In normal operation:

1. Operator creates a flow in the manager UI.
2. Manager records it as `pending`, pushes it, gets `pushed`.
3. UI shows green.

In the failure cases:

| Symptom in UI | What it means |
|---|---|
| Flow stuck on `pending` for a long time | Node is offline; will retry on reconnect |
| Flow shows `failed` with an error message | Push reached the node but the node rejected it (validation error, conflict) — read the error and edit the flow |
| Flow disappears, with a `config_sync` event reading "Ghost flow … deleted" | Manager auto-deleted a ghost; this is normal cleanup |
| New flow appears, with a `config_sync` event reading "New flow … detected on node" | Someone created it directly on the node — decide whether to ingest or delete |

## Implementation references

For developers extending the reconciliation pipeline, the relevant files in `bilbycast-manager` are:

| File | Purpose |
|---|---|
| `crates/device-edge/src/reconcile.rs` | Driver-owned reconnect reconcile path: re-push, settle, fetch config |
| `crates/manager-server/src/ws/node_hub.rs` | The diff itself: snapshot compare, drift detection, ghost cleanup |
| `crates/manager-core/src/db/managed_flows.rs` | DB layer for `managed_flows` push status |
| `crates/manager-core/src/db/tunnels.rs` | DB layer for tunnel push status (per leg) |
| `crates/manager-core/src/db/events.rs` | `config_sync` event insertion |
