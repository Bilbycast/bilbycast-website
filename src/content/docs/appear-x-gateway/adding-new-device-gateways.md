---
title: Adding New Device Gateways
description: Use bilbycast-appear-x-api-gateway as a reference template for integrating any third-party broadcast device into the bilbycast manager via a sidecar API gateway plus a manager-side driver.
sidebar:
  order: 4
---

This guide explains how to create a new API gateway for a third-party broadcast device, using `bilbycast-appear-x-api-gateway` as the reference implementation. If you've never read the [Appear X Gateway Overview](/appear-x-gateway/overview/) or the [Manager Device Drivers](/manager/device-drivers/) page, start there first.

## When to use this pattern

Use the API gateway pattern when integrating a device that:

- Has its own REST / JSON-RPC / SOAP / gRPC API
- Cannot natively speak the bilbycast WebSocket protocol
- May be behind a firewall (the gateway connects outbound to the manager)
- Needs to appear in the bilbycast dashboard, topology, and AI assistant

If your device speaks something close enough to the bilbycast protocol that you'd rather extend the protocol than write a translator, talk to the manager team first — adding a new device type natively is also an option, but the sidecar pattern keeps the manager core small and the security boundary obvious.

## Two-part integration

Each third-party device requires two pieces:

1. **API gateway binary** — a standalone Rust project that bridges the device's native API to the manager's WebSocket protocol.
2. **Manager driver** — a `DeviceDriver` implementation in `bilbycast-manager` that defines metrics extraction, command validation, and AI actions.

The manager talks only to the gateway. The gateway talks to both the manager (over the standard bilbycast WebSocket) and the device (over its native protocol). To the manager, the gateway is indistinguishable from a real bilbycast edge.

## Step 1 — Create the gateway project

### Project layout

Copy the structure of `bilbycast-appear-x-api-gateway`:

```text
bilbycast-<device>-api-gateway/
├── Cargo.toml
├── CLAUDE.md
├── src/
│   ├── main.rs              # CLI, tokio runtime, GatewayClient
│   ├── config.rs            # TOML config parsing
│   ├── upgrade_profile.rs   # Signer allowlist for remote upgrade
│   └── <device>/
│       ├── mod.rs
│       ├── api_client.rs    # Device-specific API client
│       ├── polling.rs       # Polling engine (device-specific endpoints)
│       └── commands.rs      # Command handler (device-specific translation)
├── config/
│   └── example.toml
└── docs/
```

### What the SDK provides

The manager-facing half is the `bilbycast-gateway-sdk` crate, a dependency in `Cargo.toml` rather than code to copy:

| SDK module | Purpose |
|---|---|
| `ws_client.rs` | `GatewayClient`: manager connection, reconnect with exponential backoff and URL rotation, message loop |
| `auth.rs` | Registration and reconnect auth, and `CredentialStore`, which keeps `node_id` + `node_secret` in a `0600` file |
| `tls.rs` | Three TLS modes: standard CA, self-signed (gated by `BILBYCAST_ALLOW_INSECURE=1`), cert pinning (SHA-256) |
| `dispatch.rs` | The `CommandHandler` trait; its result is packed into a `command_ack` |
| `emit.rs` | `Emitter`: sends `stats`, `health`, `event` and `command_ack` messages |
| `upgrade/` | Sigstore-verified remote upgrade, given your `UpgradeProfile` |

See [Building a Gateway Sidecar](/appear-x-gateway/writing-a-gateway/) for its API.

### Device-specific modules

Replace the `appear_x/` directory with your device's API integration. Three responsibilities:

**API client** (`<device>/api_client.rs`)

- Handle device authentication (API keys, OAuth, session tokens, ...)
- Implement request / response for the device's protocol (REST, SOAP, gRPC, ...)
- Auto-retry on auth expiry
- Maintain its own TLS config (independent of the manager's TLS settings — see [Appear X Architecture](/appear-x-gateway/architecture/) for the rationale)

**Polling engine** (`<device>/polling.rs`)

- Define what to poll (status, config, alarms, metrics)
- Map device responses into bilbycast `stats` and `health` messages
- Health derivation: map device-specific severity to `ok` / `degraded` / `critical`
- Use independently-configurable intervals per data type (alarms might need 1 s, chassis state might need 30 s)

**Command handler** (`<device>/commands.rs`)

- Map manager command types to device API calls
- Handle read commands (return current state) and write commands (apply config changes)
- Return `command_ack` with success / error and an optional response payload

### Config format

Define device-specific config sections in `config.rs`:

```toml
[manager]
# Same for all gateways — this section builds the SDK's GatewayConfig.
# `urls` is a required list of 1–16 wss:// entries. There is no scalar
# `url` field and no default: the SDK rotates through the list on WS
# close, so a single-instance manager is a one-element list.
urls = ["wss://manager.example.com:8443/ws/node"]
registration_token = "..."
credentials_file = "credentials.json"
accept_self_signed_cert = false
# cert_fingerprint = "ab:cd:ef:01:23:..."   # colon-separated lowercase hex

[<device>]
# Device-specific connection settings
address = "192.168.1.100"
api_key = "..."
accept_self_signed_cert = true   # Independent of manager TLS

[polling]
# Device-specific — you define this section's shape in your own config.rs.
# The Appear X gateway's keys, as a worked example:
alarms_interval_secs = 10
chassis_interval_secs = 30
inputs_interval_secs = 15
outputs_interval_secs = 15
cards_interval_secs = 30
```

Only `[manager]` is fixed — it is what the SDK's `GatewayConfig` is built from, and both shipped gateways spell it the same way. Everything below it is yours.

Resist the urge to make per-slot / per-board layout a config section. The Appear X gateway has none: it runs a capability-discovery pass against the chassis at startup, reads the populated slots and their card software, then spawns polling tasks only for the interface families that firmware actually exposes. Hand-written slot tables go stale against a firmware upgrade and turn into "Method not found" spam; discovery does not.

## Step 2 — Create the manager driver

A driver is a plugin crate of its own under `bilbycast-manager/crates/`, beside `device-edge`, `device-relay` and `device-appear-x`. This step is the short version; [Adding a Device Type](/manager/adding-a-device-type/) is the full one, with the trait method by method and the optional browser-side plugin.

### Driver crate

```text
crates/device-<device>/
├── Cargo.toml
└── src/
    └── lib.rs          # the DeviceDriver impl
```

```toml
[package]
name = "device-<device>"
version.workspace = true
edition.workspace = true
license-file = "../../LICENSE"
description = "My Device driver plugin for bilbycast-manager"

[lints]
workspace = true

[dependencies]
manager-core = { workspace = true }
serde_json = { workspace = true }
```

In the workspace's root `Cargo.toml`, add `"crates/device-<device>"` to `members` and `device-<device> = { path = "crates/device-<device>" }` under `[workspace.dependencies]`.

`src/lib.rs` implements `DeviceDriver`, the trait in `crates/manager-core/src/drivers/mod.rs`. All of the methods below but `ai_actions()` are required. `crates/device-appear-x/src/lib.rs` is the shipped example of a gateway-fronted device.

```rust
use manager_core::drivers::{
    ActionCategory, ActionUiHints, AiActionDescriptor, AiDeviceContext,
    CommandDescriptor, DeviceDriver, DeviceMetricsSummary,
};

pub struct MyDeviceDriver;

impl MyDeviceDriver {
    pub fn new() -> Self { Self }
}

impl Default for MyDeviceDriver {
    fn default() -> Self { Self::new() }
}

impl DeviceDriver for MyDeviceDriver {
    fn device_type(&self) -> &str { "<device>" }
    fn display_name(&self) -> &str { "My Device Name" }

    fn extract_metrics(&self, stats: &serde_json::Value) -> DeviceMetricsSummary {
        // Parse the stats JSON sent by your gateway's polling engine
    }

    fn extract_health_status(&self, health: &serde_json::Value) -> Option<String> {
        // Map your gateway's health messages to "ok"/"degraded"/"critical"
    }

    fn supported_commands(&self) -> Vec<CommandDescriptor> {
        // List the commands your gateway handles
    }

    fn validate_command(&self, action: &serde_json::Value) -> Result<(), String> {
        // Validate command payloads before they leave the manager
    }

    fn ai_context(&self) -> Option<AiDeviceContext> {
        // Provide protocol docs and config schema for the AI assistant
    }

    fn ai_actions(&self) -> Vec<AiActionDescriptor> {
        // Worked examples of your write commands for the AI assistant:
        // a prompt description and the {"command", "args"} params for each.
    }
}
```

### AI actions

The manager's AI assistant can propose the commands in your `supported_commands()` table (reads excepted — it has read tools for those) through its generic device-command action, which goes through `POST /api/v1/nodes/{id}/command` — validated by your `validate_command()`, role-checked from your command catalogue — and is applied only when an operator applies the proposal. The descriptors you return from `ai_actions()` are shown to the model as worked examples of those commands, and your `ai_context()` text is the topic it reads to learn your device.

Write each descriptor's `ai_prompt_example` as the params of that device-command step, in JSON — `{"command": "set_ip_input", "args": {"slot": 1, "inputs": [...]}}`, where `args` is what your `validate_command()` receives beside `type` — and describe in `ai_prompt_description` when to use it. Give examples only for commands the assistant may propose: a read, or a command one of the assistant's own actions owns, is left out of what the model sees. Set `category` to `ConfigAction` for a command carrying a config payload and `SimpleAction` otherwise; `ui_hints` is not read by anything any more, so fill it with plain labels and `execution_mode: "command"`.

### Register the driver

Add `device-<device> = { workspace = true }` to `crates/manager-server/Cargo.toml`, and one line to `production_driver_registry()` in `crates/manager-server/src/lib.rs` (the crate's name with underscores):

```rust
registry.register(std::sync::Arc::new(device_<device>::MyDeviceDriver::new()));
```

Add the device type to `EXPECTED_DEVICE_TYPES` in `crates/manager-server/tests/driver_contract.rs` too: that suite runs every registered driver against the trait and fails when the two lists differ.

## Step 3 — Test end-to-end

1. Build and run the manager with the new driver registered.
2. Create a node in the manager UI with `device_type: "<device>"` and copy the registration token.
3. Configure and run your gateway with that registration token.
4. Verify that:
   - The node appears online on the dashboard.
   - Stats populate from polling.
   - Health status reflects device state.
   - The AI assistant can describe the node, and propose its commands for an operator to apply.
   - Commands execute through the full chain: UI → manager → WebSocket → gateway → device → ack → UI.

## Reference: what the Appear X gateway does

To make the abstract template concrete, the Appear X gateway is built from three parts. Two run as concurrent top-level tasks — the SDK `GatewayClient` (WebSocket client) and the polling engine — while the command handler is a `CommandHandler` trait the SDK read loop invokes inline (not a separately spawned task):

| Part | Source | Purpose |
|---|---|---|
| WebSocket client (SDK `GatewayClient`) | `bilbycast-gateway-sdk` | Connects to manager, handles auth, sends stats/health, receives commands; its read loop dispatches each command inline |
| Polling engine | `appear_x/polling.rs` | Periodically calls Appear X JSON-RPC methods, maps responses to manager stats/health messages |
| Command handler | `appear_x/commands.rs` | `CommandHandler` trait invoked inline by the SDK read loop; translates each command to Appear X JSON-RPC calls and returns the value the SDK packs into `command_ack` |

It polls a range of data types (alarms, chassis, IP inputs, IP outputs, services, IP interfaces, plus card status, XGER config, and uptime) at independently-configurable intervals — with configurable SFP RX-level and temperature thresholds — derives health from alarm severity (`MAJOR`/`CRITICAL` → critical, `MINOR`/`WARNING` → degraded, none → ok), and translates 73 distinct manager command types into Appear X JSON-RPC calls.

The manager-side `AppearXDriver` lives in the `device-appear-x` plugin crate (`crates/device-appear-x/src/lib.rs`) and exposes its AI actions all in `command` execution mode.

## Suggested next steps

Once your gateway works:

- Open a PR adding your gateway to the bilbycast manager's documented device list so operators can find it.
- Consider contributing the manager-side driver upstream so future managers ship with built-in support for your device.
