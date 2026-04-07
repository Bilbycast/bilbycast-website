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
│   ├── main.rs              # CLI, config, tokio runtime
│   ├── config.rs            # TOML config parsing
│   ├── credentials.rs       # Node credential persistence (reuse as-is)
│   ├── ws/
│   │   ├── mod.rs
│   │   ├── client.rs        # WebSocket client (reuse as-is)
│   │   ├── tls.rs           # TLS config (reuse as-is)
│   │   └── message.rs       # WsEnvelope builders (reuse as-is)
│   └── <device>/
│       ├── mod.rs
│       ├── api_client.rs    # Device-specific API client
│       ├── polling.rs       # Polling engine (device-specific endpoints)
│       └── commands.rs      # Command handler (device-specific translation)
├── config/
│   └── example.toml
└── docs/
```

### Reusable modules

The `ws/` directory and `credentials.rs` are device-agnostic and can be copied directly:

| Module | Purpose |
|---|---|
| `ws/client.rs` | Manager connection, auth (registration + reconnection), reconnect with exponential backoff, message loop, command dispatch |
| `ws/tls.rs` | Three TLS modes: standard CA, self-signed (gated by `BILBYCAST_ALLOW_INSECURE=1`), cert pinning (SHA-256) |
| `ws/message.rs` | `WsEnvelope` builders for `stats`, `health`, `event`, `command_ack` messages |
| `credentials.rs` | `node_id` + `node_secret` persistence with `0600` permissions |

When a second gateway exists, these should be extracted into a shared crate (`bilbycast-gateway-common`).

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
# Same for all gateways — manager URL, auth, TLS settings
url = "wss://manager.example.com"
registration_token = "..."
credentials_file = "credentials.json"
accept_self_signed_cert = false
# cert_fingerprint = "sha256:..."

[<device>]
# Device-specific connection settings
address = "192.168.1.100"
api_key = "..."
accept_self_signed_cert = true   # Independent of manager TLS

[polling]
# Device-specific polling intervals (seconds)
alarms = 5
inputs = 10
outputs = 10
chassis = 30

[[polling.boards]]
slot = 1
interface_version = "1.15"
```

## Step 2 — Create the manager driver

### Driver file

Create `bilbycast-manager/crates/manager-core/src/drivers/<device>.rs`:

```rust
use super::{
    ActionCategory, ActionUiHints, AiActionDescriptor, AiDeviceContext,
    CommandDescriptor, DeviceDriver, DeviceMetricsSummary,
};

pub struct MyDeviceDriver;

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
        // Define AI actions with prompt instructions and UI hints.
        // All third-party device actions should use execution_mode: "command".
    }
}
```

### AI actions

When defining `ai_actions()`, use `execution_mode: "command"` for all actions. This routes through the generic `POST /api/v1/nodes/{id}/command` endpoint, which the manager forwards via WebSocket to your gateway.

For **`ConfigAction`** category (complex payloads):

- Set `payload_key` to the JSON key holding the config (e.g., `"inputs"`, `"profile"`)
- Set `preview_type` to `"generic"` (renders a key-value card) or implement a custom preview component

For **`SimpleAction`** category (buttons):

- Pick an appropriate `button_style`: `"info"` (blue), `"apply"` (green), `"delete"` (red), `"stop"` (orange)

### Register the driver

Add to `bilbycast-manager/crates/manager-server/src/main.rs`:

```rust
driver_registry.register(Arc::new(
    manager_core::drivers::<device>::MyDeviceDriver::new()
));
```

And add `pub mod <device>;` to `manager-core/src/drivers/mod.rs`.

## Step 3 — Test end-to-end

1. Build and run the manager with the new driver registered.
2. Create a node in the manager UI with `device_type: "<device>"` and copy the registration token.
3. Configure and run your gateway with that registration token.
4. Verify that:
   - The node appears online on the dashboard.
   - Stats populate from polling.
   - Health status reflects device state.
   - The AI assistant offers device-specific actions.
   - Commands execute through the full chain: UI → manager → WebSocket → gateway → device → ack → UI.

## Reference: what the Appear X gateway does

To make the abstract template concrete, the Appear X gateway runs three concurrent tasks:

| Task | Source | Purpose |
|---|---|---|
| WebSocket client | `ws/client.rs` | Connects to manager, handles auth, sends stats/health, receives commands |
| Polling engine | `appear_x/polling.rs` | Periodically calls Appear X JSON-RPC methods, maps responses to manager stats/health messages |
| Command handler | `appear_x/commands.rs` | Receives commands from manager via the WS client, translates them to Appear X JSON-RPC calls, returns ack |

It polls six data types (alarms, chassis, IP inputs, IP outputs, services, IP interfaces) at independently-configurable intervals, derives health from alarm severity (`MAJOR`/`CRITICAL` → critical, `MINOR`/`WARNING` → degraded, none → ok), and translates eight manager command types into Appear X JSON-RPC calls.

The manager-side `AppearXDriver` lives in `manager-core/src/drivers/appear_x.rs` and exposes seven AI actions, all in `command` execution mode.

## Suggested next steps

When you have your second gateway working:

- Extract `ws/`, `credentials.rs`, and any other device-agnostic helpers into a shared `bilbycast-gateway-common` crate.
- Open a PR adding your gateway to the bilbycast manager's documented device list so operators can find it.
- Consider contributing the manager-side driver upstream so future managers ship with built-in support for your device.
