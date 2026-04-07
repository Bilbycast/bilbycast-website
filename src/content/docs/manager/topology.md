---
title: Topology Visualization
description: How the bilbycast-manager topology page renders nodes, flows, tunnels, and signal paths in real time.
sidebar:
  order: 5
---

The bilbycast-manager **Topology** page is a live visualization of every node, flow, tunnel, and signal path the manager knows about. It exists to answer two operational questions at a glance:

1. *Where is this signal coming from and going to?* — the flow view, a deterministic left-to-right signal-flow diagram.
2. *Which nodes are talking to which?* — the graph view, a force-directed network of edges, relays, and third-party gateways.

Both views read from the same live data source (the manager's WebSocket stats stream), so they update without polling.

## Two views, one dataset

| View | What it answers | Layout |
|---|---|---|
| **Graph view** | "What is the shape of my plant?" | Force-directed, pan / zoom / drag. Nodes are coloured by device type (edge / relay / Appear X / ...) and sized by active flow count |
| **Flow view** | "Where does *this* signal go?" | Deterministic left-to-right column layout, one column per hop (input → edge → tunnel → edge → output → external endpoint) |

You can switch between them with a tab control at the top of the page; the selected view is remembered per-user.

## What appears in the graph view

| Element | Source |
|---|---|
| Edge / relay / Appear X **node** | Any registered device with a recent `health` heartbeat |
| **Tunnel link** between two edges | Active tunnel from `GET /api/v1/tunnels` (or its driver-specific equivalent) |
| **Flow link** from input to output | Per-flow stats stream — synthesised when input and output land on different nodes |
| **Node colour** | Device type (driver-defined) |
| **Node size** | Number of running flows |
| **Link colour** | Health: green = healthy, amber = warning, red = critical, grey = stopped |
| **Link width** | Live bitrate (logarithmic) |

The graph is **force-directed** — nodes find their own positions. Drag a node to pin it; double-click to unpin. Zoom with the mouse wheel, pan by dragging the background.

## What appears in the flow view

The flow view is the right tool for explaining "what is this stream doing?" to a non-engineer. It picks a single flow (or group) and lays it out as a left-to-right sequence of stages:

```
[ external source ]  →  [ input on edge-syd ]  →  [ tunnel ]  →  [ output on edge-perth ]  →  [ external sink ]
```

Each column represents one logical hop. Stages with sub-state (e.g., a flow with multiple outputs from one input) fan out vertically inside the column. The layout is **deterministic** — a flow with the same shape always lays out the same way, so you can take a screenshot, share it, and have the recipient see the same picture.

## Real-time updates

The manager pushes stats snapshots over its WebSocket every second. The topology page consumes that stream directly:

- Bitrates animate smoothly (no flicker).
- Health-state transitions trigger a one-shot pulse on the affected node or link.
- New nodes / flows / tunnels appear without a page reload.
- Disappearing nodes fade out and are removed after a short grace period (so flapping connections don't churn the layout).

## Capability gating for ST 2110

Edges that advertise the `st2110-*` capability in their `health` payload get a few extra topology elements:

- A **PTP card** on the node tooltip showing the current `clock_domain` and lock state (`locked` / `locked_holdover` / `free_run` / `unavailable`).
- **Red / Blue dual-leg** rendering for SMPTE 2022-7 redundant flows — each tunnel link is split into two parallel paths with per-leg loss indicators.
- **Flow groups** are rendered as visual containers — multi-essence bundles (audio + ANC + video) appear inside a dashed box so an operator can see they belong together.

If an edge does not advertise ST 2110 capabilities, none of these elements appear and the topology stays clean.

## Driver-aware node rendering

Each device type registers a manager-side **driver** (see [Device Drivers](/manager/device-drivers/)) that contributes to topology rendering:

- A node icon (or SVG glyph)
- A health summary derived from its native event/alarm format
- A list of "ports" (inputs and outputs) the driver wants visualised

This is how Appear X chassis appear in the same topology as bilbycast edges, even though they speak a different protocol on the wire — the `AppearXDriver` translates between Appear X's slot/board model and the topology's node/link model.

## Limits

| Limit | Default | Notes |
|---|---|---|
| Nodes rendered | 500 | Soft cap — beyond this, the force-directed simulation slows down noticeably |
| Flows per node | 200 | Each flow contributes one link; hidden behind a "show all" toggle when exceeded |
| Refresh rate | 1 Hz | Tied to the WebSocket stats cadence |

For very large plants (>500 nodes), use the search/filter bar at the top of the page to narrow down to a subset before switching to the graph view.
