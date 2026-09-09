---
title: Encrypted Backup & Restore
description: Two passphrase-sealed backup paths for bilbycast-manager — portable application-level export and DR-grade pg_dump archive, both AES-256-GCM via Argon2id.
sidebar:
  order: 10
---

bilbycast-manager ships **two distinct encrypted backup paths**. Both seal the output with a passphrase via Argon2id-derived AES-256-GCM keys, with the same threat model — but they cover different operational scopes.

## Why two paths

| Path | Scope | When to use |
|---|---|---|
| **Application-level export / import** | The 50 persisted application tables — tenancy, nodes, tunnels, settings, AI keys, managed flows, switcher, routines, master graphs, address pools, multiviewer, replay, DVR, config history, audit log, events. Ephemeral runtime state (sessions, node connections, PTP and telemetry caches) is intentionally excluded, and so is HA cluster state. Re-encrypts secrets across master keys, so the file is portable across deployments. | Nightly / weekly snapshots; consolidating two deployments; exporting customer data on contract end. |
| **DR-grade `pg_dump` archive** | Full Postgres-level snapshot. Round-trips every row including `manager_instances`, `node_connections`, `cross_instance_rpc` — the full cluster, byte-for-byte. | Hardware replacement; restoring after a corrupted database; the safety net for "lost master key" scenarios. |

Both paths exist because they answer different questions. Export is "I want to migrate my application data." Backup is "I want to put the cluster on a new machine without losing a single byte."

## Application-level export / import

Gated by `FEATURE_BACKUP` in the licence. Without it, `POST /api/v1/export` and `POST /api/v1/import` return HTTP 402 Payment Required. SuperAdmin only; CSRF required; 10 MiB upload cap on import.

### File format (v2)

```
magic[8]            "BCBKv2\n\0"
header_len[4]       little-endian
header JSON         { format_version:2, created_at, exporter, kdf{…, salt}, schema_version }
nonce[12]
AES-256-GCM(payload_json) || tag[16]
```

The decrypted payload is a JSON dump of every persisted table plus a `secret_columns` metadata block listing which columns will be re-encrypted on restore.

### Why secrets are re-encrypted

`_enc` blobs in the database are wrapped with KEKs derived from the source `BILBYCAST_MASTER_KEY`. Dumping ciphertext as-is would make the file useless on another machine with a different master key. So:

- **On export**, secret columns are decrypted with the source `KeyRing` before being sealed into the backup.
- **On import**, the same secrets are re-encrypted under the destination `KeyRing`.

Two consequences:

- The file is **portable across master keys**. Restore on a fresh deployment with a fresh `BILBYCAST_MASTER_KEY`; the secrets re-wrap automatically.
- The passphrase is the **single-point-of-failure**. Lose it, and the file is unrecoverable. There is no escrow, no reset, no back door — by design.

### When a secret can't be decrypted

Export is **not** all-or-nothing. An `_enc` blob the source `KeyRing` can no longer open is written into the archive as NULL and the run carries on — that blob was already unrecoverable, and the alternative is one dead row taking down every nightly backup indefinitely. Failing the whole export instead is an opt-in policy, not what `POST /api/v1/export` does.

Three places surface the loss:

- The `X-Bilbycast-Skipped-Secrets` response header carries the **count**. The response body is the archive itself, so a header is the only way a warning reaches the browser at all.
- The **`backup.export` audit row** carries the itemised list — table, column, row id, reason. That is the only place the detail lands on the manager itself, so check it after any export reporting a non-zero count.
- The list is also sealed **inside the archive**. A restore replays it — one warning per secret, plus the itemised list on the `backup.restore` audit row — so the loss is discoverable when you restore rather than only in the export operator's terminal months earlier. It is *not* in the import API response, so a restore driven from the UI shows nothing.

A secret that comes back NULL is gone: re-register that node, or re-key that tunnel.

### What gets restored

`EXPORTED_TABLES` round-trips 50 tables. Order matters — parents before children; restore runs in a single Postgres transaction with foreign-key enforcement suspended for the duration (`SET session_replication_role = 'replica'`, re-set to `origin` before the commit), which needs a role holding REPLICATION.

- **Tenancy and identity** — `users`, `groups`, `group_members`, `resource_shares`.
- **Fleet** — `nodes`, `tunnels`, `unit_links` (the cabling an operator wrote down; nothing else recreates it).
- **Catalog and configuration** — `service_templates`, `config_templates`, `settings`, `ai_keys`.
- **Flows** — `managed_flows`, `flow_groups`.
- **Switcher** — `switcher_pages`, `switcher_presets`.
- **Routines** — `routines`, `routine_actions`, `routine_schedules`, `routine_activations`.
- **Visual editor and master graphs** — `master_graphs`, `master_graph_members`, `master_graph_connections`, `generated_endpoints`, `visual_graph_layout`, `visual_graph_drafts`, `config_history`, `visual_graph_deployments`.
- **Address pools** — `address_pools`, `address_pool_exclusions`, `address_allocations`. The allocations are the half worth being explicit about: a pool restored without them believes its whole range is free.
- **Multiviewer** — `mv_monitoring_objects`, `mv_heads`, `mv_layouts`, `mv_layout_tiles`, `mv_walls`, `mv_routings`, `mv_routing_entries`.
- **Replay** — `replay_clips`, `recording_sync_groups`, `recording_sync_group_members`, `replay_sync_clips`, `replay_sync_clip_members`.
- **Browser DVR** — `dvr_sessions`, `dvr_access_grants`, `dvr_portal_users`, `dvr_portal_entitlements`.
- **UI state and history** — `topology_positions`, `ui_preferences`, `audit_log`, `events`.

Ephemeral tables (`sessions`, `revoked_sessions`, `node_connections`, `node_config_snapshots`, `ptp_state_cache`, `epoch_lock_state_cache`, `psi_catalog_cache`, `node_bus_programs`, `oidc_state`, `user_mfa_attempts`, `stream_history`, `network_history`) are wiped on restore — they would propagate stale runtime state across machines, and each one refills from the live stream within a tick or two.

The calling session's user row is replaced wholesale. The API response includes `"session_invalidated": true` and the UI bounces to `/login`.

### What an export does not carry

Seventeen live tables sit in neither list, so an export drops them and a restore leaves whatever the destination already held:

- **Services** — `services`, `service_versions`, `service_steps`, `service_automations`.
- **Children whose parents *are* exported** — `switcher_preset_actions` (so presets restore with no actions: buttons that exist and do nothing), `managed_inputs`, `managed_outputs`, `transcode_profiles`, `tunnel_teardown_targets`.
- **AI threads** — `ai_threads`, `ai_messages`, `ai_applied_actions`, `ai_embeddings`. History rather than current state, though `ai_keys` *is* exported.
- **HA cluster state** — `manager_instances`, `cross_instance_rpc`. Neither exported *nor* cleared, so the destination's own cluster rows survive a restore untouched.
- **Auth-failure counters** — `login_auth_failures`, `node_auth_failures`.

That set is a ratchet, not an exemption: a completeness test fails if it grows, so a newly added table has to be classified before it can ship. Licensees can read the standing record of why each entry is still unresolved in `docs/qa/export-classification-decisions.md`.

### CLI

The same core routines as the REST endpoints, prompted for the passphrase:

```
bilbycast-manager export --output backup.bcbkv2
bilbycast-manager import --input backup.bcbkv2
```

The CLI import has **no `--force` flag**. It always overwrites, and its only guard is an interactive prompt that wants `YES` typed in full. Only `POST /api/v1/import` refuses a populated destination — more than one user, or any nodes at all — unless the request body carries `force: true`. The `--force` on the DR `restore` command below is a different flag on a different code path.

## DR-grade `pg_dump` archive

**Not** gated by `FEATURE_BACKUP` — disaster recovery is always available. SuperAdmin via CLI only.

### File format (v1)

```
magic[8]   "BCBKMGR1"
salt[16]   Argon2id salt
nonce[12]  AES-256-GCM nonce
ciphertext+tag (Argon2id m=64MiB t=3 p=1, AES-256-GCM seals the inner pg_dump)
```

The inner format is `pg_dump --format=custom`, so restore pipes through `pg_restore --clean --if-exists --no-owner` on the destination cluster. The output captures the **full cluster** — every row of every table, including the ephemeral runtime state the application-level export deliberately drops.

### HA-safe

A single `pg_try_advisory_lock(42)` on a single connection from the pool serialises backups across an HA pair. Two simultaneous `backup` invocations on a primary + standby would race on `pg_dump` from the single writer; the lock lets the first proceed and the second bail fast. Released when the pool drops.

### CLI

```
bilbycast-manager backup  --output backup.bin                      [--passphrase-file path]
bilbycast-manager backup  --output s3://bucket/key                  [--passphrase-file path]
bilbycast-manager restore --input backup.bin                        [--passphrase-file path] [--force]
```

Restore decrypts, pipes the inner dump through `pg_restore`, then flips this instance's `manager_instances.role` to `primary` so the restored cluster boots writable on the destination host. S3 output is supported when AWS creds are in the environment.

### Observability

`/api/v1/metrics` exposes the Prometheus gauge `bilbycast_backup_last_success_timestamp`, but **nothing writes it yet** — `runtime_metrics.backup_last_success_unix` has no producer, so the gauge reads `0` on every install whether or not a backup has ever run. Running a backup cannot change that: `backup` is a short-lived CLI process while the gauge lives in the serving process's memory, so wiring it up needs a durable store rather than an in-process counter. Do not build a staleness alert on it — alert on the backup job's own exit status instead.

## Threat model

| Property | Application export | DR backup |
|---|---|---|
| Cipher | AES-256-GCM | AES-256-GCM |
| KDF | Argon2id (`m=64MiB, t=3, p=1`) | Argon2id (`m=64MiB, t=3, p=1`) |
| Authenticated? | Yes (GCM tag) | Yes (GCM tag) |
| Portable across master keys? | Yes — secrets re-wrapped on import | No — a `pg_dump` archive only restores onto a cluster whose `BILBYCAST_MASTER_KEY` matches the source |
| Captures ephemeral state? | No — sessions / node connections / PTP + telemetry caches deliberately wiped | Yes — full cluster snapshot |
| Licence-gated? | Yes (`FEATURE_BACKUP`) | No |
| Available via | REST + CLI | CLI only |

In both cases, **passphrase loss = unrecoverable file**. There is no escrow. Treat the passphrase like a master key: store it in a password manager, share it through a secure channel, never paste it into a chat.

## DR scenario walkthrough

A hardware failure on the primary manager host:

1. The standby instance in the HA pair is still serving traffic — the licence-gated cluster mechanics kept the read path alive.
2. Provision a replacement host. Run `bilbycast-manager init --mode ha-primary` to generate keys, certs, env file, systemd unit stub.
3. Copy a recent DR backup to the new host. Run `bilbycast-manager restore --input backup.bin`. The restore wipes the destination, applies the dump, and flips the new host's `manager_instances.role` to `primary`.
4. Start the new instance via systemd. It rejoins the cluster automatically; the standby promotes itself back to standby on the next heartbeat.
5. Cut DNS over to the recovered primary on your usual schedule.

If the recovery host has a fresh `BILBYCAST_MASTER_KEY` (e.g. you've also lost the original), use the application-level export instead — the DR backup is master-key-bound, the export isn't.

## Reference

- Master-key rotation: [Security](/manager/security/#master-key-rotation).
- Backup & restore endpoints: [API reference](/manager/api-reference/).
- HA failover: [Active-active HA](/manager/active-active-ha/).
