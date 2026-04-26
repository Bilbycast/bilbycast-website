---
title: Live Switcher
description: PGM/PVW director console for bilbycast — promote presets across multiple flows in one click, with drift detection and full audit trail.
sidebar:
  order: 2
---

The **Live Switcher** is bilbycast-manager's in-browser director console. It models a classic broadcast production switcher — two on-air buses (**PGM**, **PVW**), named **presets** that capture a target state across one or more flows, and **pages** that group presets for fast operator navigation. It runs in the same browser tab as the rest of the manager, so an operator can monitor signal health, take a preset on-air, and acknowledge an alarm without context-switching.

## Why it matters

Broadcast directors recognise PGM/PVW immediately — it's the surface a vMix, Tricaster, Studer, or hardware production switcher gives them. The Live Switcher brings that workflow into bilbycast without a second appliance, and drives bilbycast flows directly so the same presets that switch a clean feed in the studio also flip every downstream output.

For multi-customer plants the switcher is **per-tenant**: an operator in *Acme Media* never sees *Globex Broadcasting*'s presets, and one tenant's director can't accidentally take another tenant's feed on-air.

## Concepts

- A **preset** is a named bundle of *actions*. Each action is "set flow X on node N to use input Y as its active input" — the preset choreographs which input each flow is currently watching.
- The **PGM bus** is what's on-air right now. The **PVW bus** is what's queued up for the next take.
- **Take** promotes the PVW preset to PGM in one click. It re-runs the preset's actions against the live edges, clears the PVW marker on success, and writes a `switcher.take` audit row.
- **Pages** group presets so a director can flip between, say, an "Indoor cameras" page and an "Outdoor cameras" page without scrolling.

## Workflow

A typical sports-broadcast workflow:

1. The director loads "Match Camera" onto **PVW** and sees the preset card flash a `PVW` chip.
2. The action list expanded inside the card confirms which flows on which edges will be re-pointed.
3. On a goal, the director clicks **Take**. Match Camera flips to `PGM`, the previous PGM ("Stinger") clears, and every downstream output starts pulling from the match-camera input.
4. While Match Camera is on PGM, the director loads "Replay" onto PVW, ready for the next take.

For deterministic, no-preview activations, the **Activate** button on a preset card fires it straight to PGM. Useful for emergency cutaways and alarm-driven workflows.

## Drift detection

Each preset card carries a **matches current state** badge. The manager periodically reconciles the preset's intended actions against the cached node configs; if reality has drifted (someone manually changed an active input on the edge) the badge clears and the PGM marker auto-clears too. This protects against "Take"ing a preset whose state is already wrong — the director sees that PGM is now in an unknown state and can re-evaluate.

## Composes with Routines

Presets can be activated by [**Routines**](/manager/routines/) on a cron schedule. A "Sunday 18:00 evening news" routine that activates the "Evening News" switcher preset reuses the same per-node Operate permission checks as a manual director click — no second permission model, no second audit trail.

## Permissions

- **Listing and activating** presets requires the **Operator** role in the preset's owner group, plus per-node **Operate** permission on every action's target node.
- **Creating, editing, and deleting** presets and pages requires the **Admin** role in the owner group.
- Switcher pages and presets are first-class tenant-scoped resources via [Multi-tenant Groups](/manager/multi-tenant-groups/) — they can't be moved across tenants by accident, and SuperAdmin in "All groups" mode can administer every tenant's switcher from one console.

## Audit trail

Every meaningful action is audited:

| Action | Audit row |
|---|---|
| Activate preset directly | `switcher.preset.activate` |
| Promote PVW → PGM | `switcher.take` |
| Create / update / delete preset or page | `switcher.preset.{create,update,delete}` / `switcher.page.{create,update,delete}` |

Set or clear PVW is a UI-only marker — no audit row, by design. Activate / Take cover every audit-worthy edge-side command.

## Reference

- Operator walk-through: [`USER_GUIDE.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/USER_GUIDE.md) ("Live Switcher (PGM/PVW)").
- Architecture, REST surface, drift handling: [`switcher.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/switcher.md).
- API reference: [`API.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/API.md) ("Switcher (live PGM/PVW director console)").
