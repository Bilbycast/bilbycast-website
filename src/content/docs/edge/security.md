---
title: Edge Security Model
description: Where an edge node keeps its secrets, how it authenticates the manager link, how the local API is scoped, and how a signed release is verified before it is installed.
sidebar:
  order: 16
---

An edge node has four security surfaces, and they are independent of one another:

- **The box** — two config files on disk, one of which holds infrastructure credentials and is encrypted at rest.
- **The manager link** — an outbound `wss://` WebSocket the node dials itself. Nothing inbound is required to manage a node.
- **The local REST API** — OAuth 2.0 client-credentials + JWT, off by default, bound to loopback by default.
- **The upgrade channel** — Sigstore keyless signatures, verified against an allowlist compiled into the binary. The manager schedules an upgrade; it never chooses the bytes.

This page is the operator's view of all four. Field-by-field reference lives in [Configuration](/edge/configuration/); route-by-route reference lives in the [API Reference](/edge/api-reference/).

## Defaults worth checking first

Read from the shipped defaults, not from a hardened example:

| Setting | Default | What that means |
|---------|---------|-----------------|
| `server.listen_addrs` | `["127.0.0.1", "[::1]"]` | The REST API is **not reachable off-box** on a fresh config. LAN exposure is an explicit opt-in. |
| `server.auth` | absent | Authentication is **off**. Every `/api/v1/**` route is open to any non-browser caller that can reach the listener. The node logs `API authentication is DISABLED — all endpoints are open` at startup. |
| `auth.public_metrics` | `true` | `/metrics` needs no token even when auth is on. `/health` is unconditionally public either way. |
| `auth.token_lifetime_secs` | `3600` | Tokens live one hour and are not refreshable — request a new one. |
| `auth.token_rate_limit_per_minute` | `10` | Per client IP on `/oauth/token`. `0` disables the limiter. |
| `setup_enabled` | `true` | The `/setup` wizard answers until the node registers with a manager. |
| `manager.accept_self_signed_cert` | `false` | Manager TLS is fully validated. |
| `manager.cert_fingerprint` | unset | No pinning — any certificate a public CA vouches for is accepted. |
| `upgrades` | absent (`enabled: false`) | With no `upgrades` block the node installs no upgrade coordinator at all and refuses every `upgrade_binary` with `error_code: "upgrade_disabled"` before anything is downloaded. Note that `install-edge.sh` writes `"upgrades": { "enabled": true, "allowed_channels": ["stable"] }` into a fresh `config.json`, so a node installed that way is opted **in**. |
| `tunnels[].tunnel_encryption_key` | required in `relay` mode | Config validation refuses a relay-mode tunnel without one. Optional in `direct` mode, where QUIC/TLS 1.3 already covers the hop. |

The combination that matters: **auth off + a LAN bind**. The loopback default is what makes the auth-off default survivable, so if you widen the bind, turn auth on in the same edit.

## config.json and secrets.json

Two files, and the split is a deliberate policy decision rather than a filing convention.

| File | Holds | Visible to the manager |
|------|-------|------------------------|
| `config.json` | Operational config, plus **flow-level user parameters** — SRT passphrases, RTSP credentials, RTMP stream keys, WHIP/WHEP bearer tokens, HLS auth tokens | Yes, in full — that is the point |
| `secrets.json` | **Infrastructure secrets** — `manager_node_secret`, `manager_registration_token`, `server_tls`, `server_auth` (JWT secret + client credentials), `setup_token`, `nmos_registration_bearer_token`, per-tunnel keys under `tunnels`, cellular-router passwords under `cellular_uplinks` | No — stripped from every `GetConfig` response |

Flow credentials live in `config.json` **on purpose**: an operator editing an SRT passphrase in the manager UI has to be able to see and change it, and round-tripping the config must not silently blank it. Treat `config.json` as credential-bearing.

### Encryption at rest

`secrets.json` is AES-256-GCM sealed with a machine-derived key:

- The key is HKDF-SHA256 over a machine seed with a bilbycast-specific salt, so the same `/etc/machine-id` yields a different key for a different application.
- The seed is the first of `/etc/machine-id`, `/var/lib/dbus/machine-id`, or a randomly generated `<secrets_dir>/.secrets_key` (written `0600`) on hosts that have neither — macOS, containers, non-systemd Linux.
- The on-disk form is `v1:` + base64(12-byte nonce ‖ ciphertext ‖ 16-byte tag). A file without the `v1:` prefix is read as legacy plaintext and re-encrypted on the next save.

The consequence of a machine-derived key: **`secrets.json` does not move between hosts.** Cloning a disk to new hardware, or reimaging in a way that regenerates `/etc/machine-id`, leaves a file the node cannot decrypt. Re-register the node instead of copying the file.

### File modes

`save_secrets` re-applies `0600` after every write, so `secrets.json` cannot drift open. `config.json` gets no such treatment — `install-edge.sh` sets it `0640 bilbycast:bilbycast` at install time, but the edge's write-temp-then-`rename(2)` replaces the inode, so the file takes the process umask on the next config write (the shipped systemd unit sets no `UMask=`, which means `0644`). If your `config.json` carries SRT passphrases or RTMP keys, check its mode after the first manager-driven config change:

```bash
stat -c '%a %U:%G %n' /opt/bilbycast/edge/config.json /opt/bilbycast/edge/secrets.json
```

### What a manager push cannot change

`GetConfig` strips infrastructure secrets on the way out. The write direction is guarded too: before an `update_config` push is merged, the edge discards manager-supplied values for exactly three fields — `server.tls`, `server.auth` and `setup_token` — and then merges its own copies back in from `secrets.json`. A compromised manager therefore cannot push `server.auth = { "enabled": false }` and switch off a node's local API authentication, nor swap its TLS material.

The guard is deliberately narrow. `tunnel_encryption_key`, `tunnel_bind_secret` and cellular-uplink passwords **are** accepted from a push, because the manager is genuinely where those originate.

:::caution[A local `PUT /api/v1/config` is a different matter]
An admin-authenticated `PUT /api/v1/config` **does** write the `server.auth` block it is given into `secrets.json`. Two things follow. The router resolves auth once, when it is built at process start, so the change takes effect at the **next restart**, not immediately. And omitting the block does not reliably delete it: `secrets.json` is rewritten only when the extracted secret set is non-empty, so a push that empties every secret leaves the previous file — and therefore the previous auth config — in place.
:::

## The manager link

The node dials the manager, never the reverse. `wss://` is enforced twice: config validation rejects any `urls[]` entry that does not start with `wss://`, and the connect path re-checks before the socket is opened. Plaintext `ws://` has no escape hatch at all.

`urls[]` takes 1–16 entries, each ≤ 2048 characters and unique; the client tries `urls[0]` first and rotates on close or auth failure.

### Certificate handling

Three mutually exclusive modes, resolved in this order:

| Config | TLS behaviour |
|--------|---------------|
| `accept_self_signed_cert: true` | **All** certificate validation is disabled — chain, hostname, signature. Requires `BILBYCAST_ALLOW_INSECURE=1` in the environment; without it the connection is refused with an error naming the missing half. |
| `cert_fingerprint` set | Full CA-chain validation against the webpki root store, **then** a SHA-256 fingerprint comparison against the leaf certificate. Both must pass. |
| neither (default) | Standard CA-chain validation against the webpki root store. |

The two-key escape hatch is the point: a config file left over from a lab build cannot silently downgrade a production node's manager link, because the unit file would also have to carry `BILBYCAST_ALLOW_INSECURE=1`. When it does engage, the node logs a `SECURITY WARNING` naming the risk on every connect.

### Pinning the manager certificate

Pinning defends against a compromised or mis-issued CA, which chain validation alone cannot. Compute the fingerprint from the manager's certificate:

```bash
openssl s_client -connect manager.example.com:8443 -servername manager.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 \
  | sed 's/^.*=//' | tr 'A-Z' 'a-z'
# ab:cd:ef:01:23:45:...
```

The comparison is an exact string match against lowercase, colon-separated hex — the form the command above produces. Nothing normalises it at config-load time, so an uppercase or colon-free pin fails at connect, not at validation.

```json
{
  "manager": {
    "enabled": true,
    "urls": ["wss://manager.example.com:8443/ws/node"],
    "cert_fingerprint": "ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89"
  }
}
```

On a mismatch the node logs the expected and actual fingerprints at `error` and the connection fails — which is also what a legitimate certificate rotation looks like, so update the pin when you renew. The node does **not** log the server's fingerprint on a successful unpinned connection; use the `openssl` recipe above to obtain it.

## The local REST API

Full route reference: [API Reference](/edge/api-reference/). What matters here is who reaches what.

### Roles

Two roles, both minted by `/oauth/token` from a `client_id` / `client_secret` pair in `server.auth.clients`:

| Role | Reach |
|------|-------|
| `admin` | Read everything, change everything |
| `monitor` | Read-only — flows, stats, config, the stats WebSocket |

Write routes carry a `RequireAdmin` extractor that returns 403 for a `monitor` token. When auth is disabled the extractor finds no claims in the request extensions and returns success without checking anything, which is why an auth-off node has no role enforcement at all.

:::caution[Three write routes carry no role gate]
`RequireAdmin` is a per-handler extractor, not a router layer, and three write handlers do not take it: `PUT /api/v1/ptp`, `POST /api/v1/tunnels` and `DELETE /api/v1/tunnels/{id}`. Their layers only decode the JWT and refuse browser-initiated writes; nothing looks at the role. A `monitor` token therefore reaches all three and they execute — changing the node's PTP mode (persisted to `/var/lib/bilbycast/ptp.conf`, the settings file `bilbycast-ptp-helper` polls to drive `ptp4l`) or creating/destroying a tunnel and persisting it to `config.json`. Treat a `monitor` credential as able to do those three things until the extractor is added.

The four WHIP/WHEP signalling routes are a fourth, deliberate exception: they carry no role gate because a player is not an operator. Their only check is the optional per-flow `bearer_token` on the two **offer** endpoints, and the two session `DELETE`s check nothing — any authenticated caller can tear down a live WebRTC session.
:::

### Browser access scoping

Two separate mechanisms, and both run whether or not auth is enabled.

**No CORS on the private API.** `/api/v1/**` emits no `Access-Control-*` header on any route, unmatched paths included — the router carries an explicit not-found fallback so a layered NMOS default cannot answer an unmatched path with a wildcard. This costs nothing outside a browser: `curl`, Prometheus, native NMOS controllers and the manager's own outbound WebSocket never read those headers. Exactly two surfaces still send CORS, each because it has a real browser client — `/x-nmos/**` (AMWA requires it; safe methods only unless `server.nmos_browser_control` names a controller origin) and the four WHIP/WHEP routes.

**A cross-origin write guard.** CORS stops a browser *reading* a response; it never stops the *write*, because a request with no non-safelisted header and no non-safelisted content type is "simple" and is never preflighted. `POST /api/v1/flows/{id}/stop` takes no body extractor, so without this guard any page an operator happened to have open could take a live flow off air on an auth-off node. The guard sits on both `/api/v1/**` and `/x-nmos/**`, and lets a request through when:

1. the method is safe (`GET` / `HEAD` / `OPTIONS`); or
2. it carries valid claims — a Bearer token was accepted, whatever the `Origin`; or
3. it carries no browser fingerprint: no `Sec-Fetch-*` header, and either no `Origin` or an `Origin` matching the authority it was addressed to; or
4. on `/x-nmos/**` only, its `Origin` is listed in `server.nmos_browser_control`.

Everything else gets HTTP 403 and a `SECURITY:` log line carrying the matched route, the method and a since-boot refusal count. The `Origin` is deliberately not logged — one attacker-sized string per forged request is a journal-amplification primitive on a box whose disk is carrying media.

Keying on "a browser issued this" rather than "`Origin` and `Host` disagree" is what closes DNS rebinding, where both headers name the attacker's domain and therefore agree. Native NMOS controllers, the AMWA testing tool and `curl` stamp no `Sec-Fetch-*` and are unaffected.

The allowlist does nothing on `/api/v1/**`: that policy is constructed empty, because no browser client of the private API writes to it.

:::note[Residual risk, stated plainly]
This is mitigated-partially, not closed. IS-05 / IS-08 writes remain unauthenticated by specification on auth-off nodes — anything on the LAN that is not a browser can still drive them. With auth on, a `monitor` token is enough to re-point a live sender, because NMOS connection management does not require the `admin` role.
:::

### A worked auth-on configuration

```json
{
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_addrs": ["0.0.0.0", "[::]"],
    "listen_port": 8443,
    "tls": {
      "cert_path": "/etc/bilbycast/fullchain.pem",
      "key_path": "/etc/bilbycast/privkey.pem"
    },
    "auth": {
      "enabled": true,
      "jwt_secret": "<64+ chars from `openssl rand -base64 48`>",
      "token_lifetime_secs": 3600,
      "public_metrics": true,
      "token_rate_limit_per_minute": 10,
      "clients": [
        { "client_id": "ops-admin",  "client_secret": "<random>", "role": "admin" },
        { "client_id": "prometheus", "client_secret": "<random>", "role": "monitor" }
      ]
    }
  }
}
```

Validation refuses a `jwt_secret` under 32 characters, an empty `clients` list, an empty `client_id` or `client_secret`, and any `role` that is not exactly `"admin"` or `"monitor"`. `listen_addr` is not optional even when `listen_addrs` is present — the config parser rejects a `server` block without it before validation ever runs.

Put this block in `config.json` and the edge reads it at the next start. Where it then *lives* depends on `secrets.json`: if that file does not exist yet, start-up extracts every infrastructure secret and rewrites `config.json` without them. If it already exists — the normal case, since `install-edge.sh` pre-creates it as `{}` — the block stays in **plaintext in `config.json`** until the node next writes its config (manager registration, an `update_config` push, any REST mutation), and that write is what moves it into the encrypted file. Either way it is stripped from everything the manager sees. If you add auth by hand, check the file afterwards rather than assuming the secret has already left `config.json`.

NMOS endpoints inherit auth automatically: with `auth.enabled: true` and `nmos_require_auth` unset, IS-04/IS-05/IS-08 require a Bearer token. Setting `nmos_require_auth: false` opts out and logs a loud `SECURITY:` warning at startup.

## The setup wizard

`/setup` is public by design — it is how an unprovisioned node gets its manager URL and registration token — but it is not unguarded.

| Control | Behaviour |
|---------|-----------|
| `setup_enabled` | Default `true`. Flipped to `false` and persisted on the **first successful manager registration**, after which `GET /setup` renders a "Setup Disabled" page and `POST /setup` returns 403. |
| `setup_token` | 256-bit hex token auto-generated on first boot when the wizard is open and no token exists. Persisted in `secrets.json`, printed to stdout once, cleared on successful registration. |
| Loopback bypass | A caller from `127.0.0.0/8` or `::1` skips the token check — being on the box is already an authentication. |
| Non-loopback callers | Must send `Authorization: Bearer <setup_token>`, compared in constant time. Missing, empty or wrong is **401**. |

Reprint the token at any time:

```bash
bilbycast-edge --config /opt/bilbycast/edge/config.json --print-setup-token
```

See [Setup Wizard](/edge/setup-wizard/) for the field-by-field walkthrough.

## Tunnels between edges

Tunnels carry media between two edges through a [relay](/relay/overview/) that must never see plaintext.

- **Cipher**: ChaCha20-Poly1305 AEAD with a 32-byte key (64 hex characters) distributed by the manager, one key per tunnel. Wire format per message is `[12-byte nonce][ciphertext + 16-byte tag]` — 28 bytes of overhead, about 2 % on a 1316-byte SRT packet.
- **Mandatory where it matters**: config validation refuses a `relay`-mode tunnel with no `tunnel_encryption_key`. It stays optional for `direct` mode, where QUIC/TLS 1.3 already protects the hop and the AEAD is defence in depth.
- **Bind authentication**: an optional per-tunnel `tunnel_bind_secret` (also 64 hex characters) produces `HMAC-SHA256(tunnel_id:direction, bind_secret)`, which proves to the relay that this edge is entitled to bind that tunnel. Tunnel IDs must be valid UUIDs.
- **Bonded legs**: a relayed bond leg must carry **exactly one** encryption layer — the bond's own key or the leg's `tunnel_encryption_key`, never both and never neither. Validation enforces it in both directions; see [Multi-Path Bonding](/edge/bonding/).

:::caution[What the tunnel AEAD does not cover]
The AEAD authenticates the payload under a per-message random nonce with an empty AAD, and the 16-byte `tunnel_id` that prefixes every datagram rides **outside** that authentication. Two consequences, both current and deliberate, both gated on the next tunnel protocol version bump because closing either is a wire change both edges must take together:

- **Replay.** There is no sequence number or receive window, so a captured datagram opens successfully however often it is re-injected. Where the tunnel carries SRT, RIST or a bond leg the payload protocol dedups by its own sequence number and absorbs it. A **TCP** tunnel (camera control, signalling) and a **generic UDP** tunnel carrying raw TS or RTP have no such backstop.
- **Cross-tunnel movement.** A datagram can be re-framed with another tunnel's id. It only opens on a tunnel sharing the key, and the manager mints a distinct key per tunnel, so this is confined to hand-written configs that reuse one key. Every receive path additionally drops a datagram whose prefix is not its own tunnel id — a routing check, not authentication.

The 96-bit nonce is drawn from a CSPRNG per message, which puts the collision boundary at ~2⁴⁸ messages per key — decades for one tunnel at broadcast bitrates, but shared across every tunnel that reuses a key and across restarts. The in-tree guidance is to re-key after roughly 2³² messages (about a day of 1 Gbps at 1316-byte payloads) or 30 days, whichever comes first; rotate from the manager.
:::

## Signed upgrades

The manager has authority over **scheduling** an upgrade — which node, when, which version and channel. It has none over **what code runs**. The node builds the download URL itself and will only install a release that verifies under Sigstore.

### Trust roots compiled into the binary

| Root | Source | Rotates |
|------|--------|---------|
| Sigstore TUF root (`root.json`) | embedded in the `sigstore` crate at build time — the anchor everything else is checked against | only on a Sigstore root rotation, which needs a new edge build |
| Fulcio CA certs + Rekor public keys | shipped as an embedded `trusted_root.json` snapshot, but re-checked against Sigstore's TUF repository at verification time and re-fetched if the snapshot is stale | automatically, as Sigstore rotates them |
| `ALLOWED_SIGNERS` identity allowlist | bilbycast-specific, in `src/upgrade/trust.rs` | only when the release workflow path changes |

Loading that trust root contacts `https://tuf-repo-cdn.sigstore.dev`, so a node that cannot reach it fails the upgrade closed rather than falling back to the embedded snapshot unchecked.

The allowlist pins four claims, all of which must match: the OIDC issuer `https://token.actions.githubusercontent.com`, the repository `https://github.com/Bilbycast/bilbycast-edge`, the workflow `.github/workflows/nightly-release.yml`, and the ref pattern `refs/tags/v*`. That last pin is what makes a manually dispatched run from a branch unusable — it mints a `refs/heads/*` certificate every deployed edge rejects.

### What happens on `upgrade_binary`

1. **Policy gate, before any network traffic.** `upgrades.enabled` must be true; the requested channel must be in `allowed_channels`; the target semver must parse and clear `min_version` and the `rollback_grace` window. Each refusal carries a distinct `error_code` (`upgrade_disabled`, `upgrade_channel_not_allowed`, `upgrade_version_too_old`, `upgrade_version_invalid`, …) so the manager UI can be specific.
2. **Deterministic URL.** The node constructs `https://github.com/Bilbycast/bilbycast-edge/releases/download/v<version>/` itself. The manager supplies no URL and no hash. Only `github.com` and the GitHub release-asset CDN hosts are accepted, and redirects must stay on HTTPS within that family.
3. **Fetch + verify the manifest.** `manifest.json` and `manifest.sig.bundle` are fetched, and every one of these must pass: the leaf certificate chains to a trusted Fulcio CA; its SAN identity matches an `ALLOWED_SIGNERS` row; the Rekor entry binds this manifest's SHA-256 and this certificate, its Signed Entry Timestamp verifies under a trusted Rekor key, and its `integratedTime` falls inside the certificate's validity window; the signature verifies over the **raw** manifest bytes. Any failure — including an unreachable or malformed trust root — is fatal. An empty allowlist is itself refused, so the check can never become vacuous.
4. **Cross-check the verified manifest.** Its `version`, `channel` and `device_type` must match the request, and its `sequence` must **exceed** the last installed one — a rollback / replay guard that holds even where semver alone would allow the install (`upgrade_sequence_too_old`). Only an artefact row matching this host's arch and variant is selected.
5. **Download against the signed hash.** Only then is the tarball fetched, streamed through SHA-256 and compared to the digest inside the manifest that just verified.
6. **Atomic swap.** Extract into `versions/<new>.partial/` — the extractor refuses any tar entry with an absolute path, a `..` segment, or a resolved target outside the extraction root — then `chmod 0755` the binary, fsync, `rename(2)` the partial directory into `versions/<new>/`, rotate `previous`, and swap the `current` symlink. State is persisted under a `flock(2)` advisory lock, so two concurrent stagings are impossible; a power cut leaves only a `.partial` directory, which the next staging attempt removes before it starts.
7. **Boot watchdog.** The new install is `pending_health`. Each respawn bumps `boot_attempts`; past `max_boot_attempts` the watchdog reverts the symlink to `previous`, emits a Critical `upgrade_rolled_back`, and exits so systemd respawns the old binary. After `boot_health_window_secs` of healthy manager beats the install is promoted to stable and `upgrade_completed` is emitted.

No long-lived signing key exists anywhere in this pipeline — an ephemeral keypair signs each release and is discarded. There is nothing to steal or rotate, customers hold no key, and every signing event leaves a permanent, timestamped, public Rekor record tied to the workflow run and commit that produced it.

### Policy fields

Full reference in [Upgrade Configuration](/edge/configuration/#upgrade-configuration); the security-relevant bounds:

| Field | Default | Bounds | Effect |
|-------|---------|--------|--------|
| `enabled` | `false` | — | Master switch. A high-value site that refuses all remote upgrades leaves this off; the node rejects every `upgrade_binary` before downloading anything. |
| `allowed_channels` | `["stable"]` | 1–8 entries | Any other channel is refused. The manifest carries its own `channel` and the edge cross-checks it. |
| `min_version` | unset | valid semver | Version floor. |
| `rollback_grace` | `1` | ≤ 100 | How many minor versions back the node will move. Blocks a compromised manager forcing a known-vulnerable old release. |
| `install_root` | `/opt/bilbycast/edge` | absolute, ≤ 4096 chars | Relative paths are refused outright. |
| `boot_health_window_secs` | `120` | 10–86400 | Healthy-beat window before the install is promoted to stable. |
| `max_boot_attempts` | `3` | 1–10 | Failed boots before automatic rollback. |

:::caution[`manual_only` is not a working approval gate today]
`upgrades.manual_only = true` verifies and downloads the tarball, then bails with `upgrade_staged_manual` **before** the staging step runs — so nothing is staged. The process installs handlers for `SIGTERM` and `SIGINT` only, and the manual-apply entry point has no caller, so the promised `SIGUSR1` never completes anything. Use `enabled: false` if you need a hard refusal; do not rely on `manual_only` as a stage-then-approve control.
:::

### Verifying a release yourself

Every check the edge runs is reproducible from public information alone, with no insider access:

```bash
V=v0.109.0
curl -fsSL -O https://github.com/Bilbycast/bilbycast-edge/releases/download/$V/manifest.json
curl -fsSL -O https://github.com/Bilbycast/bilbycast-edge/releases/download/$V/manifest.sig.bundle

cosign verify-blob \
    --bundle manifest.sig.bundle \
    --certificate-identity-regexp 'https://github\.com/Bilbycast/bilbycast-edge/\.github/workflows/nightly-release\.yml@refs/tags/v.*' \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    manifest.json
```

A pass proves the manifest bytes were signed by a run of `nightly-release.yml` on `Bilbycast/bilbycast-edge`, triggered by a release tag, and that the event is recorded in Rekor. Cross-check the SHA-256 in `manifest.json` against the tarball you downloaded and you have verified the same chain the node does.

Nodes advertise `upgrade` on their health tick, so the manager hides the upgrade controls for a build that has no upgrade module. The operator workflow, rollout strategy and audit trail are on the manager side — see [Remote Upgrade](/manager/remote-upgrade/).

## Hardening checklist

1. Keep the loopback bind, or enable `server.auth` in the same edit that widens it.
2. Give each integration its own client, and `monitor` unless it genuinely writes — remembering the three ungated write routes above.
3. Put a real certificate on the API listener (`server.tls`), and pin the manager's certificate with `cert_fingerprint`.
4. Never set `accept_self_signed_cert` on a production node; if a lab node has it, keep `BILBYCAST_ALLOW_INSECURE` out of the production unit file.
5. Check the mode on `config.json` after the first manager-driven config change — it carries flow credentials and the edge does not re-apply a restrictive mode.
6. Decide `upgrades.enabled` deliberately per node, and set `allowed_channels` to `["stable"]` outside the testbed.
7. Rotate long-lived `tunnel_encryption_key`s from the manager rather than leaving one in place indefinitely.
