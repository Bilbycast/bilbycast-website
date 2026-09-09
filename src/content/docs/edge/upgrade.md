---
title: Remote Upgrade (Edge Side)
description: How an edge node verifies, stages and rolls back a manager-scheduled binary upgrade — the Sigstore trust chain, the `upgrades` config block, the on-disk layout, and the boot watchdog.
---

An edge node can be upgraded from the manager over the WebSocket link it already holds: no SSH, no per-box shell script. The node fetches a Sigstore-signed release manifest, verifies it against an identity allowlist compiled into its own binary, downloads the tarball named by that manifest, atomically swaps a symlink, and exits for systemd to respawn. If the new binary crash-loops, a boot watchdog inside it counts the restarts and puts the symlink back.

This page is the **node** side — what it verifies, what it writes to disk, what you configure, and how rollback behaves. For the operator runbook (the Upgrade button, group rollouts, badge states) see [Remote Upgrade](/manager/remote-upgrade/) on the manager. For the wider supply-chain picture see [Security architecture](/security/).

## The shape of it

The manager never chooses bytes. It names a `(version, channel)` pair; everything else — the URL, the hash, whether to install at all — is decided on the node from data the node itself verified.

1. **Policy gate.** The node checks the request against its own `upgrades` block before touching the network.
2. **Deterministic URL.** The release base URL is built from the version alone: `https://github.com/Bilbycast/bilbycast-edge/releases/download/v<version>`. The manager cannot influence it.
3. **Verify the manifest.** `manifest.json` + `manifest.sig.bundle` are fetched and the Sigstore keyless signature is checked — Fulcio certificate chain, Rekor transparency-log entry, then the workflow identity against the compiled-in `ALLOWED_SIGNERS` allowlist.
4. **Download by verified hash.** The tarball for this host's `(arch, variant)` is streamed and SHA-256'd against the digest inside the *verified* manifest.
5. **Stage atomically.** Extract to `versions/<v>.partial/`, `rename(2)` to `versions/<v>/`, rotate `current` → `previous`, `rename(2)` a new `current` symlink into place.
6. **Drain and exit.** Emit `upgrade_staged`, wait 5 seconds for in-flight packets, `exit(0)`. systemd respawns through the `current` symlink.
7. **Prove it works.** The new binary's boot watchdog counts boots on the staged version and rolls back to `previous` once that count passes `max_boot_attempts`.

## Turning it on

Upgrades are **off by default in the code** (`enabled` defaults to `false`), but the `install-edge.sh` installer writes them **on** — a node installed the recommended way is already opted in:

```json
{
  "upgrades": {
    "enabled": true,
    "allowed_channels": ["stable"],
    "install_root": "/opt/bilbycast/edge"
  }
}
```

A fuller block, with every field spelled out:

```json
{
  "upgrades": {
    "enabled": true,
    "allowed_channels": ["stable"],
    "min_version": "0.100.0",
    "rollback_grace": 1,
    "install_root": "/opt/bilbycast/edge",
    "boot_health_window_secs": 45,
    "max_boot_attempts": 3,
    "manual_only": false
  }
}
```

| Field | Type | Default | Bounds | Meaning |
|---|---|---|---|---|
| `enabled` | bool | `false` | — | Master switch. When false every `upgrade_binary` command is refused with `upgrade_disabled`, before any network traffic. Also disarms the boot watchdog. |
| `allowed_channels` | `[string]` | `["stable"]` | 1–8 entries, each ≤ 32 chars, alphanumeric plus `-` / `_`, no duplicates | Channels this node will install. `stable` is the only channel published today — the release workflow hard-codes it into every manifest. |
| `min_version` | string | unset | valid semver | Version floor. Anything below is refused with `upgrade_version_too_old`. |
| `rollback_grace` | u32 | `1` | ≤ 100 | How many **minor** versions back the node will move. `1` allows a step back to the previous minor line and blocks a forced downgrade to anything older. |
| `install_root` | path | `/opt/bilbycast/edge` | absolute, ≤ 4096 chars | Where `versions/`, `current`, `previous` and `state.json` live. Relative paths are refused at config load. |
| `boot_health_window_secs` | u32 | `120` | 10–86 400 | How long after staging the node must look healthy before the install is promoted to `stable`. Read the [promotion rule](#promotion-and-the-60-second-freshness-check) before changing it — the default does not behave the way the name suggests. |
| `max_boot_attempts` | u32 | `3` | 1–10 | Boots on the staged version before the watchdog reverts. The revert fires on attempt `max + 1`. |
| `manual_only` | bool | `false` | — | **Does not do what the name says.** See [manual_only](#manual_only-is-not-a-staging-mode). |

Validation runs at config load (`config::validation::validate_upgrade_config`) — a value outside the bounds above stops the node from starting, it is not silently clamped.

:::caution[The `upgrades` block is read once, at startup]
The coordinator snapshots `upgrades` when the process starts and nothing updates that snapshot afterwards. A pushed config change to this block — including turning `enabled` off — takes effect at the node's **next restart**, not on the push.
:::

### The capability bit

Every edge that carries the upgrade module advertises `"upgrade"` on `HealthPayload.capabilities`, and it advertises it **unconditionally** — the bit says "this binary understands `upgrade_binary`", not "this node is configured for upgrades". So the manager's per-node Upgrade control appears on any modern edge; a node with no `upgrades` block accepts the command and immediately fails it with `upgrade_disabled` and the message *upgrades not configured on this node*.

### Egress the node needs

Staging is the one operation where the edge reaches out to hosts other than its manager and its media peers. On a locked-down site, allow outbound TCP/443 to:

| Host | Why |
|---|---|
| `github.com` | The manifest, the bundle and the tarball URL the node constructs. |
| `*.githubusercontent.com` | GitHub 302-redirects release-asset downloads to its own CDN (`release-assets.githubusercontent.com` today, `objects.` historically). |
| `tuf-repo-cdn.sigstore.dev` | The Sigstore Public Good TUF repository, from which the Fulcio CA certificates and Rekor public keys are loaded at verification time. |

## What the node checks, in order

Everything below happens before a single byte of the new binary is written to disk. Each row names the `command_ack.error_code` the manager receives when that check fails.

| # | Check | `error_code` on failure |
|---|---|---|
| 1 | Only one staging run at a time (in-process guard) | `upgrade_in_progress` |
| 2 | `upgrades.enabled == true` | `upgrade_disabled` |
| 3 | Requested channel is in `allowed_channels` | `upgrade_channel_not_allowed` |
| 4 | Requested version parses as semver | `upgrade_version_invalid` |
| 5 | Version window: `≥ min_version`, not the version already running, same major, no further back than `rollback_grace` minors | `upgrade_version_too_old` |
| 6 | Constructed URL passes the exact-match host allowlist | `upgrade_url_invalid` |
| 7 | Manifest + bundle fetch (1 MiB cap each, 30 s timeout, 3 attempts) | `upgrade_network_error` |
| 8 | Sigstore verification — see [the trust chain](#the-trust-chain) | `upgrade_signature_invalid`, `upgrade_identity_not_allowed`, `upgrade_rekor_invalid` |
| 9 | Manifest cross-check: `version`, `channel`, `device_type == "edge"`, non-empty artefacts, well-formed URLs and 64-hex digests | `upgrade_manifest_invalid` |
| 10 | `manifest.sequence > state.last_sequence` (replay defence) | `upgrade_sequence_too_old` |
| 11 | An artefact exists for this host's `(arch, variant)` | `upgrade_arch_mismatch` |
| 12 | Streamed SHA-256 equals the digest in the verified manifest (512 MiB cap, 600 s timeout) | `upgrade_checksum_mismatch` |
| 13 | Extraction + atomic swap | `upgrade_extract_failed`, `upgrade_disk_full` |

Check 5 is worth reading twice: `upgrade_version_too_old` is the code for *every* version-window rejection, including "you asked for the version already running" and "that crosses a major boundary". The human-readable message in the ack says which.

Network fetches make up to three attempts on 5xx, 429 and 408, backing off 250 ms and then 500 ms between them. Any other status fails immediately.

## The trust chain

Three roots decide whether a manifest is genuine. Only one of them is Bilbycast's.

| Root | Where it comes from | How it rotates |
|---|---|---|
| Fulcio CA certificates | The Sigstore Public Good TUF repository, loaded through the `sigstore` crate at verification time | Sigstore's own rotation, announced in advance |
| Rekor public keys | Same source, same load | Same |
| `ALLOWED_SIGNERS` identity allowlist | Compiled into this binary — `src/upgrade/trust.rs` | Only when the release workflow path itself changes |

The allowlist is a single entry, and all four of its claims must match the Fulcio certificate:

```rust
AllowedSigner {
    issuer:      "https://token.actions.githubusercontent.com",
    repo:        "https://github.com/Bilbycast/bilbycast-edge",
    ref_pattern: "refs/tags/v*",
    workflow:    "https://github.com/Bilbycast/bilbycast-edge/.github/workflows/nightly-release.yml",
}
```

`issuer` and `repo` are exact string equality against the certificate's Fulcio extensions (OIDs `1.3.6.1.4.1.57264.1.1` and `.1.5`); `ref_pattern` is a `*`-suffix glob against `.1.6`; `workflow` is a prefix match against the certificate's SAN URI. A release built from `main` rather than a `v*` tag produces a `refs/heads/main` certificate and fails — which is why the release workflow is driven by a tag push, not a schedule.

Verification runs these steps and every one must pass:

1. Parse the cosign bundle — `cert` (PEM), `base64Signature`, `rekorBundle`. A bundle with no Rekor entry is rejected outright; transparency is not optional.
2. Chain the leaf certificate to a trusted Fulcio CA. This is the anti-forgery check: without it, anyone could self-sign a certificate carrying the right workflow identity.
3. Require the Rekor entry's `integratedTime` to fall inside the certificate's `[notBefore, notAfter]` window — Fulcio issues short-lived certificates, so this pins the signature to the moment the workflow ran.
4. Require the Rekor entry body to bind **this** manifest's SHA-256 and **this** certificate, so a valid entry for some other artefact cannot be replayed alongside a forged manifest.
5. Verify the Rekor Signed Entry Timestamp under a trusted Rekor key.
6. Match the certificate's identity claims against `ALLOWED_SIGNERS`.
7. Verify the ECDSA signature over the raw manifest bytes.

There is no long-lived signing key anywhere in this path. The release workflow requests a short-lived OIDC token, Fulcio mints a certificate against it, an ephemeral keypair signs and is thrown away, and the signing event is recorded permanently in Rekor against a specific commit and tag.

### Where the URL allowlist bites

Two different rules apply to two different kinds of URL, and the difference is deliberate:

- **URLs the manifest declares** (`artefacts[].url`) and URLs the node constructs are checked against an **exact-match** host list: `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com`. HTTPS only, ≤ 2048 chars.
- **Redirect targets**, which GitHub chooses rather than the manifest, are accepted anywhere in the `*.githubusercontent.com` family (plus `github.com` itself), maximum five hops, HTTPS only. GitHub renamed that CDN once already and pinned nodes stopped upgrading; the bytes are SHA-256-checked against the signed manifest regardless of which CDN host served them.

## The manifest

One `manifest.json` per release tag, signed once, listing every artefact:

```json
{
  "artefacts": [
    {
      "arch": "x86_64-linux",
      "sha256": "…64 hex chars…",
      "url": "https://github.com/Bilbycast/bilbycast-edge/releases/download/v0.109.0/bilbycast-edge-x86_64-linux-full.tar.gz",
      "variant": "full"
    },
    {
      "arch": "aarch64-linux",
      "sha256": "…",
      "url": "https://github.com/Bilbycast/bilbycast-edge/releases/download/v0.109.0/bilbycast-edge-aarch64-linux-full.tar.gz",
      "variant": "full"
    },
    {
      "arch": "aarch64-linux",
      "sha256": "…",
      "url": "https://github.com/Bilbycast/bilbycast-edge/releases/download/v0.109.0/bilbycast-edge-aarch64-linux-rockchip.tar.gz",
      "variant": "rockchip"
    }
  ],
  "channel": "stable",
  "device_type": "edge",
  "released_at": "2026-09-07T04:11:32Z",
  "sequence": 74,
  "version": "0.109.0"
}
```

| Field | Type | Meaning |
|---|---|---|
| `version` | string | Semver, must equal the version the manager asked for. |
| `device_type` | string | `"edge"`. An edge refuses a manifest for any other device type. |
| `channel` | string | Must equal the requested channel and be in `allowed_channels`. Always `stable` today. |
| `released_at` | string | ISO-8601 UTC, second precision, from the workflow runner's clock. Informational — the authoritative signing time is the Rekor entry's `integratedTime`. |
| `sequence` | u64 | Monotonic counter per `device_type` (the GitHub Actions run number). A node installs only a manifest whose `sequence` is **strictly greater** than the one it last installed. |
| `artefacts[]` | array | One row per `(arch, variant)`: `arch`, `variant`, `url`, `sha256`. |

The manifest is emitted with sorted keys (`jq -cS`) so the signed byte sequence is reproducible, and the node verifies the signature against the raw bytes it fetched — never a re-serialised copy.

### How a node picks its artefact

The node reports what it is, and looks for an exact `(arch, variant)` row.

| Host / build | `arch` | `variant` |
|---|---|---|
| x86_64 Linux | `x86_64-linux` | `rockchip` if built with `video-encoder-rkmpp`; else `full` if built with `video-encoder-x264` or `-x265`; else `default` |
| aarch64 Linux | `aarch64-linux` | as above |
| aarch64 macOS | `aarch64-darwin` | as above |
| anything else | `<arch>-<os>` from the Rust target | as above |

Three artefacts are published per release: `(x86_64-linux, full)`, `(aarch64-linux, full)` and `(aarch64-linux, rockchip)`. There is **no `default` artefact**, so a node running a binary you built yourself with plain `cargo build --release` reports `variant: default`, finds no matching row, and fails with `upgrade_arch_mismatch`. That is the intended outcome — self-built nodes are upgraded the way they were installed.

The manager may override both with the optional `target_arch` / `variant` fields on the command. A `target_arch` that disagrees with the host raises a Warning event before staging continues.

## On disk

The upgrade machinery owns `install_root`:

```text
/opt/bilbycast/edge/
├── current      → versions/0.109.0/    # systemd ExecStart resolves through this
├── previous     → versions/0.108.0/    # rollback target, created on first upgrade
├── versions/
│   ├── 0.108.0/bilbycast-edge
│   └── 0.109.0/bilbycast-edge
├── state.json                          # upgrade lifecycle record
├── config.json                         # operational config
└── secrets.json                        # 0600, machine-key encrypted
```

The systemd unit's `ExecStart` is `/opt/bilbycast/edge/current/bilbycast-edge`, so the swap lands the moment the old process exits. The unit runs `Restart=always` with `RestartSec=3` and `StartLimitBurst=10` per 300 s, which is what lets a crash-looping build burn through its boot attempts quickly enough for the watchdog to act.

Staging is built entirely on `rename(2)` on one filesystem, so power loss leaves the node either fully upgraded, fully on the old version, or holding a `versions/<v>.partial/` directory that is unambiguously not the live target:

1. Extract into `versions/<v>.partial/`. Tar entries with absolute paths or `..` segments are refused, and every unpack target is checked to stay under the extraction root.
2. Find `bilbycast-edge` at the root or one level down, `chmod 0755` it, hoist it to the top of the partial directory, fsync.
3. `rename(2)` the partial directory onto `versions/<v>/`.
4. Rotate the existing `current` target onto `previous`, symlink `current.tmp`, `rename(2)` it onto `current`, fsync the install root.
5. Sweep: `*.partial` orphans always go; of the remaining version directories the newest three by mtime are kept alongside the live one.

`state.json` is written last, under an advisory `flock(2)`, via tempfile + fsync + rename:

```json
{
  "current_version": "0.109.0",
  "previous_version": "0.108.0",
  "channel": "stable",
  "variant": "full",
  "arch": "x86_64-linux",
  "status": "pending_health",
  "boot_attempts": 0,
  "staged_at": "2026-09-07T04:20:11Z",
  "last_sequence": 74
}
```

## The boot watchdog

The watchdog runs inside the **new** binary, before flow initialisation, and is a no-op when `upgrades` is absent or `enabled` is false. A missing `state.json` (a node that has never been upgraded) or an unreadable one continues the boot normally.

| `status` | What the watchdog does |
|---|---|
| `stable` | Nothing. Normal boot. |
| `pending_health` | Increments `boot_attempts` in place. If the new count is still `≤ max_boot_attempts`, boot continues. If it exceeds it, the watchdog points `current` back at `previous`, sets `status = rolled_back`, emits a Critical `upgrade_rolled_back`, and `exit(1)` — systemd respawns into the old binary. |
| `rolled_back` | Emits the Critical `upgrade_rolled_back` event (this is the boot where the manager actually hears about it), resets `status` to `stable` and `boot_attempts` to 0, and continues on the reverted version. |
| `staged_manual` | Nothing. Nothing in the codebase ever writes this status. |

The revert needs `versions/<previous>/` to still exist. If it has been swept or deleted the revert fails, is logged, and the node exits anyway — but `current` still points at the new build, so the next boot comes up on it with `status` reset to `stable` and the crash-loop protection spent. Keep at least one older version directory on disk.

### Promotion, and the 60-second freshness check

A background task ticks every 5 s and promotes `pending_health → stable`, emitting the Info `upgrade_completed` event, when **both** of these hold:

- at least `boot_health_window_secs` have elapsed since `staged_at`, **and**
- the last recorded healthy beat is no more than **60 seconds** old.

That second timestamp is written **only when the node authenticates to the manager** — on `auth_ok`, i.e. on each new WebSocket session, not on each health tick.

:::caution[The default 120 s window cannot be satisfied by a node that stays connected]
A node that respawns, authenticates once about ten seconds after staging, and then holds that session has a healthy-beat timestamp roughly 110 seconds old by the time the default 120 s window elapses — past the 60 s freshness limit. Promotion then waits for the next `auth_ok`, the only thing that refreshes that timestamp. Until one arrives, `state.json` stays at `pending_health`, no `upgrade_completed` event is emitted, and **every boot keeps spending a `boot_attempts` slot**. Any reconnection clears it — the next 5 s tick then sees a fresh beat against a long-elapsed window and promotes — so an ordinary restart normally resolves it on the way back up. What is left exposed is a node that restarts while it cannot reach its manager: `max_boot_attempts` such boots and the watchdog reverts a binary that was never at fault.

Set `boot_health_window_secs` below 60 (for example `45`) so both conditions can be met by the single authentication that follows the respawn. After the promotion, `boot_attempts` is no longer incremented and ordinary restarts are harmless.
:::

## A worked upgrade

Assume a node running v0.108.0 with the config above, and v0.109.0 published.

```bash
curl -sS -X POST https://manager.example.com/api/v1/nodes/edge-syd-01/upgrade \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"version": "0.109.0", "channel": "stable"}'
```

`channel` defaults to `stable` if you omit it (the manager accepts `stable`, `nightly` or `beta`, and caps the version string at 32 characters); `target_arch` and `variant` are optional overrides. The manager forwards `upgrade_binary` over the node's WebSocket and hands the node's own `command_ack` payload back under `data`, unchanged, so a successful staging run comes back as:

```json
{
  "command_id": "8b1f7c2e-…",
  "success": true,
  "data": {
    "status": "staged",
    "from_version": "0.108.0",
    "to_version": "0.109.0",
    "channel": "stable",
    "variant": "full",
    "arch": "x86_64-linux"
  }
}
```

A node-side rejection comes back as HTTP 422 with `{ "error": "…", "error_code": "…" }`, carrying one of the codes from the table above. The manager screens the request first and answers HTTP 400 — same body shape — for a `version` longer than 32 characters or carrying anything outside `[A-Za-z0-9.+_-]` (`upgrade_version_invalid`) or a `channel` that is not `stable` / `nightly` / `beta` (`upgrade_channel_not_allowed`). The ack races the node's own exit, so a request that times out is reported as in-flight (HTTP 200, `status: "requested"`) rather than failed — watch the events, not the HTTP status.

The events that follow, on the node's Events page:

| Event | Severity | When |
|---|---|---|
| `upgrade_started` | info | Policy gate passed, staging begins |
| `upgrade_downloaded` | info | Manifest verified and tarball SHA-256 matched (carries `size_bytes`) |
| `upgrade_staged` | info | Symlink swapped; node is draining for respawn |
| `upgrade_completed` | info | Promoted to `stable` (carries `healthy_seconds`) |
| `upgrade_rolled_back` | critical | Watchdog reverted to the previous version |

Those five, plus `upgrade_staged_manual` and the code-less Warning raised when an explicit `target_arch` disagrees with the host, are the only `upgrade`-category rows that reach the event feed. Every other `upgrade_*` string is a `command_ack.error_code` on a failed command — alarm on the ack, not on an events filter. Full list: [Events & Alarms](/edge/events-and-alarms/#remote-upgrade-upgrade).

On the box:

```bash
readlink -f /opt/bilbycast/edge/current      # /opt/bilbycast/edge/versions/0.109.0
jq -r '.status, .boot_attempts, .last_sequence' /opt/bilbycast/edge/state.json
journalctl -u bilbycast-edge -n 50
```

## Refusing upgrades on a locked-down node

Set `enabled` to `false` and restart the node. Every `upgrade_binary` is then rejected with `upgrade_disabled` before any network traffic, and the boot watchdog is disarmed too.

### `manual_only` is not a staging mode

:::danger[`manual_only` does not stage anything, and nothing can complete it]
The field reads as "download and verify now, swap later on my say-so". What it actually does is verify the release and then **throw it away**: the node emits `upgrade_staged_manual`, returns before extraction, and acks the command as a **failure** with `error_code: upgrade_staged_manual`. Nothing is extracted, no `versions/<v>/` appears, `state.json` is untouched, and there is no signal handler that could finish the swap — the process installs handlers for `SIGTERM` and `SIGINT` only, and the manual-apply function has no callers.

To refuse upgrades, use `enabled: false`. To recover a node left on `manual_only`, clear the field **and restart the edge** (the block is snapshotted at startup), then re-issue the command — nothing was persisted, so the sequence guard does not block the retry.
:::

## Manual rollback

If a build boots and authenticates cleanly but misbehaves in a way the watchdog cannot see — the flows are wrong, not the process — roll back by hand:

```bash
sudo systemctl stop bilbycast-edge
sudo ln -sfn /opt/bilbycast/edge/versions/0.108.0/ /opt/bilbycast/edge/current.tmp
sudo mv -Tf /opt/bilbycast/edge/current.tmp /opt/bilbycast/edge/current
# Stop the watchdog fighting you on the next boot:
sudo jq '.current_version = "0.108.0" | .previous_version = "0.109.0"
         | .status = "stable" | .boot_attempts = 0' \
    /opt/bilbycast/edge/state.json > /tmp/state.json \
  && sudo install -o bilbycast -g bilbycast -m 0644 /tmp/state.json /opt/bilbycast/edge/state.json
sudo systemctl start bilbycast-edge
```

:::note[Re-installing the same version needs a newer release]
`last_sequence` is not reset by a rollback, automatic or manual. Because the node requires `manifest.sequence > state.last_sequence`, re-issuing the *same* version you just rolled back from is refused with `upgrade_sequence_too_old`. Roll forward to a newer release, or edit `last_sequence` in `state.json` deliberately while the service is stopped.
:::

## Verifying a release by hand

Anyone can check a published release with public information only — the same identity policy the node enforces, expressed as the certificate-identity regexp the release workflow itself verifies against:

```bash
VERSION=0.109.0
BASE="https://github.com/Bilbycast/bilbycast-edge/releases/download/v${VERSION}"
curl -fsSL -O "${BASE}/manifest.json"
curl -fsSL -O "${BASE}/manifest.sig.bundle"

cosign verify-blob \
    --bundle manifest.sig.bundle \
    --certificate-identity-regexp 'https://github\.com/Bilbycast/bilbycast-edge/\.github/workflows/nightly-release\.yml@refs/tags/v.*' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    manifest.json

# Then check the tarball you hold against the digest inside the verified manifest.
jq -r --arg arch x86_64-linux --arg variant full \
    '.artefacts[] | select(.arch == $arch and .variant == $variant) | .sha256' \
    manifest.json
sha256sum "bilbycast-edge-x86_64-linux-full.tar.gz"
```

Installing cosign, and the same recipe against `releases/latest`, are covered in [Install an Edge Node](/edge/getting-started/#verify-the-sigstore-signature-optional).

## Troubleshooting

| Symptom | Where to look |
|---|---|
| Upgrade button present, command fails `upgrade_disabled` | The node has no `upgrades` block, or `enabled` is false, or it was turned on in config but the node has not restarted since. |
| `upgrade_arch_mismatch` | The node's `(arch, variant)` has no row in the manifest — usually a self-built binary reporting `variant: default`. Check the variant rules above. |
| `upgrade_sequence_too_old` | The target release is not newer than the last one installed on this node. Check `.last_sequence` in `state.json`. |
| `upgrade_network_error` on the manifest fetch | Egress to `github.com` blocked, or blocked at the CDN redirect. See [Egress the node needs](#egress-the-node-needs). |
| `upgrade_signature_invalid` with a trust-root message | `tuf-repo-cdn.sigstore.dev` unreachable, so the Fulcio / Rekor roots could not be loaded. Verification is fail-closed: an unreachable trust root is a rejection, not a bypass. |
| `upgrade_identity_not_allowed` | The manifest is signed, but not by the Bilbycast release workflow. Treat this as a security event, not a transient failure. |
| Status stuck at `pending_health` | Expected with the default 120 s window on a node that stays connected — see the [promotion rule](#promotion-and-the-60-second-freshness-check). Otherwise the new binary is not authenticating: check the manager URL, node secret and TLS settings. |
| Repeated `upgrade_rolled_back` | The staged build cannot complete `max_boot_attempts` boots. `journalctl -u bilbycast-edge` from the failing boots is the record; the node is running the previous version in the meantime. |
