---
title: Adding a Device Type
description: Developer walkthrough for teaching bilbycast-manager a new kind of device — the DeviceDriver trait as declared, the per-device plugin crate, its browser-side JS module, and the CI job that gates that tree.
sidebar:
  order: 8
---

Every managed device in bilbycast-manager — edge, relay, Appear X — is a **compile-time plugin**: one workspace crate implementing the `DeviceDriver` trait, registered on a `DriverRegistry` at startup, optionally paired with a browser-side JavaScript module. The hub, database schema, REST routes, WebSocket protocol, events, audit log, export and AI assistant are all device-type-agnostic and work for a new type the moment it is registered.

This page is for developers adding one. Operators using the shipped drivers do not need it — see [Device Drivers](/manager/device-drivers/) for what a driver contributes at runtime.

## Pick your path first

There is one question to answer before writing any code: does the device run our Rust, or does it expose a proprietary API somebody has to translate?

| | **First-party node** | **Third-party vendor unit** |
|---|---|---|
| Examples | bilbycast-edge, bilbycast-relay | Appear X, and any vendor chassis with its own API |
| Who speaks the manager WebSocket? | The node binary itself | A **gateway sidecar**, one per chassis |
| Manager-side work | Driver: metadata, stats parsing, command validation | Driver: metadata and AI actions, mostly |
| Device-side work | A whole node binary | A sidecar translating vendor API ↔ bilbycast WebSocket |

**Both paths build the same manager-side driver.** The difference is only whether the WebSocket-speaking process is native or a translation shim. For the sidecar half, see [Adding New Device Gateways](/appear-x-gateway/adding-new-device-gateways/); everything below is the manager side, which you need either way.

## The plugin crate

A driver is one crate per device type under `bilbycast-manager/crates/device-<name>/`. The three shipped ones are the whole population, and the smallest by a wide margin — `device-relay`, ~520 lines across three files — is the sensible thing to copy. `device-appear-x` is a single 3,400-line `lib.rs`; `device-edge` spreads the full flow / input / output / assembly surface over seven modules and is a poor starting point unless you need all of it.

```text
crates/device-relay/
├── Cargo.toml
└── src/
    ├── lib.rs          ← the DeviceDriver impl
    └── reconcile.rs    ← the reconnect callback
```

The manifest is short, and the `[lints]` stanza is the one line worth understanding. CI runs `cargo clippy --all-targets --workspace -- -D warnings`, and `[workspace.lints.clippy]` is four documented `allow` entries — `doc_lazy_continuation`, `doc_overindented_list_items`, `new_without_default`, `type_complexity`. Inheriting them is opt-in per crate, so a manifest without this stanza re-arms all four as denials against the rest of the workspace's conventions:

```toml
[package]
name = "device-widget"
version.workspace = true
edition.workspace = true
license-file = "../../LICENSE"
description = "Widget device driver plugin for bilbycast-manager"

[lints]
workspace = true

[dependencies]
manager-core = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
```

Then two edits to the workspace root `bilbycast-manager/Cargo.toml` — add `"crates/device-widget"` to `members`, and `device-widget = { path = "crates/device-widget" }` under `[workspace.dependencies]`.

`manager-core` is framework-free by design: it has no Axum dependency, and neither should your crate. Anything that needs the HTTP layer belongs in `manager-server`.

## The `DeviceDriver` trait

Declared in `crates/manager-core/src/drivers/mod.rs`. **Seven methods are required** — omit one and the crate does not compile — and sixteen more are default-implemented extension points you override only where your device actually does the thing.

### Required

| Method | Signature | What it does |
|---|---|---|
| `device_type` | `&self -> &str` | The string stored in `nodes.device_type` and accepted by `POST /api/v1/nodes`. Once shipped it is a database value and a bookmark — renaming it is a migration |
| `display_name` | `&self -> &str` | Human label, e.g. `"Relay Server"` |
| `extract_metrics` | `(&serde_json::Value) -> DeviceMetricsSummary` | Rolls the node's cached stats into `{ metrics: Vec<(String, Value)>, items: Vec<Value> }` for the dashboard |
| `extract_health_status` | `(&serde_json::Value) -> Option<String>` | Free-form status string. No enum, no normalisation |
| `supported_commands` | `&self -> Vec<CommandDescriptor>` | The command catalogue: `{ name, description, requires_role }` |
| `validate_command` | `(&serde_json::Value) -> Result<(), String>` | Pre-flight on `POST /api/v1/nodes/{id}/command`; an `Err` becomes a 422 before the WebSocket round-trip |
| `ai_context` | `&self -> Option<AiDeviceContext>` | `{ protocol_docs, config_schema }` — return `None` if your device has no AI surface |

Two of these are required by the trait but have **no production caller today**: nothing outside the driver-contract test invokes `extract_health_status` (the hub caches and serves the node's health payload verbatim), and nothing reads the `AiDeviceContext` a driver returns. Implement them — the crate will not compile otherwise — but do not spend a week on either.

### Extension points

All default-implemented. The right-hand column is what the manager does with your override **today**, which is not the same as what the method is named after.

| Method | Default | Where it is actually read |
|---|---|---|
| `ai_actions` | `vec![]` | Serialized onto `GET /api/v1/device-types` and `/{type}` — and nowhere else. No UI module fetches them, and the AI request path never touches the driver registry |
| `wizards` | `vec![]` | The Services wizard catalogue |
| `wizard_field_ui` | `vec![]` | Composed onto the serialized wizard descriptors — form ergonomics only, never validation |
| `build_wizard_plan` | `Err(WizardError::UnknownWizard)` | Called by the wizard runner after it has validated the operator's submission against your descriptor |
| `validate_payload` | `Ok(())` | Dispatched for exactly three kinds today: `"channel_map"` and `"flow_group"` (ST 2110 routes) and `"flow_assembly"` (the PID-bus route). The rustdoc lists more; nothing forwards them yet |
| `managed_entity_kinds` | `&[]` | The registry's consistency check (below), and the device-type metadata |
| `reconnect_behavior` | `ReconnectBehavior::None` | The hub, on every reconnect |
| `tunnel_legs` | `&[]` | Tunnel push-status updates, via `TunnelLeg::as_push_status_key()` |
| `needs_tunnel_names` | `false` | The hub, to decide whether to pay a database lookup per stats frame |
| `enrich_stats` | no-op | The hub, on each inbound stats message |
| `ws_commands` | derived from `supported_commands()` | Introspection metadata |
| `rest_routes` | `vec![]` | **Nothing.** `DriverRegistry::all_rest_routes()` has no consumer — declaring a route here does not mount it |
| `permissions` | `&[]` | Serialized onto the device-type metadata, plus a test asserting ids are unique across drivers. **Not** fed to the RBAC matrix — no authorization decision reads a driver permission |
| `migrations` | `&[]` | Only a test, asserting names are unique across drivers. See the warning below |
| `ui_capabilities` | `UiCapabilities::default()` | The registry's consistency check, and the device-type metadata |
| `to_api_metadata` | assembled from the others | Override only to change *what* the assembled metadata reports. It cannot add fields: `DeviceTypeMetadata` is a fixed nine-field struct and the handler builds its JSON from named fields |

:::caution[`DriverMigration` is declared but never executed]
The trait has a `migrations()` slot and `DriverMigration { version, name, up_sql, down_sql }` compiles fine. Nothing runs it: every `sqlx::migrate!` in the workspace points at `migrations-pg/` and nothing else, and the only consumer of `all_migrations()` is a test that checks name uniqueness without touching a database. A migration declared here compiles, passes the contract test, and silently ships a table that is never created.

Put any new table in `migrations-pg/` with a driver-namespaced filename instead.
:::

## A minimum-viable driver

This is the whole of it — seven methods, no extension points, and it registers a usable device type. The runnable version lives at `crates/manager-core/examples/minimal-device-plugin.rs`; `cargo check --example minimal-device-plugin -p manager-core` keeps it honest.

```rust
use manager_core::drivers::{
    AiDeviceContext, CommandDescriptor, DeviceDriver, DeviceMetricsSummary,
};

pub struct WidgetDriver;

impl DeviceDriver for WidgetDriver {
    fn device_type(&self) -> &str { "widget" }
    fn display_name(&self) -> &str { "Widget Encoder" }

    fn extract_metrics(&self, stats: &serde_json::Value) -> DeviceMetricsSummary {
        let uptime = stats.get("uptime_secs").and_then(|v| v.as_u64()).unwrap_or(0);
        DeviceMetricsSummary {
            metrics: vec![("uptime_secs".into(), serde_json::json!(uptime))],
            items: vec![],
        }
    }

    fn extract_health_status(&self, health: &serde_json::Value) -> Option<String> {
        health.get("status").and_then(|s| s.as_str()).map(String::from)
    }

    fn supported_commands(&self) -> Vec<CommandDescriptor> {
        vec![CommandDescriptor {
            name: "get_config".into(),
            description: "Request the widget's current configuration".into(),
            requires_role: "operator".into(),
        }]
    }

    fn validate_command(&self, action: &serde_json::Value) -> Result<(), String> {
        action.get("type").and_then(|t| t.as_str())
            .ok_or_else(|| "Command must have a 'type' field".to_string())
            .map(|_| ())
    }

    fn ai_context(&self) -> Option<AiDeviceContext> { None }
}
```

That is a bare unit struct, which the registration snippet further down does not construct — it calls `WidgetDriver::new()`, the shape every shipped driver uses. Add the constructor, and pair it with a `Default` impl the way `device-edge`, `device-relay` and `device-appear-x` all do:

```rust
impl WidgetDriver {
    pub fn new() -> Self { Self }
}

impl Default for WidgetDriver {
    fn default() -> Self { Self::new() }
}
```

### `requires_role` is enforced, and it fails closed

`CommandDescriptor.requires_role` is a free-form `String`, but `POST /api/v1/nodes/{id}/command` resolves it to a permission before sending anything:

| `requires_role` | Permission required on the node |
|---|---|
| `"viewer"` or `"view"` | View |
| `"operator"` or `"operate"` | Operate |
| anything else, including a typo | Manage |

A command **absent** from your catalogue keeps the caller's baseline Operate gate rather than escalating — the catalogue is introspection metadata, not an allowlist, and the WebSocket dispatches by string with catch-all arms, so an undeclared-but-valid command must not start returning 403. A misspelled role, on the other hand, is treated as the strictest tier: a driver naming a role the mapping does not know means "stricter than operate" far more often than it means "anyone".

Command payloads are capped at 50 KB (100 KB for a config push) before the driver is consulted.

## Managed inventory and reconnect

If the manager creates entities that live on your node — flows, inputs, outputs, tunnels, flow groups — declare them and hand the hub a reconcile callback. `ManagedEntityKind` is `Flow`, `Input`, `Output`, `Tunnel`, `FlowGroup`, or `Custom(String)` for a vendor-defined kind.

```rust
const WIDGET_KINDS: &[ManagedEntityKind] = &[ManagedEntityKind::Input];

fn managed_entity_kinds(&self) -> &[ManagedEntityKind] { WIDGET_KINDS }

fn reconnect_behavior(&self) -> ReconnectBehavior {
    ReconnectBehavior::ManagedInventory {
        kinds: WIDGET_KINDS,
        reconcile_fn: crate::reconcile::widget_reconcile_on_reconnect,
    }
}
```

The callback is a plain `fn(ReconnectCtx) -> ReconcileHandle`. `ReconnectCtx` carries `node_id`, `device_type`, a `sqlx::PgPool`, and `hub: Arc<dyn NodeHubHandle>` — the abstract hub handle, which is how a plugin crate re-pushes and reconciles without depending on `manager-server`. The relay's is the whole of a working one:

```rust
pub fn relay_reconcile_on_reconnect(ctx: ReconnectCtx) -> ReconcileHandle {
    ReconcileHandle::new(async move {
        let hub = ctx.hub.clone();
        let node_id = ctx.node_id.clone();
        hub.push_pending_tunnels(&node_id).await;
        hub.reconcile_node_config(&node_id).await;
        Ok(())
    })
}
```

`NodeHubHandle` exposes `push_pending_tunnels`, `push_pending_inputs`, `push_pending_outputs`, `push_pending_flows` and `reconcile_node_config` — the last sleeping 5 seconds for the pushes to land before it fetches the node's running config and diffs it. Order matters when kinds reference each other: push inputs and outputs before flows, or the flow arrives naming IDs the node does not have yet.

The hub reads the `reconcile_fn` and **ignores the `kinds` field** at the reconnect site; the kinds are what the registry checks and what the metadata endpoint reports.

`tunnel_legs()` names which per-leg push-status column on the `tunnels` table your device populates — `Ingress`, `Egress`, `Relay`, `SecondaryRelay`, mapping to `ingress` / `egress` / `relay` / `secondary_relay`.

## Flows and Tunnels are paired declarations

Three declarations surround a device type's flows. Only one of them actually feeds a renderer, and the other two are welded to each other at startup — keep them straight:

1. The node emits `stats.flows[]` on every stats envelope, keyed by a `flow_id` that is **stable across polls**. **This is the one the UI reads**: `pages/flows.js` indexes live rows by `flow_id`, so an id that changes each snapshot makes every poll a new row.
2. The driver claims `ManagedEntityKind::Flow` in `managed_entity_kinds()`.
3. The driver lists `UiSection::Flows` in `ui_capabilities().shows_sections`.

`Tunnels` follows the identical shape: `tunnels[]` on stats ↔ `ManagedEntityKind::Tunnel` ↔ `UiSection::Tunnels`.

Declarations 2 and 3 are, today, purely declarative. Nothing at render time reads `shows_sections` — the Flows page renders from `node.flows`, and Topology from the built-in flow / tunnel endpoints or your plugin's `extractEndpoints()` — and nothing in the reconciler reads `managed_entity_kinds()`. Both are published on the device-type metadata, and both are checked against each other at boot.

:::danger[Half a pair panics the manager at boot]
`DriverRegistry::register` calls `assert_section_inventory_pair_consistent` and **panics** if a driver declares one side of the (`UiSection::Flows`, `ManagedEntityKind::Flow`) or (`UiSection::Tunnels`, `ManagedEntityKind::Tunnel`) pair without the other. The panic names which half is present, which is missing, and the method the missing one belongs in. Registration runs in `main.rs` at startup, so a mismatched driver takes the process down on its first boot instead of shipping a half-declared device type.
:::

`UiCapabilities` also carries `list_in_topology`, `list_in_dashboard`, `accent_color`, `custom_pages`, and `has_external_target` (set it for a gateway-fronted device, which turns on the dashboard's third "Target down" amber state and the Gateway Module detail header). The available `shows_sections` values are `inventory`, `flows`, `tunnels`, `io`, `config_editor`, `events`, `thumbnails`, `st2110`, `topology`, `ai_assistant` and `custom_config`.

Note that `accent_color` is served on `GET /api/v1/device-types` but no renderer reads it — the topology canvas still picks its own colours from the device type.

## Registering the driver

Three edits, all in `manager-server`:

```rust
// crates/manager-server/src/main.rs
let mut driver_registry = manager_core::drivers::DriverRegistry::new();
driver_registry.register(Arc::new(device_edge::EdgeDriver::new()));
driver_registry.register(Arc::new(device_relay::RelayDriver::new()));
driver_registry.register(Arc::new(device_appear_x::AppearXDriver::new()));
driver_registry.register(Arc::new(device_widget::WidgetDriver::new())); // NEW
```

Add `device-widget = { workspace = true }` to `crates/manager-server/Cargo.toml`, and extend **both** `build_registry()` and `EXPECTED_DEVICE_TYPES` in `crates/manager-server/tests/driver_contract.rs` — that suite rebuilds the registry the way `main.rs` does and asserts the two lists agree, so a driver registered in only one place fails the test rather than drifting quietly.

Registering is enough to create nodes. `POST /api/v1/nodes` validates `device_type` against the registry and rejects an unknown one with a 400; omitting the field defaults to `"edge"`. Filter with `GET /api/v1/nodes?device_type=widget`, and introspect the driver at `GET /api/v1/device-types/widget`.

## The browser-side plugin

Per-driver UI lives in **vanilla JavaScript** at `crates/manager-server/src/ui/static/js/devices/<name>/index.js`. There is no framework, no build step and no bundler — the files are ES modules served as-is. Copy `devices/_example/index.js`, which is reference material deliberately kept out of the loader.

```javascript
import { registerDevicePlugin } from "/static/js/devices/plugin-api.js";

registerDevicePlugin({
    deviceType: "widget",          // must match the Rust driver's device_type()
    displayName: "Widget Encoder",
    accentColor: "emerald",
    renderers: {
        renderDetailHeader: (el, node, health) => { /* … */ },
    },
    extractEndpoints: (node) => ({ inputs: [], outputs: [] }),
});
```

`registerDevicePlugin` throws on a missing `deviceType` or a duplicate registration — double-registration is almost always two script tags loading the same module, and failing loudly beats silently accepting the second one.

**Two hooks are dispatched today**, and only two:

| Hook | Called from |
|---|---|
| `renderers.renderDetailHeader(el, node, health)` | `detail/flows.js`, via `window.BilbyDevices.getDevicePlugin()` |
| `extractEndpoints(node)` | `topology/render.js` and `pages/flows.js`, to draw the device's ports |

Everything else on the plugin object — `capabilityGates`, `customPages`, `accentColor` — is declarative metadata with no consumer in executable code. Generic pages still branch on `node.device_type` directly in a dozen places; the plugin registry is the direction they are moving, not where they are.

The shipped plugins also **hand-mirror** their driver's `ui_capabilities()` rather than fetching it. A comment in `devices/edge/index.js` claims the values come from `GET /api/v1/device-types/edge` at runtime; nothing in the UI requests that per-type endpoint, and the two pages that do fetch the collection endpoint read only `device_type`, `display_name` and `ui_capabilities.has_external_target` from it. Keep the two sides in step yourself.

:::caution[A JS file that is not wired twice is never served]
The UI is compiled into the binary with `include_str!()`. Creating the file is not enough — `crates/manager-server/src/ui/mod.rs` needs **both** a `const … = include_str!("static/js/devices/widget/index.js")` and a matching `.route("/static/js/devices/widget/index.js", …)`. Miss either and the module 404s at page load with nothing else to say so.

Then add the one-line import to `devices/index.js` so the module's `registerDevicePlugin()` side effect runs:

```javascript
import "/static/js/devices/widget/index.js";
```
:::

### What the CSP forbids

Manager responses carry an **enforcing** `Content-Security-Policy` whose script directive is exactly `script-src 'self'` — no `'unsafe-inline'`, and a test pins the header name so it cannot silently revert to report-only. In hand-edited UI JavaScript that rules out:

- inline `<script>` blocks, and `on*=` attributes — including inside strings you assign to `innerHTML`
- `eval` and `new Function`
- cross-origin `fetch` / `WebSocket`, and blob workers

Adding one now breaks the page rather than filing a report.

## The `ui-js` CI job

Nothing else in the build parses this tree: the Rust job compiles the strings without looking inside them, and the frontend job covers only the React graph-editor island. A syntax error or a re-opened injection sink therefore used to reach a release binary with a green CI. The `ui-js` job is the gate, and it is three pure-stdlib Python 3 steps over every `.js` file under `crates/manager-server/src/ui/static/js` — no install step, and it runs on every push to `main` and every pull request.

| Step | Script | What fails the build |
|---|---|---|
| JS syntax (lexer) | `scripts/ui-js/jslex.py` | Unterminated string, template, regex or block comment; a raw newline inside a quoted string; unbalanced or mismatched brackets. It tracks regex-vs-division, without which these files report dozens of false errors |
| UI declared-behaviour resolution | `scripts/ui-js/api_check.py` | A `Bilby.<ns>.<method>` call that does not resolve against what the helper exports; a `data-act` with no handler in a script the page loads; a `data-modal` naming no real element |
| UI XSS regression cases | `scripts/ui-js/xss_check.py` | A named node-telemetry field reaching `innerHTML` un-coerced or un-escaped. Duplicated sinks assert an occurrence **count**, so re-opening one of two copies still fails |

It is a **lexer, not a parser**. It will not catch a type error, an undefined variable, or a hook you spelled wrong — so run the page in a browser before you call the module done.

## Checking your work

```bash
cd bilbycast-manager
cargo check -p device-widget
cargo check -p manager-server
cargo test  -p manager-server --test driver_contract
```

`driver_contract` needs no database. It exercises every registered driver against the trait: non-empty `device_type()` and `display_name()`, a non-empty command catalogue whose every entry carries a name and a description, `extract_metrics` and `extract_health_status` surviving `null`, `{}` and another driver's stats shape without panicking, `validate_command` rejecting a non-object, and permission and migration names unique across drivers. It does **not** check `requires_role` — a typo there is caught at request time by failing closed to Manage, not in CI.

Beyond that, keep the driver's own tests inside its crate and pure — `extract_metrics`, `validate_command` and `validate_payload` are all plain functions over `serde_json::Value`, with no database and no async.

## Things that bite

- **No protocol version bump.** New device types and new command names ride the existing `WS_PROTOCOL_VERSION` envelope, which dispatches by string with catch-all arms on both sides. Bumping it because you added a device type breaks compatibility for no reason.
- **New payload fields need `#[serde(default)]` and `Option`**, so an older node or manager on the other side still deserializes.
- **`device_type` strings are permanent.** The moment one ships it is a database value and a bookmarked URL.
- **`validate_payload` returns `PayloadError { field, code, message }` — but today's callers keep almost none of it.** The `flow_assembly` route surfaces `message` plus `code` (as the 422 body's `error_code`, defaulting to `invalid_assembly` when `code` is empty); the two ST 2110 routes flatten the whole error with `.map_err(|e| e.message)`. **No call site reads `field`.** Fill all three in anyway — the struct is the contract — but do not assume a dotted `field` path reaches the browser.
- **Accent colours are Tailwind palette names** (`blue`, `purple`, `amber`, `emerald`, `slate`, …), not hex.
- **Gateway sidecars should rate-limit their own events.** The manager drops anything past 1000/min per node, so a device that can storm alarms needs a self-gate below that in the sidecar.

## See also

- [Device Drivers](/manager/device-drivers/) — what a driver contributes at runtime, and how the shipped ones use it
- [Adding New Device Gateways](/appear-x-gateway/adding-new-device-gateways/) — the sidecar half, for a vendor unit that cannot speak the manager protocol
- [Manager API Reference](/manager/api-reference/) — the node and device-type endpoints a new driver inherits
