---
title: Master Key Rotation
description: Re-wrap every encrypted secret in the manager database under a new BILBYCAST_MASTER_KEY with the rotate-master-key CLI — coverage, pre-flight, worked procedure, and rollback.
sidebar:
  order: 12
---

`BILBYCAST_MASTER_KEY` is the root of every secret bilbycast-manager holds at rest — node auth secrets, tunnel keys and PSKs, AI provider keys, TOTP seeds and recovery codes, captured node configurations. Rotating it means re-wrapping all of them. The `rotate-master-key` subcommand does that in a single Postgres transaction, with the server stopped. This page is the runbook.

Rotation changes the **key**, not the **secrets**. A node's auth secret, a tunnel's PSK and a TOTP seed all come back out of a rotation byte-for-byte identical — only the wrapping changes. Edges reconnect with the credentials they already hold and nothing has to be re-paired. The one exception is pending registration tokens; see [What rotation invalidates](#what-rotation-invalidates).

## When to rotate

- Suspected exposure of the master key — a leaked `manager.env`, a stolen host backup, a key pasted into a ticket.
- A scheduled rotation policy (quarterly, annual).
- A personnel change: someone who could read `manager.env` has left.
- After consolidating two deployments with `import`. The import already re-wraps under the destination key, but rotating afterwards leaves you with a key nobody at the source ever held.

## The envelope model

Nothing in the database is encrypted directly with the master key. Each secret gets its own key, and the master key only wraps those:

1. `BILBYCAST_MASTER_KEY` is expanded with **HKDF-SHA256** into one **key-encryption key (KEK) per domain** — seven of them, each derived under its own info string, so a KEK recovered from one domain decrypts nothing in another.
2. Every encryption mints a fresh random 32-byte **data-encryption key (DEK)** and encrypts the plaintext with it under **AES-256-GCM**.
3. That DEK is then encrypted with the domain's KEK and stored alongside the ciphertext.

The stored blob is `v1:` followed by base64 of `dek_nonce[12] || wrapped_dek[48] || data_nonce[12] || ciphertext+tag`. Values written before envelope encryption shipped carry no prefix; they are read with a legacy undifferentiated key and are rewritten in the `v1:` shape the first time a rotation touches them.

Because every KEK is derived from the master key, the whole encrypted surface is unreadable without it — and, symmetrically, **a column survives a rotation only if the rotation explicitly rewrites that column**. Sharing a KEK domain with a covered column is not coverage.

### KEK domains

| Domain | HKDF info string | What it protects |
|---|---|---|
| Node secret | `kek:node-secret` | Per-node WebSocket auth secrets |
| AI key | `kek:ai-key` | AI provider API keys |
| Tunnel | `kek:tunnel` | Tunnel encryption keys, bind secrets, PSKs |
| Registration token HMAC | `hmac:registration-token` | Not encryption — the HMAC-SHA256 key that hashes node registration tokens |
| User MFA | `kek:user-mfa` | TOTP shared secrets and recovery-code blobs |
| Config history | `kek:config-history` | Captured node configs (which carry flow credentials in cleartext inside the blob) and the visual editor's draft / deployment configs |
| AI thread | `kek:ai-thread` | AI Configurator thread messages |

## What rotation covers

Eleven encrypted columns, all inside one transaction:

| Table | Column(s) | Domain |
|---|---|---|
| `nodes` | `auth_client_secret_enc` | Node secret |
| `ai_keys` | `api_key_enc` | AI key |
| `tunnels` | `tunnel_key_enc`, `tunnel_bind_secret_enc`, `tunnel_psk_enc` | Tunnel |
| `users` | `totp_secret_enc`, `mfa_recovery_codes_enc` | User MFA |
| `config_history` | `config_json_enc` | Config history |
| `visual_graph_drafts` | `base_config_enc` | Config history |
| `visual_graph_deployments` | `desired_config_enc` | Config history |
| `ai_messages` | `content_json_enc` | AI thread |

That census is enforced, not maintained by hand. A unit test named **`every_enc_column_in_the_schema_is_rotated`** scans every `.sql` file under `migrations-pg/` for column names ending in `_enc` and fails the build unless the rotation routine issues an assignment to each one. It exists because two columns — the visual editor's draft base config and its deployment desired config — shipped with no rotation block and nobody noticed: they share the config-history KEK domain, which *looks* like coverage. A rotation would have left them permanently undecryptable, and neither failure was loud at runtime.

Three of the eight — `visual_graph_drafts`, `visual_graph_deployments`, `ai_messages` — rotate without a counter on screen: `RotationSummary` carries eight counts and the CLI prints five. They are rewritten in the same transaction all the same. Their `SELECT`s are also the only three written to be skipped rather than propagated if the table were missing, but that branch is unreachable here — `rotate-master-key` migrates the schema to head before the rotation starts, and all three tables are created by migrations (`ai_messages` as far back as `0001_initial_schema.sql`).

## What rotation invalidates

**Pending registration tokens.** A registration token is stored as an HMAC-SHA256 digest keyed by the registration-token domain. A hash is one-way, so there is nothing to re-wrap: after rotation the manager hashes a presented token under the new key and finds no matching row. The CLI counts the affected nodes and warns about them.

Regenerate each pending node's token at `/admin/nodes` once the server is back up, then re-run that node's setup wizard with the new token. Nodes that have already registered are unaffected — their stored secret was re-wrapped, not replaced.

## What rotation does not touch

| Not affected | Why |
|---|---|
| User passwords | Argon2id hashes, independent of the master key. |
| Sessions and JWTs | Signed with `BILBYCAST_JWT_SECRET`. Operators stay signed in across a rotation. |
| OIDC / SSO client secret | Read from `BILBYCAST_OIDC_CLIENT_SECRET` at startup; it is never stored in the database, so there is nothing to re-wrap. |
| DVR viewer grant keys | Stored as plain SHA-256 digests of 32 random bytes — master-key independent. |
| Existing backup files | An application-level `.bcbackup` export is sealed under its own passphrase and holds decrypted secrets, so it stays restorable. A DR `pg_dump` archive holds raw ciphertext and remains bound to whichever master key was live when it was taken. See [Encrypted Backup & Restore](/manager/backup/). |
| Node auth secret **values** | Re-wrapped, not regenerated. To mint a genuinely new node secret, use `POST /api/v1/nodes/{id}/rotate-secret` instead. |

## Key requirements

| Variable | Read by | Validated as | Notes |
|---|---|---|---|
| `BILBYCAST_MASTER_KEY` | `serve`, `export`, `import`, `rotate-master-key` | Set, non-empty, **at least 64 characters**, free of known weak substrings (`change-me`, `default`, `secret`, `password`, …) | The key currently in force. During rotation this must still be the **old** key. |
| `BILBYCAST_NEW_MASTER_KEY` | `rotate-master-key` only | Set, **at least 16 characters**, and different from the current key | The replacement. |

`openssl rand -hex 32` produces exactly 64 hex characters and satisfies both.

> **The CLI's floor for the new key is lower than every floor that later has to read it back — rotating onto a short key strands the database.** `rotate-master-key` accepts a 16-character replacement, but the ≥64-character check gates `BILBYCAST_MASTER_KEY` on `serve`, on `export`, on `import` **and on `rotate-master-key` itself**. Rotate onto anything shorter than 64 and nothing opens the database again: the server refuses to start, an export refuses to run, and a second rotation refuses too — the short key is now the *current* key, and that is the one it validates first. The only way back is a backup taken before the rotation. Always generate the new key with `openssl rand -hex 32`.

Both variables are read from the process environment. The CLI also sources a `.env` from the working directory, falling back to `../.env` and stopping at the first one it finds, but **a variable already present in the environment wins over the file** — so an export in the invoking shell always beats what is on disk. `/etc/bilbycast-manager/manager.env` is *not* one of the names it looks for: source it yourself, as the procedure below does.

## Before you rotate

1. **Stop the manager on every instance.** Rotation takes no advisory lock and performs no leader election, so nothing stops you running it against a live cluster. The transaction rewrites the encrypted rows of `nodes`, `tunnels`, `users` and `ai_keys` and holds those row locks until commit, while a live peer keeps reading wrapped DEKs through its **old** key ring — a read that interleaves with the commit gets ciphertext it cannot open. In an HA pair, `sudo systemctl stop bilbycast-manager` on **both** hosts.
2. **One invocation covers the cluster.** Both instances share one Postgres, so run `rotate-master-key` once, from either host. You do not run it per instance.
3. **Write the new key down first.** Generate it, put it in your password manager, and only then run the rotation. A key that exists only in a shell that has since closed is a lost key.
4. **Take a backup.** `bilbycast-manager export --output pre-rotation.bcbackup` (licensed, `FEATURE_BACKUP`) or `bilbycast-manager backup --output pre-rotation.bin`. The rotation rolls back cleanly on error, but this is the artefact you fall back to if the *key handling* goes wrong rather than the transaction.
5. **Use the binary you are about to run as the server.** `rotate-master-key` opens its pool through the same initialiser `serve` uses, which applies any outstanding migrations in `migrations-pg/` before the rotation begins.

## Procedure

A worked run on the standard systemd layout from [Install the Manager](/manager/getting-started/), where secrets live in `/etc/bilbycast-manager/manager.env` and the binary in `/opt/bilbycast-manager/`.

```bash
# 1. Stop the server — on every instance in an HA pair.
sudo systemctl stop bilbycast-manager

# 2. Generate the new key and record it somewhere safe BEFORE going further.
openssl rand -hex 32
# → 7f3c1e...  (64 hex chars — copy this into your password manager now)

# 3. Rotate, as root — manager.env is 0640 root:bilbycast.
#    BILBYCAST_MASTER_KEY must still be the OLD key here; the DSN comes
#    from the same file (or from the config file's database_url).
sudo -s
set -a; . /etc/bilbycast-manager/manager.env; set +a
BILBYCAST_NEW_MASTER_KEY=7f3c1e... \
  /opt/bilbycast-manager/bilbycast-manager rotate-master-key \
    --config /opt/bilbycast-manager/config/default.toml
```

A successful run prints a per-category summary:

```text
Rotating master encryption key...
This will re-encrypt all secrets in the database.

Rotation complete:
  Node secrets rotated:   14
  AI API keys rotated:    2
  Tunnel secrets rotated: 9
  User MFA secrets rotated: 3
  Config history rotated: 412

  WARNING: 2 pending registration token(s) invalidated.
  Regenerate tokens for pending nodes after updating the master key.

Next steps:
  1. Update BILBYCAST_MASTER_KEY to the new value in your environment/.env file
  2. Remove BILBYCAST_NEW_MASTER_KEY from the environment
  3. Restart the server
```

The counts are rows, not columns: `Tunnel secrets rotated: 9` means nine tunnel rows were rewritten (up to three columns each), and `Node secrets rotated` counts only nodes that actually hold a secret. The registration-token warning appears only when there are pending nodes. Visual-editor drafts, visual deployments and AI thread messages rotate in the same transaction without a summary line.

Then swap the key into the environment file and bring the service back:

```bash
# 4. Point the server at the new key.
sudo sed -i 's|^BILBYCAST_MASTER_KEY=.*|BILBYCAST_MASTER_KEY=7f3c1e...|' \
  /etc/bilbycast-manager/manager.env

# 5. Restart — in an HA pair, one host at a time, and update
#    each host's manager.env before starting it.
sudo systemctl start bilbycast-manager

# 6. Smoke test.
curl -fsSk https://localhost:8443/health
sudo journalctl -u bilbycast-manager -n 50 --no-pager
```

Then, in the UI:

- Sign in and confirm the node list, tunnels and AI keys all load. Anything the new key cannot open surfaces as a decrypt failure in the log, not as a blank page.
- Confirm each edge and relay comes back **online** — they re-authenticate with the secret they already hold.
- Regenerate registration tokens for any node still **pending** at `/admin/nodes`.
- Store the pre-rotation backup as carefully as the old key, or destroy it. Whoever holds both can read every old ciphertext.

## Rollback

The rotation runs inside a single transaction. On any error — a row it cannot decrypt, a lost connection, the process being killed — the transaction rolls back and **the database is unchanged**. Leave `manager.env` pointing at the old key, start the server, and investigate.

If the CLI reported success and the server then fails to decrypt, the near-certain cause is that `manager.env` was not updated, or the new key was mis-pasted. Stop the server, compare the value in `manager.env` against the key you passed as `BILBYCAST_NEW_MASTER_KEY` character for character, and restart.

If the database really is rotated and the new key is genuinely gone, restore the pre-rotation backup:

```bash
sudo systemctl stop bilbycast-manager
# The export holds decrypted secrets, so it is portable across keys:
# whichever BILBYCAST_MASTER_KEY is set here is what they get re-wrapped
# under. Set the OLD key to land back where you started.
bilbycast-manager import --input pre-rotation.bcbackup
sudo systemctl start bilbycast-manager
```

`import` has no `--force` flag: it always replaces the destination, prompts on the terminal for the backup passphrase and for a typed `YES`, and refuses to run without a licence granting `FEATURE_BACKUP`. Run it somewhere you can answer both prompts.

## If the old key is lost

Without the old `BILBYCAST_MASTER_KEY` there is nothing to decrypt the source ciphertexts with, so `rotate-master-key` cannot run at all. Two recovery paths, in order of preference:

1. **An application-level export taken while the old key still worked.** `export` decrypts with the source key ring and seals the plaintext under the passphrase, so the archive is portable across master keys. Run `bilbycast-manager import --input <file>` with the **new** key in the environment; the secrets are re-wrapped under it during import.
2. **A DR `pg_dump` archive taken under the old key** — restorable only onto a cluster whose `BILBYCAST_MASTER_KEY` is that same old key. It re-keys nothing.

With neither, every encrypted secret is gone: node auth secrets, MFA enrolments, AI keys, tunnel keys. Re-bootstrap — regenerate node registration tokens, reset passwords, re-enrol MFA, redistribute tunnel keys.

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| `Environment variable BILBYCAST_MASTER_KEY is not set.` | The old key is not in the environment and not in a `.env` the CLI found. | Source it — `set -a; . /etc/bilbycast-manager/manager.env; set +a` — or run from a directory holding a `.env`. Only `.env` and `../.env` are picked up automatically. |
| `BILBYCAST_MASTER_KEY is too short (N chars). Must be at least 64 hex chars (32 bytes)` | Truncated paste. | Check with `printf '%s' "$BILBYCAST_MASTER_KEY" \| wc -c` — it should print `64`. |
| `BILBYCAST_MASTER_KEY contains a weak/default value.` | The key contains a placeholder substring such as `change-me` or `password`. | Generate a real key. No secret was rewritten — though the pool is opened, and any outstanding migrations applied, before the key is validated. |
| `BILBYCAST_NEW_MASTER_KEY environment variable is required` | The new key was not exported in the same shell. | Export both variables in the invocation that runs the CLI. |
| `BILBYCAST_NEW_MASTER_KEY must be at least 16 characters` | Truncated or placeholder replacement. | `openssl rand -hex 32`. |
| `BILBYCAST_NEW_MASTER_KEY must differ from the current BILBYCAST_MASTER_KEY` | Both variables hold the same value — usually a copy-paste, sometimes an attempt to re-randomise DEKs in place. | Generate a genuinely new key. There is no DEK-only rotation: the check runs before the key rings are built and before the transaction opens, so no ciphertext was rewritten. |
| `Failed to decrypt <secret> …: Decryption failed` | A column holds ciphertext sealed under a *different* key — typically a `pg_dump` archive restored from another deployment without re-keying. | The transaction rolled back. Take an `export` first: if that also reports skipped secrets, the database holds cross-deployment ciphertext and the source deployment's backup is the way back. |
| Server starts, every edge fails to authenticate | `manager.env` still names the old key while the database is rotated. | Update the env file to the new key and restart. |
| A node sits **pending** and its token is rejected | Its registration token was invalidated by the rotation. | Regenerate the token at `/admin/nodes` and re-run that node's setup wizard. |

## Reference

- The envelope format, the per-column KEK domains and the rest of the at-rest design: [Security architecture](/security/).
- Manager authentication, session handling and deployment hardening: [Security](/manager/security/).
- Backup paths and their master-key coupling: [Encrypted Backup & Restore](/manager/backup/).
- Stopping and restarting instances in a pair: [Active/Active HA](/manager/active-active-ha/).
- Environment file layout and the systemd unit: [Install the Manager](/manager/getting-started/).
