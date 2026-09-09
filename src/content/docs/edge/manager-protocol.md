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
- **Activate an input** — and *only* this command moves what is on air. A whole-config push, including a config-history restore, pins every passthrough flow's `inputs[].active` back to whatever the node already has on air, so replaying a stale copy of the config can never perform a Take as a side effect of an unrelated edit. Two cases take the pushed value instead: assembled (PID-bus) flows, which never read the flag, and a flow with nothing on air yet. The one exception is a push that *deletes* the on-air input — with no incumbent left to hold, the edge promotes a survivor (preferring the member the pushed config flags active) by moving the pointer only, never splicing an assembled flow's program.
- **Create / update / delete / start / stop / restart flows**, individually.
- **Hot-add and hot-remove outputs** on a running flow without dropping live SRT connections or other in-flight outputs.
- **Hot-add and hot-remove inputs** on a running flow. A change to a flow's input roster is applied surgically, so the flow's outputs keep running across the edit, and editing a *standby* input's definition is applied in place (remove + add) — the on-air input is never disturbed. The edge escalates to a full flow restart only when it refuses the surgical path: the edited member is the flow's active input, a PID-bus slot source, or a leg of a hitless slot.
- **Hot-swap a flow's assembly plan** on a running assembled flow. Unchanged slots keep their bus fan-ins with no packet gap; `PMT.version_number` bumps mod 32 for changed programs, `PAT.version_number` only when the set of programs changes, and PSI is re-emitted immediately so receivers see the new PMT before any packet lands on a new `out_pid`. Transitions across the passthrough ↔ assembled boundary are rejected — those need a full update. See [Flow Assembly (PID Bus)](/edge/flow-assembly/).
- **Manage tunnels** — create (an upsert) and delete. There is no separate start / stop verb: `create_tunnel` establishes the tunnel the moment it lands and `delete_tunnel` tears it down. A tunnel's `enabled` flag only decides whether the node brings that tunnel up at boot, so clearing it in a pushed config does not stop a running tunnel until the edge restarts.
- **Start and stop flow groups atomically.** Multi-essence bundles (e.g., ST 2110-30 audio + ST 2110-31 transparent + ST 2110-40 ANC as one program) are brought up or down as a single logical unit, with automatic rollback on partial failure so a receiver never sees one essence without its companions.
- **Rotate the node's authentication secret on a live connection.** The new secret is written to the edge's encrypted secrets file atomically; old secrets are invalidated by the manager once the edge has acknowledged the write. No downtime, no WebSocket drop.
- **Run on-demand diagnostics** — probe an input or output before committing it (refused while that entity is attached to a running flow, so a test can never steal a live port), measure a bonded leg's reachable capacity against a peer's probe responder, check a cellular or Starlink uplink, and reset a flow's statistics counters.

## What the edge pushes unsolicited

The edge emits four kinds of outbound messages:

| Message | Cadence | Purpose |
|---|---|---|
| `stats` | every 1 s | Per-flow input/output bitrates, packet counts, FEC stats, TR 101 290, IAT / PDV |
| `health` | every 15 s | Node-level health, software version, capability list |
| `thumbnail` | every 5 s per flow (configurable 1–60 s) | 320×180 JPEG preview (when enabled) |
| `event` | on state change | Operational events with severity, category, optional `flow_id` and details — see [Events & Alarms](/edge/events-and-alarms/) |

Events are deduplicated — they fire on state transitions, not periodically — and queued when the manager is disconnected so a reconnect delivers the backlog.

## Secret boundaries

Two classes of secret are treated differently:

- **Infrastructure secrets** (node↔manager auth, tunnel keys and bind secrets, server TLS, OAuth client credentials) are device-bound. They are **never** returned to the manager on config reads. When the manager pushes a config update, the edge re-injects its local infrastructure secrets before applying.
- **Flow-level user credentials** (the passphrases and tokens an operator types into the manager UI) are preserved through config reads so the UI can show and round-trip them.

This split means the manager can be compromised without exposing any node-bound credential, while the operator UX of "I typed this passphrase into the manager; I expect to see it there" is preserved.

## Backward-compatible evolution

The protocol is designed to evolve without breaking running deployments. Edges advertise a `protocol_version` and `software_version` at connect time; newer edges and older managers (or vice versa) coexist cleanly. The current version is **4**, which added the native binary media-library upload frame — an edge below it is refused that one upload with a `compatibility` warning event rather than being left to drop the frame silently (see [Media Library](/manager/media-library/)). Unknown message types on either side are logged and ignored rather than tearing down the connection. The same resilience pattern applies to the [edge ↔ relay tunnel protocol](/relay/architecture/).

## Full protocol reference

The complete command enumeration, request/response envelopes, error shapes, diff-rule tables, and flow-group lifecycle semantics are documented in the commercial integration reference supplied under NDA. Contact **contact@bilbycast.com** for access.
