---
title: Multi-tenant Groups
description: Run bilbycast for multiple customers from one manager — per-tenant users, resources, quotas, switcher pages, routines, and per-tenant logo + brand-colour theming.
sidebar:
  order: 4
---

bilbycast-manager ships **multi-tenancy by default**. A single manager instance can serve multiple customers — each with their own users, nodes, tunnels, audit trail, switcher pages, routines, and per-tenant UI theming — using the **Groups** model. Groups are an **access-control boundary**, not a billing surface: the manager doesn't take payment, doesn't issue invoices, and doesn't gate features per tenant.

## Why it matters

Three workloads collapse onto the same surface:

- **White-label managed services.** A systems integrator runs bilbycast for several broadcast customers; each customer logs in to a console branded with their own logo and accent colour, sees only their own nodes, tunnels, and flows, and never knows the integrator manages other customers from the same manager.
- **Multi-region or multi-channel operations.** A broadcaster runs separate "Sport", "News", and "Entertainment" production silos that must not see each other's flows or be able to fire each other's switcher presets.
- **Compliance separation.** Operations teams that need to evidence "team A cannot touch team B's resources" for a regulator get the audit trail to prove it: every audit row carries a `group_id`.

## Concepts

| Concept | What it is |
|---|---|
| **Group** | A tenant / workspace. Every managed resource (node, tunnel, switcher page, switcher preset, routine, user membership) belongs to exactly one. Every fresh install seeds a `grp_default` group that every pre-multi-tenant resource lives in until the operator creates a second group. |
| **Platform role** | Set on the user. `user` (everyone — sees only their groups) or `super_admin` (the company running the manager — bypasses every group filter, the only role that can create groups, change quotas, or land in "All groups" aggregate view). |
| **Member role** | Set per-group via membership. `viewer` (read), `operator` (start/stop, activate, ack), or `admin` (CRUD users + resources). A user can be Admin in one group and Viewer in another. |
| **Share** | Grants a non-owner group view / operate / manage permission on a single shared node, with an optional expiry. Used for cross-tenant tunnels and contractor access. |
| **Quota** | Per-group caps on nodes / tunnels / users. Optional. Stack beneath the licence-wide node limit. |
| **Theming** | Per-group `logo_url` and `brand_color`. Apply to the active tenant's UI in place of the bilbycast defaults. |

## Per-tenant theming

Two optional fields on each group drive the per-tenant UI:

- `logo_url` — a public HTTPS image used in place of the bilbycast sidebar logo.
- `brand_color` — a hex colour used to drive the active nav-item, top-bar focus, primary buttons, and link hovers via CSS `color-mix`. Both a strong and a tinted variant are derived automatically.

When an operator's active group is *Acme Media*, the manager looks like it was built for Acme Media. When they switch the nav selector to *Globex Broadcasting*, the same browser tab re-themes to Globex's palette. SuperAdmin in "All groups" mode falls back to bilbycast defaults, so the operations team always sees they're in the platform-aggregate view.

Editable by group Admin or SuperAdmin via `PUT /api/v1/groups/{id}`. The brand colour is server-validated as a 7-char hex, the logo URL is sanitised before being injected as `<img src>`.

## Access control

The authoritative predicate sits in code (`AuthUser::can_perform_on_node`) and applies to every mutation:

```
user can perform ACTION on resource R iff
  user.platform_role == 'super_admin'
  OR (membership effective_perm(GM, R) >= required_perm(ACTION)
      AND (GM.allowed_node_ids is NULL or R.id in GM.allowed_node_ids))
```

Effective permission is taken from the membership's `member_role` if the membership owns the resource, otherwise from any active `resource_share`. Destructive actions (delete node, rotate secret, ownership transfer, delete group) additionally require **native ownership** — a sharee with manage permission can't delete the resource they're sharing.

## Cross-group tunnels

A tunnel whose endpoints belong to different groups is allowed if the caller has `manage` on both edges. The tunnel's owner group is the ingress node's owner; the manager auto-inserts a `view` share into the egress group on success, so the egress tenant sees the tunnel terminating on their edge without getting mutation rights. Deleting the tunnel, rotating its bind secret, or transferring its ownership all remain with the owner group's admins.

## Quotas and live usage

Per-group caps on `max_nodes`, `max_tunnels`, `max_users` are preflighted at resource-creation time:

```json
HTTP/1.1 409 Conflict
{
  "error_code": "group_quota_exceeded",
  "quota": "max_nodes",
  "current": 10,
  "limit": 10
}
```

`GET /api/v1/groups/{id}/usage` returns live counts so the admin UI can render a quota bar. Quotas are operational caps, not commercial — they stack beneath the licence-wide node limit, and there is no payment surface anywhere in the manager.

## Ownership transfer

```
PUT /api/v1/nodes/{id}/owner-group     { "new_group_id": "..." }
PUT /api/v1/tunnels/{id}/owner-group   { "new_group_id": "..." }
```

The caller must be the native owner in the source group AND Admin in the destination group (or SuperAdmin). All existing shares on the resource are dropped (they were scoped to the previous owner context). Both groups' session caches are flushed via cross-instance pubsub so the next request rebuilds with the new visibility set. Audit: `node.transfer` / `tunnel.transfer` with the old + new group ids for compliance.

## OIDC group sync

`BILBYCAST_OIDC_ROLE_MAP` accepts tenant-aware entries:

```json
{
  "bilbycast-admins":  "admin",                              // legacy — grp_default at this role
  "acme-admins":       {"group": "acme",  "role": "admin"},
  "acme-operators":    {"group": "acme",  "role": "operator"},
  "globex-viewers":    {"group": "globex", "role": "viewer"},
  "platform-support":  {"super_admin": true}                 // platform role only, no group
}
```

With `BILBYCAST_OIDC_GROUP_SYNC=true` the manager idempotently replaces the user's `group_members` rows from the IdP claim on every login. Unknown group slugs are dropped with a single `auth.sso_unknown_group` audit event — there's no JIT group creation, so an IdP misconfiguration can never silently provision a new tenant.

## Worked example: a managed service provider

Acme Integrators runs bilbycast for three broadcast customers — *Sportscaster Co*, *NewsNet*, and *KidsTV*. They:

1. Create three groups: `sportscaster`, `newsnet`, `kidstv`. Each gets its own `logo_url` and `brand_color`.
2. Provision each customer's edges into the right group, tagged with quotas (Sportscaster: 50 nodes, NewsNet: 20 nodes, KidsTV: 5 nodes).
3. Create per-customer admin and operator users via OIDC, with the `BILBYCAST_OIDC_ROLE_MAP` mapping Acme's IdP groups to bilbycast group memberships.
4. The integrator's own staff sign in as `super_admin` and land in "All groups" mode to see the consolidated view across every customer.

NewsNet's evening-shift director signs in, sees the NewsNet logo and palette, sees only NewsNet's nodes / flows / switcher pages / routines / events, and can't accidentally take a Sportscaster preset on-air or even discover that Sportscaster exists.

## What it isn't

- **Not a billing surface.** No payment provider, no invoicing, no metered billing. Quotas are operational caps; the integrator runs their own commercial agreement with each customer outside bilbycast.
- **Not a feature-gating mechanism.** Every tier of bilbycast-manager (Community, Commercial, Enterprise/OEM) ships the full multi-tenancy feature. The `FEATURE_HA` and `FEATURE_BACKUP` licence flags gate the HA panel and encrypted backup respectively, but multi-tenancy itself is always available.
- **Not a code separation.** Groups are a row-level access boundary on the same Postgres schema, not separate databases or separate processes. A misconfigured share between groups is recoverable; a corrupted database is one disaster-recovery action away from any other tenant's data, so backups, master-key rotation, and Postgres hygiene are still platform-wide concerns.

## Reference

- Operator + admin reference: [`groups-and-tenancy.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/groups-and-tenancy.md) — full access predicate, share semantics, ownership transfer, OIDC group sync, migration notes.
- API reference: [`API.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/API.md) ("Multi-tenant Groups").
