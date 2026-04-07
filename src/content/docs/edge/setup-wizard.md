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

If your deployment workflow already pushes a complete `config.json` (e.g., via Ansible, Terraform, cloud-init), you can leave `setup_enabled: false` and skip the wizard entirely.

## Enabling the wizard

In `config.json`:

```json
{
  "server": {
    "bind": "0.0.0.0",
    "port": 8080
  },
  "setup_enabled": true
}
```

When enabled, `GET /setup` is publicly accessible (no auth) and serves an inline HTML form. **No other route is opened up** — `/api/v1/*` still requires whatever auth is configured.

## What the form collects

| Field | Stored as | Notes |
|---|---|---|
| Device name | `manager.device_name` | Free-form label shown in the manager UI |
| Manager URL | `manager.url` | Must be `wss://...` — plaintext `ws://` is rejected |
| Registration token | `manager.registration_token` | One-time token issued by the manager admin |
| Accept self-signed cert | `manager.accept_self_signed_cert` | Requires `BILBYCAST_ALLOW_INSECURE=1` env var as a safety guard |
| Certificate fingerprint (optional) | `manager.cert_fingerprint` | SHA-256 fingerprint for cert pinning |
| API listen address | `server.bind` | Default `0.0.0.0` |
| API listen port | `server.port` | Default `8080` |

On submit, the wizard:

1. Persists the new values to `config.json` and `secrets.json` (the registration token lands in `secrets.json`, encrypted at rest).
2. Restarts the manager WebSocket client to pick up the new URL and token.
3. The manager validates the registration token, mints a permanent `node_id` and `node_secret`, and the edge stores them.
4. Subsequent reconnects use the secret, not the token. The token can be safely deleted from the manager once first auth has succeeded.

## Disabling after provisioning

For production deployments, **disable the wizard after first-run provisioning is complete**:

```json
{
  "setup_enabled": false
}
```

The wizard is a public endpoint by design — it has to be reachable before any auth is configured. Leaving it enabled in production is equivalent to leaving an unauthenticated config endpoint open. The wizard will refuse to overwrite a `manager.url` that already has a `node_secret` paired with it without an explicit "re-provision" confirmation, but the safest option is to turn it off.

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
  "manager": {
    "url": "wss://manager.example.com",
    "device_name": "edge-syd-1"
  },
  "setup_enabled": false
}
```

```json
// secrets.json (encrypted at rest, machine-id keyed)
{
  "manager": {
    "registration_token": "rtok_..."
  }
}
```

On first start, the edge will use the registration token to mint a permanent `node_secret`. After that, `secrets.json` will hold the secret instead of the token.
