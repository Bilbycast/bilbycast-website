---
title: Manager Protocol
description: Overview of how bilbycast-edge integrates with bilbycast-manager — commands supported, diff-based updates, atomic flow groups, live secret rotation.
sidebar:
  order: 11
---

bilbycast-edge connects outbound to its bilbycast-manager via a persistent, authenticated WebSocket. The manager pushes commands; the edge pushes stats, health, thumbnails, and operational events back. This page is a **capability overview** — full message schemas, payload shapes, and protocol extension rules are provided to commercial licensees and integration partners under NDA.

## What the edge can be commanded to do

The manager can drive the complete lifecycle of a managed edge without the operator touching the node's `config.json`:

- **Read the running config**, with node-bound infrastructure secrets stripped so they never leave the device. Flow-level credentials that the operator entered (SRT passphrases, RTSP creds, RTMP keys, bearer/HLS tokens) are preserved so the manager UI can display and round-trip them.
- **Update config** — either the whole config or a single flow. Updates are **diff-based**: unchanged flows are not disturbed, and output-only changes are hot-applied without interrupting the flow's other outputs.
- **Create / update / delete / start / stop / restart flows**, individually.
- **Hot-add and hot-remove outputs** on a running flow without dropping live SRT connections or other in-flight outputs.
- **Manage tunnels** — create, delete, start, stop.
- **Start and stop flow groups atomically.** Multi-essence bundles (e.g., ST 2110-30 audio + ST 2110-31 transparent + ST 2110-40 ANC as one program) are brought up or down as a single logical unit, with automatic rollback on partial failure so a receiver never sees one essence without its companions.
- **Rotate the node's authentication secret on a live connection.** The new secret is written to the edge's encrypted secrets file atomically; old secrets are invalidated by the manager once the edge has acknowledged the write. No downtime, no WebSocket drop.

## What the edge pushes unsolicited

The edge emits four kinds of outbound messages:

| Message | Cadence | Purpose |
|---|---|---|
| `stats` | every 1 s | Per-flow input/output bitrates, packet counts, FEC stats, TR 101 290, IAT / PDV |
| `health` | every 15 s | Node-level health, software version, capability list |
| `thumbnail` | every 10 s per flow | 320×180 JPEG preview (when enabled) |
| `event` | on state change | Operational events with severity, category, optional `flow_id` and details — see [Events & Alarms](/edge/events-and-alarms/) |

Events are deduplicated — they fire on state transitions, not periodically — and queued when the manager is disconnected so a reconnect delivers the backlog.

## Secret boundaries

Two classes of secret are treated differently:

- **Infrastructure secrets** (node↔manager auth, tunnel keys and bind secrets, server TLS, OAuth client credentials) are device-bound. They are **never** returned to the manager on config reads. When the manager pushes a config update, the edge re-injects its local infrastructure secrets before applying.
- **Flow-level user credentials** (the passphrases and tokens an operator types into the manager UI) are preserved through config reads so the UI can show and round-trip them.

This split means the manager can be compromised without exposing any node-bound credential, while the operator UX of "I typed this passphrase into the manager; I expect to see it there" is preserved.

## Backward-compatible evolution

The protocol is designed to evolve without breaking running deployments. Edges advertise a `protocol_version` and `software_version` at connect time; newer edges and older managers (or vice versa) coexist cleanly. Unknown message types on either side are logged and ignored rather than tearing down the connection. The same resilience pattern applies to the [edge ↔ relay tunnel protocol](/relay/architecture/).

## Full protocol reference

The complete command enumeration, request/response envelopes, error shapes, diff-rule tables, and flow-group lifecycle semantics are documented in the commercial integration reference supplied under NDA. Contact **contact@bilbycast.com** for access.
