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
| `tunnels` | `ingress_push_status` | The ingress edge's leg of the tunnel |
| `tunnels` | `egress_push_status` | The egress edge's leg |
| `tunnels` | `relay_push_status` | The relay's leg (relay-mode tunnels only) |

Each column moves through these states:

| State | Meaning |
|---|---|
| `pending` | Manager has recorded the desired state but has not yet pushed it (or the node was offline at push time) |
| `pushing` | Push is in flight |
| `pushed` | Push succeeded; the node acknowledged it |
| `failed` | Push failed; the manager has the error in `push_error` and will retry on the next reconnect |

The UI shows these states as small badges next to each flow/tunnel so operators can see at a glance whether the manager's view matches reality.

## Reconnection workflow

When a node reconnects to the manager (after a network blip, restart, or first-ever connection), the manager runs the reconciliation pipeline:

1. **Replay pending pushes** — every `managed_flows` row and tunnel-leg with `push_status = "pending"` or `"failed"` is re-pushed. Successes flip to `pushed`; persistent failures stay in `failed` and surface as an event.
2. **Wait a settle delay** (~5 s) — gives the node time to apply the pushes and stabilise.
3. **Fetch the node's actual config** — the manager calls `get_config` on the node. The response has infrastructure secrets stripped (see [Manager Protocol — secret stripping contract](/edge/manager-protocol/#get_config--secret-stripping-contract)).
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

> **Ghost rule**: any `managed_flows` or tunnel-leg row in `push_status = "failed"` for **5 minutes or more**, where the target node is currently online, is auto-deleted.

The auto-delete is logged as a `config_sync` event so operators have a record of what happened.

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

## `config_sync` events

Reconciliation activity is reported via `config_sync` operational events on the manager's events stream. Categories:

| Category | When |
|---|---|
| `config_sync.push_succeeded` | A pending push was applied successfully on reconnect |
| `config_sync.push_failed` | A push failed; includes the error message |
| `config_sync.ghost_cleanup` | A ghost row was auto-deleted |
| `config_sync.drift_extraneous` | Found a flow/tunnel on the node not in the DB |
| `config_sync.drift_missing` | Expected flow/tunnel missing from the node |
| `config_sync.drift_mismatched` | Field-level mismatch between DB and node |

All `config_sync` events carry the affected `node_id` and `flow_id` (or `tunnel_id`) so operators can filter the Events page to a single resource and see its full reconciliation history.

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
| Flow disappears with a `ghost_cleanup` event | Manager auto-deleted a ghost; this is normal cleanup |
| New flow appears with a `drift_extraneous` tag | Someone created it directly on the node — decide whether to ingest or delete |

## Implementation references

For developers extending the reconciliation pipeline, the relevant files in `bilbycast-manager` are:

| File | Purpose |
|---|---|
| `crates/manager-core/src/reconciliation/` | The pipeline itself: replay, snapshot, diff, ghost cleanup |
| `crates/manager-core/src/managed_flows.rs` | DB layer for `managed_flows` push status |
| `crates/manager-core/src/tunnels.rs` | DB layer for tunnel push status (per leg) |
| `crates/manager-core/src/events.rs` | `config_sync` event categories and emission |
