---
title: AI Assistant
description: How the bilbycast-manager AI assistant uses a driver-aware action system to create, analyze, and troubleshoot media flows on any registered device.
sidebar:
  order: 6
---

The bilbycast-manager **AI Assistant** is a chat panel that lets an operator describe a flow in natural language and have it reviewed, validated, and (with confirmation) applied. It is built on top of the same **driver-aware action system** that powers the manager's REST and WebSocket APIs — the AI does not have a privileged backdoor; it can only call actions that a human operator could already call.

![AI Assistant — preview pane showing a proposed JSON flow definition next to plain-English requirements and a recommendation summary](../../../assets/screenshots/ai-config.png)

## Supported providers

The assistant is provider-agnostic — Anthropic, OpenAI, and Google Gemini. Each user saves their own API key and picks a model per provider under **AI Assistant → AI Keys** (`/ai/settings`), which the assistant page links to directly. There is no AI section on the admin **Settings** page.

The model dropdowns are not a fixed list. They are populated live from the provider's own catalogue via `GET /api/v1/ai/providers/{provider}/models`, called with that user's saved key — Anthropic and OpenAI `/v1/models`, Gemini `/v1beta/models` — filtered to chat-capable models and cached per provider for an hour. A short bundled list stands in when no key is saved yet, or when the provider call fails or returns nothing; the response's `source` field reports which of `remote`, `cache`, or `fallback` answered, and the page renders that beside the dropdown as either *(live)* or *(default list — save key to fetch live models)*.

API keys are stored **encrypted at rest** in the manager database using envelope encryption (AES-256-GCM with a per-secret DEK wrapped by an `ai-key` domain KEK derived from `BILBYCAST_MASTER_KEY` via HKDF-SHA256). Keys are never logged, never returned over the API, and never visible in audit entries.

![AI API Keys page — OpenAI, Anthropic, and Gemini provider cards with masked key input and model dropdown](../../../assets/screenshots/ai-api-keys.png)

## How a request becomes an action

The assistant is an **agent loop**, not a single prompt-and-answer round trip. When the operator types a message like *"create an SRT-to-RTP relay from edge-syd to edge-perth using the existing tunnel"*, the manager:

1. **Builds the system prompt** — one cached block composed from the compiled-in knowledge base, then an uncached *current system state* block holding the nodes this user is allowed to see plus a health snapshot of anything offline or alarming in the last 60 minutes.
2. **Replays the thread** — conversations are persistent, so the stored messages (including previous tool results) are loaded from the database and re-sent.
3. **Iterates.** On each turn the model either answers or emits `tool_use` calls; the manager dispatches those tools, feeds each result back as a `tool_result`, and calls the model again. The loop runs to at most 12 turns or 120 seconds, whichever comes first, evicting the oldest turns whenever the working context would exceed its budget.
4. **Extracts one proposed action** from the model's final text — a fenced `json` block carrying an `action` field — and renders it as a preview card. Nothing is applied yet.
5. **Operator confirms.** Only then does `POST /api/v1/ai/apply` run: the manager re-checks the caller's `Operate` permission on the target node, fetches the node's live config, restores the credentials it had redacted, re-runs the same validator the preview used, snapshots the config, and issues the command over that node's WebSocket.

Progress streams to the browser over SSE while the loop runs, so the operator watches each turn and each tool call go by rather than a spinner.

**Every tool the agent can call is read-only**, and each one is filtered by the caller's own node access — the agent can look at anything the signed-in user could look at, and change nothing. The single mutating path in the whole feature is the operator-confirmed apply in step 5.

### Tools

The main agent is given 29 tools:

| Group | Tools |
|---|---|
| Node & config | `list_nodes`, `get_node_config`, `get_node_capabilities`, `get_node_stats`, `get_node_health`, `get_node_resources`, `validate_config`, `check_port_available`, `list_tunnels`, `get_peer_config`, `propose_peer_input`, `propose_peer_output` |
| Diagnostics & history | `diagnose_node`, `get_events`, `search_events`, `get_config_history`, `diff_configs`, `search_past_conversations` |
| Reference material | `search_example_configs`, `get_ui_guide` |
| Manager surfaces | `list_clips`, `get_recording_status`, `list_routines`, `get_routine`, `get_upcoming_fires`, `list_switcher_pages`, `list_switcher_presets`, `list_media_files`, `get_appear_x_status` |

`propose_peer_input` / `propose_peer_output` are the ones that most look like writes and are not: they compute a matching far-end config for a peer node and hand it back as a proposal, which still has to reach the operator as a preview card before anything is applied.

### Knowledge base and retrieval

The cached system block is assembled from a knowledge base compiled into the binary — an operator persona, topology patterns, input/output pairing rules, per-feature and per-protocol modules, and Markdown UI guides the `get_ui_guide` tool can pull on demand. `search_example_configs` retrieves from the worked-example config corpus embedded at build time using BM25-lite lexical scoring; there is no vector database, no embedding model and no network call on that path. Embeddings are used in exactly one place — `search_past_conversations`, over stored thread summaries.

On Anthropic the tool specifications and the knowledge-base block carry a prompt-caching breakpoint, and extended thinking is left adaptive; cache read/write token counts are accounted per turn alongside input and output tokens.

### Threads and streaming

Conversations are first-class rows, not browser state: `/api/v1/ai/threads` creates and lists them, `/threads/{id}/messages` returns the stored history, `/threads/{id}/live` and `/chat/stream` are the SSE progress channels, and `/threads/running` reports which threads currently have an agent in flight. See the [AI endpoints in the API reference](/manager/api-reference/#ai) for the full table.

### Credential handling

Node configs reach the model through the `get_node_config` tool, which redacts on the way out. Redaction is **key-based**: any string value at `passphrase`, `stream_key`, `bearer_token`, `password`, `auth_token`, or `api_token`, anywhere in the config tree, is replaced with the literal `[REDACTED]`. On apply, the same field list is walked in reverse and the real secrets are spliced back in from the node's live config, so an `update_*` action round-trips losslessly. If the operator (or the model on their behalf) replaced a redaction with a genuinely new value, that new value wins.

Because the match is on the **field name**, a credential embedded in a URL is not caught. An RTSP input that carries its secret in the dedicated `password` field is redacted; the same camera configured as `rtsp://user:pass@host/stream` in `rtsp_url` is sent to the provider verbatim. Keep credentials in their own fields.

## Action descriptors

Every device driver registers a list of **action descriptors** with the manager at startup. An action descriptor is a structured definition of one operation the driver can perform — its name, a display label, a category, prompt text and a worked JSON example describing when and how to use it, and UI hints including its execution mode.

Descriptors are the manager's catalogue of what each driver can be asked to do, published on the driver-metadata REST surface (`GET /api/v1/device-types`). What actually bounds the assistant is narrower and fixed in the apply endpoint: flow / input / output create, update and delete, start and stop flow, flow-assembly update, tunnel create / update / delete, the replay and media-library commands, `update_node_web_ui_url`, two relay-side ops, and activating a routine or a switcher preset. Anything else is rejected as an unsupported action, so the model cannot invent a new operation or reach a private API.

| Driver | Action count | Examples |
|---|---|---|
| Edge | 23 | `create_flow`, `update_flow`, `delete_flow`, `start_flow`, `stop_flow`, `create_output`, `delete_output`, `create_tunnel`, `delete_tunnel`, `cue_clip`, `set_bond_uplinks` |
| Relay | 7 | `get_config`, `list_tunnels`, `list_edges`, `disconnect_edge`, `close_tunnel`, `authorize_tunnel`, `revoke_tunnel` |
| Appear X | 18 | `set_ip_input`, `set_ip_output`, `get_inputs`, `get_outputs`, `get_services`, `get_alarms`, `get_chassis` |

When a new device driver is added (see [Device Drivers](/manager/device-drivers/)), its action descriptors are picked up automatically and the manager's driver-capabilities surface reflects them with no prompt-engineering changes. Extending what the *assistant* can apply is a second, deliberate step: the new action name has to be added to the apply endpoint's list as well, so a driver cannot widen the AI's write surface just by declaring a descriptor.

## Execution modes

Each action runs in one of a few execution modes, which controls how the manager applies it:

| Mode | What happens |
|---|---|
| `command` | A single device command issued over the device's WebSocket connection |
| `flows_create` | A bulk create on the manager's `managed_flows` table; pushed to the target device on next reconnect if the device is offline |
| `flows_delete` | Symmetric to `flows_create` |
| `tunnels_create` | Coordinated tunnel creation across both endpoint edges and (if applicable) the relay; tracked via per-leg push status |
| `tunnels_delete` | Symmetric to `tunnels_create` |

The manager handles all the orchestration — the LLM only ever proposes the action; it doesn't need to know about reconnect logic, push status, or rollback.

## Preview cards

When the AI proposes an action, the operator sees a **preview card** rather than a chat-style summary. The card is rendered by the manager's own UI from the structured action JSON, not from LLM-generated prose — so the operator always sees what will actually run, regardless of how the model phrased its response.

Preview cards include:

- A header naming the proposed action type
- The fields the action would set, pulled out of its JSON — not a before/after diff
- The target device(s)
- A "Show raw JSON" toggle over the exact payload that would be sent to `/apply`
- An **Apply** button and a **Dismiss** button

Nothing on the card is editable — the raw-JSON toggle is an inspection affordance, not an editor. **Dismiss** simply removes the card and does nothing else. A multi-step plan arrives as one card with its steps listed in order and a single **Apply**; there is no bulk "apply all" control.

Two behaviours are worth knowing before you click:

- **Deletes need the ID typed.** `delete_flow`, `delete_input`, `delete_output`, and `delete_tunnel` prompt for the resource ID and abort unless something is entered.
- **A successful apply can be undone.** The card locks to "Applied" so it cannot double-execute, and — when the apply returned a pre-change snapshot — offers an **Undo** link that restores it via `POST /api/v1/nodes/{id}/config-history/{snapshot_id}/restore`.

## How the preview is rendered

Rendering keys off the **proposed action's own type**, not off the driver. A multi-step plan gets a numbered step list; an informational answer gets a plain info card; a tunnel action gets an ingress → relay → egress diagram; everything else goes through the entity renderer, which pulls out the fields worth showing for a flow, input, or output — id, name, type, address, mode, encode settings — and falls back to a labelled badge with the target node when it does not recognise the shape.

Because there is no per-driver renderer to register, a third-party device gateway plugs into the AI workflow without writing any UI: whatever it proposes is previewed by the same entity renderer, backed by the "Show raw JSON" toggle for anything the summary does not cover.

## Applied-action record

An applied **node** action is recorded as a **before/after pair of config snapshots plus a ledger row**, not as an audit-log entry.

Immediately before the command goes out, the manager writes the node's current config into `config_history` with source `ai_assistant` and label `pre-<action_type>`. Once the node has acknowledged, it requests the node's fresh config and writes a matching `post-<action_type>` snapshot. It then links the two with one `ai_applied_actions` row holding the thread id, the message id, the action type, the node id, both snapshot ids, the timestamp, and the user who confirmed. That pre-snapshot id is what the card's **Undo** link restores. The other apply paths — tunnel create / update / delete, routine and switcher-preset activation, and the replay / media / web-UI-link commands — take no snapshots at all and record the ledger row alone, which is why a card for one of those offers no Undo.

Note what is *not* in that record: there is no provider, no model, and no parameter dump. And a failed apply writes no ledger row at all — the row is inserted only after the node accepts the command. Where the failure lands decides what is left behind: a permission refusal, an unreachable node and a manager-side validation rejection all fail *before* the `pre-` snapshot is taken and write nothing, while a command the edge itself rejects leaves that snapshot standing with no ledger row beside it. Treat `ai_applied_actions` as a per-thread record of what the assistant changed, not as a security audit trail.

## What the AI cannot do

By design, the AI assistant cannot:

- See or transmit a credential held in one of the redacted fields — `passphrase`, `stream_key`, `bearer_token`, `password`, `auth_token`, `api_token` — anywhere in a node's config. Redaction is key-based, so a credential written into a URL instead of its own field is *not* covered; see [Credential handling](#credential-handling) above
- See infrastructure secrets — node secrets, registration tokens, tunnel encryption keys and bind secrets, server TLS material — because the edge blanks those from every `get_config` response, so they are absent from the config `get_node_config` hands the model
- Modify users, RBAC roles, or manager settings — none of those is reachable from the apply endpoint's action list
- Bypass per-user device-access restrictions — actions are executed under the requesting user's identity and respect the same node-access policy as manual actions
- Apply changes without operator confirmation — even when the LLM is highly confident, the preview-card workflow always inserts a human in the loop
