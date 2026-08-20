---
title: Visual Flow Editor
description: Build a node's configuration by drawing it — sources, flows and destinations on a canvas — with a validate, preview and deploy cycle. Master graphs put several units on one canvas.
sidebar:
  order: 4
---

The **Visual Flow Editor** is a canvas for building a node's configuration by drawing it: sources on the left, destinations on the right, wires between them. It is an alternative to the configuration forms, not a replacement — both write the same configuration, and you can move between them freely.

It is available to every installation. There is nothing to switch on.

Two surfaces share the same editor:

- **Single unit** — **Nodes → \<node\> → Visual editor**. One box: its inputs, flows and outputs.
- **Master graph** — **Master graphs** in the sidebar. Several units on one canvas, with the transport between them drawn as wires.

## How a change reaches a node

Nothing you draw is live until you deploy it. The sequence is deliberate:

1. **Draft** — your work in progress. One person holds the draft for a unit at a time.
2. **Validate** — the server checks the graph properly, not just your browser.
3. **Preview** — shows exactly what would change on the unit. Nothing is written.
4. **Accept and deploy** — records the desired state, snapshots the unit's current configuration, writes the audit trail, and *then* dispatches.

Because the record is written before dispatch, deploying to a node that is **offline loses nothing**. The deployment sits at **pending** and goes out when the node reconnects.

If someone has left a draft open on a unit you need, a Super Admin can take it over.

## Deployment states

| State | Meaning |
|---|---|
| **Pending** | Accepted, waiting for the unit — it is offline, or has not reported in yet. |
| **Applying** | Dispatched to the unit. |
| **Applied** | The unit **acknowledged** the configuration. |
| **Degraded** | The unit accepted it, and then something the change touched raised a critical alarm. |
| **Failed** | The unit rejected it. |

:::caution[Applied means acknowledged, not working]
An acknowledgement only means the configuration parsed. A configuration a node accepts can still fail immediately — binding a socket to an address that exists on no interface, for example.

For a short window after dispatch the manager watches the unit's alarms. If a critical event names a resource your deployment changed, the deployment moves to **degraded**. Correlation is by resource, never by timing alone, so unrelated noise on a busy unit is not blamed on your change.
:::

## Requirements on the target node

Deploying pushes the unit's **whole** configuration. How gracefully a unit absorbs that depends on its own change-detection logic, which improved materially in recent releases.

Nodes older than **edge v0.101.0** are refused, with a message saying so. Pushing a whole configuration at an older node risks taking unrelated running flows off air, which is not a trade worth making silently.

A node that has simply never reported in is **not** refused — it is accepted and held pending, which is the ordinary offline case.

## Master graphs

A master graph puts several units on one canvas and lets you wire transport between them.

- **Wiring two units requires Operate permission on both.** A connection puts an endpoint on somebody else's machine, so authority over one end is not authority over the link. The same applies to previewing a connection, since a preview names a unit's interfaces.
- **Units from another group appear as a boundary card** showing only their connection points. Their internal configuration is never sent to your browser — not merely hidden from view.
- **Deleting a wire leaves its endpoints in place**, marked as no longer referenced. The graph records intent; it does not own a unit's configuration. Remove the endpoint through that unit's own editor if you want it gone.
- **Endpoints reach units through each unit's own editor**, never a second write path — so they pass the same validation, snapshot, audit and deploy checks as any other change.

### Reachability

The editor evaluates whether two units can actually reach each other, using the interfaces they report and the tunnels that exist between them. It does not probe the network.

Findings carry a confidence level, and suggested fixes are only clickable when clicking them is honest: an address can be applied, a tunnel is a link to where you would build one, and a relay is drawn on the canvas as a proposal rather than offered as a button.

### Declared cabling

You can tell the manager which units are physically cabled together. This is recorded as operator knowledge and used when evaluating reachability. Telemetry can correct it, but nothing infers it — a cable that exists in no record does not exist as far as the graph is concerned.

## Permissions

| Action | Requires |
|---|---|
| View a graph | View |
| Draft, validate, preview, deploy, retry, restore | Operate |
| Take over someone else's draft | Super Admin |
| Cross-unit connection or preview | Operate on **both** units |

## Rolling back

Restore never rewrites history. Loading an earlier deployment brings it back as a **draft**, which you then validate and deploy like any other change — so a rollback passes through the same checks as the change that caused it.

## Addresses

Type an address into a connection and it is used exactly as you typed it — the manager never reinterprets an address you supplied. Type `auto` in the listen-address field instead, or use the allocate control, and the manager hands one out of an [address pool](/manager/address-pools/).

- **The pool is resolved from the *receiving* unit**, not from whichever group you happen to be browsing in — the address belongs to the machine that will listen. Pools are declared installation-wide, per group, or per network zone, and the most specific one that applies wins. An exhausted zone pool falls through to the group's and then to the installation's, rather than refusing while a wider range sits empty.
- **A port is checked against the same port-conflict preflight** that would otherwise refuse the connection a moment later, so the manager will not hand out a port it is about to reject. A **multicast** group has no such second opinion: the preflight only knows about an output's optional source bind, never its destination, so the pool's own allocation table is the only authority on which groups are in use. Keep multicast ranges out of anything else's hands.
- **Every allocation is a row** naming the wire that holds it, so a connection can say which pool its address came from instead of showing a bare number nobody recognises.
- **Preview names the pool and the value it would likely use, and holds nothing.** Preview runs on every debounced edit; an allocating preview would drain a pool one keystroke at a time.
- **A value handed out for a connection that is then refused is released again.** It is committed only when the connection is actually written, and a reservation left abandoned on a closed canvas expires on its own.
- **With no applicable pool, nothing is invented.** The wire is refused with *"No address pool is configured for this unit and transport, so there is nothing to allocate from."* A multicast allocation is refused on anything but UDP, since SRT and RIST negotiate a session with a single peer.

Allocation sits *above* the graph compiler, which still refuses to invent an address of its own. That rule was never about addresses being unknowable — it was about a guessed address being indistinguishable from a chosen one. An allocated address is distinguishable: it has a row naming who holds it.

## Current limitations

- **No graph templates yet.**
- An input has one listener, so a second graph naming a *different* address for the same input is refused, and the refusal names the other graph and both addresses. Naming the *same* address is not a conflict. You can override, and the override is audited with what it contradicted.

## See also

- [Config Reconciliation](/manager/config-reconciliation/) — how the manager and a node agree on what is configured
- [Topology Visualization](/manager/topology/) — the read-only live map, as distinct from this authoring surface
- [Node Bus Matrix](/manager/node-bus/) — crosspoint authoring for the node-wide elementary-stream bus
- [Address Pools](/manager/address-pools/) — declaring the ranges of ports and multicast groups the manager may hand out
