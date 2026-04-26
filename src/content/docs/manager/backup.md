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
| **Application-level export / import** | Persisted application tables only — users, nodes, tunnels, settings, AI keys, audit log, events. Ephemeral runtime state (sessions, instance heartbeats, PTP cache) is intentionally excluded. Re-encrypts secrets across master keys, so the file is portable across deployments. | Nightly / weekly snapshots; consolidating two deployments; exporting customer data on contract end. |
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

### What gets restored

The list of persisted tables (`EXPORTED_TABLES`) covers users, nodes, tunnels, AI keys, config templates, settings, managed flows, flow groups, topology positions, UI preferences, audit log, events. Order matters — parents before children; restore runs in a single Postgres transaction with deferred constraint checks.

Ephemeral tables (`sessions`, `revoked_sessions`, `node_connections`, `node_config_snapshots`, `ptp_state_cache`, `oidc_state`, `user_mfa_attempts`, `manager_instances`, `cross_instance_rpc`) are wiped on restore — they would propagate stale runtime state across machines.

The calling session's user row is replaced wholesale. The API response includes `"session_invalidated": true` and the UI bounces to `/login`.

### CLI

Same logic as the REST endpoints, prompted for the passphrase:

```
bilbycast-manager export --output backup.bcbkv2
bilbycast-manager import --input backup.bcbkv2 --force
```

`--force` is required when the destination DB already holds more than the bootstrap admin or any nodes — the safe default refuses to overwrite a populated database.

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

Successful backups stamp `runtime_metrics.backup_last_success_unix`, surfaced as the Prometheus gauge `bilbycast_backup_last_success_timestamp`. Operations teams alert on staleness, not zero — the gauge is `0` only on a fresh deployment that has never run a backup.

## Threat model

| Property | Application export | DR backup |
|---|---|---|
| Cipher | AES-256-GCM | AES-256-GCM |
| KDF | Argon2id (`m=64MiB, t=3, p=1`) | Argon2id (`m=64MiB, t=3, p=1`) |
| Authenticated? | Yes (GCM tag) | Yes (GCM tag) |
| Portable across master keys? | Yes — secrets re-wrapped on import | No — a `pg_dump` archive only restores onto a cluster whose `BILBYCAST_MASTER_KEY` matches the source |
| Captures ephemeral state? | No — sessions / heartbeats / PTP cache deliberately wiped | Yes — full cluster snapshot |
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

- Operator runbook: [`USER_GUIDE.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/USER_GUIDE.md) ("Backup & Restore (Super Admins only)").
- Master-key rotation runbook: [`master-key-rotation.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/master-key-rotation.md).
- API reference: [`API.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/API.md) ("Backup & Restore (Encrypted)").
- HA failover runbook: [`DNS_FAILOVER.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/DNS_FAILOVER.md).
