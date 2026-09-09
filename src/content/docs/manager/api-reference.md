---
title: API Reference
description: REST and WebSocket API reference for bilbycast-manager.
sidebar:
  order: 2
---

This page lists the public-facing HTTP endpoints exposed by bilbycast-manager and their purpose at a high level. It is **not** a complete integration reference — the manager registers over 250 routes under `/api/v1`, and what follows is the operator-visible surface, one table per feature area. Full request/response schemas, WebSocket command enumerations, backup file format, and internal protocol details are provided to commercial licensees under NDA.

Most endpoints require authentication via a session cookie (set automatically at login). API clients may alternatively use an `Authorization: Bearer <token>` header.

State-changing requests (POST, PUT, PATCH, DELETE) to authenticated endpoints also require an `X-CSRF-Token` header matching the `csrf_token` cookie value.

---

## Authentication

| Method | Path                                   | Description                                                           |
|--------|----------------------------------------|-----------------------------------------------------------------------|
| POST   | `/api/v1/auth/login`                   | Password login. Rate-limited per IP.                                  |
| POST   | `/api/v1/auth/login-form`              | Form-based login with redirect.                                       |
| POST   | `/api/v1/auth/logout`                  | Log out and clear session.                                            |
| GET    | `/api/v1/auth/me`                      | Return the current user's profile.                                    |
| PUT    | `/api/v1/auth/me`                      | Self-service profile edit.                                            |
| POST   | `/api/v1/auth/change-password`         | Self-service password change.                                         |

### MFA (TOTP)

| Method | Path                                    | Description                                    |
|--------|-----------------------------------------|------------------------------------------------|
| POST   | `/api/v1/auth/mfa/totp/setup`           | Start TOTP enrollment.                         |
| POST   | `/api/v1/auth/mfa/totp/confirm`         | Finalise enrollment and return recovery codes. |
| POST   | `/api/v1/auth/mfa/totp/disable`         | Turn MFA off (requires password + code).       |
| POST   | `/api/v1/auth/mfa/verify`               | Complete login after the MFA challenge.        |
| POST   | `/api/v1/auth/mfa/verify-form`          | Same, for the form-based login flow (redirects rather than returning JSON). |

### SSO (OIDC)

| Method | Path                                 | Description                                   |
|--------|--------------------------------------|-----------------------------------------------|
| GET    | `/api/v1/auth/oidc/status`           | Public probe — is SSO enabled on this server? |
| GET    | `/api/v1/auth/oidc/login`            | Start the OIDC authorisation flow.            |
| GET    | `/api/v1/auth/oidc/callback`         | IdP callback.                                 |

SSO is a commercially licensed feature. See the [SSO setup guide](/manager/security/#single-sign-on-oidc) for per-IdP configuration.

---

## Users

| Method | Path                    | Description              |
|--------|-------------------------|--------------------------|
| GET    | `/api/v1/users`         | List all users           |
| POST   | `/api/v1/users`         | Create a new user        |
| GET    | `/api/v1/users/{id}`    | Get user by ID           |
| PUT    | `/api/v1/users/{id}`    | Update user              |
| DELETE | `/api/v1/users/{id}`    | Delete user              |

---

## Nodes

| Method | Path                          | Description                              |
|--------|-------------------------------|------------------------------------------|
| GET    | `/api/v1/nodes`               | List all registered nodes (filter by `?device_type=`) |
| POST   | `/api/v1/nodes`               | Register a new node                      |
| GET    | `/api/v1/nodes/endpoints`     | Inputs and outputs from every connected edge node the caller can see, each tagged with that node's `network_zone` — the cross-node listener picker's source |
| GET    | `/api/v1/device-types`        | List registered device drivers           |
| GET    | `/api/v1/nodes/{id}`          | Get node by ID                           |
| PUT    | `/api/v1/nodes/{id}`          | Update node metadata                     |
| DELETE | `/api/v1/nodes/{id}`          | Delete node                              |
| POST   | `/api/v1/nodes/{id}/token`    | Regenerate registration token            |
| GET / PUT | `/api/v1/nodes/{id}/config` | Read the cached config from a connected node, or push a whole configuration |
| POST   | `/api/v1/nodes/{id}/command`  | Send a command to a connected node       |
| POST   | `/api/v1/nodes/{id}/reconcile`| Re-run config reconciliation against the node |
| GET    | `/api/v1/nodes/{id}/config-history` | List stored configuration snapshots (`/{sid}`, `/{sid}/label`, `/{sid}/restore` act on one) |
| POST   | `/api/v1/nodes/{id}/rotate-secret` | Rotate the node's auth secret (requires an active WebSocket) |
| GET    | `/api/v1/nodes/{id}/stats`    | Latest stats snapshot (`/stats-history` for the retained series) |
| GET    | `/api/v1/nodes/{id}/resources`| The node's advertised resource budget    |
| GET    | `/api/v1/nodes/{id}/psi-catalogs` | The most recent PSI catalogue cached per input, each with the time it was captured — the source list behind the track/PID picker |
| GET    | `/api/v1/nodes/{id}/display-devices` | KMS connectors for the local-display output. `204` when the node reports none |
| GET    | `/api/v1/nodes/{id}/sdi-devices` | DeckLink per-port health. Always `200` with a tagged envelope rather than an error — `state` is `unsupported` on an edge built without `sdi-decklink`, `offline` when the node is not connected, `no_devices` when no card was found |
| GET    | `/api/v1/nodes/{id}/network-history` | Per-interface bandwidth and drop/error history behind the node page's sparklines |
| GET    | `/api/v1/nodes/{id}/fabric-discovery` | Read-only projection of the cached health envelope — interface identities and addresses, PTP state, advertised MXL domains, NMOS state |
| GET    | `/api/v1/device-types/{device_type}` | Metadata for one driver (`/ui-manifest` for its UI contract) |

The set of valid commands and their payload schemas is specific to each device driver. The list of supported commands per driver is returned by `/api/v1/device-types` and documented in full in the commercial integration reference.

`/api/v1/nodes/{id}/command` requires **Operate** on the node as a baseline, and then enforces the driver's own declared minimum role for the named command on top of it — so a command a driver marks admin-only is refused with HTTP 403 and `error_code: "insufficient_role"` even for a caller who can start and stop flows. The declared minimum rides on `/api/v1/device-types` as `supported_commands[].requires_role`; see [Per-command roles](/manager/security/#role-based-access-control-rbac).

### Node Bus

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/v1/nodes/{id}/bus` | The node-wide elementary-stream bus — every program currently visible across every input, with its per-program ES detail. Built from the `psi_catalog` blocks the node publishes on its stats frames, so an edge that publishes none simply answers with an empty list |
| PUT    | `/api/v1/nodes/{id}/bus/routes` | Bulk slot rerouting. Body `{routes: [{flow_id, program_number, out_pid, source, stream_type?}, …]}` — non-empty, at most 64 per request (`413` beyond that). Per-flow atomic; a multi-flow swap reports per-flow results rather than failing as a whole. Requires Operate on the node |

See [Node Bus Matrix](/manager/node-bus/).

---

## Flows, Inputs & Outputs

Inputs and outputs are first-class entities; flows reference them by ID. Every mutation here is proxied to the node over its WebSocket, so the node is always the one that accepts or rejects it.

| Method | Path | Description |
|--------|------|-------------|
| POST   | `/api/v1/nodes/{id}/flows` | Create a flow |
| PUT / DELETE | `/api/v1/nodes/{id}/flows/{flow_id}` | Update or delete a flow |
| POST   | `/api/v1/nodes/{id}/inputs` | Create an input |
| PUT / DELETE | `/api/v1/nodes/{id}/inputs/{input_id}` | Update or delete an input |
| POST   | `/api/v1/nodes/{id}/outputs` | Create an output |
| PUT / DELETE | `/api/v1/nodes/{id}/outputs/{output_id}` | Update or delete an output |
| POST   | `/api/v1/nodes/{id}/flows/{flow_id}/inputs` | Add an input to a **running** flow without restarting it |
| DELETE | `/api/v1/nodes/{id}/flows/{flow_id}/inputs/{input_id}` | Remove an input from a running flow |
| POST   | `/api/v1/nodes/{id}/flows/{flow_id}/activate-input` | Make one input the flow's active input |
| POST   | `/api/v1/nodes/{id}/flows/{flow_id}/outputs/{output_id}/active` | Enable or disable a single output |
| PUT    | `/api/v1/nodes/{id}/flows/{flow_id}/assembly` | Hot-swap the PID-bus assembly plan |
| POST   | `/api/v1/nodes/{id}/flows/{flow_id}/master-clock/lipsync` | Apply the per-flow lip-sync trim |
| POST   | `/api/v1/nodes/{id}/flows/{flow_id}/reset-counters` | Reset the flow's stats counters |
| GET    | `/api/v1/nodes/{id}/flows/{flow_id}/thumbnail` | Latest flow thumbnail (`…/inputs/{input_id}/thumbnail` per input) |
| POST   | `/api/v1/nodes/{id}/test-input` · `/test-output` | Validate an input/output definition without attaching it to a flow |

The manager preflights new inputs and outputs against already-managed entities and rejects address collisions with HTTP 422 and `error_code: "port_conflict"` before any WebSocket round-trip.

---

## Media library

Proxied to the edge's on-disk library, which a `media_player` input replays. See [Media Library](/manager/media-library/).

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/v1/nodes/{id}/media` | List the files in the node's library |
| POST   | `/api/v1/nodes/{id}/media/upload` | Upload one chunk. The body is the raw chunk bytes (`application/octet-stream`) and the metadata rides the query string (`?name=&chunk_index=&total_chunks=&total_bytes=`) — no base64 anywhere on the path. The browser sends 1 MiB chunks and anything above 2 MiB is refused; the manager allows 60 s for each chunk's ACK rather than its usual 10 s, because the last one waits on the edge checking the assembled length and renaming the staging file into place |
| POST   | `/api/v1/nodes/{id}/media/upload/abort` | Record an upload the operator cancelled. Raises a `media_upload_aborted` event only past the half-way mark, so cancelling the wrong file does not spam the events feed |
| DELETE | `/api/v1/nodes/{id}/media/{name}` | Idempotent delete. If a `media_player` input still references the file, the manager raises `media_deleted_in_use` naming the inputs and flows that do |
| GET    | `/api/v1/nodes/{id}/media/{name}/programs` | Probe the asset's PAT so the program picker offers a real list rather than a guess |
| GET    | `/api/v1/nodes/{id}/media/{name}/manifest` | The persisted manifest for an asset — kind derived from the bytes, not the extension |
| POST   | `/api/v1/nodes/{id}/media/{name}/reprobe` | Force the manifest to be re-derived |
| POST   | `/api/v1/nodes/{id}/media/plan` | Classify every adjacent playlist boundary, and the loop wrap, before the playlist is saved — an incompatible splice shows at edit time rather than on air |
| POST   | `/api/v1/nodes/{id}/flows/{flow_id}/inputs/{input_id}/media-player/next` | Advance a running media-player input to the next item. The body's required `expected_generation` must be the generation the UI last saw, so a double-click cannot skip two items. The UI offers the control only on nodes advertising `media-player-control-v1`; the route forwards either way, and an input not running the controller answers `media_player_control_unavailable` |

The first chunk of an upload runs a quota preflight and answers HTTP 413 with `error_code: "media_quota_exhausted"` when the file would breach the 4 GiB per-file cap or push the library past its 16 GiB total, raising a matching warning event so the refusal is visible outside the upload modal.

---

## Switcher

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/switcher/presets` | List or create presets |
| PUT / DELETE | `/api/v1/switcher/presets/{id}` | Update or delete a preset |
| POST   | `/api/v1/switcher/presets/{id}/activate` | Activate a preset straight to PGM |
| POST   | `/api/v1/switcher/take` | Promote PVW to PGM |
| POST   | `/api/v1/switcher/pvw` | Set or clear the PVW bus (omit the preset id to clear) |
| GET / POST | `/api/v1/switcher/pages` | List or create preset pages |
| PUT / DELETE | `/api/v1/switcher/pages/{id}` | Update or delete a page |

Activating a preset — straight to PGM, or by **Take** from Preview — requires the **Operator** role in the preset's owner group plus per-node Operate on every action target; staging a preset onto Preview needs the same group role but touches no node, so no per-node check applies. Creating, editing and deleting presets and pages requires **Admin**. Listing is not role-gated at all — it is visibility-filtered only, so any member of the owning group sees that group's presets and pages whatever their role. See [Live Switcher](/manager/switcher/).

---

## Routines

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/routines` | List or create routines |
| GET / PUT / DELETE | `/api/v1/routines/{id}` | Read, update or delete a routine |
| POST   | `/api/v1/routines/{id}/preview` | Dry-run — what the routine would do |
| POST   | `/api/v1/routines/{id}/activate` | Fire the routine now |
| GET    | `/api/v1/routines/{id}/activations` | Activation history for one routine |
| GET    | `/api/v1/routines/upcoming` | Next scheduled firings across all routines |
| POST   | `/api/v1/routines/{rid}/schedules` | Add a cron schedule |
| PUT / DELETE | `/api/v1/routines/{rid}/schedules/{sid}` | Update or delete a schedule |
| PATCH  | `/api/v1/routines/{rid}/schedules/{sid}/toggle` | Enable or disable a schedule |
| POST   | `/api/v1/routines/{rid}/schedules/{sid}/skip-next` | Skip the next firing only |

See [Routines](/manager/routines/).

---

## Replay & Recordings

Recording and scrub controls are proxied to the edge's replay server. They exist only on nodes advertising the `replay` capability.

| Method | Path | Description |
|--------|------|-------------|
| POST   | `/api/v1/nodes/{id}/flows/{flow_id}/recording/start` · `/stop` | Arm or disarm recording |
| GET    | `/api/v1/nodes/{id}/flows/{flow_id}/recording/status` | Recording state (`idle` / `pre_buffer` / `armed`) |
| POST   | `/api/v1/nodes/{id}/flows/{flow_id}/replay/mark-in` · `/mark-out` | Mark clip boundaries |
| POST   | `/api/v1/nodes/{id}/flows/{flow_id}/replay/cue` · `/play` · `/stop` · `/scrub` · `/speed` · `/step` | Transport control for the scrub workspace |
| GET    | `/api/v1/nodes/{id}/flows/{flow_id}/replay/clips` | Clips in the current recording |
| GET    | `/api/v1/nodes/{id}/flows/{flow_id}/replay/filmstrip` | Filmstrip index (`/nodes/{id}/replay/filmstrip-frame/{recording_id}/{pts}` for one frame) |
| PATCH / DELETE | `/api/v1/nodes/{id}/replay/clips/{clip_id}` | Rename/re-describe, or delete a clip |
| GET    | `/api/v1/nodes/{id}/replay/clips/{clip_id}/export` | Export one clip as MPEG-TS |
| GET    | `/api/v1/replay/clips/{clip_id}/audit` | Per-clip audit history |
| GET    | `/api/v1/nodes/{id}/recordings` | Every on-disk recording on the node, including orphans |
| DELETE | `/api/v1/nodes/{id}/recordings/{recording_id}` | Delete a recording |
| GET    | `/api/v1/nodes/{id}/recordings/{recording_id}/clips` · `/export` | Its clip list, or an MPEG-TS export of the whole recording |

### Sync groups (multi-cam)

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/sync-groups` | List or create a sync group |
| GET / PUT / DELETE | `/api/v1/sync-groups/{id}` | Read, edit membership, or delete |
| POST   | `/api/v1/sync-groups/{id}/recording/start` · `/stop` | Fan recording start/stop to every member |
| POST   | `/api/v1/sync-groups/{id}/replay/mark-in` · `/mark-out` | Fan the marks and produce one synchronised clip set |
| GET    | `/api/v1/sync-groups/{id}/clips` | Synchronised clip sets for the group |
| POST   | `/api/v1/sync-clips/{id}/play` | Play a clip set against a shared future start anchor |
| DELETE | `/api/v1/sync-clips/{id}` | Delete a clip set |

See [Replay (Operator UI)](/manager/replay/).

---

## Multiviewer

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/mv/walls` | List or create a wall |
| GET / PUT / DELETE | `/api/v1/mv/walls/{id}` | Read, rename or delete a wall |
| PUT    | `/api/v1/mv/walls/{id}/head` · `/layout` | Assign the wall's compositor head, or its layout |
| GET    | `/api/v1/mv/walls/{id}/routing` | What each tile is currently showing |
| PUT / DELETE | `/api/v1/mv/walls/{id}/routing/{tile_id}` | Route or clear one tile |
| POST   | `/api/v1/mv/walls/{id}/routing/recall` | Recall a saved routing salvo |
| POST   | `/api/v1/mv/walls/{id}/routing/save` | Freeze what the wall is showing now into a named salvo. Operate on the wall's group. An empty live routing is refused `409 routing_empty` — a salvo of nothing clears every tile when it is recalled |
| GET / POST / DELETE | `/api/v1/mv/walls/{id}/deploy` | Preview, deploy, or tear down the wall on its node |
| GET / POST | `/api/v1/mv/layouts` | List or create a layout |
| GET / PUT / DELETE | `/api/v1/mv/layouts/{id}` | Read, update or delete a layout (`/tiles` to add, `/tiles/{tile_id}` to remove) |
| GET / POST | `/api/v1/mv/monitoring-objects` | Sources that can be routed to a tile |
| PUT / DELETE | `/api/v1/mv/monitoring-objects/{id}` | Update or delete a monitoring object |
| GET    | `/api/v1/mv/heads` | Compositor heads the visible nodes advertise |
| PUT    | `/api/v1/mv/heads/{id}` | Annotate a head |
| POST   | `/api/v1/mv/routings` | Declare a new, empty named salvo against a layout (`{name, description?, owner_group_id, layout_id}`) — a `wall_id` is refused `400 routing_not_a_salvo` |
| DELETE | `/api/v1/mv/routings/{id}` | Delete a saved salvo |

See [Multiviewer](/manager/multiviewer/).

---

## Viewer distribution & DVR

A **DVR session** ties a source to the edge that produces its CMAF renditions, the relay that holds them, and the window a viewer may seek back across. Viewers are not manager users — they arrive on a link carrying a grant key, or sign in to the portal service fronting the relay.

| Method | Path | Description |
|--------|------|-------------|
| POST   | `/api/v1/nodes/{id}/distribution/streams` | Mint a shareable viewer URL for a stream on a relay running the `viewer-distribution` role. See [Viewer Distribution](/relay/viewer-distribution/) |
| PUT    | `/api/v1/nodes/{id}/distribution/config` | Configure that relay's viewer-distribution role — persisted on the node's metadata, pushed over WebSocket, and re-pushed on reconnect |
| GET / POST | `/api/v1/dvr/sessions` | List sessions in the caller's groups, or create one |
| GET / DELETE | `/api/v1/dvr/sessions/{id}` | Read one, or delete it — which also asks the relay to drop the streams it was holding |
| POST   | `/api/v1/dvr/sessions/{id}/activate` · `/stop` | Start or stop the session now |
| POST   | `/api/v1/dvr/sessions/{id}/schedule` | Arm a start time, a stop time, or both; nulls disarm it |
| GET / POST | `/api/v1/dvr/sessions/{id}/grants` | List the viewing links issued for a session, or issue one. The key is returned **once** — only its hash is stored |
| DELETE | `/api/v1/dvr/grants/{grant_id}` | Withdraw a viewing link. The row is kept, so "who could watch this, and when did that stop" still has an answer |
| GET / POST | `/api/v1/dvr/portal-users` | Portal logins the caller can see, or add one |
| DELETE | `/api/v1/dvr/portal-users/{id}` | Remove a portal login |
| PUT    | `/api/v1/dvr/portal-users/{id}/entitlements` | Replace the set of sessions that login may watch — the operator is looking at a checklist, so a merge would leave anything they unticked quietly in force |
| GET / POST / DELETE | `/api/v1/dvr/portal-service-token` | Whether a portal token is configured, mint a replacement, or clear it. **SuperAdmin** — the token is not group-scoped, and its value is shown once and never readable again |

Authority follows the multiviewer split: creating and deleting a session is **Admin** in its owner group because it commits a node's disk, while activating, stopping and scheduling one is **Operator** — the people who start and stop a recording are not administrators. Grants and portal logins are Admin.

### Public endpoints

These carry no session cookie, by design.

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/watch/{stream_id}` | The viewer's entry point. Takes the grant key as `?k=`, validates it, mints a short-lived viewer token and redirects to the relay's player. Every refusal is the same `403` with the same wording, so a dud link never reveals whether the feed exists, or whether the key was revoked rather than expired |
| GET    | `/api/v1/dvr/portal/streams` | What one portal username may watch — `active` sessions only |
| POST   | `/api/v1/dvr/portal/token` | Mint a viewing token for one session on behalf of a username. The entitlement is re-checked here rather than taken from the last listing, so access withdrawn in between takes effect |

The two `/api/v1/dvr/portal/…` routes are called by the portal service on the relay's VPS and authenticate with the shared service token above, presented as `Authorization: Bearer`. They are fail-closed: a manager with no token configured refuses every request rather than answering entitlement questions.

The manager's `/watch/{stream_id}` is **not** the relay's `/watch/{stream_id}` — different server, different credential. The manager's exchanges a grant key for a redirect; the relay's is the player page itself, on its distribution listener.

---

## Tunnels

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/tunnels` | List or create a tunnel |
| GET / PUT / DELETE | `/api/v1/tunnels/{id}` | Read, update or delete a tunnel |
| POST   | `/api/v1/tunnels/{id}/rotate-bind-secret` | Mint a new per-tunnel bind secret and re-push it |
| PUT    | `/api/v1/tunnels/{id}/owner-group` | Transfer tunnel ownership to another group |
| GET    | `/api/v1/nodes/{id}/tunnels` | Tunnels that terminate on one node |

See [IP Tunneling](/manager/ip-tunneling/).

---

## Groups (multi-tenancy)

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/groups` | List or create a group |
| GET / PUT / DELETE | `/api/v1/groups/{id}` | Read, update or delete a group |
| GET    | `/api/v1/groups/{id}/members` | Group membership (`/members/candidates` for users who could be added) |
| PUT / DELETE | `/api/v1/groups/{id}/members/{user_id}` | Add/change a member's role, or remove them |
| GET    | `/api/v1/groups/{id}/usage` | Live usage against the group's limits |
| POST   | `/api/v1/groups/{id}/upgrade` | Staged binary rollout across the group's nodes (Group Admin+) |
| GET    | `/api/v1/nodes/{id}/shares` | Which groups a node is shared with |
| PUT / DELETE | `/api/v1/nodes/{id}/shares/{group_id}` | Share a node with a group, or stop sharing |
| PUT    | `/api/v1/nodes/{id}/owner-group` | Transfer node ownership |

See [Multi-tenant Groups](/manager/multi-tenant-groups/).

---

## Alignment Groups

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/alignment-groups` | List, or create/update an alignment group |
| DELETE | `/api/v1/alignment-groups/{id}` | Delete an alignment group |
| POST   | `/api/v1/alignment-groups/{id}/remint` | Mint a fresh shared anchor for the group's members |

See [Aligned Output](/manager/aligned-output/).

---

## Visual Flow Editor & master graphs

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/nodes/{id}/visual-graph` | Read a unit's graph, or validate a candidate one |
| GET / PUT / DELETE | `/api/v1/nodes/{id}/visual-draft` | Read, save or discard the unit's draft |
| POST   | `/api/v1/nodes/{id}/visual-draft/takeover` | Take over someone else's draft (Super Admin) |
| PUT    | `/api/v1/nodes/{id}/visual-layout` | Save canvas positions |
| POST   | `/api/v1/nodes/{id}/visual-deployment/preview` · `/apply` | Preview exactly what would change, then accept and deploy |
| GET    | `/api/v1/nodes/{id}/visual-deployments` | Deployment history (`/{deployment_id}/diff`, `/{deployment_id}/restore`) |
| POST   | `/api/v1/nodes/{id}/visual-deployments/retry` | Retry a deployment that failed or is stuck pending |
| GET / POST | `/api/v1/master-graphs` | List or create a master graph |
| GET / PUT / DELETE | `/api/v1/master-graphs/{id}` | Read, update or delete a master graph |
| PUT / DELETE | `/api/v1/master-graphs/{id}/members/{node_id}` | Put a unit on the canvas, or take it off |
| GET / POST | `/api/v1/master-graphs/{id}/connections` | List or create a cross-unit connection |
| POST   | `/api/v1/master-graphs/{id}/connections/preview` | Side-effect-free preview of a connection |
| DELETE | `/api/v1/master-graphs/{id}/connections/{connection_id}` | Delete a connection |
| GET    | `/api/v1/master-graphs/{id}/observed-connections` | Transport the manager can already see between the members |
| GET    | `/api/v1/master-graphs/{id}/history` | Deployment history for the graph |
| GET / POST | `/api/v1/unit-links` | Declared physical cabling between units |
| GET / DELETE | `/api/v1/nodes/{id}/generated-endpoints[/{resource_id}]` | What a master graph put on this unit. The DELETE only forgets the provenance record — it never touches the unit's own configuration |
| GET    | `/api/v1/nodes/{id}/master-graphs` | Which canvases carry this unit, so an operator about to change it knows who depends on it. Only graphs the caller can read are returned, and the rest are not even counted |

Cross-unit connection and preview require Operate on **both** units. See [Visual Flow Editor](/manager/visual-flow-editor/).

---

## Address Pools

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/address-pools` | List or declare a pool of ports or multicast groups |
| PUT / DELETE | `/api/v1/address-pools/{id}` | Update or delete a pool |
| GET    | `/api/v1/address-pools/{id}/allocations` | What the pool has handed out, and to which wire |
| POST   | `/api/v1/address-pools/{id}/exclusions` | Carve a range out of a pool |
| DELETE | `/api/v1/address-pools/{id}/exclusions/{exclusion_id}` | Remove an exclusion |
| DELETE | `/api/v1/address-allocations/{id}` | Release one allocation |

See [Address Pools](/manager/address-pools/).

---

## Services, wizards & templates

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/services` | List or create a service |
| GET / PUT / DELETE | `/api/v1/services/{id}` | Read, update or delete a service |
| POST   | `/api/v1/services/{id}/reapply` | Re-apply a service to its nodes |
| GET    | `/api/v1/services/{id}/versions` | Version history |
| POST / DELETE | `/api/v1/services/{id}/automations` | Attach or detach an automation |
| GET    | `/api/v1/wizards` | Available service wizards |
| POST   | `/api/v1/wizards/{id}/preview` · `/apply` | Dry-run a wizard, then apply it |
| GET / POST | `/api/v1/service-templates` | List or create a template (`/import`, `/{id}/export` to move one between installations) |
| GET / PUT / DELETE | `/api/v1/service-templates/{id}` | Read, update or delete a template |
| GET    | `/api/v1/service-templates/{id}/shares` | Which groups a template is shared with |
| PUT / DELETE | `/api/v1/service-templates/{id}/shares/{group_id}` | Share a template with a group, or stop |
| GET / POST | `/api/v1/transcode-profiles` | Reusable encode/transcode bundles |
| GET / PUT / DELETE | `/api/v1/transcode-profiles/{id}` | Read, update or delete a profile |
| GET / PUT / DELETE | `/api/v1/topology/positions` | Saved node positions on the topology map |
| GET / PUT / DELETE | `/api/v1/preferences/{key}` | One per-user UI preference. `{key}` must be one of a fixed server-side whitelist; anything else is rejected |

---

## SMPTE ST 2110 (Phase 1)

ST 2110 controls are available only on nodes whose health capabilities advertise ST 2110 support. Older edges transparently hide these controls in the UI.

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/api/v1/nodes/{id}/ptp` | Cached PTP state. |
| GET    | `/api/v1/nodes/{id}/nmos` | Live NMOS state. |
| GET    | `/api/v1/nodes/{id}/flows/{flow_id}/sdp/{essence}` | SDP document for one essence of a ST 2110 flow. |
| GET / PUT  | `/api/v1/nodes/{id}/audio/channel-map` | Read or stage + activate the node-wide IS-08 channel map. |
| GET / POST / PUT / DELETE | `/api/v1/nodes/{id}/flow-groups[/{gid}]` | Manage flow groups (essence bundles). |

Mutating endpoints require the Operator role and the usual CSRF + node-access checks. Full payload schemas are provided in the commercial integration reference.

---

## Events

| Method | Path                        | Description                        |
|--------|-----------------------------|------------------------------------|
| GET    | `/api/v1/events`            | List events (supports pagination)  |
| POST   | `/api/v1/events/{id}/ack`   | Acknowledge an event               |
| GET    | `/api/v1/events/count`      | Get unacknowledged event count     |

---

## Audit Log

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/v1/audit-log` | Group-scoped audit trail — timestamp, user, action, target, structured details. Admins of the owning group, and SuperAdmins across all groups. |

The log is append-only at the data layer; no API path deletes rows. The UI page is `/admin/audit-log`.

---

## Settings

| Method | Path                            | Description                                                |
|--------|---------------------------------|------------------------------------------------------------|
| GET    | `/api/v1/settings`              | Get current settings                                       |
| PUT    | `/api/v1/settings`              | Update settings                                            |
| GET    | `/api/v1/settings/tls`          | Get TLS certificate info                                   |
| GET    | `/api/v1/settings/acme`         | Get ACME / Let's Encrypt status                            |
| POST   | `/api/v1/settings/acme/configure` | Configure ACME / Let's Encrypt certificate provisioning  |
| POST   | `/api/v1/settings/acme/renew`   | Force an immediate certificate renewal                     |
| POST   | `/api/v1/settings/acme/disable` | Turn ACME off and fall back to the configured cert source  |
| GET    | `/api/v1/settings/sso`          | Current OIDC/SSO configuration (secrets masked)            |

---

## Cluster (HA)

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/v1/instances` | Manager instances that have heartbeated in the last 15 seconds, plus a `current` block naming the instance serving the request. SuperAdmin only — a caller without that role gets `403` whatever the licence says; a SuperAdmin without the HA feature gets `402`. See [Active/Active HA](/manager/active-active-ha/) |

---

## License

| Method | Path                  | Description                                                |
|--------|-----------------------|------------------------------------------------------------|
| GET    | `/api/v1/license`     | Current license status (Admin+).                           |
| PUT    | `/api/v1/license`     | Apply or replace a license key (SuperAdmin).               |
| DELETE | `/api/v1/license`     | Remove the installed license key (SuperAdmin).             |

The free tier supports a limited number of managed nodes. Commercial licenses unlock higher node limits and advanced features. Endpoints gated by paid features return a machine-readable error that the UI uses to render an upgrade prompt.

---

## Upgrade & Releases

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/v1/releases/{device_type}` | Recent published releases for a binary, as a version-picker source (`?channel=stable\|beta\|nightly`). Advisory only — a node reconstructs the download URL itself and verifies the Sigstore signature before trusting anything. |
| POST   | `/api/v1/nodes/{id}/upgrade` | Upgrade one node to a named version |
| POST   | `/api/v1/groups/{id}/upgrade` | Staged rollout across a group's nodes (Group Admin+) |

Nodes advertise the `upgrade` capability on their health payload; the UI hides these controls on nodes that do not. See [Remote Upgrade](/manager/remote-upgrade/).

---

## Backup & Restore

Encrypted backup and restore is a commercially licensed feature available to SuperAdmins.

| Method | Path              | Description                                                                      |
|--------|-------------------|----------------------------------------------------------------------------------|
| POST   | `/api/v1/export`  | Download an encrypted backup of the manager's state.                             |
| POST   | `/api/v1/import`  | Restore from an encrypted backup (destructive).                                  |

Backups are sealed with a user-supplied passphrase using authenticated encryption and a memory-hard key derivation function. Secret fields are portable across deployments with different master keys. File format details are provided to commercial licensees.

---

## AI

| Method | Path                           | Description                          |
|--------|--------------------------------|--------------------------------------|
| GET / POST / DELETE | `/api/v1/ai/keys`  | List the stored provider keys (masked), store one, or delete one |
| GET    | `/api/v1/ai/providers/{provider}/models` | The models the named provider exposes |
| GET / POST | `/api/v1/ai/threads`       | List conversation threads, or start one |
| GET    | `/api/v1/ai/threads/running`   | Threads with an agent run in progress |
| GET / PATCH / DELETE | `/api/v1/ai/threads/{id}` | Read, rename or delete one thread   |
| GET    | `/api/v1/ai/threads/{id}/messages` | The messages in a thread         |
| GET    | `/api/v1/ai/threads/{id}/live` | Server-Sent Events stream of an in-progress run on the thread |
| POST   | `/api/v1/ai/chat`              | Run the agent once, returning the full response |
| POST   | `/api/v1/ai/chat/stream`       | Run the agent with a streamed (SSE) response |
| POST   | `/api/v1/ai/apply`             | Apply an AI-proposed configuration change |

The AI assistant calls back to the manager using the same driver action system exposed through the UI. Prompt construction, per-driver action schemas, and credential-stripping behaviour are documented in the commercial integration reference.

---

## WebSocket Endpoints

### `/ws/dashboard`

Real-time updates for browser-based dashboards. Receives aggregated node status, stats, and health data. Requires an authenticated session.

### `/ws/node`

Authenticated connection endpoint for managed devices (edge nodes, relay servers, and third-party API gateways). Devices connect outbound to the manager, enabling management of devices behind firewalls and NAT.

The node protocol is an authenticated JSON message channel with backward-compatible versioning. The full message schema, command set per device driver, and protocol extension rules are provided to commercial licensees and integration partners under NDA.

---

## Health & Metrics

| Method | Path       | Description                          |
|--------|------------|--------------------------------------|
| GET    | `/health`  | Health check (no authentication)     |
| GET    | `/api/v1/metrics` | Prometheus text exposition. **Fail-closed** — a scrape must either present a bearer token listed in the metrics token set, or come from an exactly-matching peer IP in the metrics allowlist; anything else gets `401` with no body. `X-Forwarded-For` is deliberately not trusted here. |
| POST   | `/api/v1/csp-report` | Content-Security-Policy violation sink named by the `report-uri` directive. Public, because the browser's reporter sends no cookies. Best-effort logging only — always `204`, so a browser never retries |
