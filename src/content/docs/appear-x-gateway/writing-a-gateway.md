---
title: Building a Gateway Sidecar
description: Writing a third-party device gateway with bilbycast-gateway-sdk — config fields and bounds, the CommandHandler and Emitter surfaces, reconnect and heartbeat behaviour, and Sigstore-verified remote upgrade.
sidebar:
  order: 5
---

A gateway sidecar is a small Rust binary, deployed 1:1 with a vendor chassis, that speaks the bilbycast manager WebSocket protocol on one side and the vendor's native API (JSON-RPC, REST, SNMP, ...) on the other. `bilbycast-gateway-sdk` owns the manager-facing half of that — WSS connect, TLS, registration and reconnect auth, heartbeats, command dispatch, graceful shutdown, and remote binary upgrade — so a vendor integration is a polling loop plus a command handler.

This page covers the gateway binary. The manager-side `DeviceDriver` that pairs with it is covered in [Adding New Device Gateways](/appear-x-gateway/adding-new-device-gateways/). The reference pair is `bilbycast-appear-x-api-gateway` (the sidecar) and `bilbycast-manager/crates/device-appear-x` (its driver).

## What the SDK owns, and what you write

| Concern | Owner |
|---|---|
| WSS connect, TLS mode selection, cert pinning | SDK |
| Auth first frame, `register_ack` / `auth_ok` / `auth_error` handling | SDK |
| Reconnect with backoff + multi-URL failover | SDK |
| Health heartbeat on a timer | SDK (thin — see [Heartbeat, health and capabilities](#heartbeat-health-and-capabilities)) |
| Inbound dispatch, `command_ack` packing, `ping` → `pong` | SDK |
| Sigstore-verified binary upgrade, boot watchdog, rollback | SDK (machinery only — you wire it, see [Remote upgrade](#remote-upgrade)) |
| Vendor API client (HTTP / JSON-RPC / SNMP / ...) | You |
| Polling loop and the `stats` / `health` / `event` payload shapes | You |
| `CommandHandler` — mapping `action.type` to vendor calls | You |
| TOML config schema outside the `[manager]` section | You |

## The skeleton

`bilbycast-gateway-template` is a runnable skeleton of exactly this shape — clone it, copy its `config.example.toml` to `config.toml`, and fill in `src/vendor.rs`:

```text
your-gateway/
├── Cargo.toml            # depends on bilbycast-gateway-sdk + tokio
├── config.toml           # [manager] + [vendor] (+ optional [upgrade]) sections
└── src/
    ├── main.rs           # load config, build GatewayClient, spawn polling, run()
    ├── vendor.rs         # vendor API client + polling loop + CommandHandler
    └── upgrade_profile.rs # ALLOWED_SIGNERS + UpgradeProfile consts (optional)
```

The template's `simulate_snapshot()` returns an `Err` on purpose: until you replace it, the polling loop emits a `vendor_api_error` event every tick, so an unwired integration is visible on the manager's events feed instead of quietly reporting zero flows forever.

## The `[manager]` config section

`GatewayConfig` is the SDK's view of the manager connection. It derives `Serialize` / `Deserialize`, so you can embed it verbatim, but the Appear X gateway and the template both declare their own `[manager]` section and map it by hand — that is what lets them add `credentials_file`, which is a gateway concern and not an SDK one.

```toml
[manager]
# Ordered list of manager WebSocket URLs. Each must be wss://; 1–16 entries.
# A single-instance manager is a one-element list.
urls = ["wss://manager.example.com:8443/ws/node"]

# One-time token from the manager's Add Node flow. Delete after first
# successful registration — from then on the credentials file is authoritative.
registration_token = "paste-token-from-manager-here"

# Where node_id + node_secret are persisted (written 0600).
credentials_file = "credentials.json"

accept_self_signed_cert = false
# cert_fingerprint = "ab:cd:ef:01:..."   # 64 hex chars, ':' separators optional

# Must match a DeviceDriver registered in the manager.
device_type = "my_device"

[vendor]
address = "192.168.1.100"
username = "admin"
password = ""
poll_interval_secs = 15
```

`GatewayConfig`'s fields, as the SDK reads them:

| Field | Type | Default | Notes |
|---|---|---|---|
| `manager_urls` | `Vec<String>` | *(required)* | 1–16 entries, each `wss://`, ≤ 2048 chars, no duplicates. Rotated on every reconnect. |
| `device_type` | `String` | *(required)* | 1–64 chars. Must match `DeviceDriver::device_type()` in the manager. |
| `software_version` | `String` | *(required)* | Reported to the manager and shown on the node page. Use `env!("CARGO_PKG_VERSION")`. |
| `node_id` | `Option<String>` | `None` | Set together with `node_secret` or not at all. |
| `node_secret` | `Option<String>` | `None` | Same pairing rule. |
| `registration_token` | `Option<String>` | `None` | Either the `node_id` + `node_secret` pair **or** this must be set. |
| `accept_self_signed_cert` | `bool` | `false` | Also needs `BILBYCAST_ALLOW_INSECURE=1` in the environment, checked when the TLS config is built. |
| `allow_plaintext_ws` | `bool` | `false` | Integration tests only. Also needs `BILBYCAST_SDK_ALLOW_PLAINTEXT_WS=1` — see below. |
| `cert_fingerprint` | `Option<String>` | `None` | SHA-256 of the server leaf cert, 64 hex chars with optional `:` separators. Takes precedence over `accept_self_signed_cert`. |
| `heartbeat_interval` | `Duration` (whole seconds in TOML/JSON) | `15` | Bounded 5–300 inclusive; anything outside is a config error. |
| `reconnect_backoff.steps_secs` | `Vec<u64>` | `[1, 2, 5, 10, 30]` | Delay per attempt, saturating at the last step. |

`GatewayClient::connect` calls `GatewayConfig::validate()`, which enforces every bound above **except** `cert_fingerprint` — that one is parsed when the TLS config is built, on the first connect attempt, so a malformed pin surfaces as a per-attempt error rather than a startup failure. (`software_version` is passed through unchecked.) `connect` does **not** open a socket either — the TCP/TLS connect happens inside `run()`, which is why an unreachable manager surfaces as a reconnect warning rather than a startup error.

### `wss://` only, and the two keys behind the plaintext hatch

Plain `ws://` is refused. The escape hatch for integration tests against a mock manager needs **both** halves:

```rust
let mut cfg = GatewayConfig::minimal(url, "my_device", "0.1.0");
cfg.registration_token = Some("test-token".into());  // validate() needs this or a node pair
cfg.allow_plaintext_ws = true;            // config half
// and in the environment:
// BILBYCAST_SDK_ALLOW_PLAINTEXT_WS=1     // env half
```

Either alone is refused, and the error names the missing half. Two keys rather than one because this used to be environment-only: a single variable set anywhere — a unit file, a shell profile, a container spec — silently downgraded a sidecar's manager link from TLS to cleartext while it was carrying its node secret, with nothing in the sidecar's own configuration consenting. The self-signed hatch (`accept_self_signed_cert` + `BILBYCAST_ALLOW_INSECURE=1`) already worked this way; this matches it. Ship production sidecars with `allow_plaintext_ws: false` and no config surface to turn it on.

### TLS modes

| Mode | Selected by | Behaviour |
|---|---|---|
| Standard | neither flag set | Validates against the bundled webpki roots. |
| Pinned | `cert_fingerprint` set | Full chain validation **and** the leaf's SHA-256 must match. Checked first, so it wins over `accept_self_signed_cert`. |
| Self-signed | `accept_self_signed_cert = true` **and** `BILBYCAST_ALLOW_INSECURE=1` | All certificate validation disabled, with a `SECURITY WARNING` logged on every connect. Without the environment variable the client errors out instead. |

## Connect, run, shut down

```rust
use std::sync::Arc;
use bilbycast_gateway_sdk::{
    CredentialStore, GatewayClient, GatewayConfig, PersistedCredentials,
};

let store = CredentialStore::new(&cfg.manager.credentials_file);
let persisted = store.load()?;

let mut gateway_cfg = GatewayConfig {
    manager_urls: cfg.manager.urls.clone(),
    device_type: cfg.manager.device_type.clone(),
    software_version: env!("CARGO_PKG_VERSION").to_string(),
    node_id: persisted.node_id.clone(),
    node_secret: persisted.node_secret.clone(),
    registration_token: None,
    accept_self_signed_cert: cfg.manager.accept_self_signed_cert,
    allow_plaintext_ws: false,
    cert_fingerprint: cfg.manager.cert_fingerprint.clone(),
    heartbeat_interval: std::time::Duration::from_secs(15),
    reconnect_backoff: Default::default(),
};
// Disk credentials win; the one-time token is only used on a virgin install.
if !persisted.has_credentials() {
    gateway_cfg.registration_token = cfg.manager.registration_token.clone();
}

let state = Arc::new(vendor::VendorState::new());
let handler = Arc::new(vendor::VendorCommandHandler {
    state: state.clone(),
    upgrade_coord: None,                 // see Remote upgrade, below
});
let mut client = GatewayClient::connect(gateway_cfg, handler).await?;

// Persist (node_id, node_secret) the first time the manager mints them.
let store_cb = store.clone();
client.on_register(move |node_id, node_secret| {
    let _ = store_cb.save(&PersistedCredentials {
        node_id: Some(node_id.to_string()),
        node_secret: Some(node_secret.to_string()),
        registration_token: None,
    });
});

let emitter = client.emitter();          // clone freely; all clones share one channel
let shutdown = client.shutdown_token();  // cancel for a graceful close

tokio::spawn(vendor::run_polling(cfg.vendor.clone(), state, emitter, shutdown.child_token()));

client.run().await?;                     // blocks until the token is cancelled
```

Useful handles on the client:

| Symbol | Purpose |
|---|---|
| `emitter()` | `Emitter` for `stats` / `health` / `event` / `thumbnail`. |
| `shutdown_token()` | `CancellationToken` propagated to the read, write and heartbeat paths. |
| `connection_state()` | Cloneable, lock-free `ConnectionState`. Take it **before** `run()` and read `is_connected()` / `last_connect_epoch()` from a local `/health` endpoint or a status LED — no manager round trip. |
| `is_connected()` | Shorthand for `connection_state().is_connected()`. |
| `current_credentials()` | `(Option<String>, Option<String>)` snapshot of the live `(node_id, node_secret)`. |
| `on_register(cb)` | Fires once on first-time registration only; reconnects do not call it. |

## Registration and credentials

The first frame on every connection is an `auth` envelope carrying `software_version`, `device_type`, `protocol_version`, and either a `registration_token` (new node) or a `node_id` + `node_secret` pair (returning node). The manager answers with `register_ack` (carrying the minted `node_id` + `node_secret`), `auth_ok`, or `auth_error`. The SDK gives the handshake 10 seconds before failing with an auth timeout and reconnecting.

`protocol_version` is pinned at **1** by the SDK while the manager is at **4**. That is deliberate and not a bug: the manager warns on a mismatch and raises a Warning `compatibility` event against the node, but it does not reject the connection, and unknown message types and fields are tolerated on both sides. Expect that event on the Events page for every gateway.

`CredentialStore` / `PersistedCredentials` write the pair to a JSON file with `0600` permissions, creating the parent directory if needed. A gateway that loses that file re-registers only if it still has a valid one-time token.

## Handling commands

```rust
#[async_trait]
pub trait CommandHandler: Send + Sync + 'static {
    async fn handle_command(
        &self,
        command_id: String,
        action: Value,
    ) -> Result<Value, CommandError>;

    async fn on_config_request(&self) -> Value { Value::Null }
}
```

The SDK's read loop calls `handle_command` inline for every `command` envelope — there is no separate handler task to spawn — and packs the return value into a `command_ack`. Commands arrive as `{ "type": "<action>", ...params }`:

```rust
async fn handle_command(
    &self,
    _command_id: String,
    action: Value,
) -> Result<Value, CommandError> {
    match action.get("type").and_then(|t| t.as_str()) {
        Some("get_inputs") => self.vendor.get_inputs().await
            .map_err(|e| CommandError::new("vendor_api_error", e.to_string())),
        Some("set_input") => {
            let slot = action.get("slot").and_then(|v| v.as_u64())
                .ok_or_else(|| CommandError::validation("slot required"))?;
            self.vendor.set_input(slot as u8, &action).await
                .map_err(|e| CommandError::new("vendor_api_error", e.to_string()))?;
            Ok(Value::Null)          // fire-and-forget: no `data` on the ack
        }
        Some(other) => Err(CommandError::unknown_action(other)),
        None => Err(CommandError::validation("missing action.type")),
    }
}
```

On success the ack carries `command_id`, `success: true`, and `data` (omitted entirely when the handler returns `Value::Null`). On failure it carries `success: false`, `error` from `CommandError::message`, `error_code` from `CommandError::code`, and `details` when set — the same unified error-code model the edge uses, so the manager UI can machine-match and highlight the offending field. `CommandError::unknown_action(..)` yields `unknown_action` and `CommandError::validation(..)` yields `validation_error`; beyond those, reuse the edge taxonomy (`port_conflict`, `bind_failed`, `unsupported_codec`, `timeout`, ...).

`get_config` is intercepted by the SDK rather than reaching your `match`. It calls `on_config_request()`, emits the successful `command_ack` **first**, then the `config_response` envelope — that order matters, because the manager invalidates its cached config on every ack, and reversing it would clear the snapshot immediately after storing it. Return whatever the manager UI should show as this node's configuration, typically a roll-up of your polling engine's latest snapshots.

`ping` is answered with `pong` automatically. Unknown message types are logged and dropped, so a newer manager cannot break an older gateway. Inbound messages and frames are capped at 5 MiB.

## Emitting to the manager

`Emitter` wraps a 256-frame outbound channel feeding the write task. Clone it into every task that needs it.

| Method | Envelope | Notes |
|---|---|---|
| `emit_stats(Value)` | `stats` | Shape is a contract with your manager-side driver's `extract_metrics()`, not with the SDK. |
| `emit_health(Value)` | `health` | Ad-hoc health outside the heartbeat tick. |
| `emit_health_with_target(Value, GatewayTargetHealth)` | `health` | Merges a typed `gateway_target` sub-status in as a sibling key. Drives the dashboard's third "Target down" amber state. |
| `emit_event(GatewayEvent)` | `event` | Typed builder; `emit_event_raw(Value)` is the untyped escape hatch. |
| `emit_thumbnail(flow_id, jpeg)` | `thumbnail` | Base64-encodes into `image_base64` alongside `flow_id`. |
| `emit_config_response(Value)` | `config_response` | Usually left to the `get_config` interception above. |
| `emit_command_ack(id, result)` | `command_ack` | For late or out-of-band replies; the read loop already acks normal commands. |

Events carry a lowercase severity — `info`, `minor`, `major`, `critical` — plus a category, a message, optional structured `details`, and optional `flow_id` / `input_id` / `output_id`. The shared category constants are `port_conflict`, `bind_failed`, `validation_error`, `connection`, `config_sync`, `vendor_api`, `auth` and `rate_limit`; vendor-specific strings are fine alongside them.

```rust
emitter.emit_event(
    GatewayEvent::major(categories::VENDOR_API, format!("vendor API error: {e}"))
        .with_error_code("vendor_api_error"),
).await?;
```

`GatewayTargetHealth` reports the *vendor* link, separately from the manager link:

| Field | Type | Notes |
|---|---|---|
| `reachable` | `bool` | Drives the "Target down" dashboard state. |
| `target_address` | `String` | The address the gateway polls. |
| `gateway_host` | `Option<String>` | The sidecar's own hostname — what an operator can SSH to. |
| `gateway_egress_ip` | `Option<String>` | Best-effort egress IP. |
| `last_successful_poll_unix` | `Option<i64>` | Epoch seconds. |
| `last_error_code` | `Option<String>` | A fixed vocabulary by convention, not by type — `http_timeout`, `tcp_refused`, `tls_handshake`, `auth_rejected`, `rpc_protocol_error`, `other`. Nothing in the SDK or the manager validates it, so the discipline is yours: send a code, never the vendor's error text. The manager caches this payload and broadcasts it to the dashboard, and a verbose string fans vendor URLs and credential hints out with it. |
| `consecutive_failures` | `Option<u32>` | Failure run length behind the reachability decision. |

A sidecar must ride through target outages without exiting. Vendor API errors belong on the events feed and the next poll tick; the only acceptable reasons to exit are SIGTERM / ctrl-c, an unrecoverable config error, or a genuine fault.

## Heartbeat, health and capabilities

The SDK's built-in heartbeat sends exactly this, every `heartbeat_interval`:

```json
{ "status": "ok", "version": "<software_version>" }
```

That is enough to keep the node alive on the manager, and **not** enough for anything gated on capabilities. The manager shows the per-node Upgrade button only when `last_health.capabilities` contains `"upgrade"`, so a sidecar that relies on the SDK heartbeat alone advertises nothing and the button never appears, no matter how completely the upgrade profile is filled in.

Emit your own health envelope on a ticker:

```rust
emitter.emit_health(json!({
    "status": "ok",
    "version": env!("CARGO_PKG_VERSION"),
    "capabilities": ["upgrade"],
})).await?;
```

Both envelopes write the same `cached_health` on the manager, so the two tickers race. The Appear X gateway resolves that by pushing the SDK heartbeat out to 300 s (the validated maximum) and emitting its own envelope far more often — every 10 s while it is still discovering the chassis, then on the polling engine's own cadence — through `emit_health_with_target`, so target reachability rides along. Advertise `"upgrade"` unconditionally — the upgrade module is always compiled in, and when the operator has not wired an `[upgrade]` section the command arm refuses with `upgrade_disabled` and a pointer at the missing config, which is more discoverable than a hidden button.

## Reconnect and failover

The connect loop is: connect → auth → serve until the session ends → advance to the next URL in `manager_urls` → sleep the backoff delay → repeat. The attempt counter resets to zero after any session that authenticated, so a link that flaps returns to a 1 s first retry rather than staying at 30 s. With the default steps a sustained outage settles at one attempt per 30 s, each logged as one `WARN` naming the attempt number and the next delay — paced by the backoff itself, and the primary outage signal on a headless sidecar with no local UI.

A single-instance manager is a one-element list, and rotation then simply retries the same URL. For an active-active manager pair, list both and the sidecar fails over on its own.

The TLS config is rebuilt on every attempt — but from the `GatewayConfig` the client was constructed with, which `connect` snapshots once. The SDK never re-reads your config file, so rotating a pinned `cert_fingerprint` on disk needs a restart (or your own reload path that builds a fresh `GatewayClient`).

## Remote upgrade

Gateways inherit the edge's upgrade machinery — Sigstore-keyless manifest verification, streaming SHA-256, atomic symlink swap, boot watchdog and rollback — parameterised by a per-binary `UpgradeProfile` so no gateway can accept a signature produced by a sibling binary's release workflow.

```rust
pub const ALLOWED_SIGNERS: &[AllowedSigner] = &[AllowedSigner {
    issuer: "https://token.actions.githubusercontent.com",
    repo: "https://github.com/Bilbycast/bilbycast-appear-x-api-gateway",
    ref_pattern: "refs/tags/v*",
    workflow: "https://github.com/Bilbycast/bilbycast-appear-x-api-gateway/.github/workflows/nightly-release.yml",
}];

pub const PROFILE: UpgradeProfile = UpgradeProfile {
    repo: "Bilbycast/bilbycast-appear-x-api-gateway",
    binary_name: "bilbycast-appear-x-api-gateway",
    device_type: "appear_x",
    allowed_signers: ALLOWED_SIGNERS,
};
```

| `UpgradeProfile` field | Meaning |
|---|---|
| `repo` | `Bilbycast/<repo>`. The release base URL is derived as `https://github.com/<repo>/releases/download/v<version>`; the host is separately checked against a whitelist of `github.com`, `release-assets.githubusercontent.com` and `objects.githubusercontent.com`, https only. |
| `binary_name` | Filename of the binary inside the release tarball. |
| `device_type` | Must equal the `device_type` inside `manifest.json`, which the release workflow injects. A mismatch is rejected as `upgrade_manifest_invalid`. |
| `allowed_signers` | Identity allowlist, OR-ed: the Fulcio cert must satisfy all four claims of at least one entry. `issuer` and `repo` are exact string equality; `ref_pattern` is a `*`-suffix glob (`refs/tags/v*`); `workflow` is a **prefix** match, because the cert's SAN carries `<workflow>@<ref>`. No entry matches, and staging fails with `upgrade_identity_not_allowed`. An empty allowlist refuses every signature. |

The operator-facing policy is an `[upgrade]` section deserialised into `UpgradeConfig`:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. Off means `stage()` refuses with `upgrade_disabled`. |
| `allowed_channels` | `["stable"]` | Channel must appear here and match the manifest. |
| `min_version` | *(none)* | Floor; useful to stop a rollback undoing a fix. |
| `rollback_grace` | `1` | How many minor versions below current a downgrade may target. |
| `install_root` | `/opt/bilbycast/gateway` | Must match what your packaging uses, or the staged binary lands where the unit file will not find it. |
| `boot_health_window_secs` | `120` | Healthy-beat window before a staged version is promoted to stable. |
| `max_boot_attempts` | `3` | Exceeding this rolls the symlink back and exits. |
| `manual_only` | `false` | Verify and download, then stop **before** anything is written — see the note below. |

`manual_only` is not finished in the SDK as shipped, and the flag does not do what its name implies. `stage()` checks it *after* the download and returns an error carrying `upgrade_staged_manual`, ahead of extraction: no version directory, no `state.json`, no symlink change. The deferred half (`apply::manual_apply_pending`) looks for `state.json` in status `staged_manual`, and no code path ever writes that status, so there is nothing for it to apply. Leave it `false`.

Wiring it up, in order:

1. **Run the boot watchdog before any other init.** On a `pending_health` install it bumps the boot counter; past `max_boot_attempts` it reverts the `current` symlink, writes status `rolled_back`, queues a Critical `upgrade_rolled_back` event and calls `exit(1)` so systemd respawns the previous version. That first event never reaches the wire — the process exits immediately behind it. The next start reads the `rolled_back` status, re-emits the same Critical event, and *that* copy drains over the WebSocket on the first successful connect.
2. **Open an `mpsc` channel for `UpgradeEvent`** and build the `UpgradeCoordinator` from `PROFILE`, the config, the sender and `env!("CARGO_PKG_VERSION")` — before connecting, so the handler has it from the first frame.
3. **Spawn an event forwarder** that drains that channel into `Emitter::emit_event`, so upgrade lifecycle events ride the same path as vendor events.
4. **Add an `upgrade_binary` arm** to `handle_command`. The manager sends `{ "type": "upgrade_binary", "version", "channel", "target_arch"?, "variant"? }`; call `coord.stage(version, channel, target_arch, variant)`, then schedule `std::process::exit(0)` after a short drain — the SDK does not exit for you, and systemd respawns through the `current/` symlink. Route this arm even while your vendor client is still initialising: self-upgrade has to work when the target device is unreachable, otherwise you cannot ship a fix to a sidecar whose chassis is offline.
5. **Spawn the periodic watchdog and a healthy-beat ticker.** The watchdog wakes every 5 s and promotes `pending_health` → `stable` once `boot_health_window_secs` has elapsed since the version was staged **and** the newest healthy beat is no more than 60 s old, emitting `upgrade_completed`. Nothing stamps that beat for you — the ticker is yours to spawn (the template's runs every 15 s).
6. **Advertise `"upgrade"` on your health envelope** — see above.

`stage()` is single-flight and refuses concurrent calls with `upgrade_in_progress`. In order it checks: enabled, channel allowed, semver parse, the version window (`min_version` floor, no major-version crossing, not the version already installed, not more than `rollback_grace` minors behind), then fetches `manifest.json` + `manifest.sig.bundle`, verifies the bundle against `allowed_signers`, checks the manifest's version / channel / `device_type`, refuses a `sequence` that is not greater than the last installed one, picks the artefact matching the requested arch — or the detected one (`x86_64-linux` / `aarch64-linux`) when the manager named none — and the variant (`default` unless the manager asked for another), downloads the tarball against the SHA-256 the signed manifest carries, stages it into `install_root/versions/<v>/`, and writes `state.json`. Failures surface as stable `error_code` strings on the `command_ack`:

| Code | Raised when |
|---|---|
| `upgrade_disabled` | `[upgrade]` missing or `enabled = false`. |
| `upgrade_in_progress` | Another staging is already running. |
| `upgrade_channel_not_allowed` | Channel not in `allowed_channels`. |
| `upgrade_version_invalid` / `upgrade_version_too_old` | Bad semver, or outside the version window. |
| `upgrade_sequence_too_old` | Manifest `sequence` ≤ the last installed sequence. |
| `upgrade_identity_not_allowed` | Signing identity not in `allowed_signers`. |
| `upgrade_signature_invalid` / `upgrade_rekor_invalid` | Bundle or transparency-log verification failed. |
| `upgrade_manifest_invalid` | Version, channel or `device_type` mismatch, or unparseable manifest. |
| `upgrade_url_invalid` | The release base URL derived from `repo` fails the host/scheme check. A bad host on an *artefact* URL is caught by the manifest check instead and surfaces as `upgrade_manifest_invalid`. |
| `upgrade_arch_mismatch` | No artefact in the manifest for this `(arch, variant)` pair. A variant miss raises this same code — `upgrade_variant_mismatch` is defined in `error_codes` but no call site emits it. |
| `upgrade_checksum_mismatch` | Downloaded tarball does not match the signed SHA-256. |
| `upgrade_network_error` / `upgrade_extract_failed` | Transport failure fetching the manifest, bundle or tarball; or a failure unpacking and staging the tarball — a full disk lands on `upgrade_extract_failed` too, since `upgrade_disk_full` is likewise defined but never emitted. |
| `upgrade_staged_manual` | `manual_only = true` — returned as a *failed* ack even though the download verified. |

Release-side, the shared `scripts/build-manifest.sh` in the SDK produces the canonical `manifest.json` from your per-arch tarballs; sign it with `cosign sign-blob --bundle` (workflow `permissions:` needs `id-token: write`), then self-verify with `cosign verify-blob` against your own allowlist *before* publishing — that catches an allowlist/workflow-path mismatch in CI instead of in production. See [Remote Upgrade](/manager/remote-upgrade/) for the manager-side controls.

## Testing against a mock manager

`bilbycast-gateway-sdk/tests/integration_mock_manager.rs` stands up a local plaintext WebSocket server, drives the SDK through registration, reconnect, commands and close, and asserts on both directions of the wire. Copy it as your starting point — and remember it needs both plaintext keys set, which is the one place `allow_plaintext_ws` belongs.

## What the SDK deliberately does not do

- **Client-side event rate limiting.** The manager applies a per-node limit; if you expect alarm storms, self-gate below it. The Appear X gateway does this in its own `event_gate.rs`.
- **TOML parsing.** You own your config schema; `GatewayConfig` is only serde-compatible.
- **A vendor HTTP client.** Bring your own `reqwest` / `hyper`.
- **Wizards.** `WizardHandler`, `WizardDescriptor` and friends are exported from the crate root but nothing constructs, serialises or dispatches them, and the manager never reads a `wizards` field off a node. Declare wizards manager-side on the driver instead; each plan step reaches the gateway as an ordinary command, so what you need is one `handle_command` arm per action.
- **Manager-side concerns** — config templates, managed-entity push status, tunnel reconciliation. Those live in your `DeviceDriver` plugin crate.

## See also

- [Adding New Device Gateways](/appear-x-gateway/adding-new-device-gateways/) — the manager-side driver, end to end.
- [Appear X Gateway Overview](/appear-x-gateway/overview/) and [Architecture](/appear-x-gateway/architecture/) — the reference implementation.
- [Setup Guide](/appear-x-gateway/setup-guide/) — install layout, service account and systemd unit a gateway is expected to follow.
- [Manager Device Drivers](/manager/device-drivers/) — the driver contract on the other side of the wire.
