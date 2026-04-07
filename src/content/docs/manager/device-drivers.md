---
title: Device Drivers
description: How the bilbycast-manager driver-aware action framework lets third-party broadcast devices plug into the same UI, AI workflow, and audit trail as native edges.
sidebar:
  order: 7
---

bilbycast-manager has a **driver-aware** architecture: every device type (edge, relay, Appear X, ...) registers a `Driver` implementation that contributes to the WebSocket protocol, REST surface, topology rendering, and AI assistant workflow. Adding support for a new third-party device is a matter of writing a driver and (usually) a sidecar API gateway — no manager core changes required.

This page is for developers integrating new device types. Operators using existing drivers don't need to read it.

## What a driver provides

A driver is a Rust trait implementation in `bilbycast-manager/crates/manager-core/src/drivers/`. It supplies:

| Function | Purpose |
|---|---|
| Device type identifier | The string used in `node.device_type` (e.g., `"edge"`, `"appear_x"`) |
| Validation | Checks an incoming `command` payload before execution and returns descriptive errors |
| Execution | Performs the validated command — typically by sending a WebSocket message to the device |
| Action descriptors | Structured definitions of every action the driver exposes to the AI assistant and generic UI |
| Topology rendering hints | Icon, colour, derived health, list of "ports" (inputs / outputs) |
| Health derivation | Maps the driver's native event/alarm format into the manager's `Healthy` / `Warning` / `Critical` model |
| AI context contribution | A short text block describing the driver's protocol semantics, included in AI-assistant prompts |

The trait is designed so that **everything that varies per device type lives in the driver**, and everything that's shared (auth, push status, ghost cleanup, audit, RBAC) lives in the manager core.

## How drivers integrate with the rest of the system

```text
                    ┌──────────────────────────┐
                    │     Manager core         │
                    │   (auth, RBAC, audit,    │
                    │    push status, sync)    │
                    └────────────┬─────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
  ┌───────────┐           ┌───────────┐            ┌──────────────┐
  │ EdgeDriver │           │ RelayDriver│            │ AppearXDriver│
  └─────┬─────┘           └─────┬─────┘            └──────┬───────┘
        │                       │                         │
        │ WebSocket             │ WebSocket               │ WebSocket
        ▼                       ▼                         ▼
   bilbycast-edge          bilbycast-relay      bilbycast-appear-x-api-gateway
                                                        │
                                                        │ JSON-RPC over HTTPS
                                                        ▼
                                                  Appear X chassis
```

The pattern is the same for every driver: the manager core talks to a Rust process (the device or its sidecar gateway) over the standard bilbycast WebSocket protocol. The sidecar takes responsibility for translating between the bilbycast protocol and the device's native API.

## Two-part pattern: driver + sidecar gateway

For a third-party device that doesn't natively speak the bilbycast WebSocket protocol, the recommended pattern is **driver + sidecar**:

1. **Manager-side driver** — A Rust module in `bilbycast-manager/crates/manager-core/src/drivers/<vendor>.rs` that implements the `Driver` trait and exposes vendor-specific actions to the manager.
2. **Sidecar API gateway** — A standalone Rust binary that maintains a persistent WebSocket connection to the manager (using the same auth as a real edge or relay) and translates manager commands into the device's native API calls. It also polls the device for stats / health / alarms and forwards them as bilbycast `stats` / `health` / `event` messages.

The sidecar runs anywhere it can reach the device and the manager — usually colocated with the device. From the manager's perspective, it looks identical to a native bilbycast node.

[`bilbycast-appear-x-api-gateway`](/appear-x-gateway/overview/) is the reference implementation of this pattern. Its source layout is intended to be copy-able as a template — see [Adding New Device Gateways](/appear-x-gateway/adding-new-device-gateways/).

## Action descriptors

Action descriptors are how a driver advertises its operations to the manager. Each descriptor includes:

```rust
pub struct ActionDescriptor {
    pub name: &'static str,           // e.g., "appear_x.set_ip_input"
    pub display_name: &'static str,   // human-readable label
    pub description: &'static str,    // sent to the AI assistant
    pub parameters: ParameterSchema,  // JSON-schema-like structure
    pub preview_template: &'static str,
    pub execution_mode: ExecutionMode,
    pub required_role: Role,
}
```

- **`name`** — namespaced (`<driver>.<action>`) so descriptors from multiple drivers don't collide.
- **`description`** — fed verbatim into the AI assistant's system prompt. Be specific about what the action does and what its preconditions are.
- **`parameters`** — used by both the AI assistant (to know what fields to fill in) and the generic UI renderer (to draw a form).
- **`preview_template`** — generates the human-readable diff card the operator sees before confirming.
- **`execution_mode`** — one of `command`, `flows_create`, `flows_delete`, `tunnels_create`, `tunnels_delete`. See [AI Assistant](/manager/ai-assistant/#execution-modes).
- **`required_role`** — RBAC level required to execute this action (`Viewer`, `Operator`, `Admin`, `SuperAdmin`).

When a new driver is registered, its descriptors are added to the global descriptor registry and immediately:

- Become callable via the REST API (`POST /api/v1/devices/{id}/actions/{name}`).
- Are visible to the AI assistant.
- Render in the generic action UI in the manager web app.

## Health derivation

Each driver maps its device's native event/alarm format into the manager's tri-state health model:

| State | When |
|---|---|
| `Healthy` | All flows / tunnels / inputs are running and no active critical alarms |
| `Warning` | Degraded service: minor alarms, partial outages, congestion |
| `Critical` | Service-impacting failure: major alarms, no input lock, dead device |

The Appear X driver, for example, derives this from the alarm severity field in the Appear X JSON-RPC API:

| Appear X severity | Manager health |
|---|---|
| `MAJOR`, `CRITICAL` | `Critical` |
| `MINOR`, `WARNING` | `Warning` |
| (no alarms) | `Healthy` |

The mapping is internal to the driver — the manager core doesn't need to know about Appear X severity classes.

## Topology rendering

Drivers contribute to the topology view by providing:

- A node icon (SVG glyph or image URL)
- A node colour (hex or named theme)
- A list of "ports" — abstract inputs and outputs the device exposes, used to draw flow links between devices

The graph view (force-directed) and flow view (deterministic columns) both consume this driver-supplied metadata, so a third-party device automatically appears in topology with no extra UI work.

## Walking through `AppearXDriver`

To make this concrete, here's how `AppearXDriver` (in `manager-core/src/drivers/appear_x.rs`) implements each piece:

| Piece | What `AppearXDriver` does |
|---|---|
| `device_type` | Returns `"appear_x"` |
| `validate(command)` | Validates Appear X-specific payloads (IP input/output addressing, slot/board IDs in hex) |
| `execute(command)` | Sends the command to the connected sidecar over the existing WebSocket; the sidecar handles JSON-RPC translation |
| `action_descriptors()` | Returns 7 descriptors (`set_ip_input`, `set_ip_output`, `get_inputs`, `get_outputs`, `get_services`, `get_alarms`, `get_chassis`) |
| `derive_health(stats)` | Reads alarm severity counts from the latest stats and maps to `Healthy`/`Warning`/`Critical` |
| `topology_metadata()` | Provides the Appear X icon, colour, and a port list synthesised from the chassis layout |
| `ai_context()` | Returns a short Appear X protocol primer the AI assistant can use to generate sensible commands |

The full source is in `bilbycast-manager/crates/manager-core/src/drivers/appear_x.rs`.

## Adding a new driver

The high-level steps are:

1. Create a new module `manager-core/src/drivers/<vendor>.rs` and implement the `Driver` trait.
2. Register the driver in `manager-core/src/drivers/mod.rs` so the manager core discovers it at startup.
3. (Optional but recommended) Build a sidecar gateway as a standalone Rust binary — copy the layout of `bilbycast-appear-x-api-gateway/`.
4. Add a docs page describing the device type, the sidecar setup, and any vendor-specific configuration.
5. Add unit tests for the validation and action-descriptor surfaces.

For a step-by-step walkthrough using Appear X as the worked example, see [Adding New Device Gateways](/appear-x-gateway/adding-new-device-gateways/).
