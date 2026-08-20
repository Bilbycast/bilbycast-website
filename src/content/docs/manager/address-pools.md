---
title: Address Pools
description: Declare the ranges of ports and multicast groups the manager may hand out, so a cross-unit connection is given an address instead of one being picked by hand.
sidebar:
  order: 4
---

Every cross-unit connection needs an address the receiving unit listens on, and until address pools shipped, every one of them was typed in by a person. That works until two operators pick port 9000 on the same unit, or two trucks pick `239.10.0.5` on the same network — and it fails at deploy time, on hardware, in front of whoever is waiting for the feed.

An **address pool** is the range somebody actually gave you — a block of ports, or a block of multicast groups — written down in one place so the manager can hand out of it and record who holds what.

Find it in the manager's left navigation under **Address Pools** (`/address-pools`). It is available on every installation; there is nothing to switch on, and an installation with no pools behaves exactly as it did before.

:::note[A pool is not a cleverer guess]
The rule the [Visual Flow Editor](/manager/visual-flow-editor/) has always had is unchanged: the manager never invents an address. A wire with no pool and no typed address is still refused, because a guessed port is a silent misconfiguration wearing the clothes of a helpful default.

What an allocation adds is not cleverness — it is a row naming who holds the value, which a guess could never have. That is the whole difference, and it is why allocation sits *above* the part of the manager that refuses to guess rather than replacing it.
:::

## What a pool hands out

A pool is one of two kinds, fixed when you create it.

| Kind | Hands out | Notes |
|---|---|---|
| **Ports** | A port number only | The manager composes it with an address the receiving unit reports, preferring one on the same network as the sending unit |
| **Multicast groups** | A group address **and** a port, together | A multicast destination is meaningless as half a pair. UDP only |

Both kinds carry a **port range**, because a multicast stream still needs a port and a pool that handed out a group address with no port would be handing out half an answer.

A multicast pool also carries a group range in CIDR form, for example `239.10.0.0/24`. It must be a real IPv4 multicast range (`224.0.0.0`–`239.255.255.255`) and no wider than a `/16` — a `/8` is sixteen million addresses, which is a typo rather than a plan, so it is refused when you save the pool rather than hours later when an allocation is attempted.

When a multicast pool is searched, the **group address advances first and the port is held**. That matches how a facility actually uses multicast: the port tends to be conventional and the group address is what distinguishes one stream from another.

## Which pool applies

Three scopes, and the **most specific one that applies wins**.

| Scope | Applies to | Who can create or change it |
|---|---|---|
| **Every unit** | The whole installation | Super Admin only |
| **One group** | Every unit that group owns | That group's Admins, or Super Admin |
| **One network zone** | Every unit carrying that **Network Zone** label — optionally narrowed to one group as well | Super Admin, or the named group's Admins when it names a group |

The zone scope matches the unit's own **Network Zone (optional)** field on the Nodes page. It is free text on purpose: the moment it becomes a fixed list, somebody has a site it cannot describe.

Three things are worth knowing about how resolution behaves:

- **The pool is resolved from the *receiving* unit** — its owning group and its zone. Not from whichever group you happen to be browsing in, which is a navigation preference and says nothing about who owns the machine being configured.
- **An exhausted pool falls through to the next one**, less specific each time. A full zone pool drops to the group's, and then to the installation-wide one, rather than refusing while a wider range sits empty.
- **Two identical requests always resolve the same way.** Within a scope, ties are settled by name and then by id, so the answer never depends on the order the database happened to return rows in — an operator comparing two units never sees the manager disagree with itself for no visible reason.

A pool can also be limited to particular transports — `udp`, `srt`, `rist` — by listing them in **Transports**. Leave it blank for any, which is the useful default: an administrator carving out a range usually cares about the range, not about which protocol rides it. Matching is case-insensitive, and at most eight transports may be listed.

A **disabled** pool is skipped entirely. Disabling is the reversible way to take a range out of service; deleting is not, and is refused while the pool still holds anything out.

:::note[Everyone can see an installation-wide pool]
A pool with no owning group is readable by every authenticated user, even though only a Super Admin can create or change one. That is deliberate. Inheritance means a group's address may come out of a range that group does not own, and an operator who cannot see the range they were served from has no way to understand the answer — they report it as a fault.

Pools owned by a group are visible only to that group (and to Super Admin), and reading a pool's **allocations** is filtered further: you see the allocations made to units you can already see, and nothing tells you how many you cannot.
:::

## Declaring a pool

**Address Pools → New address pool.**

| Field | What it does |
|---|---|
| **Name** | How the pool is named in the list and in refusal messages. Unique within its scope |
| **Description** | Optional free text |
| **Hands out** | Ports or Multicast groups. **Cannot be changed later** |
| **Applies to** | Every unit / One group / One network zone. **Cannot be changed later** |
| **Owning group** | The group id, for a group-scoped pool (or to narrow a zone pool to one tenant) |
| **Network zone** | The label to match against a unit's Network Zone, for a zone-scoped pool |
| **Multicast range** | The group range in CIDR form, multicast pools only |
| **First / last port** | Inclusive, 1–65535 |
| **Transports** | Comma-separated, blank for any |
| **Hold an unsaved address for** | How long a value handed out for an unfinished connection stays held. 60 seconds to 24 hours, default 1 hour |

:::caution[Kind and scope are fixed once a pool exists]
Editing a pool cannot move it between tenants or turn a port pool into a multicast one. Addresses already handed out of it would then describe something the pool no longer is. Delete it and declare a new one — which makes that consequence visible, because a delete is refused while the pool still holds anything out.
:::

## Exclusions

A pool is usually a block somebody was given, inside which a handful of values are already spoken for by equipment the manager does not control. An **exclusion** carves those out without shrinking the range around them.

Exclusions carve one of two axes — `port` or `address` — with inclusive bounds, and carry an optional reason. They appear on the pool's expanded **Allocations** panel under *Never handed out*.

They are **not creatable from the UI yet**. Today they are added and removed through the API:

```
POST   /api/v1/address-pools/{id}/exclusions
DELETE /api/v1/address-pools/{id}/exclusions/{exclusion_id}
```

An address exclusion wider than 65,536 addresses is refused rather than expanded, on the same reasoning as the `/16` cap on the pool's own range.

## Asking for an address instead of typing one

Type an address into a connection and it is used exactly as typed — that path is unchanged and remains available. To ask for an allocation instead, the connection is created with either of two spellings in its transport parameters:

| Send | Meaning |
|---|---|
| `"allocate_address": true` or `"allocate_address": "port"` | Allocate a port |
| `"allocate_address": "multicast"` | Allocate a group address and port |
| `"listen_addr": "auto"` | Allocate a port — the sentinel form, so no rebuild of the editor is required for the feature to work |

Both are accepted by `POST /api/v1/master-graphs/{id}/connections`. On success the manager writes the allocated address into the connection and stamps it with `address_pool_id`, so the wire carries a record of where its address came from rather than a bare number nobody recognises.

The **preview** endpoint reports which pool would serve and the value it would most likely hand out, and holds nothing. Preview runs on every debounced edit, so an allocating preview would drain a pool one keystroke at a time. The value it names is a likely answer, not a promise — between preview and create, somebody else may take it.

:::caution[The canvas has no allocate control yet]
The connection dialog in the Visual Flow Editor still has only the address field. Typing `auto` into it does work — the manager allocates before it evaluates anything else — but the dialog's live reachability panel reads the literal text and will tell you `"auto"` is not an address and a port. You can proceed past that, and the check that actually decides the outcome runs against the address the pool handed out, not the word you typed.

Until the control ships, the API is the path that reads honestly. A multicast allocation can only be asked for by name (`"allocate_address": "multicast"`); the `auto` sentinel always means a port.
:::

## Held, in use, and released

An allocation has two states, both visible on the pool's **Allocations** panel.

- **Held** — reserved for a connection that has not been written yet. It expires by itself after the pool's hold time, because a draft canvas deliberately has no expiry of its own to inherit.
- **In use** — committed. It stays until a person releases it.

The address is committed at the moment the connection row is written, and every refusal between allocating and writing gives it straight back. That matters more than it sounds: reachability findings and endpoint conflicts *ask* rather than refuse, so acknowledging two warnings would otherwise burn two addresses, and an hour of clicking could empty a small pool without a single connection existing.

**Releasing** is always a person's decision, never automatic — the **Release** button on the pool's allocations table, or `DELETE /api/v1/address-allocations/{id}`.

:::caution[Releasing an address does not change any unit]
It only stops the manager holding the value. A unit may still be bound to it and carrying traffic — deleting a wire deliberately leaves its endpoints in place — so releasing an address that is still in use lets a later allocation hand the same value to a different machine, and the original sender then connects to the wrong one. Release only what you know is finished.

For the same reason, deleting a unit from the manager does **not** free its addresses. The allocation stays, listed with no unit against it, until somebody releases it.
:::

A hold that has lapsed stops blocking its value as soon as anything next allocates from that pool — the allocator clears its own pool's lapsed holds before it searches. The row itself may still be listed as *Held* until then, so a lapsed hold you can still see is not one that is standing in anyone's way.

## When there is nothing to hand out

A refused allocation refuses the connection; it never falls back to a guess. Each refusal comes back as HTTP 409 with a code you can act on, and says which pool it is talking about.

| Code | What it means | What to do |
|---|---|---|
| `address_pool_none` | No pool applies to this unit, this transport and this kind | Type an address, or declare a pool that covers the receiving unit's group or zone |
| `address_pool_exhausted` | Every value in every applicable pool is spoken for | Release one, widen the range, or type an address |
| `address_pool_no_host` | A port is available, but nothing is known about an address the receiving unit actually holds | Bring the unit online once so it reports its interfaces, or type the address yourself |
| `address_pool_malformed` | The pool's own definition cannot be read — a bad range, or an exclusion wider than the cap | Fix the pool named in the message |

Any other `address_pool_*` code means the manager could not reach its own database while allocating. Nothing has been handed out and nothing is held; retry the request.

A multicast allocation on anything but UDP is refused earlier, with `multicast_unsupported` (HTTP 400): SRT and RIST negotiate a session with one peer, so a group address is not a destination they can use.

:::note[Why `address_pool_no_host` is a refusal and not a fallback]
A port pool hands out a port; the host has to come from somewhere, and it comes from the addresses the receiving unit has reported — preferring one on the same network as the sender. If the unit has never reported a routable address, there is no host to put the port on.

Falling back to loopback would be the one value that always parses, always deploys, and never carries traffic between two machines. That is how a unit ends up listening on `127.0.0.1:9100` for a caller that could never arrive, so it is refused instead.
:::

## How this fits the port-conflict preflight

The manager already refuses a colliding bind: creating an input, output or tunnel is preflighted against everything already configured on that unit, and a collision is rejected before any command reaches the node.

Allocation consults **that same view**, not a second one of its own. Before a port pool picks a value, every port already bound by that unit's managed inputs, managed outputs and tunnels is treated as taken — so the manager cannot hand out a port it is about to reject a moment later.

:::caution[Multicast has one authority, and it is the pool's own table]
The preflight comparator registers an output's *source bind*, never its destination. For a multicast pool that means the unit's own configuration contributes nothing, and the only record of which groups are in use is what the pool itself has handed out.

So a group address somebody typed by hand into an output, on a unit that no pool knows about, will not stop that same group being allocated to somebody else. This is a limit of the existing preflight rather than one address pools introduced, but it is the one to keep in mind when mixing hand-picked and allocated multicast on the same network.
:::

## Permissions

| Action | Requires |
|---|---|
| See a pool with no owning group | Any authenticated user |
| See a group's pool | Membership of that group, or Super Admin |
| See a pool's allocations | Read on the pool; rows are filtered to units you can already see |
| Create or change a group's pool | **Admin** of that group, or Super Admin |
| Create or change an installation-wide pool | **Super Admin** |
| Release an address | Write on the pool it came from |
| Allocate for a connection | Operate on **both** units, exactly as any cross-unit wire |

Declaring a range decides where every unit in scope gets its addresses, which is an administrative act rather than an operational one — so Operate is not enough to create or edit a pool. Another tenant's pool reads as *not found* rather than *forbidden*, so its existence is never confirmed to somebody who cannot see it.

Every create, edit, delete, exclusion change and release is written to the audit log against the owning group.

## Deleting

- **A pool that still holds addresses cannot be deleted.** The refusal names how many are outstanding so you can go and look. Release them, or disable the pool instead.
- **A group that owns pools cannot be deleted.** The refusal names them. A pool is operator-authored knowledge that nothing recreates, so deleting a group is blocked by it rather than silently destroying it — the same rule that protects tunnels and declared cabling.

## Not built yet

Stated plainly, because each one is a thing you might reasonably expect to find:

- **No allocate control on the canvas.** The server accepts both spellings and both are tested; the "Automatic" control in the connection dialog needs a rebuild of the editor bundle and has not shipped.
- **Exclusions are API-only.** They are displayed on the pool page but cannot be created or removed there.
- **Pools serve cross-unit connections on a master graph.** An ordinary input, output or tunnel created directly on a node still takes an address you type; it does not draw from a pool.
- **Multicast pools are IPv4.**
- **A lapsed hold is cleared lazily**, by the next allocation out of that pool, so it can remain listed as *Held* after its hold time has passed.

## See also

- [Visual Flow Editor](/manager/visual-flow-editor/) — where a cross-unit connection is drawn, and where an allocated address is used
- [Multi-tenant Groups](/manager/multi-tenant-groups/) — the group model that the group and zone scopes rest on
- [IP Tunneling](/manager/ip-tunneling/) — for when two units cannot reach each other directly at all
- [Config Reconciliation](/manager/config-reconciliation/) — how the manager and a node agree on what is configured
