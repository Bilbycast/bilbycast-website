---
title: Setup Wizard
description: Browser-based first-boot provisioning for bilbycast-edge nodes — manager URL, registration token, and self-signed cert handling.
sidebar:
  order: 9
---

bilbycast-edge ships with a browser-based **setup wizard** at `/setup` for initial provisioning. It is gated by the `setup_enabled` flag in `config.json` and is designed to be enabled at first boot in the field, then disabled once the node has joined a manager.

## When to use it

- Bare-metal or containerised edge nodes that need to be told where their manager lives at first boot.
- Edge nodes deployed by a different team than the one running the manager (operators don't need shell access — just a browser).
- Replacing or re-provisioning a node without re-uploading a full `config.json`.

If your deployment workflow already pushes a complete `config.json` (e.g., via Ansible, Terraform, cloud-init), you can set `setup_enabled: false` and skip the wizard entirely.

## Enabling the wizard

`setup_enabled` defaults to **true**, so a fresh node needs no config file at all to reach `/setup` — though with no config file the API server binds loopback only, so reach it from the node itself or over an SSH tunnel. To pin the flag explicitly in `config.json`:

```json
{
  "version": 2,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_addrs": ["0.0.0.0", "[::]"],
    "listen_port": 8080
  },
  "setup_enabled": true
}
```

`version`, `server.listen_addr` and `server.listen_port` are all required fields — a `server` block missing the address or the port aborts startup with a parse error rather than falling back to the built-in defaults. `listen_addrs` is the optional dual-stack list; when present it is what the API server binds, and `listen_addr` is kept for backward compatibility with pre-dual-stack configs.

When enabled, `GET /setup` is publicly accessible (no auth) and serves an inline HTML form. `POST /setup` is unauthenticated **only from loopback** — a caller from the LAN or the internet must send `Authorization: Bearer <setup_token>`, or the node answers `401`. **No other route is opened up** — `/api/v1/*` still requires whatever auth is configured.

## What the form collects

| Field | Stored as | Notes |
|---|---|---|
| Device name | `device_name` (top level — **not** under `manager`) | Free-form label shown in the manager UI |
| Manager URLs | `manager.urls` | One per line, 1–16 entries. Each must be `wss://...` — plaintext `ws://` is rejected |
| Registration token | `manager.registration_token` | One-time token issued by the manager admin; split out to `secrets.json` as `manager_registration_token` |
| Accept self-signed cert | `manager.accept_self_signed_cert` | Requires `BILBYCAST_ALLOW_INSECURE=1` env var as a safety guard |
| API listen address | `server.listen_addr` | Default `127.0.0.1` (loopback only — expose on the LAN with `--bind-addrs 0.0.0.0,[::]`). A comma-separated value is split into `server.listen_addrs`, with the first entry left in `listen_addr` |
| API listen port | `server.listen_port` | Default `8080` |

The form's **Setup Token** field is not stored anywhere — it is sent as the `Authorization: Bearer <token>` header that a non-loopback `POST /setup` requires. Take the token from the node's first-boot stdout banner, or re-print it with `bilbycast-edge --config config.json --print-setup-token`; it is cleared automatically on the first successful manager registration. See [Getting started](/edge/getting-started/#4-run-the-edge-and-complete-the-setup-wizard) for the first-boot walkthrough.

There is no certificate-fingerprint field: `manager.cert_fingerprint` cannot be set from the wizard. A fingerprint already in `config.json` is carried through a submit untouched, but pinning a new one means hand-editing `config.json`.

On submit, the wizard:

1. Persists the new values to `config.json` and `secrets.json` (the registration token lands in `secrets.json`, encrypted at rest).
2. Answers `Configuration saved. Restart the bilbycast-edge service to apply the new settings.` — the manager WebSocket client is started once, at process boot, so nothing connects until you restart the service.

### After the restart

1. The manager validates the registration token, mints a permanent `node_id` and `node_secret`, and the edge stores them.
2. Subsequent reconnects use the secret, not the token. The token can be safely deleted from the manager once first auth has succeeded.

## Disabling after provisioning

On the normal path this happens by itself: the first time the edge registers successfully with a manager it sets `setup_enabled: false` and clears the one-shot `setup_token`, so `/setup` stops accepting reconfiguration with no operator action at all.

Set the flag by hand only on a node that was configured but never completed registration:

```json
{
  "setup_enabled": false
}
```

The wizard is a public endpoint by design — it has to be reachable before any auth is configured — and there is no re-provision confirmation: while `setup_enabled` is true, a submit re-points a node that already holds a `node_secret` without asking (the secret and `node_id` are carried forward, the manager URLs are overwritten). A node that has registered has already closed the wizard itself; one that never registered — or one you re-enabled by hand — is a token-gated config endpoint left open.

## Self-signed cert mode

If your manager uses a self-signed cert (e.g., during development or behind an internal CA that the edge doesn't trust), tick the **Accept self-signed cert** box and set the env var:

```bash
BILBYCAST_ALLOW_INSECURE=1 bilbycast-edge --config config.json
```

The env var is checked at process start. Without it, `accept_self_signed_cert: true` is rejected at config load — this prevents accidental production deployments with TLS verification disabled.

For better security in self-signed environments, use **certificate pinning** instead: leave `accept_self_signed_cert: false`, set `cert_fingerprint` to the manager's SHA-256 fingerprint, and the edge will validate that exact cert without trusting the system CA store.

## Headless / scripted alternative

Everything the wizard does can be done with a `config.json` + `secrets.json` pair on disk. If you want to skip the browser flow entirely, write the same fields directly:

```json
// config.json (operator-visible)
{
  "version": 2,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_addrs": ["0.0.0.0", "[::]"],
    "listen_port": 8080
  },
  "device_name": "edge-syd-1",
  "manager": {
    "enabled": true,
    "urls": ["wss://manager.example.com"]
  },
  "setup_enabled": false
}
```

`device_name` is a top-level field, and `manager.enabled` must be `true` — the client is only started when it is.

```json
// secrets.json (encrypted at rest, machine-id keyed)
{
  "manager_registration_token": "rtok_..."
}
```

The secrets file is **flat**: every key sits at the top level, so there is no `manager` object to nest the token under. A hand-written plaintext file is accepted on load and silently re-encrypted (AES-256-GCM, machine-derived key) at the next save, but unrecognised keys are discarded without a warning — nest the token and the node boots with no token at all and never registers.

On first start, the edge will use the registration token to mint a permanent `node_secret`. After that, `secrets.json` holds `manager_node_secret` instead of the token.
