---
title: Active/Active HA
description: Two bilbycast-manager instances against a shared Postgres 18 cluster — concurrent serving, cross-instance pubsub, multi-region observability, DNS failover.
sidebar:
  order: 11
---

bilbycast-manager supports an **active/active HA topology**: two manager instances run against the same Postgres 18 cluster and serve traffic concurrently. The licence-gated `FEATURE_HA` controls visibility of the cluster management surfaces (instances list, multi-region settings panel) — the cluster mechanics themselves (heartbeats, LISTEN/NOTIFY, advisory locks) run in every build, so operators can stand up a two-instance pair against shared Postgres for evaluation without a licence, just without the management UI.

## Why it matters

Broadcast operations expect reliability you'd associate with a hardware control plane: a primary failure can't take the manager offline for the time it takes to spin up a replacement. Active/active across two instances against shared Postgres gives you:

- **Zero-downtime failover** — both instances are live, both can answer REST + WS at any moment. DNS failover is the only operator action.
- **Rolling deploys** — drain one instance, swap the binary via systemd, rejoin. The other instance keeps serving the entire time.
- **Geographic redundancy** — instances in two regions, one Postgres cluster reachable from both.
- **Honest observability** — every Prometheus sample carries `instance_id` and `region` labels so dashboards can split metrics per node.

## Architecture

```
                Browser / Edge nodes
                       │
                       ▼ wss://manager.example.com
                  ┌────────────┐
                  │    DNS     │ (Route 53 / Cloudflare / etc.)
                  └─────┬──────┘
                        │
            ┌───────────┴───────────┐
            ▼                       ▼
    ┌──────────────┐        ┌──────────────┐
    │  Manager A   │        │  Manager B   │
    │  region=syd  │        │  region=mel  │
    └──────┬───────┘        └──────┬───────┘
           │                       │
           └──────────┬────────────┘
                      ▼
              ┌──────────────┐
              │ Postgres 18  │ (shared writer + read replicas if you have them)
              └──────────────┘
```

Both instances:

- Read and write to the same Postgres 18 cluster.
- Heartbeat every few seconds to `manager_instances`; rows whose heartbeat lapses past a 15 s window are reaped.
- Coordinate cross-instance work (node hub command fan-out, browser broadcast aggregation, license / cache invalidation, session cache invalidation) via Postgres LISTEN/NOTIFY (small payloads inline; large payloads spill via `cross_instance_rpc` then NOTIFY-the-row-id).
- Coordinate one-at-a-time operations (DR backup, master-key rotation) via Postgres advisory locks (`pg_try_advisory_lock(42)` for backup; per-resource locks for routine schedule fires).

Edge nodes connect to whichever instance DNS sends them to. If the connected instance dies, the edge reconnects (via the same DNS name) and lands on the surviving instance — the surviving instance reads the edge's stored secret from Postgres and authenticates the reconnect transparently.

## Instance identity

Each manager process resolves a stable UUID via:

1. `BILBYCAST_INSTANCE_ID` env var, if set.
2. `<data_dir>/instance_id` (auto-generated 0600 file on first boot).
3. Fresh v4 UUID (last resort).

`BILBYCAST_REGION` (free-form string) tags the instance for cross-region observability. Both values land on the `manager_instances` row + every Prometheus sample.

## HA lifecycle CLI

Three subcommands handle the lifecycle:

| Command | What it does |
|---|---|
| `bilbycast-manager promote` | Flips this instance's `manager_instances.role` to `primary` and demotes peers atomically. Used after failover to mark which instance is now the writer-of-record. |
| `bilbycast-manager rejoin` | Re-registers a row that the heartbeat reaper dropped during an outage. Used when restarting an instance after a long downtime. |
| `bilbycast-manager upgrade [--drain-secs N]` | Writes the `BILBYCAST_DRAIN` signal file the running `serve` watches. The instance drains in-flight WS connections and exits 0 so systemd can swap the binary. The peer keeps serving the whole time. |

The runbook for DNS failover, region promotion, and rolling upgrades lives in [`DNS_FAILOVER.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/DNS_FAILOVER.md).

## Provisioning

```
bilbycast-manager init --mode ha-primary
bilbycast-manager init --mode ha-standby --master-key <paste from primary>
                                        --jwt-secret <paste from primary>
                                        --database-url postgres://…shared cluster…
```

`init` generates secrets + self-signed TLS + `<confdir>/manager.env` + a systemd unit stub. It deliberately does **not** run `systemctl`, vendor Postgres, or apply migrations — those happen on first `serve`. The HA-standby invocation reuses the primary's master key + JWT secret so both instances can decrypt the same shared ciphertexts.

## Cross-instance pubsub

`manager-core/src/pubsub.rs` wraps Postgres LISTEN/NOTIFY behind a typed envelope. Used for:

- **Node-hub command fan-out.** A browser connected to instance A can address a command to a node connected to instance B. Instance A publishes; instance B's hub picks it up and dispatches.
- **Browser-broadcast aggregation.** Stats, health, and event broadcasts to dashboards combine across instances so any browser sees every node's data regardless of which instance it's connected to.
- **License / cache invalidation.** A license change on instance A invalidates the moka caches on instance B in milliseconds.
- **Session cache invalidation.** Membership / share / ownership mutations broadcast `SESSION_INVALIDATE` so peer instances drop cached entries the moment the change commits.

NOTIFY payloads under 8000 bytes ship inline; larger payloads spill to a `cross_instance_rpc` row and the NOTIFY ferries the row id (consume + DELETE on read).

## Multi-region observability

Every Prometheus sample carries `instance_id` and `region` labels so dashboards split per node. Cross-region RPC samples land in the `bilbycast_region_latency_ms` histogram so you can chart how long inter-instance commands take.

The `node_connections` table records which instance + region each node is currently live on; the settings UI renders a per-region / per-instance breakdown. Operations teams use this to balance load across regions and to spot drift (e.g. all nodes have re-homed onto one instance after a partial outage).

## Backup safety

The DR-grade `bilbycast-manager backup` CLI takes `pg_try_advisory_lock(42)` so two simultaneous invocations across the HA pair cannot race on `pg_dump` from the single Postgres writer. The first wins, the second backs off cleanly. See [Encrypted Backup & Restore](/manager/backup/) for the full backup model.

## Master-key rotation in HA

Rotation runs in a single Postgres transaction that touches every `_enc` row. **Stop both instances before running `rotate-master-key`** — leaving one alive will deadlock against the rotation transaction. A single CLI invocation against the shared Postgres covers the whole cluster; you do not need to run it on each host. See [`master-key-rotation.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/master-key-rotation.md) for the full runbook.

## Licence model

`FEATURE_HA` gates only the management surfaces:

- `GET /api/v1/instances` — the instances-list endpoint.
- The multi-region panel in the settings UI.

The cluster mechanics — heartbeats, LISTEN/NOTIFY, advisory locks, cross-instance RPC — run in every build. Operators without `FEATURE_HA` can still stand up two instances against shared Postgres for evaluation; they just can't observe the topology in the UI.

## Reference

- Operator runbook: [`DNS_FAILOVER.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/DNS_FAILOVER.md).
- Provisioning walkthrough: `installer/README.md` in the bilbycast-manager repo.
- API reference: [`API.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/API.md) ("Cluster (HA)" + "Metrics").
- Backup safety: [Encrypted Backup & Restore](/manager/backup/).
