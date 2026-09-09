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

:::caution[With `ROLE_SYNC=true`, `acme-admins` above becomes a *platform* Super Admin]
The platform-role lookup flattens each mapped entry to a single string and takes the first one the user's own claim matches, so a structured entry whose `role` is `admin` — `acme-admins` here — promotes that user to platform **Super Admin**, not merely admin of the `acme` group. Whether it fires depends on the order the IdP lists the user's groups: a user whose claim happens to start with `acme-ops` flattens to `operator` and stays a plain User.

Leave `BILBYCAST_OIDC_ROLE_SYNC` unset if the platform role should stay manager-owned — group sync on its own never touches it.
:::

At Keycloak, add a **Group Membership** mapper to the client's dedicated scope, claim name `groups`, "Full group path" off (so the claim reads `acme-ops`, not `/acme-ops`) and "Add to ID token" on. The manager reads the group claim out of the **ID token**, not the userinfo endpoint, and only accepts it as an array of strings.

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

With `BILBYCAST_OIDC_ROLE_SYNC=true`, the user's platform role is recomputed on every login: **Super Admin** if any matched entry is `{"super_admin": true}` or the first matching group maps to the string `admin` or `super_admin`, and plain **User** otherwise. Ordering in the map itself is irrelevant — it is a hash map, so the order of the user's own claim decides which mapped group is "first".

| Entry shape | Example | Meaning |
|---|---|---|
| Plain string | `"admin"`, `"operator"`, `"viewer"` | Membership of the default group at that member role — except that group sync cannot currently resolve it; see the note below. `admin` and `super_admin` also flip the platform role, when role sync is on and this is the first matched group. |
| `{"group": …, "role": …}` | `{"group":"acme","role":"operator"}` | Membership of the named group at `viewer`, `operator` or `admin`. A `role` of `admin` **also flips the platform role to Super Admin** when role sync is on and this is the first matched group — the platform-role lookup flattens a structured entry down to its `role` string. |
| `{"super_admin": true}` | `{"super_admin":true}` | Platform Super Admin. Implies no group membership. |

:::danger[Plain-string entries grant no group membership in v0.84.0]
The callback expands the legacy shorthand against the constant `grp_default` — which is the default group's **id** — and then resolves it **by slug**, and the default group's slug is `default`. The lookup misses (unless a group whose slug is literally `grp_default` happens to exist), so with group sync on a plain-string entry adds the user to nothing and instead lands in `auth.sso_unknown_group` with `grp_default` in `unknown_slugs`. Its effect on the platform role is unaffected.

Write `{"group":"default","role":"operator"}` instead of `"operator"` to get the membership the shorthand was meant to grant.
:::

:::caution[Role sync rewrites the role, it does not only raise it]
While role sync is on, a login whose groups map to nothing — or to anything other than `admin` / `super_admin` — sets the account back to **User**, demoting an existing Super Admin. If you turn role sync off later, set each user's role by hand afterwards; nothing restores what the sync last wrote.
:::

## Group sync — memberships

`BILBYCAST_OIDC_GROUP_SYNC=true` makes the IdP claim authoritative over the user's [group memberships](/manager/multi-tenant-groups/). On each login the manager resolves the claim into a set of `(group, member role)` pairs, upserts every one of them, and then **removes every existing membership not in that set**. Where two mapped IdP groups point at the same manager group, the higher member role wins. Every membership it writes carries a null `allowed_node_ids` — which means *every* resource the group owns or is shared into — so an admin's per-member narrowing to a subset of the group's nodes is cleared on that user's next SSO login. The user's cached session state is then dropped on this instance and the invalidation is fanned out to every peer, so the next request rebuilds their memberships from the database rather than serving the old visibility. It does not sign them out — an open session keeps working, with the new scope.

Two things are dropped rather than guessed at:

- **Unknown group slugs.** There is no just-in-time group creation — create the group in the manager first. Each login that names one emits a single `auth.sso_unknown_group` audit event listing the slugs, so the gap is visible.
- **Unknown member roles.** Only `viewer`, `operator` and `admin` are member roles. A map entry naming anything else (including `super_admin`, which is a *platform* role) contributes no membership.

:::caution[An empty groups claim skips synchronisation entirely]
Both sync paths are guarded on the claim being non-empty. If the IdP sends an empty array, omits the claim, or sends something that is not an array of strings, the manager treats it as *no information* rather than *no groups*: the user keeps every membership and the platform role they already had.

The practical consequence is that **removing someone from all of their IdP groups revokes nothing**. Revoke access by deactivating or deleting the user — in the IdP, in the manager, or both — or by moving them into a mapped lower-privilege group so the claim still carries something. Removing a *subset* of their groups does work, because the remaining groups keep the claim non-empty.
:::

## Checking what is live

| Surface | Who can see it | What it tells you |
|---|---|---|
| `GET /api/v1/auth/oidc/status` | public | `{"enabled": …}` — the same signal that decides whether the login page shows the SSO button. |
| `GET /api/v1/settings/sso` | Super Admin | `enabled`, `licensed`, `configured_via_env`, plus the resolved issuer, client ID, redirect URL, provider ID, `role_sync_enabled`, `role_claim` and the role-map **keys**. Never the client secret. |
| Administration → Settings → **Single Sign-On (OIDC)** → View (`/admin/settings/sso`) | Super Admin | The same values, rendered. Read-only — configuration lives in the environment. |

`enabled: false` with `configured_via_env: true` means the licence is the blocker. `enabled: false` with `configured_via_env: false` means `BILBYCAST_OIDC_ENABLED` is not set on the running process — check the process environment, not just the file you edited. Note that the settings endpoint does not echo `BILBYCAST_OIDC_GROUP_SYNC`; confirm that one against the environment directly.

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

A run of `auth.sso_refused` events sharing one subject almost always means someone was added at the IdP and never provisioned in the manager.

## What SSO does not change

- **Local password login.** Still available. Keep one local admin as a break-glass account.
- **MFA.** An SSO login skips the manager's TOTP step entirely — the IdP owns the second factor for those users. Password logins still go through it.
- **Everything after authentication.** Session cookies, CSRF, session revocation, group scoping and per-node RBAC are identical whichever way the user signed in.
- **Node connections.** Edges, relays and gateway sidecars authenticate over their own WebSocket protocol and are untouched by SSO.

## Related

- [Security](/manager/security/) — session model, MFA, licensing and the rest of the auth surface.
- [Multi-tenant Groups](/manager/multi-tenant-groups/) — what the group slugs and member roles in the role map actually grant.
- [API Reference](/manager/api-reference/) — the `/api/v1/auth/oidc/*` endpoints in context.
