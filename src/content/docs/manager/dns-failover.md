---
title: DNS Failover
description: Move traffic between two manager instances in different regions using your own DNS provider — what the manager does, what it deliberately does not, and the order the steps go in.
sidebar:
  order: 12
---

An [active/active pair](/manager/active-active-ha/) gives you two live manager instances against one shared Postgres. **DNS failover is the operator action that decides which of them the world talks to.**

The manager has no DNS integration. It does not own a zone, call a provider API, or flip a record when it notices a problem. Failover is something you do at Route 53, Cloudflare, or whatever fronts your instances — the manager's part is to make both instances genuinely interchangeable so the flip is safe.

That leaves you two decisions, and they are separate: **where new connections land** (DNS), and **which Postgres is writable** (your database). The first is reversible in one TTL. The second is not reversible without a restore.

## What DNS failover actually moves

Browsers and nodes find a manager in different ways, so a DNS flip does not affect them equally.

| Client | How it finds a manager | What a DNS flip does |
|---|---|---|
| Browser (operator UI, REST) | One hostname, resolved per page load | **Everything.** This is the only mechanism a browser has. |
| Edge / relay node | The ordered `manager.urls` list in its own `config.json` | **Nothing**, if you listed both managers. The node rotates through its own list on every close. |

That second row is the one that surprises people. An edge does not depend on DNS to survive a manager outage:

- `manager.urls` holds **1–16** `wss://` entries, validated at config load — empty, over 16, non-TLS, over 2048 characters, or duplicated all refuse to start.
- On any close or connect failure the client advances to the next entry and waits a fixed **5 s** before retrying. A failed connect also raises a Warning event on the node ("Manager connection lost, rotating to next URL"). The cursor advances whichever way the attempt ended, so a manager that accepts a connection and immediately drops it cannot starve the others.
- The surviving instance reads the node's stored secret from the shared Postgres and authenticates the reconnect with no operator involvement.

The relay client is the same shape, same list, same 5 s.

So there are two deployment styles, and they want different DNS:

- **List both managers on every node.** Node failover is client-side and DNS only matters to browsers. This is the resilient shape.
- **List one DNS name on every node.** Node failover now rides the record, and your TTL becomes the node reconnect time. Choose this only if you need one name to be the single point of configuration.

:::caution[One pinned fingerprint covers every URL in the list]
`cert_fingerprint` is a single value on the node's `manager` block, not per-URL. If you pin a certificate and then list two managers presenting **different** certificates, the node can only ever connect to one of them. Either front both instances with the same certificate, or leave the fingerprint unset and rely on normal CA validation.
:::

## Worked example

Two instances, one shared Postgres in Sydney, an async replica in Melbourne.

**Manager A** — `/etc/bilbycast-manager/manager.env`:

```bash
BILBYCAST_DATABASE_URL=postgres://bcm:PASS@db-syd.internal:5432/bilbycast
BILBYCAST_REGION=syd
BILBYCAST_DATA_DIR=/var/lib/bilbycast-manager/data
BILBYCAST_JWT_SECRET=…              # identical on both hosts
BILBYCAST_MASTER_KEY=…              # identical on both hosts
```

**Manager B** — the same file with `BILBYCAST_REGION=mel`, pointed at the **same** writable database.

**Every edge and relay** — in its JSON config (`config.json` on an edge, whatever path `--config` names on a relay):

```json
{
  "manager": {
    "enabled": true,
    "urls": [
      "wss://mgr-a.example.com:8443/ws/node",
      "wss://mgr-b.example.com:8443/ws/node"
    ]
  }
}
```

**DNS** — `mgr.example.com` is the browser-facing name only, weighted 100/0 towards A, with a TTL you have already lowered to 60 s. The two per-instance names in the node list are plain A records that never move.

Failing over is then one change at the provider: weight A to 0, B to 100. Browsers follow within a TTL. The nodes have already moved themselves.

:::note[Both hosts must share the master key and JWT secret]
`bilbycast-manager init --mode ha-standby` requires `--master-key` and `--jwt-secret` pasted from the primary, and refuses to run until the primary has applied migrations. Two instances with different master keys can read each other's rows and decrypt none of them — every node secret, tunnel key and API key on the far side is unreadable.
:::

## Instance identity and region tags

Each process resolves a stable UUID at boot, in this order:

1. `BILBYCAST_INSTANCE_ID`, if set — a value that is not a valid UUID aborts the boot rather than falling through to the file.
2. `<data_dir>/instance_id` — created 0600 on first boot.
3. A fresh v4 UUID, written to that file.

| Variable | Default | What it does |
|---|---|---|
| `BILBYCAST_INSTANCE_ID` | unset | Pins the instance UUID. Set it when the data directory is not durable — a Kubernetes pod without a persistent volume mints a new identity on every restart otherwise. |
| `BILBYCAST_DATA_DIR` | `data`, **relative to the working directory** | Where `instance_id` and the drain sentinel live. The unit stub `init` generates leaves this unset and points `WorkingDirectory` at the data directory instead, so `serve` ends up writing `/var/lib/bilbycast-manager/data/instance_id`. Setting it explicitly is worth doing — see the caution below. |
| `BILBYCAST_REGION` | unset → `NULL` in the row, `region="unknown"` in metrics | Free-form tag stamped on the instance's `manager_instances` row and on the `region=` label of every Prometheus sample. |

`BILBYCAST_REGION` is not cosmetic. Cross-instance round-trips are only recorded into `bilbycast_region_latency_ms` when **both** ends have a region set and the two differ — leave it unset on either host and that histogram stays permanently empty. The 500 ms per-call warning log is gated on the same condition.

Both values, plus hostname, role, software version, start time and last heartbeat, are visible at **Settings → High Availability → List Instances**, with a *you are here* badge on the instance serving your browser. That endpoint (`GET /api/v1/instances`) is SuperAdmin-only and returns HTTP 402 without a licence granting `ha`.

## Signals worth failing over on

A manager instance heartbeats its row every **5 s**; any row whose heartbeat is older than **15 s** is reaped by whichever instance sweeps next. Deleting the row cascades its `node_connections`, and the nodes that instance owned are then marked offline — which is how a dead peer's fleet is released.

| Signal | Reads as | Notes |
|---|---|---|
| `bilbycast_cluster_size` | Live instances in the last 15 s window, cluster-wide | Reported by **each** instance, so the `region=` label is the reporter's region, not a filter. When a whole region dies its series stops being scraped rather than falling to 0 — alert on absence, not on zero. |
| `bilbycast_cluster_size` = `-1` | That instance could not read Postgres | The most direct "this instance has lost the database" signal there is. |
| `bilbycast_connected_nodes` | Nodes attached to **this** instance | Watch both instances during a flip: one climbs as the other falls. |
| `bilbycast_region_latency_ms` | Cross-region manager↔manager RPC round-trip | Not database latency. Empty unless both regions are tagged and differ. |
| `bilbycast_db_pool_acquired` / `_idle` | Pool saturation, from the live pool | Each instance opens up to **50** connections with a 5 s acquire timeout, so budget `instances × 50` on the Postgres side. |

:::caution[Two probes that will not tell you what you want]
`GET /health` reads in-memory state only — version, self-signed-cert flag, licence tier. **It never touches Postgres**, so an instance whose database has gone away still answers `200 {"status":"ok"}`. A DNS provider health check pointed at `/health` will keep sending traffic to an instance that cannot serve a single page.

`bilbycast_db_pool_waiting` is exposed but has no producer today — the instrumented acquire path it counts has no callers, so it reads `0` under any load. Use `_acquired` versus `_idle` instead.
:::

## Failing over — DNS only

The reversible path. Use it whenever Region A is degraded rather than gone, and always as the first step of the other path.

1. **Lower the TTL first**, at least half an hour ahead. 60 s is a reasonable failover TTL; a default 86 400 traps you a full day past recovery.
2. **Shift the weights** at the provider — A to 0, B to 100 — or drop the A origin from the load-balancer pool.
3. **Watch `bilbycast_connected_nodes` on both instances.** If your nodes carry both URLs they have already moved; if they carry one DNS name, they arrive over the next TTL plus their 5 s backoff.
4. **Leave Postgres alone.** Nothing about this step is destructive. If Region A recovers inside your RTO, put the weights back.

## Failing over — with database promotion

Every instance points at a **single** `BILBYCAST_DATABASE_URL`. There is no multi-writer mode and no read-replica awareness: if the writable database is gone, both instances are down regardless of DNS. Promoting a replica is therefore a database operation you perform, and it is irreversible without a restore.

1. Complete the DNS-only steps above.
2. **Confirm no Region A instance is still writing.** Nothing enforces this for you. The boot gate refuses only an *unlicensed* newcomer — it exits 1 when a live peer exists and the licence lacks `ha` — and it reads neither region nor role, so a licensed Region A instance rejoins freely whether or not B has promoted.
3. **Promote the replica** with your database's own mechanism, and confirm `SELECT pg_is_in_recovery()` returns `f`.
4. **Repoint the surviving instances** at the new primary in `manager.env`, then restart each one.
5. **Label the leader**: `sudo bilbycast-manager promote`. This demotes every other row marked `primary` and stamps this one — see the caveat below about what that is worth.
6. **Restore the TTL** once the record is where you want it to stay.

:::caution[Version skew during a promotion]
`serve`, `promote`, `rejoin` and `upgrade` — and `setup`, `export`, `import`, `license` and `rotate-master-key` — all open the pool through one helper, and that helper **runs migrations** before it returns. Whichever binary touches the shared cluster first migrates it for everyone. Do not point a newer manager at a database an older peer is still serving. `backup` and `restore` are the exceptions: each opens its own single-connection pool and never migrates.
:::

## Roles are labels, not locks

`manager_instances.role` is written by `serve` (at boot), `promote`, `rejoin`, `upgrade` and `restore` — and read by exactly three things: `GET /api/v1/instances`, the settings panel, and the CLI's own output. **Nothing in the manager branches on it.** It cannot prevent a write, elect a leader, or stop a split brain.

Two consequences that catch people out:

- **Two `primary` rows is the normal steady state.** Every `serve` boot registers with the role hardcoded to `primary`, through an upsert that overwrites the existing value. A healthy licensed pair reads as split-brain if you judge by the column.
- **A `promote` does not survive a peer's restart.** The peer re-stamps itself `primary` the moment it comes back — including when you deliberately restart it during recovery. Re-run `promote` afterwards if you want the labels to match reality.

Detect a real split brain on the database side instead: two *writable* primaries, `pg_is_in_recovery()` returning `f` in both places at once. The fix is to decide which database is authoritative, demote the other one there, then run `promote` on the intended leader — one command demotes every other `primary` row and stamps itself, in that order.

## Planned failover, and coming back

For a rolling upgrade or a deliberate handover, drain rather than kill:

```bash
sudo bilbycast-manager upgrade --drain-secs 90
```

That writes `<data_dir>/upgrade.drain` carrying the requested window, and flips this instance's row to `standby`. The running `serve` polls for the sentinel every 5 s; on seeing it, it raises a Warning `upgrade_drain` event, waits out the window, deregisters its row, removes the sentinel and exits 0 for systemd. The window is a **timed wait, not a gate** — nothing refuses new connections while it runs — so size it for how long your clients need to rotate, and shift DNS away first if you want the wait to be quiet.

An instance stopped any other way (`systemctl stop`, a crash, a partition) leaves its row behind until the 15 s reaper removes it. That is normal; no operator action is needed.

Bringing a host back:

| Situation | Command |
|---|---|
| Instance restarted normally | Nothing. `serve` re-registers itself on boot. |
| Row was reaped during a long outage and the instance is not serving | `bilbycast-manager rejoin` — re-registers as `standby`, no-op if the row is already live. |
| Labels no longer match which region leads | `bilbycast-manager promote` on the intended leader. |

`promote` refuses when this host has no row at all, and tells you to `rejoin` first — though it demotes the peers *before* it checks, so a failed `promote` still leaves every other row `standby`. All three commands take `BILBYCAST_INSTANCE_ID` or read the id file, and never mint one, so a lifecycle command cannot create an identity no server ever used.

:::caution[Run the lifecycle commands where `serve` writes]
`promote`, `rejoin` and `upgrade` resolve the data directory as `--data-dir`, else `BILBYCAST_DATA_DIR`, else the **relative** `data` — the same rule `serve` uses, and `serve` has no flag of its own. Under the generated systemd unit `serve` takes its working directory from `WorkingDirectory=` with the variable unset, so a command typed from your own shell resolves `data` somewhere else entirely and cannot find the id file. Pass `--data-dir /var/lib/bilbycast-manager/data` explicitly — `manager.env` is delivered by systemd's `EnvironmentFile=` and never reaches a command you type yourself (the binary only auto-loads a `.env` in its own working directory or the one above it). The same gap applies to `BILBYCAST_DATABASE_URL`: export it, or point `--config` at a config file that carries the DSN, or the command silently falls back to the built-in `postgres://bilbycast:…@localhost:5433/bilbycast` default instead of your shared cluster.
:::

## Before you need it

Rehearse the DNS-only flip on a staging pair and confirm nodes rebalance; rehearse the promotion separately, because it is the half nothing in the manager can undo for you. Take a backup before either — see [Encrypted Backup & Restore](/manager/backup/), and note that `bilbycast-manager backup` takes `pg_try_advisory_lock(42)` so a second invocation from the peer fails immediately, naming the lock, instead of racing the first.

## Reference

- Cluster mechanics, pubsub and the licence model: [Active/Active HA](/manager/active-active-ha/).
- Backup and restore, including what `restore` does to the role column: [Encrypted Backup & Restore](/manager/backup/).
- Certificate sources for the instances DNS points at: [TLS Deployment](/manager/tls-deployment/).
- Node-side reconnect behaviour after a flip: [Config Reconciliation](/manager/config-reconciliation/).
