---
title: Multiviewer Walls
description: Author a video wall in the manager and deploy it to a unit that composites it — layouts, tile routing, heads, and the honest limits of the phase-1 surface.
sidebar:
  order: 4
---

A **wall** is a mosaic of live signals, composited by an edge unit and published as an ordinary flow. The manager holds the wall — the furniture, which signal sits in which tile, and which unit draws it — and deploys it to that unit. In phase 1 that authoring happens over the **REST API**: the browser's Multiviewer Walls page is a read-only view plus Deploy, Redeploy and Undeploy. From the moment a wall is deployed it is a flow like any other: attach an SRT, UDP, RTP or WebRTC output to it and the wall goes wherever you send it.

:::note[Two sidebar entries, similar names, different things]
**Multiview** is a grid of flow thumbnails the manager assembles by itself. It needs nothing from any unit and shows still frames.

**Multiviewer Walls** is this feature — a real composited canvas, encoded on the unit. Both are described on this page; the thumbnail grid is at the bottom.
:::

## What a unit needs before any of this works

A unit offers to draw a wall only when it advertises the **`mv-compositor`** capability, and it advertises that only when the binary was built with the multiviewer feature **and** carries a video encoder. That pairing is not fussiness: a flow carries MPEG-TS, so a composited canvas reaches an output by being encoded and muxed. A build with the compositor and no encoder would accept the wall and fail at its first frame.

- **Every published release artefact carries it.** `x86_64-linux-full`, `aarch64-linux-full` and `aarch64-linux-rockchip` are all built with the multiviewer feature and a video encoder, and the release job asserts both on the shipped binary before publishing. A node running an official build always advertises a head.
- **A binary you build yourself does not, unless you ask for it.** The multiviewer feature is off by default, so a plain `cargo build --release` produces an edge that never advertises a head. Nothing breaks — the unit simply cannot be chosen.
- Check any binary without running it: `bilbycast-edge --print-capabilities` prints one token per line, and you want the line `capability mv-compositor`.

A unit without the capability advertises no head, so in the ordinary case there is nothing to point a wall at. Where a head does linger — advertised by an earlier build and never deleted, because a missed health tick must not drop your allocation — preview and deploy both say the unit does not offer a compositor, rather than leaving you to work out why nothing happens.

## The pieces, and why they are separate

Four things persist independently, and keeping them apart is the whole design.

| Piece | Holds | Deliberately does **not** hold |
|---|---|---|
| **Signal** (monitoring object) | Its name, its on-screen label, which unit and input the picture comes from, an optional program / PID, a tally address | Any geometry, any wall |
| **Layout** | Canvas size and rate, the tile rectangles, z-order, aspect policy | Any signal, any unit |
| **Routing** | Which signal is in which tile | Any geometry |
| **Head allocation** | Which head is drawing the wall right now — one field on the wall | Anything else |

A **wall** is the only place the three meet, and only for reading.

They are separate because they change on completely different timescales — furniture on the day the gallery is built, routing every few minutes during a show, head allocation when a screen dies. Fold any two together and every recall becomes all-or-nothing. The payoff:

- **One layout serves many shows.** "2x2 with a big left" holds no signal and no unit, so it is recallable against any wall.
- **Re-routing a wall never redraws it.** Moving a camera between tiles touches one row.
- **Re-pointing a head touches neither.** It is one field, so a re-point cannot disturb what is on the wall.
- **The caption and the tally follow the signal, not the tile.** Move camera 4 from tile 3 to tile 11 and its name and its red light move with it. If the label lived on the tile, the wall would be lying about which camera is on air — the most expensive error a multiviewer can make.

A routing keys on the tile's **id**, never its name, and a routing can only name tiles belonging to its own layout — that is enforced in the database, not by convention, so a salvo can never land on furniture it was not authored for. Changing which layout a wall runs is its own action for the same reason: it **discards the wall's live routing**, because those tile ids do not exist on the new layout. Named salvos are untouched.

## Heads

A **head** is a rendering output that a unit advertises. You never create one.

- **It is discovered, not declared.** Each unit reports its heads on its health tick, and the manager mirrors them keyed on (unit, head id). Re-advertising the same head updates the existing row rather than minting a second one.
- **Phase 1 has one kind that renders: a stream head**, which publishes the canvas as a flow. Panel (HDMI / DisplayPort) and SDI head kinds exist in the model for later; a wall pointed at one is refused, with the kind named.
- The unit owns the reported half of a head — its kind, its connector, the largest canvas it will draw, the encoder backend it will use, and when it last checked in. You own a display name and an enable switch. Editing a head needs **Manage** on the unit that advertises it; anything the unit reports is overwritten on the next health tick.
- **A head missing from one health report is not deleted.** A node that misses a tick or restarts mid-show would otherwise drop its operator's allocation. Staleness is expressed by the last-seen time ageing instead.
- **Losing a head releases the wall; it never deletes it.** Delete a unit and its heads go with it, and every wall on those heads is left with no head assigned — which is exactly what has happened. Nothing you authored is lost.
- **One wall per head** in phase 1. Pointing a second wall at a busy head is refused with `head_in_use`, naming the wall already on it.
- **Re-pointing a wall at a spare head is Operate-level and one field wide.** That is the action you want at 20:59 when a screen dies, and it must not require finding an administrator.

## What the browser gives you today

The **Multiviewer Walls** page is a read-only list of your walls plus the deploy controls — **Deploy** (which reads **Redeploy** once the wall is up) and **Undeploy**. Each card shows where the wall is deployed, its state badge, everything the head will not honour, the compiled tile list, and a **Show what will be sent** disclosure containing the exact input body a deploy would post — byte for byte the same body, so you can compare it against the unit's own Input dialog rather than taking the button on trust.

:::caution[There is no layout editor yet]
Creating signals, layouts and walls, routing tiles, recalling salvos and pointing a wall at a head are **REST calls** in phase 1. The endpoints, permissions, refusals and audit trail below are all real and shipped; the screens for them are not built. The only authoring the browser does today is Deploy, Redeploy and Undeploy.
:::

| What | Endpoints |
|---|---|
| Signals | `GET`/`POST /api/v1/mv/monitoring-objects`, `PUT`/`DELETE .../{id}` |
| Heads | `GET /api/v1/mv/heads`, `PUT /api/v1/mv/heads/{id}` |
| Layouts | `GET`/`POST /api/v1/mv/layouts`, `GET`/`PUT`/`DELETE .../{id}`, `POST .../{id}/tiles`, `DELETE .../{id}/tiles/{tile_id}` |
| Walls | `GET`/`POST /api/v1/mv/walls`, `GET`/`PUT`/`DELETE .../{id}` |
| Head allocation | `PUT /api/v1/mv/walls/{id}/head` |
| Which layout a wall runs | `PUT /api/v1/mv/walls/{id}/layout` |
| Tile routing | `GET /api/v1/mv/walls/{id}/routing`, `PUT`/`DELETE .../routing/{tile_id}` |
| Salvo recall | `POST /api/v1/mv/walls/{id}/routing/recall` |
| Saved salvos | `POST /api/v1/mv/routings`, `DELETE /api/v1/mv/routings/{id}` |
| Preview / deploy / undeploy | `GET`/`POST`/`DELETE /api/v1/mv/walls/{id}/deploy` |

## Routing does not reach the screen on its own

:::caution[Re-routing marks the wall stale — it does not change the picture]
Routing a tile, clearing a tile and recalling a salvo are database writes. Nothing is sent to the unit. The wall keeps drawing the plan it was deployed with, and its badge changes to **Changed since deploy**. Redeploy to put the change on screen.

This is deliberate rather than unfinished. Every configuration change a unit accepts rewrites its configuration file and re-encrypts its secrets file, so pushing on every drag would mean a disk write and a re-encrypt per drag. Live, frame-accurate re-routing is a later phase.
:::

## Deploying a wall

Three verbs share one endpoint.

- **Preview** — compiles the wall and returns the exact input body it would send, together with every refusal, every warning and everything the head will not honour. It does **not** talk to the unit; it uses the unit's last-known health and configuration. It still needs Operate on the target unit, because the answer names that unit's inputs.
- **Deploy** — creates the compositor input, then the flow, on the head's unit. Both carry the **id** `mvwall-<wall id>` and the wall's own name as their name, so look for the wall in the ID column of the unit's Inputs list rather than the Name column. The order is forced both ways: a flow resolves its input, so the input goes first, and a failed first deploy rolls back in reverse.
- **Redeploy** — updates the existing input in place, which hot-restarts the owning flow. Nothing is deleted first, so a failed edit is not an outage on a wall that was already up.
- **Undeploy** — deletes the flow, then the input, because a unit refuses to delete an input a flow still references. It is idempotent: undeploying a wall that is not deployed succeeds.

A deploy creates exactly two things on the unit: one **compositor input** carrying the canvas size, rate, target bitrate and the tile list; and one **flow** with thumbnails on and **no outputs**. The empty output list is on purpose — a wall composites, encodes, muxes and produces thumbnails without one. Send it somewhere by attaching an output to that flow on the unit's own Outputs screen, exactly like any other flow.

The canvas encoder's target, `video_bitrate_kbps`, defaults to **8000** kbit/s and accepts **100 to 200000**. There is no codec choice here, and the wall does not need one: the unit resolves its own encoder backend against the hardware it has and reports the resolved chain on the head, so `h264_auto` lands on the best encoder that host can open. A dropdown would only be useful to *override* that, which is a later phase.

### Deployment states

| Badge | Meaning |
|---|---|
| **Not deployed** | This wall has not been sent to a unit. |
| **On air** | What is on screen matches what is authored here. |
| **Changed since deploy** | It is on air, drawing an older plan. Redeploy. |
| **Unit is gone** | The unit it was deployed to has been deleted. Undeploy to clear the record, then assign a new head. |
| **Unknown** | The unit is not reachable, or the wall no longer compiles, so what it is drawing cannot be confirmed. |

The comparison is a **hash of the compiled body**, not a revision counter. That matters: rename a signal and the caption burned into the canvas changes while no layout revision moves, so a revision-based badge would report "current" over a wall showing the wrong name. Geometry, routing, a signal rename and a re-binding all move the hash. Re-pointing a wall at a **different head on the same unit** does not, and should not: the compiled body carries no head identity, nothing about the picture changes, and the badge correctly stays **On air**. Moving a wall to a head on a *different* unit would move it — every tile unassigns — but that deploy is refused until you undeploy first, as below.

:::caution[Move a wall to another unit by undeploying it first]
Re-point a deployed wall at a head on a **different** unit and press Deploy, and you get `wall_deployed_elsewhere`, naming both units. The alternative would be to tear down hardware you have stopped looking at, or to leave the wall running on the old unit with no record of it. Undeploy, re-point, deploy.
:::

### Why a deploy is refused

Refusals arrive **all at once**, so you fix one screen instead of discovering faults one deploy at a time:

- the wall has no head (`head_unassigned`), or the head is not a stream head, or the head is disabled;
- the unit is offline, or does not offer a compositor;
- the canvas is larger than the head draws, or has an odd width or height (every encoder here is 4:2:0, so both dimensions must be even), or has no area;
- the canvas rate is not a whole number of frames per second. **29.97 and 59.94 are refused, not rounded**, with the whole-number suggestion in the message. A wall's rate is deliberately independent of its sources, which repeat or decimate to match it — silently turning an authored 29.97 into 30 would never be discovered;
- the layout has no tiles, or more than **64**;
- a tile has no area, or runs past the edge of the canvas.

### What the head will not honour

Reported explicitly rather than dropped in silence, because silence here is the one lie this feature has available — a deploy that "succeeded" over a wall showing something else:

- **A tile aspect policy other than fit.** Every tile is letterboxed; crop and stretch arrive later.
- **Tile widgets.** Not drawn yet. The tile shows picture and its label.
- **A signal that names a program or PID.** The tile shows the first video stream it finds in that source — which, on an MPTS, looks entirely plausible and is the wrong programme.
- **`delivery: cmaf`.** Not acted on. A wall reaches a viewer through an output you attach to its flow.

And three warnings that deploy but may not light up:

- **A tile whose signal lives on another unit** reads `UNASSIGNED` on the canvas. A tile can only show an input local to the unit drawing the wall; the warning names both units so the cause is not a mystery.
- **A tile naming an input the unit's last-known configuration does not contain** — usually a renamed or re-bound input.
- **A head the unit has never advertised** — its capabilities are unknown.

## Capacity is warn-only, and the warning is thin

Pointing a wall at an undersized head **warns; it does not refuse**. The wall is created, the head is assigned, and a list of warnings comes back alongside the success.

What the check actually compares is short:

- the layout's canvas against the largest canvas the head advertises (**1920x1080** on a phase-1 stream head);
- whether the head is disabled;
- whether the head has ever been advertised at all.

What it does not consider, at all: **tile count**, what those tiles cost to decode, encoder sessions, or what else the unit is already running. Sixteen tiles is sixteen decodes whatever size they are drawn at — and every one of them runs on the unit's **CPU**, not on its video hardware, so what binds on a small box is CPU decode throughput rather than any hardware decoder session count.

The unit's own resource budget does not close that gap yet either. A wall is charged as **one** video encode, and its per-tile decodes are not modelled at all — so the Resources card and the flow modal's resource preview miss a sixteen-tile wall's sixteen CPU decodes entirely.

:::caution[An empty warnings list is not a capacity guarantee]
It means nothing that had an answer came back wrong — not that the head can cope. A unit that has never advertised a ceiling produces no warnings and no confidence, which is precisely why this cannot be a refusal yet. Size a head from measurement on the hardware you are actually using. Capacity refusal, head pooling and quotas are phase 2.
:::

## Permissions

| Action | Requires |
|---|---|
| See walls, layouts, salvos and signals | Membership of the owning group |
| Create, rename or delete a wall, layout, salvo or signal | **Admin** of the owning group |
| Change which layout a wall runs (discards its live routing) | **Admin** of the owning group |
| Route a tile, clear a tile, recall a salvo | **Operate** on the wall's group |
| Point a wall at a head, or release it | **Operate** on the wall's group **and** on the head's unit |
| Preview what a deploy would send | Membership of the wall's group **and** **Operate** on the head's unit |
| Deploy a wall | **Operate** on the wall's group **and** on the target unit |
| Undeploy a wall | **Operate** on the wall's group |
| Rename or disable a head | **Manage** on the unit that advertises it |
| Bind a signal to a unit's input | **Operate** on that unit |

The split is the point. Authoring decides **what exists**, and that is administrative. The operate tier decides **what is on screen right now** — routing a tile, recalling a salvo, re-pointing a head — and that is show work, done during a programme, at drag rate, by whoever is running the gallery. On most installations that person is not a group Admin. Requiring Admin would mean either handing Admin to gallery staff or having nobody able to use the feature at the only moment it matters.

Deploying and re-pointing need authority on **both** sides because they put entities on somebody's hardware; authority over the wall alone is not enough. Undeploy is the exception, and deliberately so: it removes only what the manager already recorded putting there, so it asks for authority over the wall and nothing else — losing access to a unit must never leave you unable to take your own wall off it.

## Tenancy

- **Walls, layouts, salvos and signals belong to a group.** A wall, the layout it runs and the signals it shows must all be in the **same** group — otherwise a wall could put another tenant's pictures on a head.
- **A head has no owner of its own.** Its tenancy is its unit's tenancy, which gives one answer to "who owns this box" and cannot drift when the unit changes hands. The head list is filtered by which units you can see. If a wall's head ends up on a unit you cannot see, its capabilities — including its canvas ceiling — are withheld, and the wall says so rather than quietly showing you somebody else's hardware.
- **A cross-tenant read answers 404, never 403.** A 403 confirms the id exists, and wall names are show names.
- **A group that still owns walls, layouts, salvos or signals cannot be deleted.** The refusal names the kinds rather than listing ids, so it tells you which page to go to. These are hand-authored and reconstructible from nothing, so a group delete must be refused by them rather than absorb them.

Every authoring action writes an audit row, scoped to the owning group for walls, layouts, salvos and signals. A salvo recall records which tiles it changed **and how many it cleared** — the half an operator cannot see coming.

## The Multiview thumbnail grid

**Multiview** in the sidebar is a different feature with a confusingly similar name. It is a monitoring grid the manager builds entirely from the JPEG thumbnail endpoint that already exists for every flow, so it needs no capability from any unit and works on any installation, including one with no multiviewer-capable node at all.

- One tile per (unit, flow) you can see, sorted by unit then flow so a tile keeps its place across refreshes.
- Layouts are **2x2 / 3x3 / 4x4 / Auto-fit**. Auto-fit shows at most **64** signals and says "showing 64 of 231" when it is showing only a prefix of the fleet.
- Tiles carry the same alarm vocabulary as the Flows page — Offline, Stopped, no SDI signal, No signal, Black, Frozen, Thumbnails off, Stale *n*s — so there is no second dialect to learn. Signal loss outranks configuration: a running flow reporting zero bitrate reads **No signal** even if its thumbnails are switched off.
- Polling is adaptive and per tile: a changing tile re-polls at about **1 s**, an unchanged one backs off to **6 s**, tiles are phase-staggered and jittered so they do not lock together, and no more than **6** requests are ever in flight. A sixteen-tile wall is therefore not a sixteen-fold request burst against a manager that is also fanning out node WebSockets.

Its honest limits against a real wall:

- **It is a still-frame confidence monitor, not video.** One frame a second at best. Do not judge motion, cadence, or lip-sync from it.
- **There is no audio and there are no meters.** The manager has no video player, and adding one would mean an edge change to publish a viewable stream per flow.
- **No layout authoring, no UMD from a signal name, no tally.** Tiles are labelled with the flow name and the unit name.
- **The pictures arrive at your browser, not at a screen in the gallery.** Sixteen tiles is sixteen HTTP polls from wherever you are sitting. A deployed wall is one encoded stream leaving the unit.

Use Multiview to answer "is everything up". Use a wall when you need a multiviewer output on a screen.

## Current limitations

- **No browser authoring yet** — signals, layouts, walls, tile routing and salvos are REST-only.
- **A salvo cannot be filled yet.** A saved routing is created against a layout and starts empty, and phase 1 exposes no call that copies a wall's live routing into one. Recall is wired end to end, but there is nothing to put in a salvo — and because a recall clears every tile the salvo does not name, recalling an empty one clears the wall.
- **Canvas is capped at 1920x1080, and 64 tiles.** The ceiling is the head's own advertised maximum, which is 1920x1080 on a phase-1 stream head. An oversized layout **saves, with a warning**, and it is the **deploy** that is refused, naming that ceiling. (A mosaic written straight into a unit's configuration file never reaches this path — the unit refuses it when that configuration is validated.)
- **Whole frames per second only.** 29.97 and 59.94 canvases are refused.
- **One wall per head, one head per wall.** Head pooling is phase 2.
- **Only stream heads render.** Panel and SDI head kinds exist in the model; nothing draws them yet.
- **Tiles must be local to the unit drawing the wall.** A cross-unit signal reads `UNASSIGNED`; proxying one between units is a later phase.
- **Capacity is warn-only**, and the warning does not model tile cost.
- **Routing is not live.** Redeploy to put a re-route on screen.

## See also

- [Multiviewer (Edge)](/edge/multiviewer/) — the compositor itself: how tiles are decoded, scaled and drawn, and what it costs on a unit
- [Multi-tenant Groups](/manager/multi-tenant-groups/) — the group model these permissions are built on
- [Resources & Capacity](/edge/resources/) — what a unit advertises about its encoder and decoder headroom
- [Live Switcher](/manager/switcher/) — the other operator-tier surface, for taking sources to air
