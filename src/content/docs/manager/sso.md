---
title: SSO & OIDC
description: Configure OpenID Connect single sign-on on bilbycast-manager — the environment reference, strict provisioning, role and group sync, and why removing a user from every IdP group revokes nothing.
---

bilbycast-manager signs users in against any identity provider that speaks **OpenID Connect Authorization Code flow with PKCE**. Local password login keeps working alongside it, so there is always a break-glass path if the IdP is unreachable.

Two things are true of every deployment and catch people out, so they are worth stating before the configuration:

- **The manager never creates a user from an SSO login.** An admin creates the local user first, with the email the IdP will assert. The first successful SSO login binds the IdP's subject to that row.
- **SSO is a licensed feature.** Without a licence granting `sso`, the `BILBYCAST_OIDC_*` variables are read, a warning is logged, and SSO stays off. Startup still succeeds — a licence downgrade cannot brick a running server.

## How a sign-in works

1. The login page probes `GET /api/v1/auth/oidc/status` and renders **Sign in with SSO** only when it answers `{"enabled": true}`.
2. The button hits `GET /api/v1/auth/oidc/login`. The manager mints state, nonce and a PKCE verifier, stores them, sets a random `oidc_binding` HttpOnly cookie whose SHA-256 it keeps alongside the state row, and redirects to the IdP.
3. The IdP returns the user to `GET /api/v1/auth/oidc/callback`. The state row is consumed atomically, the `oidc_binding` cookie must match its stored hash, and the ID token is verified for signature, issuer, audience, expiry and nonce.
4. The user is resolved by the strict-provisioning rules below, optional role and group sync run, and the same `session` + `csrf_token` cookies the password path issues are set — a 24-hour session.
5. The browser lands on the `next` path it started from, or `/dashboard`.

The state row and the binding cookie both live **300 seconds**. Take longer than five minutes at the IdP and the callback is refused as an expired session; start again. The manager's HTTP client to the IdP has redirects disabled, so a discovery or token endpoint cannot be bounced elsewhere.

## Before you start

- A licence granting the `sso` feature. `GET /api/v1/license` must list `"sso"` in its features.
- The manager reachable on a stable HTTPS URL. `localhost` redirect URLs are rejected by most public IdPs.
- Admin access at the IdP, and the ability to set environment variables on the manager host and restart it.
- One local user already created with the exact email the IdP asserts for your test account.

## Register the client at your IdP

| Field | Value |
|---|---|
| Client type | Confidential ("web application") — not public / SPA / native |
| Grant type | Authorization Code, with PKCE (`S256`) |
| Redirect URI | `https://<manager-host>/api/v1/auth/oidc/callback` — exact match, HTTPS |
| Scopes | `openid`, `email`, `profile`; add `groups` if you want role or group sync |
| Response type | `code` |

The manager requests the `email` and `profile` scopes on every authorization request, and adds `groups` automatically whenever `BILBYCAST_OIDC_ROLE_CLAIM` is set. The IdP gives you back a client ID and a client secret; you also need its **issuer URL**, which the manager runs OIDC discovery against at startup — give it the issuer itself, not the `/.well-known/openid-configuration` document underneath it.

## Environment reference

Every one of these is read **once, at process start**. Changing any of them needs a restart; there is no runtime edit surface, and the SSO settings page in the UI is read-only by design.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `BILBYCAST_OIDC_ENABLED` | — | off | Master switch. `1`, `true` or `yes` (any case) turns SSO on; every other value, including `on`, leaves it off. |
| `BILBYCAST_OIDC_ISSUER_URL` | when enabled | — | IdP issuer. **Must start with `https://`** — an `http://` issuer is refused at startup rather than allowing an on-path attacker to rewrite discovery. |
| `BILBYCAST_OIDC_CLIENT_ID` | when enabled | — | Client ID registered at the IdP. |
| `BILBYCAST_OIDC_CLIENT_SECRET` | when enabled | — | Client secret. Never echoed by any API or UI surface. |
| `BILBYCAST_OIDC_REDIRECT_URL` | when enabled | — | Must match the URI registered at the IdP byte for byte. |
| `BILBYCAST_OIDC_PROVIDER_ID` | no | `oidc:default` | Stored on `users.sso_provider`. Give each deployment its own value when several share one database, so their subject bindings do not collide. |
| `BILBYCAST_OIDC_ROLE_CLAIM` | no | unset | Name of the ID-token claim carrying the user's groups. Setting it also adds `groups` to the requested scopes. Without it, no group is ever read and both sync knobs below are inert. |
| `BILBYCAST_OIDC_ROLE_MAP` | no | `{}` | JSON object, IdP group name → authority. Invalid JSON is a startup error. Shapes are in the table further down. |
| `BILBYCAST_OIDC_ROLE_SYNC` | no | off | Recompute the user's **platform** role (`user` / `super_admin`) from the claim on every login. Same `1`/`true`/`yes` parsing. |
| `BILBYCAST_OIDC_GROUP_SYNC` | no | off | Replace the user's **group memberships** from the claim on every login. Same parsing. |

Startup behaviour is deliberately loud in one direction and quiet in the other:

- Enabled but incomplete (issuer set, client ID missing), invalid role-map JSON, a non-HTTPS issuer, or a failed discovery handshake — the server **logs the reason and exits**. A misconfigured SSO deployment never boots into a half-working state.
- Enabled, valid, but the licence does not grant `sso` — the server logs `OIDC SSO is configured (BILBYCAST_OIDC_*) but the installed license does not include the 'sso' feature — SSO disabled. Apply a license that grants SSO to enable it.` and starts normally with SSO off. The login and callback routes re-check the licence themselves and return `404 SSO is not enabled on this server.`

## A worked configuration

Keycloak realm `bilbycast`, manager at `https://manager.example.com`, two IdP groups driving authority:

```bash
BILBYCAST_OIDC_ENABLED=true
BILBYCAST_OIDC_ISSUER_URL=https://keycloak.example.com/realms/bilbycast
BILBYCAST_OIDC_CLIENT_ID=bilbycast-manager
BILBYCAST_OIDC_CLIENT_SECRET=<from the IdP>
BILBYCAST_OIDC_REDIRECT_URL=https://manager.example.com/api/v1/auth/oidc/callback

# Optional — authority from IdP groups
BILBYCAST_OIDC_ROLE_CLAIM=groups
BILBYCAST_OIDC_ROLE_SYNC=true
BILBYCAST_OIDC_GROUP_SYNC=true
BILBYCAST_OIDC_ROLE_MAP='{"platform-support":{"super_admin":true},"acme-ops":{"group":"acme","role":"operator"},"acme-admins":{"group":"acme","role":"admin"}}'
```

:::caution[Neither sync ran before the release after v0.91.0]
Up to and including manager v0.91.0 the ID token's groups claim was dropped while the token was decoded, so `BILBYCAST_OIDC_ROLE_SYNC` and `BILBYCAST_OIDC_GROUP_SYNC` were accepted and changed nothing (manager#131). From the next release they run, and the first SSO login after upgrading rewrites each user from the map. Check the map before you upgrade. In particular, map your platform admins as `{"super_admin": true}`, as `platform-support` is above: `acme-admins` makes its members admins of `acme` and never platform Super Admins.

Leave `BILBYCAST_OIDC_ROLE_SYNC` unset if the platform role should stay manager-owned. Group sync on its own never touches it.
:::

At Keycloak, add a **Group Membership** mapper to the client's dedicated scope, claim name `groups`, "Full group path" off (so the claim reads `acme-ops`, not `/acme-ops`) and "Add to ID token" on. The manager reads the group claim out of the **ID token**, not the userinfo endpoint, as an array of strings; a single string counts as one group. `BILBYCAST_OIDC_ROLE_CLAIM` names a **top-level** claim and is taken literally. A namespaced name such as `https://example.com/groups` works. A dotted path such as `realm_access.roles` is not traversed, so it reads as absent.

Keep the file holding these out of version control and at `chmod 600` — the client secret is a credential.

## Strict provisioning

On every callback the manager resolves the user in this order:

1. Match `(provider_id, sso_subject)`. This is the steady-state path once a user has signed in before.
2. Otherwise match `users.email` against the ID token's `email` claim, **only if `email_verified` is true**. On a match the subject is bound to that row and every later login takes path 1.
3. Otherwise refuse. No user is ever created.

The email comparison is an exact SQL match on a plain text column, so **case matters** — provision the address in the same case the IdP asserts.

| Refusal reason (in the audit event) | What went wrong |
|---|---|
| `no email claim` | The ID token carried no `email`, so there is nothing to match on. Add the claim at the IdP (Entra ID needs it added explicitly as an optional claim). |
| `email not verified` | The token's `email_verified` was false or absent. |
| `no local account with that email` | Nobody has been provisioned in the manager with that address. This is the common one. |
| `account already bound to a different SSO identity` | The matched local user is already bound to another provider or subject. Unbind it deliberately rather than letting an IdP migration reassign accounts silently. |

All four land the user on `/login` with *"No bilbycast account is provisioned for that SSO identity. Contact your administrator."* — the detail stays in the audit trail, not on the login page.

A user who resolves but is inactive, expired or locked is refused separately, with an `auth.sso_blocked` audit event.

## Role sync — the platform role

With `BILBYCAST_OIDC_ROLE_SYNC=true`, the user's platform role is recomputed on every login. It is **Super Admin** if *any* of the user's groups maps to platform authority, meaning a legacy `"admin"` or `"super_admin"` string or `{"super_admin": true}`, and plain **User** otherwise. The order of the groups in the claim makes no difference.

| Entry shape | Example | Meaning |
|---|---|---|
| Plain string | `"admin"`, `"operator"`, `"viewer"`, `"super_admin"` | `admin`, `operator` and `viewer` are membership of the default group at that member role, and `admin` also grants platform Super Admin when role sync is on. `super_admin` grants the platform role only, with no group membership. |
| `{"group": …, "role": …}` | `{"group":"acme","role":"operator"}` | Membership of the named group (the default group when `group` is left out) at `viewer`, `operator` or `admin`. **Never platform authority**: `{"group":"acme","role":"admin"}` makes the user admin of `acme` and nothing more. |
| `{"super_admin": true}` | `{"super_admin":true}` | Platform Super Admin. Implies no group membership. |

The manager **refuses to start** when either sync is on and something is missing or invalid: no `BILBYCAST_OIDC_ROLE_CLAIM`, a standard OIDC claim named as the groups claim, an empty map, a role other than the ones in the table, a structured entry with neither `role` nor `super_admin`, or a `{"super_admin": true}` entry that also names a `group` or `role`. It logs a warning when role sync is on and no entry grants platform authority, and it names any `{"role": "admin"}` entries.

:::caution[Role sync rewrites the role, it does not only raise it]
While role sync is on, a login whose groups map to no platform authority sets the account back to **User**, an empty claim included, and an existing Super Admin is demoted with it. That is how removing someone from the admins group takes effect. **The last Super Admin is not protected**, because revocation has to reach the account with the most authority too. Map your platform admins before you turn it on.

Keep the break-glass local admin out of SSO. Give it no email, or one no IdP asserts as verified; otherwise its first SSO login binds it and role sync then governs it. If the last Super Admin is demoted anyway, the way back is on the database host: `UPDATE users SET role = 'super_admin' WHERE username = '<name>';`. If you turn role sync off later, set each user's role by hand. Nothing restores what the sync last wrote.
:::

## Group sync — memberships

`BILBYCAST_OIDC_GROUP_SYNC=true` makes the IdP claim authoritative over the user's [group memberships](/manager/multi-tenant-groups/). On each login the manager turns the claim into a set of `(group, member role)` pairs. It writes each pair that is new or has a different role, then **removes every existing membership not in that set**, including one an admin added by hand. Where two mapped IdP groups point at the same manager group, the higher member role wins.

The sync writes the member role and nothing else. An admin's node restriction (`allowed_node_ids`) or page scope on a synced membership survives every login. A membership the sync creates has neither, so it reaches everything its role allows until an admin narrows it. A membership the sync **removes** takes its narrowing with it, so if the map later adds the user back, the membership returns unrestricted.

The user's cached session state is then dropped on this instance, and the invalidation is fanned out to every peer, so the next request rebuilds their memberships from the database. It does not sign them out: an open session keeps working, with the new scope.

- **Unknown group slugs** are dropped. There is no just-in-time group creation, so create the group in the manager first. Each login that names one writes a single `auth.sso_unknown_group` audit event listing the slugs.
- **Every change is audited** as `auth.sso_membership_synced`, scoped to its group so that group's admins see it. A removal records the node restriction and page scope the membership carried, so they can be put back by hand.
- **A failed database read changes nothing** for that login, the platform role included: every read runs before anything is written (`auth.sso_sync_skipped` with reason `db_error`). It is never read as "no such group".
- **A new membership counts against the group's user limit**, like one an admin adds. A full group refuses it, audited as `auth.sso_membership_refused`, and the rest of the claim still applies.

:::caution[An empty claim revokes; an absent one does not]
If the claim is present it is synced, even when it is empty. Removing someone from all of their IdP groups therefore demotes them and removes every membership. If the IdP **omits** the claim, sends something that is not a list of strings, or sends an overage reference instead (Entra's `_claim_names`), the manager treats it as *no information*. The user keeps everything they had, and `auth.sso_sync_skipped` records why.

Some IdPs omit the claim for a user in no matching group. Okta does this when its groups filter matches nothing, so keep the filter at `.*`. Entra does it for a user with no group of the selected type, so prefer "Groups assigned to the application" and assign a group every manager user is in. Either way, a user who ends up with no claim at all is revoked by deactivating the account, not by group removal.
:::

## Checking what is live

| Surface | Who can see it | What it tells you |
|---|---|---|
| `GET /api/v1/auth/oidc/status` | public | `{"enabled": …}` — the same signal that decides whether the login page shows the SSO button. |
| `GET /api/v1/settings/sso` | Super Admin | `enabled`, `licensed`, `configured_via_env`, plus the resolved issuer, client ID, redirect URL, provider ID, `role_sync_enabled`, `group_sync_enabled` (from the release after v0.91.0), `role_claim` and the role-map **keys**. Never the client secret. |
| Administration → Settings → **Single Sign-On (OIDC)** → View (`/admin/settings/sso`) | Super Admin | The same values, rendered. Read-only — configuration lives in the environment. |

`enabled: false` with `configured_via_env: true` means the licence is the blocker. `enabled: false` with `configured_via_env: false` means `BILBYCAST_OIDC_ENABLED` is not set on the running process — check the process environment, not just the file you edited. Up to v0.91.0 the settings endpoint does not echo `BILBYCAST_OIDC_GROUP_SYNC`; on those releases, check that one against the environment directly.

## Sign-in errors

The manager sends every failure back to `/login?error=<code>` with a deliberately generic message. The detail is in the server log and the audit trail.

| Message on the login page | Code | Where to look |
|---|---|---|
| No bilbycast account is provisioned for that SSO identity. | `sso_no_account` | The `auth.sso_refused` audit event and its `reason` field. |
| SSO session expired. Please try again. | `sso_state` | Expected after five minutes at the IdP. Also fires when the `oidc_binding` cookie is missing or does not match — a callback replayed in a different browser. |
| SSO token verification failed. | `sso_verify` | Server log, `OIDC token exchange/verify failed`. Usually clock skew or a redirect-URL mismatch. |
| SSO sign-in failed. | `sso` | The IdP returned an error on the callback; its own logs have the reason. |
| Invalid username or password | `invalid` | Reached via `auth.sso_blocked` — the account matched but is inactive, expired or locked. |
| An internal error occurred | `internal` | A manager-side failure, not an IdP one: writing or reading the state row, the user / email lookup, the SSO bind, or minting the session JWT. Server log has the error. |

## Audit trail

| Action | Fires when | Carries |
|---|---|---|
| `auth.login_sso` | Successful SSO sign-in | `user_id`, IP, `details.provider` |
| `auth.sso_refused` | Strict-provisioning refusal | IP, `details.subject`, `details.email`, `details.reason` |
| `auth.sso_blocked` | Matched user is inactive, expired or locked | `user_id`, IP, `details.reason` |
| `auth.sso_unknown_group` | Group sync saw slugs that do not exist | `user_id`, IP, `details.provider`, `details.unknown_slugs` |
| `auth.sso_role_synced` | Role sync changed the platform role | `user_id`, IP, `details.provider`, `details.from`, `details.to` |
| `auth.sso_membership_synced` | Group sync added, re-roled or removed one membership | `user_id`, `group_id`, IP, `details.op`, `details.from_role`, `details.to_role`; on a removal also `details.allowed_node_ids` and `details.allowed_pages` |
| `auth.sso_membership_refused` | Group sync would have added a membership to a group at its user limit | `user_id`, `group_id`, IP, `details.reason`, `details.to_role`, `details.current`, `details.limit` |
| `auth.sso_sync_skipped` | Sync is on, but the claim was absent, malformed or an overage reference, or a database read failed. Nothing was changed. | `user_id`, IP, `details.provider`, `details.reason`, `details.claim` |

These are on the **Audit Log** page, not on Events, because an event belongs to a node. A run of `auth.sso_sync_skipped` rows means the IdP has stopped sending the claim.

A run of `auth.sso_refused` events sharing one subject almost always means someone was added at the IdP and never provisioned in the manager.

## What SSO does not change

- **Local password login.** Still available. Keep one local admin as a break-glass account, and keep it out of SSO so role sync never governs it.
- **MFA.** An SSO login skips the manager's TOTP step entirely — the IdP owns the second factor for those users. Password logins still go through it.
- **Everything after authentication.** Session cookies, CSRF, session revocation, group scoping and per-node RBAC are identical whichever way the user signed in.
- **Node connections.** Edges, relays and gateway sidecars authenticate over their own WebSocket protocol and are untouched by SSO.

## Related

- [Security](/manager/security/) — session model, MFA, licensing and the rest of the auth surface.
- [Multi-tenant Groups](/manager/multi-tenant-groups/) — what the group slugs and member roles in the role map actually grant.
- [API Reference](/manager/api-reference/) — the `/api/v1/auth/oidc/*` endpoints in context.
