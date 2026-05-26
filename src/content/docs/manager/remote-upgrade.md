---
title: Remote Upgrade
description: Upgrade edge nodes and gateway sidecars from the manager UI. Sigstore-verified, with automatic rollback on a bad release.
sidebar:
  order: 13
---

The manager can upgrade every connected edge node and gateway sidecar over the existing WebSocket link — no SSH, no shell scripts on each box, no fleet-wide outage during a rolling release. Operators pick a version in the manager UI; the target node downloads + verifies the new build, atomically swaps a symlink, and respawns under systemd.

This page is the operator's runbook. The cryptographic trust model and the edge-side staging machinery live in the [edge upgrade reference](https://github.com/Bilbycast/bilbycast-edge/blob/main/docs/upgrade.md) and the [security model](https://github.com/Bilbycast/bilbycast-edge/blob/main/docs/security.md) — those documents matter if you're auditing the supply chain. Most operators only need this page.

## What the manager can upgrade

- **bilbycast-edge** nodes
- **Gateway sidecars** built on `bilbycast-gateway-sdk` — today that means [bilbycast-appear-x-api-gateway](/appear-x-gateway/setup-guide/), and any future first- or third-party sidecar that opts into the same machinery

Manager and relay binaries are upgraded **manually** today. The same Sigstore-signed releases ship for them, but there's no manager-driven rollout — see [Install the manager](/manager/getting-started/) and [Install the relay](/relay/getting-started/) for the manual flow (and the optional Sigstore-verification step on each).

## Prerequisites — first install

Manager-driven upgrade only works once the node is **already installed and registered**. The first install always uses the curl-pipe-bash one-liner:

- Edge: see [Install an edge node](/edge/getting-started/) → [Install as Ubuntu service](/edge/install-ubuntu-service/)
- Sidecar: see [Appear X gateway setup](/appear-x-gateway/setup-guide/)

Both installers lay out `/opt/bilbycast/<service>/{current,versions/<v>/,state.json,config…}` with `current` as a symlink the upgrade machinery atomically swaps. After the first install, every subsequent upgrade is the manager-driven flow on this page.

## Per-node upgrade (UI)

1. Sign in to the manager as **Operator** or higher (group-scoped — Operator on the node's owner group).
2. Navigate to **Managed Nodes** (`/admin/nodes`).
3. Find the row for the node you want to upgrade. The **Actions** column shows an **Upgrade…** button **only when the node has advertised the `"upgrade"` capability** on its most recent health beat. Older nodes that predate the upgrade module hide the control automatically.
4. Click **Upgrade…**. The modal opens and queries the available released versions for that node's binary (cached server-side for 5 min).
5. Pick a `(version, channel)`:
   - **stable** is the only channel published today.
   - The dropdown lists the most recent ~10 releases. Pick the one you want.
6. Click **Stage upgrade**.
7. The modal closes and the node row's Version column starts showing a small badge:
   - `upgrading` — the edge is staging (downloading + verifying + extracting + symlink swap)
   - `updated` — completed; the node is now running the new version
   - `upgrade failed` — staging rejected the release. Hover for the structured `error_code` (e.g. `upgrade_signature_invalid`, `upgrade_checksum_mismatch`, `upgrade_disk_full`).

Steady-state, the whole flow takes ~30 seconds for a small binary on a fast link. The node briefly disconnects from the WebSocket while systemd respawns it; the manager treats that as an in-flight upgrade and waits for the new binary to re-authenticate with the new `software_version`.

## Group bulk rollout (UI)

For larger fleets the per-node flow is tedious. Group Admin users can roll out a release across every node in a group with one action:

1. Navigate to **Groups** (`/admin/groups`) and pick the target group.
2. Click **Upgrade group**.
3. Pick `(version, channel)` and a strategy:
   - **Staged (recommended)** — the manager fans out the upgrade in three waves: 10% canary → 50% wave → 100% wave, with a 5-minute settle window between waves. If any node in a wave fails staging, the orchestrator **pauses** and the remaining waves do not run. You retry after fixing the underlying issue.
   - **Immediate** — every node in parallel. Use this for small clusters or test environments.
4. Click **Stage rollout**. The modal returns immediately with the wave plan; the actual rollout proceeds in the background. Watch the **Events** page (filter category: `upgrade`) for live progress.

## Rollback — automatic

Every staged upgrade is gated by a **boot watchdog** on the target. If the new binary fails to come up healthy within `boot_health_window_secs` (default 120 seconds) after `max_boot_attempts` (default 3) systemd respawns, the watchdog **reverts the symlink** to the previous version and emits an `upgrade_rolled_back` Critical event. No operator action required.

Rollback is your safety net — a botched build can't take a node offline indefinitely. The previous version is kept in `versions/<old>/` and the symlink revert is atomic.

If you need to roll back a successful upgrade *after* the boot health window has passed (the new version started healthy but caused a regression in production), schedule another upgrade from the manager UI to the previous version. The same staging path runs in reverse.

## Trust model — what the manager can and can't do

The manager has authority over **scheduling** an upgrade (which node, when, which version), but never over **what code runs**. The bytes are gated by the edge's compiled-in Sigstore allowlist:

1. The manager sends `upgrade_binary { version, channel }` over the existing authenticated WebSocket.
2. The target node fetches `manifest.json` + `manifest.sig.bundle` from GitHub Releases.
3. The node verifies the manifest signature against its compiled-in `ALLOWED_SIGNERS` allowlist (Sigstore Fulcio cert binding the workflow run identity, plus a Rekor transparency log lookup).
4. Only then does it use the SHA-256 in the verified manifest to download the tarball, recheck the hash, extract, and atomically swap.
5. systemd respawns into the new binary via the `current` symlink.

A fully compromised manager can only schedule a real, Sigstore-signed Bilbycast release. It cannot install arbitrary code.

The same trust roots are used by the curl-pipe-bash installer at first install, and by every manual `cosign verify-blob` an operator chooses to run.

## Audit trail

Every upgrade attempt is recorded in the audit log (`/admin/audit`):

| Action | Trigger | Details |
|---|---|---|
| `node.upgrade.request` | per-node upgrade | `{version, channel}` |
| `group.upgrade.schedule` | group rollout | `{version, channel, strategy, node_count}` |
| `group.upgrade.paused` | rollout pause-on-failure | `{version, failure_count}` |
| `group.upgrade.complete` | rollout finished | `{version, completed_count}` |

Plus the lifecycle events (`upgrade_started`, `upgrade_downloaded`, `upgrade_staged`, `upgrade_completed`, `upgrade_rolled_back`, `upgrade_*_failed`) ride the normal events stream under `category: upgrade` for dashboard / SIEM consumption.

## Troubleshooting

| Badge / error_code | Meaning | Fix |
|---|---|---|
| Upgrade button missing | Node's last health beat didn't advertise `"upgrade"` capability | Update the node manually once to a version that has the upgrade module. From then on the button appears. |
| `upgrade_disabled` | Operator left `[upgrade] enabled = false` (or omitted the section) in the node's local config | SSH to the node, set `enabled = true` in `[upgrade]`, restart the service. |
| `upgrade_channel_not_allowed` | Node's `[upgrade] allowed_channels` doesn't include the requested channel | Add the channel locally and restart. |
| `upgrade_version_too_old` | Node's `[upgrade] min_version` is higher than the requested version | Pick a newer version. |
| `upgrade_signature_invalid` / `upgrade_identity_not_allowed` | The manifest's Sigstore signature didn't pass — either tampering or a release workflow path that doesn't match the node's compiled-in allowlist | If you renamed the release workflow recently, you must publish a new release from the OLD workflow first that carries the new allowlist. |
| `upgrade_checksum_mismatch` | The downloaded tarball's SHA-256 doesn't match what the verified manifest claims | Network corruption or release-asset tampering. Retry; if it persists, file a security issue. |
| `upgrade_disk_full` | Less than ~3× the tarball size free on the install root | Free up disk on the node. |
| `upgrade_rolled_back` | The new version failed to come up healthy; watchdog reverted | Inspect `journalctl -u bilbycast-edge -e` on the node for the actual failure. The node is running the previous version again — safe to investigate. |

For deeper diagnostics, the edge ships a per-event `details.error_code` on every `category: upgrade` event — filter the events page by that category to see the full state machine.

## See also

- [Install an edge node](/edge/getting-started/) — first-time install via curl-pipe-bash
- [Install the manager](/manager/getting-started/) — manager itself (manual upgrade)
- [Install the relay](/relay/getting-started/) — relay (manual upgrade)
- [Appear X gateway setup](/appear-x-gateway/setup-guide/) — first-time sidecar install
- [Multi-tenant Groups](/manager/multi-tenant-groups/) — RBAC and group-scoped operator permissions
- [Security](/manager/security/) — full manager-side security architecture
