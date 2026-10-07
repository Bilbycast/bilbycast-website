---
title: Viewer Portal
description: bilbycast-portal — a separate sign-in service beside a distribution relay that asks the manager which feeds a viewer may watch and hands them a short-lived DVR token, and can keep Authelia's accounts and password emails in step with the manager.
sidebar:
  order: 4
---

A gated feed has two ways in. The **link** is minted per session from the
manager and is revocable — right for a one-off guest. The **portal** is the
login, right for staff who watch regularly and for whom issuing and chasing
links is the worse job. Neither replaces the other.

`bilbycast-portal` is that login. A viewer signs in through your existing
forward-auth identity provider (Authelia, in the worked example below), sees the
feeds they are entitled to, clicks one, and lands in the
[DVR player](/relay/viewer-distribution/) with a token that admits that feed and
nothing else.

It holds no signing key and keeps no state of its own. The one secret it always
holds is its own service token; the optional
[account sync](#accounts-and-password-links) also writes Authelia's users file,
and the optional [`mail` block](#rewriting-authelias-email) gives it an SMTP
relay key and a listener secret.

- **It does not sign tokens.** It asks the manager to mint one, and the manager
  re-checks the entitlement before it does. A public-facing VPS holding the key
  that signs every viewer credential would make a compromise there a compromise
  of every feed on every relay.
- **It does not hold entitlements.** It asks the manager on each page load, so
  withdrawing someone's access takes effect on their next click rather than on
  the next successful push to a box that might be unreachable.
- **It is not the relay.** Separate binary, separate systemd unit, separate
  user — because the relay terminates media for every viewer on the box, and a
  bug in a public-facing web page must not be able to take that with it.

**Versions.** Account sync, password links and mail rewriting are in relay
**0.15.0** and later, and need manager **0.87.0** or later. The
[set-password page](#the-set-password-page) is in relay releases **after
0.15.0**; on 0.15.0 the emailed link is Authelia's own.

## A second binary, not a relay mode

The portal is declared as its own `[[bin]]` in the relay's `Cargo.toml`, lives
outside `src/bin/` so it is not auto-discovered, and is gated on
`required-features = ["portal"]` — a plain `cargo build` simply does not produce
it and links no HTTP client:

```bash
cargo build --release --features portal      # -> target/release/bilbycast-portal
```

The `portal` feature is independent of `viewer-distribution`. The portal hands
out links to a relay, which need not be the one it sits beside, and building it
pulls in neither str0m nor OpenSSL.

**It ships only in the tarball.** The release workflow builds the two
`-distribution` artefacts with `--features "viewer-distribution-vendored,portal"`
and stages the portal into the signed tarball only — the bare binary published
alongside it is the relay and nothing else, so a plain `curl` of that file cannot
give you a portal.

| Release artefact | What it carries |
|---|---|
| `bilbycast-relay-<arch>-linux-distribution` | The relay binary alone. |
| `bilbycast-relay-<arch>-linux-distribution.tar.gz` | The relay, `bilbycast-portal`, `packaging/bilbycast-portal.service`, `packaging/bilbycast-portal.sysusers` and `portal-config.example.json`, alongside the relay's own unit and example config. |
| `bilbycast-relay-<arch>-linux` (lean forwarder) | No portal — the variant is built without the feature. |

The unit runs as `bilbycast-portal`, a distinct system account from
`bilbycast-relay` with home `/var/lib/bilbycast/portal` and `/usr/sbin/nologin`
as its shell. One account for both would mean a portal compromise could read the
relay's config and the manager secret in it. The unit carries the relay's
hardening profile — `ProtectSystem=strict`, an empty `CapabilityBoundingSet`,
`RestrictAddressFamilies=AF_INET AF_INET6`, `SystemCallFilter=~@privileged
@resources` and the rest are the same lines — and differs in three places:

| Line | Why |
|---|---|
| `ReadOnlyPaths=/etc/bilbycast` | The relay has it under `ReadWritePaths` so it can persist its node identity. The portal persists nothing there. |
| `ReadWritePaths=-/etc/authelia/users` | The one place the portal may write, and only account sync does: it replaces Authelia's users file by renaming a new one over it, so it needs the directory. The leading `-` lets a portal without account sync start when the directory does not exist — which also means a directory created after the portal started stays read-only until it restarts. |
| `SystemCallFilter=@chown` | Given back after the `@privileged` deny. Account sync keeps the users file's group across a rewrite with `fchown`, and a call the filter denies does not fail — it kills the process with `SIGSYS`. With no capabilities, the portal can only hand a file it owns to a group it is already in. |

## Install it

`install-relay.sh` takes `--with-portal <manager base URL>`. That is the
manager's **HTTPS base URL**, not the WebSocket one — the portal talks to its
REST API:

```bash
curl -fsSL https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/install-relay.sh \
  | sudo bash -s -- \
      --manager wss://manager.example.com/ws/node \
      --registration-token <token-from-the-manager-UI> \
      --with-portal https://manager.example.com \
      --player-origin https://relay.example.com
```

| Path | What lands there |
|---|---|
| `/opt/bilbycast/portal/bilbycast-portal` | The binary, mode `0755`. |
| `/etc/systemd/system/bilbycast-portal.service` | The unit from the tarball. |
| `/etc/bilbycast/portal.json` | A generated config, mode `0644`. Written **only if absent**, so an upgrade never overwrites a working one. |
| `/etc/bilbycast/portal.env` | An empty `BILBYCAST_PORTAL_TOKEN=`, mode `0600`, group `bilbycast-portal`. |
| `/var/lib/bilbycast/portal` | The unit's working directory, owned by the service account. |

`--with-portal` against the lean forwarder tarball is **refused** with a message
saying the portal ships in the distribution variant, rather than installing a
relay and quietly skipping the half you asked for. The installer writes neither
an `accounts` nor a `mail` block, and touches nothing of Authelia's — both are
yours to add (see [Configure it](#configure-it)).

**The installer does not start the portal**, and cannot: it needs a manager
service token that does not exist until you generate one, and a portal started
without one does not start at all — validation runs once at startup and the
process exits with ``portal config: no manager token: set BILBYCAST_PORTAL_TOKEN
or `manager_token` in the config file``, so the packaged unit (`Restart=always`,
`RestartSec=3`) would only restart it into the same error every three seconds
until its start limit trips (ten failures in five minutes). Generate the token
(below), put it in `portal.env`, then:

```bash
sudo systemctl enable --now bilbycast-portal
```

### Upgrading

`upgrade-relay.sh` carries the portal along automatically when the host has one —
no flag. The portal is swapped while the relay is down and started again only
after the relay's health probe passes, and only if it was running before, so it
never comes up beside a relay that is about to be rolled back; if the relay
rolls back, so does the portal, unit file included. If the relay is healthy but
the portal is not running when the script checks — once, right after starting
it — the script prints a warning naming the previous binary instead of rolling
the relay back: the portal is not the data plane. A portal that exits a moment
later can pass that check, so confirm it with
`systemctl status bilbycast-portal`. Upgrading with a *lean* tarball on a host
that runs a portal warns and leaves the portal alone.

From relay 0.15.0 the script also **refreshes the portal's unit file** when the
release's differs from the one at
`/etc/systemd/system/bilbycast-portal.service`, then runs
`systemctl daemon-reload`. A release can need something new from systemd — 0.15.0
did: the writable users directory and `SystemCallFilter=@chown` above — and a
new binary under an old unit would fail where the new unit would not.

- **Your own changes belong in a drop-in** (`systemctl edit bilbycast-portal`),
  which lives in `bilbycast-portal.service.d/` and is kept. An edit to the unit
  file itself is replaced, and the replaced file is kept at
  `/opt/bilbycast/portal/bilbycast-portal.service.previous`.
- **A unit that runs something else is left alone.** The file is replaced only
  while its `ExecStart=`, `User=`, `Group=`, `WorkingDirectory=` and
  `EnvironmentFile=` lines are the packaged ones. One where any of those was
  edited — a binary moved elsewhere, another config or token file — or a unit
  installed somewhere else is left as it is, with a warning naming what this
  release's unit adds. Its binary is still upgraded: the script finds it from
  the unit file's own `ExecStart=`, which is why a moved binary is named in the
  unit file rather than in a drop-in.
- **`portal.json` and Authelia are never touched.** A change a release needs
  in either is yours to make first — see
  [Upgrading a portal that already runs account sync or mail](#upgrading-a-portal-that-already-runs-account-sync-or-mail).
  From relay releases after 0.15.0, for a portal whose config has both
  `accounts` and `mail` but whose `mail` block does not name `click_through`,
  the script also prints a reminder that password links now point at the
  portal's `/set-password` page, with the Authelia `bypass` rule it needs.

## Configure it

`portal-config.example.json`, the shipped example. The installer writes a file
of the same shape to `/etc/bilbycast/portal.json`, filling in the
`--with-portal` URL as `manager_url` and `--player-origin`, if given, as the
single entry in `player_origins` — and no `logout_url`:

```json
{
  "listen_addr": "127.0.0.1:8088",
  "manager_url": "https://manager.example.com",
  "username_header": "Remote-User",
  "logout_url": "https://auth.example.com/logout",
  "trusted_proxies": ["127.0.0.1", "::1"],
  "player_origins": ["https://relay.example.com"]
}
```

| Field | Default | What it does |
|---|---|---|
| `listen_addr` | `127.0.0.1:8088` | Where to listen. Loopback, so the proxy on the same host is the only thing that can reach the port. |
| `manager_url` | *(required)* | The manager's base URL. Trailing slashes are stripped on load. |
| `manager_token` | `""` | The service token. Normally left empty here and supplied through `BILBYCAST_PORTAL_TOKEN`, which **overrides** the file. |
| `username_header` | `Remote-User` | The header the proxy puts the username in. Lower-cased on load; header lookup is case-insensitive either way. |
| `logout_url` | *(unset)* | Where "Sign out" points. Unset means no button is rendered. Not written by the installer — add it by hand. |
| `trusted_proxies` | `["127.0.0.1", "::1"]` | The peers whose username header is believed. **Empty means nobody.** |
| `player_origins` | `[]` | Origins allowed to renew a token. **Empty means no renewal at all.** Trailing slashes are stripped on load. |
| `accounts` | *(unset)* | Keep Authelia's users file in step with the manager's portal logins and send password links. See below. |
| `mail` | *(unset)* | Take Authelia's notification email and send it as the portal's own invitation or reset. See below. |

The binary takes `--config <path>` (defaulting to `portal-config.json`, which is
why the packaged unit passes `--config /etc/bilbycast/portal.json`) and
`--listen <addr>` to override `listen_addr` without editing the file. A
`--listen` value is validated on the same pass as the file.

The service token goes in the environment rather than the file, because the file
is what gets copied between hosts while someone is debugging:

```
# /etc/bilbycast/portal.env   (0600, group bilbycast-portal)
BILBYCAST_PORTAL_TOKEN=<the value the manager generated>
```

**Point `manager_url` at where the manager actually answers.** The portal
follows no redirects — not from the manager, not from Authelia, not from a
relay's origin — because following one would re-send the request, body and all,
wherever `Location` pointed. A `3xx` is handled as that service refusing; from
the manager it reaches the log as, for instance, `portal: manager refused the
stream list status=308 Permanent Redirect`.

### Optional blocks: accounts and mail

Both are optional and both are off unless present. Without them the portal runs
exactly as it did before they existed, and every Authelia account is made and
removed by hand. `mail` is only useful alongside `accounts`: without `accounts`
the portal asks for no links, so it has nothing to rewrite and relays everything
unchanged.

```json
"accounts": {
  "users_file": "/etc/authelia/users/users.yml",
  "public_host": "watch.example.com",
  "authelia_url": "http://127.0.0.1:9091/auth",
  "managed_group": "bilbycast-portal",
  "interval_secs": 15
}
```

| `accounts` key | Default | What it does |
|---|---|---|
| `users_file` | *(required)* | Authelia's `authentication_backend.file.path`. It must exist before the portal syncs; an empty file is read as no accounts. Keep it in a directory of its own — see [The users file](#the-users-file-permissions-and-two-writers). |
| `public_host` | *(required)* | The host the emailed link names, as a bare host name — no scheme, no `/`, no spaces. Surrounding spaces are trimmed. See [The link host and Authelia's address](#the-link-host-and-authelias-address). |
| `authelia_url` | `http://127.0.0.1:9091/auth` | Authelia itself, reached directly rather than through the public proxy. Its path must be the path of Authelia's own `server.address`. A trailing `/` is trimmed. |
| `managed_group` | `bilbycast-portal` | The Authelia group that marks an account as the portal's. Use it for nothing else. |
| `interval_secs` | `15` | Seconds between syncs, 5 to 3600. |

```json
"mail": {
  "listen_addr": "127.0.0.1:2525",
  "listen_password_file": "/etc/bilbycast/portal-mail-listener",
  "relay_host": "smtp-relay.brevo.com",
  "relay_username": "xxxxxxx@smtp-brevo.com",
  "relay_password_file": "/etc/bilbycast/portal-smtp-key",
  "from": "Example Notifications <noreply@example.com>",
  "sign_in_url": "https://watch.example.com",
  "brand": "Example",
  "link_lifetime": "three days"
}
```

| `mail` key | Default | What it does |
|---|---|---|
| `listen_addr` | `127.0.0.1:2525` | Where Authelia delivers: `127.0.0.1` or `[::1]` and a port. The listener speaks no TLS, and Authelia's SMTP client sends its password without TLS only to `127.0.0.1`, `::1` or `localhost`, so any other address — `127.0.0.2` included — is refused. |
| `listen_password_file` | *(required)* | A file holding the secret Authelia authenticates to the listener with: one line, no control characters, at least 32 characters (`openssl rand -hex 32`). Read once at startup and trimmed. Authelia authenticates with the same secret — normally from the same file. |
| `relay_host` | *(required)* | The SMTP relay that delivers, e.g. `smtp-relay.brevo.com`. |
| `relay_port` | `587`, or `465` with `implicit_tls` | `0` is refused, and so is `465` without `implicit_tls: true`. |
| `relay_username` | *(required)* | The relay login — for Brevo, the SMTP login it shows (`…@smtp-brevo.com`), not the account's email address. |
| `relay_password_file` | *(required)* | A file holding the relay password (Brevo's SMTP key, not an API key). Read once at startup and trimmed. |
| `from` | *(required)* | The From on every rewritten email, as `Name <address>` — the name in double quotes if it contains any of `, ( ) : ; @ [ ] \ "`. Its address must be Authelia's `notifier.smtp.sender` address, and its domain authenticated at the relay. |
| `sign_in_url` | *(required)* | Where a viewer signs in — the **portal's** address, never Authelia's login host. Named in the emails, and where the set-password page is served unless `click_through_base` says otherwise. `http://` or `https://`; a trailing `/` is trimmed. |
| `click_through` | `true` | Email the portal's own [set-password page](#the-set-password-page) instead of Authelia's link. `false` emails Authelia's link, as 0.15.0 does. Relay releases after 0.15.0. |
| `click_through_base` | `sign_in_url` | Where that page is served: the portal's `https://` address, a host alone — no path, credentials, query or fragment. A trailing `/` is trimmed. Relay releases after 0.15.0. |
| `brand` | `Bilbycast` | 1 to 64 characters, one line. Used in the wording, the header bar, the "*brand* Notifications" sign-off and the default subjects. |
| `link_lifetime` | *(unset)* | Up to 64 characters, one line. When set, the emails say "This link lasts *link_lifetime*." — so it must agree with Authelia's `identity_validation.reset_password.jwt_lifespan`, which the portal cannot read. Unset, the emails make no claim. |
| `invite_subject` | `Your <brand> account` | Up to 200 characters, one line. Blank means the default. |
| `reset_subject` | `<brand> password reset` | Up to 200 characters, one line. Blank means the default. |
| `starttls` | on, unless `implicit_tls` | STARTTLS to the relay. `false` is accepted only for a relay on this host (a loopback address or `localhost`): it sends the relay password in clear. |
| `implicit_tls` | `false` | TLS from the first byte (`submissions`, port 465) instead of STARTTLS. Refused together with `starttls: true`. |

Both secret files sit under `/etc/bilbycast`, which the unit mounts read-only
for the portal. The listener secret has to be readable by Authelia too; with
Authelia's user already in the `bilbycast-portal` group for the users file,
mode `0640` in that group does it:

```sh
openssl rand -hex 32 > /etc/bilbycast/portal-mail-listener
chown root:bilbycast-portal /etc/bilbycast/portal-mail-listener
chmod 0640 /etc/bilbycast/portal-mail-listener

install -m 0640 -o root -g bilbycast-portal /dev/null /etc/bilbycast/portal-smtp-key
# then write the relay's SMTP key into it
```

Otherwise keep two files holding the same secret: one the portal can read,
named in `listen_password_file`, and one Authelia can read, named in its
`AUTHELIA_NOTIFIER_SMTP_PASSWORD_FILE`.

### What refuses to start

Validation runs once at startup rather than per request, so a misconfigured
portal refuses to run instead of refusing every viewer with a message that looks
like their account being wrong. It bails on:

- no `manager_url`, or one that is neither `http://` nor `https://`;
- a `manager_url` carrying a `user:password@` — it never worked (the manager
  reads the Basic credential instead of the portal's token), and it would put
  the password in the startup log, which prints `manager_url`. The refusal does
  not repeat the URL:
  `manager_url cannot carry credentials (a user:password@ part): …`;
- a plaintext `http://` `manager_url` without `BILBYCAST_ALLOW_INSECURE=1` — the
  manager token rides on every request to that URL, so plaintext hands out the
  portal's service identity;
- no manager token, from either the environment or the file;
- an empty or malformed `username_header`;
- a `logout_url` that is not `http://` or `https://`;
- an **empty `trusted_proxies`** — an empty list that meant "trust all" would
  turn a typo into an open portal;
- a `player_origins` entry of `*` (a response carrying
  `Access-Control-Allow-Credentials` may not answer a wildcard), one without a
  scheme, or one carrying a path;
- an unparseable `listen_addr`.

With an `accounts` block, also on:

- no `users_file`;
- an `authelia_url` that is not `http(s)`, that carries credentials, a query or
  a fragment, or that is plain `http://` to anything but a loopback address or
  `localhost` — it carries the username of everyone being invited, and whoever
  can read it can forge the request that mails them a link;
- a `public_host` that is empty or holds a `/` or a space;
- an empty `managed_group`, or an `interval_secs` outside 5–3600.

With a `mail` block, also on:

- a `mail.listen_addr` that is not `127.0.0.1` or `[::1]`;
- no `listen_password_file` — ``mail.listen_password_file is required: …``;
- no `relay_host`, `relay_username` or `relay_password_file`;
- `relay_port` `0`, or `465` without `implicit_tls: true`; `implicit_tls`
  together with `starttls: true`; `starttls: false` to a relay not on this host;
- a `from` that will not parse — ``mail.from `…` is not an address to send from:
  write `Name <noreply@example.com>`, with the name in double quotes if it
  contains any of , ( ) : ; @ [ ] \ "``;
- a `sign_in_url` that is not `http(s)`;
- a `click_through_base` that is set but is not an `https://` host alone
  (relay releases after 0.15.0; 0.15.0 does not know the key and ignores it. A
  `sign_in_url` that could not serve the page is not an error — see
  [The set-password page](#the-set-password-page));
- a `brand`, `link_lifetime` or subject that is too long or holds a control
  character, or an empty `brand`.

Then, once validation has passed, the mail listener is bound **before anything is
served**, so these stop the portal at startup too: a port somebody else holds
(`portal mail listener 127.0.0.1:2525: …`), a listener secret that cannot be
read, is not one line or is shorter than 32 characters (`portal mail listener:
…`), and a relay key that cannot be read (`portal mail relay: …`).

The portal's own `listen_addr` (not `mail.listen_addr`) that is not loopback is
**not** an error — the proxy may legitimately be on another host — but it logs a
warning at startup, because at that point `trusted_proxies` is the only thing
left holding the boundary.

## The trust boundary

The portal authenticates nobody. It learns who you are from a header that your
forward-auth proxy sets after it has authenticated the viewer. **That header is a
claim, not a proof** — anything that can reach the portal directly can set it and
become anyone.

The peer address is checked against `trusted_proxies` **before the header is read
at all**, so a misconfiguration cannot silently downgrade to trusting everyone. A
v4 proxy arriving over a dual-stack v6 socket as `::ffff:127.0.0.1` is matched
against its v4 form, which is what stops the loopback default failing on exactly
the deployment it was written for.

Past that check, a username is accepted only if it is non-empty, at most 256
characters, and free of control characters and whitespace — the same rule the
manager applies. Anything else could not have survived a header round-trip
intact, so matching it against an entitlement would be guesswork.

### Putting Authelia in front

Any forward-auth proxy works; the portal only needs the username header. With
Caddy:

```caddyfile
portal.example.com {
    forward_auth authelia:9091 {
        uri /api/authz/forward-auth
        copy_headers Remote-User Remote-Groups Remote-Name Remote-Email
    }
    reverse_proxy 127.0.0.1:8088
}
```

That is an Authelia served at the root. One served under a path prefix
(`server.address: 'tcp://127.0.0.1:9091/auth'`) takes the prefix in every path
the proxy calls — `uri /auth/api/authz/forward-auth` — and, with account sync,
in `accounts.authelia_url` too.

Two things to get right:

1. **The proxy must strip an inbound `Remote-User`** before setting its own. A
   client that supplies one and has it passed through is a client that picked its
   own identity. Authelia's forward-auth response replaces it; make sure nothing
   in front re-adds it. This matters as much for the
   [set-password page](#the-set-password-page), which Authelia lets through
   without authenticating.
2. **Nothing but the proxy may reach `127.0.0.1:8088`.** On a shared host that
   means keeping the loopback default rather than binding the LAN address.

## Portal logins

Entitlements live in the manager, under **DVR Sessions → Portal logins**
(see [DVR Sessions](/manager/dvr/#portal-logins)). Add a username — with an
email if the portal runs account sync — then tick the feeds it may watch.

The username is matched against the identity provider's spelling **exactly** — it
is a plain SQL equality, so `A.Smith` and `a.smith` are two different people,
because they are two different identities to the IdP. What the manager knows
about the person behind it depends on how their Authelia account was made:

- **A login with an email, on a portal running account sync.** The portal
  creates the Authelia account and the person sets their own password from an
  emailed link — see [Accounts and password links](#accounts-and-password-links).
  (Not when Authelia already has a hand-made account of that name: the portal
  leaves that one alone, refuses its links, and never removes it. A login held
  back for a clash with another account gets no account either; see
  [What a sync does to Authelia's users file](#what-a-sync-does-to-authelias-users-file).)
  Removing the username's last login, in every group that grants it, removes
  the account at the portal's next sync; adding it again replaces it. So to give
  a username to a different person, **remove the login and add it again**.
  Changing the email instead keeps the account, its password and its
  entitlements — it only changes where the next link goes.
- **A login without an email, or any login on a portal without account sync.**
  The login is an entitlement against an Authelia account somebody manages by
  hand, and the manager cannot verify the name: adding one grants access to
  whoever the IdP later decides that name belongs to, so **a hand-made account
  reused for a different person inherits the previous holder's entitlements**,
  and deleting a leaver in the IdP does not delete their login here — remove it
  in the manager too.

The manager keeps one person behind one username, across every group:

- An email belongs to one username (compared without regard to case), and a
  username cannot be another login's email.
- A second group adding a username that is already a login elsewhere must give
  the **same email**, or none if it has none.
- Once a username is granted in more than one group, only a super admin can
  change its email, and the change reaches every group's login.
- An email cannot be removed once set — change it, or remove the login.

The manager accepts `a.smith` beside an existing `A.Smith`, but account sync
will not create an account whose username differs **only in case** from one
already in Authelia's file, and its password link fails with *another Authelia
account already has this username, in another case or as its email*. Give each
person a username that differs by more than case.

Only sessions in the **`active`** state are listed. A feed that is not on air is
simply absent, rather than offering a link to a black screen.

The tick list is a **replace**, not a merge: what is on screen when you save is
what is true afterwards. At most 256 feeds may be sent in one request.

### The service token

The portal authenticates to the manager with a shared service token, generated
under **DVR Sessions → Portal logins → Generate a token**.

| Property | Behaviour |
|---|---|
| Who may mint it | Super admin only — the credential is not group-scoped, so its holder can ask about any username in any group. |
| How it is produced | Generated, never typed. An operator asked to invent a machine credential invents a weak one. |
| Visibility | Shown once, in the response. The status endpoint reports only whether one is *configured*; the audit row records the rotation, never the value. |
| Rotating | Replaces the live one. The portal stops working until the new value is deployed: the manager answers the portal `401`, the portal turns any refusal into `502`, and every viewer sees **Cannot reach the manager right now** — a message about the manager, with nothing to say it is the portal's credential. Account sync stops too. So rotate deliberately. |
| Clearing | Turns the portal off outright, leaving no live credential behind. |
| None configured | The manager refuses every portal request. A manager never set up for a portal must not answer entitlement questions for whoever asks. |

## Accounts and password links

With an [`accounts` block](#optional-blocks-accounts-and-mail), the portal
**creates the Authelia accounts** for portal logins that have an email in the
manager, **removes** them when the manager deletes the login, and has Authelia
email the **set-your-password** link an operator asks for. Nobody at either end
ever sees or sets the person's password.

Every `interval_secs` the portal asks the manager for
`GET /api/v1/dvr/portal/accounts` — one row per username, with its email,
display name and any outstanding link request, plus `removed`: each username
whose last login has been deleted. It reads Authelia's users file, writes it if
anything changed, asks Authelia for the links that are due, and reports back on
`POST /api/v1/dvr/portal/accounts/link-sent` and
`POST /api/v1/dvr/portal/accounts/removed-applied`. A manager without these
routes (older than 0.87.0) answers 404, and the portal logs
`portal account sync failing; logins in the manager are not reaching Authelia`
and writes nothing.

The portal also tells the manager its interval on every poll, and why its last
pass could not write the users file when it could not. The manager's Portal
logins panel uses both: it says whether a portal is collecting the login list —
one that has not polled within three of its intervals (five minutes at least)
counts as not collecting, and while none is, no account is made and no link goes
out — and, when one is collecting but cannot write the file, shows the portal's
reason until a pass succeeds.

At startup the portal logs `syncing portal logins to Authelia`, and asks
`<authelia_url>/api/health`, where only Authelia's own `{"status":"OK"}` counts.
Authelia is expected to be late at boot — with `mail` it starts after the
portal — so the portal asks again every 10 seconds and logs one error only after
two minutes without that answer. Syncing runs meanwhile.

### What a sync does to Authelia's users file

- **A login with a usable email and no account of that name** gets one:
  `disabled: false`, its display name (or the username, when it has none), its
  email, `groups: [<managed_group>]`, and a `password` that is an argon2id hash
  of 32 random bytes nobody ever sees — so nobody can sign in to it until its
  owner sets a password through the emailed link.
- **An account carrying `managed_group`** follows the manager: its `email` and
  `displayname` are rewritten when the manager's differ. Its password,
  `disabled` and any other groups you give it are left as they are.
- **A hand-made account** — any entry without `managed_group`, including one
  with the same name as a manager login — is **never rewritten or removed**, and
  a link asked for one is answered with a reason instead of being sent. An entry
  whose key YAML reads as something other than text — an unquoted `12345:` — is
  never the portal's, whatever its groups say.
- **A username the manager removed and gave out again** is a different person
  under the same name, and its managed account is **replaced** (see below).

A login with no email, or one that is not a plausible address, simply gets no
account. Three kinds of login are held back as well, each logged once as
``portal login `<name>` was not written to Authelia: <reason>``:

- one whose email another account already has, as its email or as its username,
  compared without regard to case;
- one whose username another account already has in another case, or has as its
  email;
- `<<`, which Authelia's parser reads as a YAML merge key, or any username that
  would not read back as the same text. Others that YAML would misread are
  written quoted (`'12345':`, `'true':`), so a staff or membership number works
  as a username.

These rules exist because, with `search.email` on (which account sync
requires), Authelia refuses the **whole file** when two accounts share an email
or one's email is another's username — hand-made accounts included — and a
refused file locks everyone out the next time Authelia starts. The check is made
against the file as this cycle's write will leave it, so two accounts can swap
addresses in one write. A login held back has its link request answered with
the reason, and the way does not clear by itself: change the logins in the
manager, or the hand-made account in the file, and press **Send password link**
again.

### Removing and replacing accounts

An account is removed **only when the manager says the login is gone**: the
username is in the answer's `removed` list. The manager records that by itself
whenever a username's last login goes, by any path — a delete, a group removal —
and keeps the record until the portal acknowledges it. Being missing from the
list is not enough: a database restored from an older backup is missing
everything created since, and deleting an account takes the password its owner
chose with it.

| The removed username… | What the portal does |
|---|---|
| is not a login any more | Removes the managed account. |
| is a login again — deleted and re-added, in this group or another, before the portal applied the removal | **Replaces** the managed account: drops it and makes it afresh with a new unusable password and the current email and name, in one write. The last holder's password no longer works; the new holder sets their own from the invitation, which goes out on a later cycle. |
| has no managed account — none, or a hand-made one | Nothing. |

A removal is acknowledged only once a later read of the file still shows it
applied. Authelia rewrites the whole file from what it has loaded whenever
anyone sets a password, so a password set in the moment before it reloads can
put a removed entry back; the next cycle notices, logs ``Authelia wrote back an
account the portal had removed or replaced …``, and applies the removal again.
The manager prunes a record nobody acknowledges after 90 days, so a portal that
does not poll for that long never removes that account — remove it by hand.

:::caution[Removing or replacing an account does not sign anyone out]
Authelia ends a signed-in session only when its user has gone from the file or
been disabled, and only when that session next makes a request after its
profile refresh. An account made afresh under the same username is neither, and
a session left idle through a plain removal is never checked while the account
is gone — so it is honoured again if the username is given out later. Either
way, a session the last holder already has open keeps reaching the portal as
that username until it expires — up to a month with Authelia's default
remember-me — and is served the new holder's feeds.

The portal cannot reach Authelia's sessions. Each time it replaces an account it
logs a warning beginning ``replaced the Authelia account `<name>` for the
login's new holder``, and each time it removes one it logs the same remedy at
info level: clear Authelia's sessions — restart Authelia when it keeps them in
memory (its default, without `session.redis`), or delete them from its Redis.
Either signs every viewer out. Where you can, give a new person a username
nobody has had.
:::

A manager **backup restore** records no removals: a login added after the backup
was taken is gone from the manager, but its Authelia account and password stay.
Before that username goes to anyone else, delete its account from Authelia's
file by hand, or add it as a login with no email and no feeds and remove it
again, which records the removal the portal acts on. A username the archive
holds with a different email than it has had since the backup is the same
story: the portal rewrites its account back to the old address and keeps the
current password, so the next link goes to the old address. Remove every
group's login for that username (a super admin in All groups) and add it again.

### Password links

An operator presses **Send password link** on a login in the manager (adding a
login with an email asks for one straight away). The manager offers the request
to the portal for **24 hours**; after that it shows it as expired and the
operator presses the button again, so a link asked for while no portal was
collecting cannot go out weeks later.

The portal asks Authelia for the link only when all of this holds:

- **The account is one the portal manages.** A hand-made account's request is
  answered with a reason.
- **Its entry already held the manager's email when the cycle began.** Authelia's
  reset endpoint answers OK for any username and mails whatever address it has
  loaded. So an account created this cycle, or whose email this cycle rewrites,
  waits for the next one, by when Authelia has reloaded the file — and the link
  goes to the new address, not the one it replaced. A new login's first email
  therefore arrives within about two `interval_secs`.
- **This cycle's write landed**, for an account the write was going to create
  or change. A write that failed, or was abandoned because Authelia changed the
  file first, holds those accounts' links for a later cycle.
- **Authelia is not rate-limiting.** It limits these requests per client
  address — by default 5 in 10 minutes — and every request the portal makes
  comes from `127.0.0.1`. On a `429` the request stays *requested*, no more are
  asked for that cycle (nor until Authelia's `Retry-After`, capped at an hour),
  and the log says once `Authelia is rate-limiting password links; the rest
  wait for a later cycle`. If you send links in batches, raise
  `server.endpoints.rate_limits.reset_password_start` in Authelia.

The request is Authelia's own `POST <authelia_url>/api/reset-password/identity/start`,
sent as if forwarded for `public_host`. The person follows the emailed link and
chooses a password on Authelia's reset page. Each request is served once per
portal process; a link that failed is not retried by the portal — press **Send
password link** again, which is a new request. A portal restarted between
sending a link and getting its acknowledgement through sends that link again.

**What "sent" means** on the manager's list:

- **Without `mail`:** Authelia answered `{"status":"OK"}`. Authelia reports its
  own failures — its notifier, its storage, a `public_host` outside its cookie
  domains — as `200` with `{"status":"KO"}`, and those come back as the reason.
  Whether the mail then reached an inbox is between Authelia and its SMTP relay.
- **With `mail`:** the SMTP relay accepted the rewritten message (`250`) within
  20 seconds — accepted for delivery, not delivered. The portal waits up to 30
  seconds for Authelia's email to reach its listener and for the relay to answer.

### What the manager shows

Each login's row says where its link stands: *requested* (waiting for the
portal's next sync; a brand-new account takes two), *sent* with a time,
*failed* with the reason, or *expired*. A reason is one line of at most 300
bytes:

| When | The reason |
|---|---|
| The username is a hand-made Authelia account | `this username is an Authelia account managed by hand; the portal only sends links for accounts it created` |
| The login has no email, or one the portal cannot use | `this login has no email the portal can use, so no link was sent` |
| Another account has the email, as email or username | `another Authelia account already uses this email, or has it as its username, so the portal did not write it` |
| Another account has the username, in another case or as its email | `another Authelia account already has this username, in another case or as its email, so the portal did not create it` |
| The username cannot be a key in the file | `this username cannot be written into Authelia's user file as it is, so the portal did not create it` |
| Authelia answered `{"status":"KO"}` | `Authelia could not send the link: <Authelia's message> (see Authelia's log)` |
| Authelia answered another error status | `Authelia refused the request (<status>)`, with Authelia's message when it gave one |
| Authelia's answer was not its JSON | `Authelia sent a reply the portal could not read` |
| Authelia could not be reached | `could not reach Authelia: <error>` |
| With `mail`: nothing arrived within 30 s — usually Authelia's email never reached the listener | `timed out waiting for Authelia's email; check that Authelia's notifier points at mail.listen_addr, authenticates with mail.listen_password_file, and sends from mail.from's address` |
| With `mail`: the listener dropped the request before its email arrived | `the portal never saw the email Authelia was asked to send` |
| With `mail`: the relay refused the message | `the mail relay refused it: <the relay's error>` |
| With `mail`: the relay did not answer | `the mail relay did not answer within 20s` |

When the portal cannot write the users file at all — it cannot be read or
parsed, an entry would not survive a rewrite, the replacement would lock
Authelia out, or the write fails — no single login's request says why, so the
reason appears in the Portal logins panel instead. It is the same text the
portal logs with `portal account sync failing; logins in the manager are not
reaching Authelia`, beginning, for instance, `cannot read …`, `cannot parse …`,
`not rewriting …`, `not replacing …` or `cannot write …`.

### The link host and Authelia's address

**`public_host`** is the host the emailed link names. Authelia builds the link
from the forwarded host and its own path, so it must be a host Authelia's pages
are served on: the portal's host when Authelia sits under a path there
(`watch.example.com`, links to `https://watch.example.com/auth/reset-password/…`),
otherwise Authelia's own login host. A host outside Authelia's cookie domains
gets `{"status":"KO"}`, shown as `Authelia could not send the link: …`.

**`authelia_url`** has Authelia's API paths appended to it, so **its path must
be the path of Authelia's own `server.address`**. The default,
`http://127.0.0.1:9091/auth`, matches an Authelia served under `/auth`. For an
Authelia served at the root, drop the path: `http://127.0.0.1:9091`. A wrong
path shows up at startup, after two minutes, as ``Authelia's health check did
not answer at accounts.authelia_url (<status>, and not Authelia's own OK); its
path must be the path of Authelia's own server.address, and every password link
will fail until it is`` — or, with nothing listening, ``could not reach Authelia
at accounts.authelia_url (<error>); password links will fail until it answers
there``. The opposite mistake — an Authelia under `/auth` with the path left
off — passes the health check and shows up as links naming the wrong path.

**`managed_group` belongs to the portal alone.** Any account carrying it is
treated as the portal's — its email and name overwritten from the manager, and
removed when the manager reports its username removed — so do not add it to an
account you made by hand. It is also the natural group to grant the portal on in
Authelia; give hand-made accounts that should reach the portal a group of their
own (see the access-control rules below).

### What Authelia needs

```yaml
authentication_backend:
  password_reset:
    disable: false
  file:
    path: /etc/authelia/users/users.yml
    watch: true             # required: reload when the portal replaces the file
    search:
      email: true           # required: sign in with the email as well as the username

identity_validation:
  reset_password:
    jwt_lifespan: '3 days'  # how long a link lasts; the default is 5 minutes

access_control:
  default_policy: deny
  rules:
    # Relay releases after 0.15.0 only, and only with `mail`: the set-password
    # page. Anchored, and BEFORE the portal's own rule.
    - domain: 'watch.example.com'
      resources:
        - '^/set-password([?].*)?$'
      policy: bypass
    - domain: 'watch.example.com'
      subject:
        - 'group:bilbycast-portal'   # every account the portal created
        - 'group:portal-staff'       # hand-made accounts you let in yourself
      policy: one_factor
```

- **`watch: true`** — without it Authelia does not see a new account until it
  restarts, and every link asked for one is answered OK and sent nowhere.
- **`search.email: true`** — the emails tell people to sign in "with your email
  address or your username", and the uniqueness rules above exist so the file
  stays loadable with it on. Check your hand-made accounts for shared emails
  before turning it on.
- **`jwt_lifespan`** — how long a link works. Five minutes is too short for an
  invitation somebody reads the next morning. With `mail`, `mail.link_lifetime`
  must say the same in words, or be left unset.
- **The bypass rule** is needed only for the
  [set-password page](#the-set-password-page). It names that one path,
  anchored, so that nothing else on the host is let through unauthenticated.
- **The notifier.** Without a `mail` block Authelia mails your SMTP relay
  itself — any relay works, configured in Authelia's `notifier.smtp` as usual
  (for Brevo: `submission://smtp-relay.brevo.com:587`, the SMTP login as
  username, the SMTP key through `AUTHELIA_NOTIFIER_SMTP_PASSWORD_FILE`). With a
  `mail` block, Authelia mails the portal instead — see
  [Authelia's notifier with mail](#authelias-notifier-with-mail).

Either way, **authenticate the sending domain at the relay** (its verification
record, DKIM, and a DMARC record), or the links go to spam — and for a password
link, spam is the same as broken. Send a test to each mail provider your viewers
actually use before trusting it.

### The users file: permissions and two writers

Authelia rewrites the file whenever someone sets a password; the portal writes
it only when something changed. There is no lock the two share, so the portal
writes a temp file beside it (`.users.yml.portal-tmp`, created `0600` because it
holds password hashes, then given the old file's permission bits and group),
checks just before the rename that the file has not changed since it was read,
and abandons the write if it has (`Authelia changed its user file mid-sync;
retrying next cycle`). A password Authelia writes in the instant of the rename
itself can still be lost.

The portal must be able to replace the file, and Authelia must still be able to
read and write it afterwards. Replacing a file needs write permission on its
directory, so keep it in **a directory of its own**, owned by Authelia, in the
portal's group, setgid so every file made there takes that group:

```sh
install -d -o authelia -g bilbycast-portal -m 2770 /etc/authelia/users
mv /etc/authelia/users_database.yml /etc/authelia/users/users.yml   # your current users file
chown authelia:bilbycast-portal /etc/authelia/users/users.yml
chmod 660 /etc/authelia/users/users.yml
usermod -aG bilbycast-portal authelia
```

Then point `authentication_backend.file.path` at the new location, **restart
Authelia** (a process picks up a new group only when it starts) and **restart
bilbycast-portal** (its unit's `ReadWritePaths=` is applied at start).
Substitute the user Authelia really runs as for `authelia`. The portal also
needs to pass through `/etc/authelia` itself (execute permission), but nothing
else there needs to be readable by it.

After the portal's first write the file belongs to `bilbycast-portal`, so
Authelia reaches it only through the group. The portal **refuses a write that
would lock Authelia out**, and each refusal names its fix: give the file a group
the portal is in (`chgrp`), let the group read and write it (`chmod g+rw`), or
put Authelia's user in that group (`usermod -aG …`, then restart Authelia). That
last check reads this host's `/etc/passwd` and `/etc/group` only. A root-owned
`0644` file in root's group is replaced as it is.

A rewrite drops comments, blank lines and quoting style — the file is parsed and
written out again — and writes YAML anchors out in full. String values survive;
a value YAML would read as a number or a boolean would not, so a hand-made entry
holding an unquoted number, a `true` / `false` anywhere but `disabled`, or a key
that is not text, **stops every write** until it is quoted, and the log names it:
``not rewriting <file>: the account `<name>` has an unquoted number or true/false
in `<field>`, which rewriting the file would change; quote it in the file``.

**systemd.** The packaged unit lets the portal write `/etc/authelia/users` and
nothing else. A `users_file` anywhere else needs its own drop-in — never an edit
to the unit, which the installer and `upgrade-relay.sh` replace:

```sh
systemctl edit bilbycast-portal
#   [Service]
#   ReadWritePaths=/srv/authelia/users
systemctl restart bilbycast-portal
```

A write blocked this way fails with a read-only-file-system error naming that
drop-in. Nothing under `/home` or `/tmp` can work: the unit's `ProtectHome=` and
`PrivateTmp=` hide them. **A custom unit that denies `@privileged` must add
`SystemCallFilter=@chown` after the deny**, or the portal is killed the first
time it restores the file's group.

**Docker.** An Authelia container that runs with `user:` needs the
`bilbycast-portal` group's numeric id in its `group_add:`; one running as root
needs none. If a host user shares the container's uid (typically 1000), add that
user to the `bilbycast-portal` group too, or the `/etc/passwd` check refuses the
write. **Mount the directory, not the file**: a
bind mount of a single file keeps showing the file it was made with, so Authelia
would never see the portal's change, and its own writes would go to the orphan.

## Rewriting Authelia's email

Authelia sends one email for "set your first password" and "I forgot my
password" — one subject, one body, one link lifetime — because it cannot tell the
two apart. The manager can: it knows whether a link for this person has ever been
sent. So with a [`mail` block](#optional-blocks-accounts-and-mail), Authelia is
pointed at an **SMTP listener inside the portal** on loopback instead of at the
relay, and a message the portal has just asked for is rewritten — an
**invitation** for a first link, a **password reset** otherwise — around
Authelia's own link, then sent through the relay named in `mail`. The relay
login and key move from Authelia to the portal.

The portal cannot mint the link itself: it is a token Authelia signs *and*
records, and one minted anywhere else is refused. Taking Authelia's message is
the only way to put other words around it.

At startup the portal logs `rewriting Authelia's notification email`.

### What is rewritten, and what is not

Only a message to somebody the portal has just asked a link for, matched by
recipient address (without regard to case) within 30 seconds of the request.
**Everything else Authelia sends is relayed byte for byte** — including a
viewer's own "Reset password" from Authelia's sign-in page, and Authelia's own
notices.

The rewritten email is plain text with an HTML alternative, addressed to and
greeting the login's display name (the username when it has none). The
invitation says they have been given access to *brand* live and recorded video,
asks them to choose a password, and tells them to sign in at `sign_in_url`
"with your email address or your username". The reset says somebody asked to
reset the password on their *brand* account. Both carry the link — the
[set-password page](#the-set-password-page)'s address in relay releases after
0.15.0 with `click_through` on, Authelia's own otherwise — the lifetime sentence
when `link_lifetime` is set, and sign off "*brand* Notifications".

If the rewrite cannot be composed, or Authelia's message holds no link the portal
can find, Authelia's message is relayed unchanged — the person still gets their
link, in Authelia's words.

**What "sent" means with `mail`.** Authelia treats a message as sent the moment
the listener answers `250`, and will not send it again; the relay is tried
afterwards, for at most 20 seconds. For a link the portal asked for, the relay's
answer is what the manager is told. Mail nobody here asked for has nobody to
report to, so a relay failure on it is only an error in the portal's journal:
``could not relay an email Authelia sent; Authelia was told it was accepted and
will not send it again``.

### Authelia's notifier with mail

```yaml
notifier:
  smtp:
    address: 'smtp://127.0.0.1:2525'
    username: 'authelia'
    sender: 'Example Notifications <noreply@example.com>'
    disable_require_tls: true
```

```ini
# /etc/authelia/authelia.env
AUTHELIA_NOTIFIER_SMTP_PASSWORD_FILE=/etc/bilbycast/portal-mail-listener   # = mail.listen_password_file
```

- **`address`** names `mail.listen_addr` — `127.0.0.1` or `::1` as written
  there, or `localhost` where that resolves to it — and its port.
- **`username`** can be any non-empty name; the listener checks only the
  password. Without a username Authelia does not authenticate at all, and the
  listener refuses its mail.
- **The password** is the secret in `mail.listen_password_file`. A trailing
  newline in the file is fine.
- **`sender`'s address must equal `mail.from`'s address** (case aside; the
  display names may differ). Any other sender is refused with `550`, and the
  portal logs ``refused mail from a sender other than mail.from; Authelia's
  notifier.smtp.sender must carry the same address``.
- **`disable_require_tls: true`** — the listener offers no STARTTLS; the
  conversation never leaves the host.
- **`subject`**, if you keep one, applies only to mail passed through unchanged.
- **Remove** Authelia's old relay address and password file.

Authelia's notifier startup check runs the whole exchange against the listener,
and a failure stops Authelia, so an Authelia that starts is one the listener
accepts: a wrong password (`535`) or sender (`550`) shows in Authelia's own log
at once. The portal logs a failed `AUTH` too: ``a client failed to authenticate
to the notification mail listener; if it was Authelia, its notifier.smtp
password is not the secret in mail.listen_password_file``.

### The listener's limits

It speaks enough SMTP for Authelia and nothing more. `AUTH PLAIN` or `AUTH LOGIN`
is required before `MAIL`, `RCPT` or `DATA` (`530` otherwise), within 10 seconds
and 6 commands; three failed `AUTH`s or unrecognised commands close the
connection. It takes 16 connections at once — when full, the oldest one that has
not authenticated is closed to make room, so idle local sockets cannot keep
Authelia out — 60 seconds per session, 30 seconds idle, one recipient per message,
64 KiB per line and 1 MiB per message, and 8 messages waiting on the relay
(past that, `DATA` is answered `451`). A line that looks like HTTP closes the
connection.

### Startup and ordering

If the listener or the account sync ever stops or panics after startup, the whole
portal exits non-zero and systemd restarts it, rather than serving viewers while
links quietly stop. Authelia's startup check needs the listener up, so **start
Authelia after the portal**:

```sh
systemctl edit authelia
#   [Unit]
#   After=bilbycast-portal.service
#   Wants=bilbycast-portal.service
```

A restart of the portal leaves a few seconds in which Authelia's mail — a
viewer's own reset included — has nowhere to go.

## The set-password page

*Relay releases after 0.15.0, with both `accounts` and `mail`.*

Authelia's set-password link is **one-time**, and the page it points at submits
the token as soon as it loads. Mail security that opens links to check them
therefore *spends* the link: an invitation to a Microsoft 365 mailbox was
consumed by a Microsoft address seconds after delivery, and its owner was told
the token "may have expired" two minutes later. Every recipient behind that kind
of filtering hits it, and it reads as expiry rather than what it is.

So the rewritten email points at a page the portal serves,
`<click_through_base>/set-password`, carrying Authelia's URL as a parameter.
The page:

- **does nothing on `GET`** but render HTML — a scanner that fetches it, follows
  it or renders it with JavaScript spends nothing;
- holds Authelia's URL **percent-encoded in a hidden field**, so there is no
  URL-shaped string for a scraper to pull out and no `<a>` to follow; and
- moves on only when somebody presses **Set your password**, a form `POST` that
  the portal answers with a `303` to Authelia's reset page.

It is a bounded defence: a scanner that submitted forms, or decoded the `u`
parameter and fetched what it found, would still spend the link. None of the
ones that cause this do either. And it covers only the links the portal asks
for — a viewer who uses "Reset password" on Authelia's sign-in page gets
Authelia's own email and link, which a scanner can still spend; for someone
behind that kind of filtering, send the link from the manager instead.

**The page is not an open redirect.** It follows a URL only when it is Authelia's
reset page (`…/reset-password/step2`), over `https`, on `accounts.public_host`,
with a token and no credentials or fragment, at most 2048 bytes. Anything
else answers `400`.

**Authelia must let the page through unauthenticated** — the person following
the link has no password yet. That is the `bypass` rule in
[What Authelia needs](#what-authelia-needs): `^/set-password([?].*)?$` on the
portal's host, **ahead of** the portal's `one_factor` rule, naming that path and
nothing else. A bypassed request gets no `Remote-User`: the page reads no
identity, and everything else must stay behind Authelia. Without the rule the
link lands on Authelia's sign-in page, which the person cannot get past (they
can still use "Reset password" there) — and the manager still shows it *sent*.
Once the rule is added, a link already in someone's inbox works, as long as
Authelia's link lifetime has not run out.

The portal cannot see Authelia's rules, so with the page in use it says so at
every start:

```
password links point at the set-password page: Authelia needs a `policy: bypass` rule for `^/set-password([?].*)?$` ahead of the portal's own, or they land on the sign-in page
```

**When it falls back to Authelia's own link.** The same checks run before each
email is written, and an email pointing at a page that cannot work is worse than
the problem the page solves. So the link goes out as Authelia wrote it, with the
warning `emailing Authelia's own link, not the set-password page` and the reason,
when:

- Authelia's link is one the page would refuse;
- `click_through_base` — or `sign_in_url`, which it defaults to — is not an
  `https://` host alone (a `click_through_base` you set that way stops the
  portal at startup; a `sign_in_url` only causes the fallback);
- that host is where Authelia's links are at the root, so `/set-password` there
  would be Authelia's — because `sign_in_url` (or `click_through_base`) names
  Authelia's host rather than the portal's, or because `accounts.authelia_url`
  is missing the path Authelia is served under.

The startup check applies the same conditions, so in those cases it warns
instead: `password links go out as Authelia wrote them, where a mail scanner can
spend them`. `"click_through": false` turns the page off and emails Authelia's
link with no warning.

**Keep `/set-password` out of the proxy's access log.** Its query carries a
one-time credential that stays live until the button is pressed or Authelia's
`jwt_lifespan` runs out — and a scanner's visit no longer spends it. Caddy writes
no access log unless told to; with a `log` directive, add `log_skip
/set-password` (Caddy 2.8 and later; `skip_log` before). On nginx, give it a
`location = /set-password` with `access_log off;` and the same proxy and auth
configuration as the rest.

## Upgrading a portal that already runs account sync or mail

`upgrade-relay.sh` swaps the portal binary, refreshes the packaged unit file
(see [Upgrading](#upgrading)) and starts the portal again if it was running; it
never touches `portal.json` or Authelia. Make these changes **before** the upgrade.

**To a relay release after 0.15.0** — every portal with both `accounts` and
`mail`:

1. **Let the set-password page through Authelia.** Password links now point at
   the portal's `/set-password` page, and Authelia must answer that path with
   `policy: bypass`, in a rule ahead of the portal's own:

   ```yaml
   - domain: 'watch.example.com'
     resources:
       - '^/set-password([?].*)?$'
     policy: bypass
   ```

   Without it every new link lands on the sign-in page, and the manager still
   shows it sent. To keep emailing Authelia's own link instead, set
   `"click_through": false` in `mail`. `upgrade-relay.sh` prints this reminder
   when `/etc/bilbycast/portal.json` has `accounts` and a `mail` block that
   does not name `click_through`. It reads that file only, so a portal run with
   another config gets no reminder.
2. **Check `sign_in_url`** is the portal's own `https://` address, or set
   `click_through_base` to it; otherwise the links go out unwrapped, with a
   warning (see [The set-password page](#the-set-password-page)).
3. **Keep `/set-password` out of the proxy's access log.**

**From a build that predates relay 0.15.0** — account sync and `mail` existed in
earlier, unreleased builds, which took a config 0.15.0 refuses and worded their
emails differently. Steps 1, 4 and 5 decide whether the new binary starts at
all. A portal that refuses its config exits, and systemd retries it every 3
seconds until its start limit trips. The script checks only once, right after
starting it, so after the upgrade confirm with
`systemctl status bilbycast-portal` / `journalctl -u bilbycast-portal -e`. The
rest decide whether it goes on working as it did:

1. **Create the listener secret** and name it in `mail` as
   `listen_password_file` — it is now required (see
   [Optional blocks](#optional-blocks-accounts-and-mail)).
2. **Keep the wording you have.** The earliest of those builds wrote a fixed
   brand into every email, and their subjects defaulted to that brand's wording
   unless `invite_subject` / `reset_subject` were set (those two keys still work
   as before). The defaults are now "Bilbycast", `Your Bilbycast account` and
   `Bilbycast password reset`. Set `brand`, and any subject you never set
   yourself, to what your viewers have been getting.
3. **Say how long a link lasts only if it is true.** Earlier emails said "This
   link lasts three days" whatever Authelia did. Set `link_lifetime` to match
   Authelia's `jwt_lifespan`, or leave it out.
4. **Check `mail.from`, `mail.listen_addr` and `mail.relay_port`.** `from` must
   parse as `Name <address>`; `listen_addr` must be on `127.0.0.1` or `[::1]`;
   `relay_port: 465` needs `"implicit_tls": true`.
5. **Check `accounts.authelia_url`.** The default is unchanged. A URL carrying
   credentials, a query or a fragment is now refused, and so is a plain
   `http://` URL to anything but a loopback address or `localhost`
   (`accounts.authelia_url may only be http:// on this host; use https:// for
   an Authelia anywhere else`).
6. **Give Authelia's notifier a username and the password**, as in
   [Authelia's notifier with mail](#authelias-notifier-with-mail), turn on
   `search.email: true` (checking hand-made accounts for shared emails first),
   and add the `After=` / `Wants=` drop-in to `authelia.service`.
7. **Move edits of the unit file into a drop-in.** On a unit the script leaves
   alone, add `ReadWritePaths=` for the users directory and
   `SystemCallFilter=@chown` after any line denying `@privileged` yourself, then
   `systemctl daemon-reload`.
8. **Check the users file's permissions** against
   [The users file](#the-users-file-permissions-and-two-writers): the portal now
   refuses a write that would leave Authelia unable to reach the file.
9. **The set-password steps above**, when going straight to a release after
   0.15.0.

Then upgrade, and **restart Authelia once the new portal is running**: the earlier
listener offered no `AUTH`, so an Authelia configured to authenticate fails its
startup check against it, and an Authelia still on the old notifier config has its
mail refused by the new listener with `530`. The window between the two restarts
is the only time mail fails.

Three behaviours change without any config:

- **Removal needs the manager's word.** With manager 0.87.0 or later, an
  account is removed only when its username is in the manager's `removed` list,
  and absence alone no longer removes anything. Upgrade a pre-release manager
  build too: against a manager that sends no `removed` list, the portal still
  removes by absence (though an empty login list removes nobody).
- **Links go only to accounts the portal made**, and only once the file holds
  the manager's address.
- **A username given out again is a new account**, replaced with a new unusable
  password; earlier builds kept the account and its password. A session the last
  holder has open is not ended — see
  [Removing and replacing accounts](#removing-and-replacing-accounts).

## What a viewer sees

A page headed **Your feeds**, with "Signed in as *username*" beside it and a
**Sign out** link only when `logout_url` is set. Below it, one row per entitled
on-air feed — the feed's name and a **Watch** button — and a note that opening a
feed gives thirty minutes of access at a time: where renewal has been set up the
player extends that itself while they keep watching (see **Renewal, and the
origin gate** below); if it reports expired access instead, they come back here
and open the feed again.

**Watch** posts the *session* id to the portal, which asks the manager to mint,
and follows the returned URL **in the same tab** (a token-bearing URL opened with
`window.open()` gets blocked as a popup often enough that the failure would read
as the feed being broken). The viewer arrives at the relay's DVR page with
`?token=…`, plus `&hold=…` — an opaque id for this device, see **One viewing
session per login** below — and `&from=…`, this page's own origin, which the
player's back-to-feeds button honours only when it matches the relay's
configured `portal_url` and otherwise ignores.

With nothing entitled and on air, the page says so in one message. Distinguishing
"you have none" from "none are on air" would need the manager to report
entitlements for feeds it has decided not to show, which is precisely the oracle
the API declines to be: a viewer with no entitlement, a session that does not
exist, and a session that is not running all produce **one identical refusal**.

The feed list is rendered with `createElement` and `textContent`, and the page is
served with a `script-src 'self'` CSP — which is why the script is its own route
rather than an inline block.

## What a viewing token admits

A viewer token is an HMAC over `(scope, streams, expiry)`, signed by the manager
with the distribution `token_secret` — one secret, pushed to every distribution
relay it configures. There is no per-viewer state on the relay,
so **the list of streams travels inside the token**:

| Form | Shape |
|---|---|
| One stream | `{exp}.{hmac}` |
| Several | `{exp}.{stream,stream,…}.{hmac}` — sorted and de-duplicated, so the same set always mints the same token |

The HMAC covers that list, so adding a name to it invalidates the signature. A
one-element token is byte-identical to the older single-stream form, which is
what keeps already-issued WHEP tokens valid.

Two rules follow, and they are what makes the DVR player work off one credential:

- A token minted for `show` **also admits `show-proxy`** — its derived
  low-resolution rendition. The converse does not hold: a token minted for
  `show-proxy` admits only `show-proxy`.
- The manager mints a portal token over **both** of a session's stream ids, so the
  player fetches the main rendition and the proxy off the one credential.

A portal-minted token lasts **thirty minutes** — much shorter than the three
hours a token exchanged from a one-off link gets, because a viewer who came
through the portal renews (see below) and a link viewer cannot. The player
strips it, and the holder id beside it, from the URL on load — a viewer copying
the address bar should not hand out their credential —
and keeps it in `sessionStorage` for the life of the tab, so a reload, a
back-navigation or a restored tab does not report expired access that has not
expired. A token the origin refuses is forgotten, so one refusal cannot become a
loop that survives every reload.

When it does run out, the player offers a link straight back to **that feed** —
`{portal}/watch?stream={id}` — rather than to the portal's front page. The portal
already knows who they are, so recovering is one tap. A stream the viewer is not
entitled to and one that does not exist both land back on the front page, with no
hint of which.

## Renewal, and the origin gate

Thirty minutes does not cover a match plus its build-up, and the failure would
arrive before half-time. So the player renews itself **600 seconds before
expiry**, by calling `GET /api/renew?stream=…&held=…` on the portal — which puts
the entitlement re-check on a twenty-minute cadence.

That renewal goes back through the manager exactly as the first mint did, and
**the manager re-checks the entitlement before it signs**. That is what keeps a
short expiry meaningful: it is revocation latency, not a countdown. A renewal
that skipped the check would quietly turn "access lasts thirty minutes" into
"access lasts as long as the tab is open".

Renewal needs **two** settings, on two different services, and either one missing
disables it silently:

| Where | Setting | If it is missing |
|---|---|---|
| Relay | `distribution.portal_url` (the manager's **Viewer portal URL** field) | The player schedules no renewal at all, however the portal is configured. The thirty minutes become a hard limit. |
| Portal | `player_origins` | The renewal request is refused `403`, and the viewer loses access mid-event. |

`install-relay.sh --player-origin https://relay.example.com` writes the second one
for you; without it the installer prints a note saying tokens will not renew,
because the failure is otherwise silent.

The origin gate is a real CSRF boundary, not a formality: the renewal is a
cross-origin request carrying the viewer's session cookie. So:

- Matches are **exact**, never a prefix, and `*` is refused at startup.
- The origin is checked **before anything is done**, so an unlisted one cannot
  even cause a mint.
- Every exit *past* that check carries the CORS headers, refusals included — the
  origin is already trusted by then, and withholding them only turns a clear
  `403` into an opaque browser error. Responses also carry
  `Cache-Control: no-store` (the body is a credential) and `Vary: Origin`.

A failed renewal retries with a widening gap — 30 s, doubling to a 300 s ceiling —
and never past the token's own expiry, after which the expired-access link is the
honest answer. **Only a viewer who came through the portal can renew**, because
only they hold the session cookie; a guest on a one-off link cannot, and should
not — their three hours are the point of the link.

Removing a portal login stops that user getting *new* tokens immediately. A token
already in a browser keeps working until it expires: the relay verifies a
signature and an expiry and holds no per-viewer state to revoke. Thirty minutes
is the outer bound on how long a withdrawal takes to bite: the player renews ten
minutes early, so the manager re-checks the entitlement every twenty minutes,
and a refused renewal does not recall the token in hand — it runs out its
remaining ten minutes. A withdrawal therefore lands somewhere between ten and
thirty minutes after it is made.

## One viewing session per login

Pressing **Watch** — or following the player's `/watch?stream=…` link back —
*claims* the login. The manager records this device under an opaque holder id
(a random UUID, deliberately not the token: two tokens minted in the same second
for the same streams are byte-identical and cannot tell two devices apart),
hands it to the player as `&hold=…` beside the token, and the player presents it
back as `&held=…` on every renewal and every beat.

The record is keyed by **username**, not by username and feed, so one login is
one device on one feed at a time: opening a second feed, or the same feed on a
second device, displaces the first, and the newest device wins. A renewal from
the displaced device is answered `409` (`session_taken_over`); the player
forgets its token, pauses, and shows *This login is in use on another device.
Only one at a time.* with a link back to the feed, which takes the login back.
The displaced picture runs until that renewal, not mid-sentence, so the wait is
bounded by the token's remaining life. Claims, renewals and displacements land
in the manager's audit log.

Mints made only as a permission check — the three clips routes below — claim
nothing, so a clip poll cannot displace the viewer's own player. A renewal that
arrives without a holder is treated as a fresh Watch, so an older player keeps
its feed by retaking the login.

The beat, not the renewal, is what feeds the manager's "who is watching" count:
a renewal arrives every twenty minutes, a beat every minute (the cadence travels
in each reply as `next_beat_secs`, so it is the manager's to change), and a
viewer whose beats stop is dropped from the count after 150 s. It rides the same
two settings as renewal — `distribution.portal_url` on the relay and
`player_origins` on the portal — and without them no beat ever lands, so the
manager falls back to counting whoever holds a live token, which keeps a closed
tab in the count until its token runs out. Its DVR Sessions page says so rather
than asserting silence: the count is marked approximate, with a note that this
relay's player is not sending heartbeats.

## Exports

Once there is a clip on any feed the viewer may reach, the page grows an
**Exports** table — hidden until then, so someone whose feeds carry no clips is
not shown an empty shelf. It lists every clip cut from the player's Marks panel
on every feed the user may reach, newest first, with a download link that goes
through the portal and a delete button; a clip still being cut is listed too,
marked not ready, so an operator who has just pressed Export sees that something
is happening. Clips are kept for **24 hours after the feed stops**, on the
manager's clock (`clips_expire_at`, set when the session stops), and the
manager's expiry sweep is what removes them — which is why a stopped feed with
clips still appears here for a day, though never as something to watch. The
relay's own sweep is only a backstop for a manager that never comes back:
half-written uploads and media with no record beside it after an hour, and
anything older than seven days. A clip belongs to the session, not to whoever
exported it: anyone entitled to the feed can see it, download it and delete it.
While a cut is still pending the page re-asks every five seconds for up to ten
minutes from the last page load; a failed poll keeps asking, and only "nothing
pending" from the server stops it.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | The page. Served `no-store`, with `X-Frame-Options: DENY` and a `script-src 'self'` CSP. |
| `GET /portal.js` | Its script — a separate route so the page can carry that CSP. |
| `GET /api/feeds` | What the signed-in user may watch, plus their username and `logout_url`. |
| `POST /api/watch` | Mint a link for one feed. The body names the **session**; the username comes from the header and can never be supplied by the browser. Pressing Watch *claims* the login (see above). |
| `GET /watch?stream=…` | One tap back to a feed whose credential ran out — re-mints (claiming the login afresh) and redirects. This is where the player's expired-access link points. |
| `GET /api/renew?stream=…&held=…` | Background renewal. Cross-origin, so it answers only origins named in `player_origins`. `held` is the holder id the player was given: a renewal that presents it must still hold the login (else `409`), and one that omits it — an older player — is treated as a fresh Watch and retakes the login. The reply carries the new token and the holder. |
| `POST /api/beat?stream=…&held=…` | "Still watching", from a playing tab, on the cadence the manager's reply sets (`next_beat_secs`, currently 60 s; the player floors it at 15 s and pauses while the tab is hidden). Cross-origin and gated on `player_origins` exactly as renewal is. Authenticated by the same session cookie as everything else here, but it carries no viewing token and mints nothing: it moves one timestamp on a row this device must already hold, so without `held` it is `400`. The reply's `held: false` tells a displaced tab to stop beating — its picture is ended at its next renewal, not here — and any upstream failure answers `held: true`, so a lost beat costs a number on an operator's screen, never a picture. |
| `GET /api/clips` | Every clip — ready, still cutting, or failed — on every feed the user may reach, which includes a stopped feed for the 24 hours its clips are kept (the manager is asked `?for=clips`). Each feed costs one manager mint, purely as the permission check and re-made on every call rather than cached, plus one origin listing over the minted token, eight feeds at a time. A relay too old to know about clips answers 404 and is skipped silently. |
| `GET /api/clips/download?session=…&name=…` | Hands a finished clip to the viewer **through the portal** — re-minting as the permission check and streaming the bytes from the origin with the token in a header — so the viewer token never appears in a link they are told to right-click and save, nor in the relay's access log. |
| `DELETE /api/clips` | Removes one clip; the JSON body names the `session_id` and the clip `name`. Through the portal because the page's `connect-src 'self'` CSP stops the browser reaching the origin itself. The mint is the only check, so any viewer entitled to the feed may delete any clip on it — the stated design. An origin `404` counts as done. |
| `GET /healthz` | Liveness. Deliberately needs no user — a health check that required one would be reporting on the proxy. |
| `GET /set-password?u=…` | The page an emailed password link points at (relay releases after 0.15.0): a **Set your password** button and nothing else — no link, no script. **Public**: it needs no user, and needs Authelia's `bypass` rule for the path. `400` for a link the portal would not follow; `404` unless both `mail` and `accounts` are configured. Served `no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and a CSP of `default-src 'none'` (inline styles only), because its address carries a one-time credential. |
| `POST /set-password` | The button. **Public**, like the page. `303` to Authelia's reset page, only when the link is that page on `accounts.public_host`; `400` otherwise; `404` unless both `mail` and `accounts` are configured. Same headers as the page. |

Upstream failures answer `502` with "Cannot reach the manager right now", never
`401`: a `401` from the manager is the *portal's* credential being wrong, and
telling the viewer they are not signed in would send them to log in again
forever.

## The player they land in

The portal hands off to the relay's DVR page at `/dvr/{stream_id}`. What arrives
is a full transport surface, not a video element:

| Control | Behaviour |
|---|---|
| Scrub bar | The lit portion is held on the device, and dragging there moves the real picture frame for frame; outside it you get a preview thumbnail while dragging and the video when you let go. A zoom slider sets how much of the window the bar covers. |
| Time ruler | Labelled marks at round clock times — `1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600` seconds — with the largest spacing that still puts **at least three across the bar**, plus minor marks subdividing it. Because each is pinned to an absolute moment, they drift left on their own as the view follows the playhead, and stop when the transport stops. |
| Marks | Press **MARK** (or `M`) to flag the moment you are looking at; hold for the list, and `[` / `]` to jump. Each carries a name and one of a **closed** six-colour palette — Red, Amber, Green, Blue, Purple, White. Closed for more than taste: the colour is written into an inline `style`, and anyone on the feed can write a mark, so only a listed value is accepted. Marks are **shared by everyone watching the feed** — the relay keeps one list per stream and every player polls it every 3 s (relay 0.15.0 and later; an older relay leaves them on the device that made them). |
| Picture ladder | Three points on the curve, chosen in Settings and applied on reload: **Full** (1080p throughout, about 9.3 Mbit/s), **Balanced** (low-resolution while moving, full resolution when stopped — about 3.1 Mbit/s plus roughly 2 MB each time you stop) and **Low** (low-resolution throughout, about 3.1 Mbit/s). The default is Full. Shuttle and scrub work in all three, because the low-resolution rendition is all-intra. |
| Frame stepping | `,` and `.`, or the jog buttons either side of pause. Jog stays on the main rendition; only shuttle hands over to the proxy. |
| Shuttle and rates | `J` / `L` cycle 2× / 4× / 8× / 16× in either direction, `K` stops; fixed rates of 33 %, 50 % and 100 % sit on the bar. |
| Full screen | The `F` key or the corner button. The button removes itself entirely on a browser with no Fullscreen API rather than sitting there inert. |
| Time of day | The left-hand readout is the wall-clock time the frame was ingested, as `HH:MM:SS:FF` — real time of day, not elapsed position — derived from the playlist's `EXT-X-PROGRAM-DATE-TIME`. It falls back to elapsed time when no wall clock is available. |
| Self-test | From Settings, or `?selftest=1`. About a minute, and it measures what *this device* can actually present rather than what the decoder reports: shuttle rate inside the buffer (50 seeks in 2 s), scrub preview coverage across the bar (20 positions), dragging through the real handlers (40 moves), and token renewal against the current token's expiry. |

Keyboard summary: `J`/`L` shuttle, `K` stop, `,`/`.` frame step, `Space`
play/pause, `End` live, `F` full screen, `M` mark, `[`/`]` previous/next mark,
`Escape` closes the innermost panel.

The page itself is served `no-store, must-revalidate`, so an upgraded player is
never masked by a cached copy.

## hls.js is vendored, not fetched

The DVR page loads **hls.js 1.6.16** from the relay itself, at
`GET /dvr/hls.js`, compiled into the binary. The response is
`public, max-age=31536000, immutable`, and the page appends `?v=1.6.16` so that
promise stays true across a version bump.

Vendored rather than CDN-referenced for two reasons, both load-bearing: relays are
frequently deployed where viewers have no route to the public internet, and
Android Chrome has no native HLS — so on the tablets this surface targets, hls.js
is not a progressive enhancement but the only way the page plays anything.

**Attribution.** hls.js is Apache-2.0, and vendoring it makes this a
redistribution: the bytes are compiled into the relay binary and served verbatim
to every DVR viewer, so §4's attribution has to travel with them. **Today it does
not.** The relay repository ships `LICENSE` and `LICENSE.commercial` but no
`NOTICE`, and the release tarball packs the licences, `README.md`, the example
configs and the `packaging/` units — not the vendor README that records the
upstream, version, SHA-256 and licence. Closing the gap means adding a relay
`NOTICE` naming hls.js 1.6.16 / Apache-2.0 and staging it into the tarball
alongside `LICENSE`, as bilbycast-edge already does with its own `NOTICE` files.
