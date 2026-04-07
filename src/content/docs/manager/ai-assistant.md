---
title: AI Assistant
description: How the bilbycast-manager AI assistant uses a driver-aware action system to create, analyze, and troubleshoot media flows on any registered device.
sidebar:
  order: 6
---

The bilbycast-manager **AI Assistant** is a chat panel that lets an operator describe a flow in natural language and have it reviewed, validated, and (with confirmation) applied. It is built on top of the same **driver-aware action system** that powers the manager's REST and WebSocket APIs — the AI does not have a privileged backdoor; it can only call actions that a human operator could already call.

## Supported providers

The assistant is provider-agnostic. Each user picks their preferred provider and model in **Settings → AI**:

| Provider | Models |
|---|---|
| Anthropic | Claude (recommended for tool-use accuracy) |
| OpenAI | GPT-4 / GPT-4o family |
| Google | Gemini |

API keys are stored **encrypted at rest** in the manager database using envelope encryption (AES-256-GCM with a per-secret DEK wrapped by an `ai-key` domain KEK derived from `BILBYCAST_MASTER_KEY` via HKDF-SHA256). Keys are never logged, never returned over the API, and never visible in audit entries.

## How a request becomes an action

When the operator types a message like *"create an SRT-to-RTP relay from edge-syd to edge-perth using the existing tunnel"*, the manager:

1. **Builds a context prompt** from the registered device drivers and the current topology snapshot — what nodes exist, what tunnels exist, what flows are running, what each driver supports.
2. **Strips credentials** from that context. SRT passphrases, RTSP credentials, RTMP stream keys, and bearer tokens are replaced with placeholder tokens before the prompt is sent to the LLM.
3. **Calls the LLM** with the (sanitised) context and a list of available **action descriptors** — structured tool definitions describing what the AI is allowed to propose.
4. **Receives a structured response** — not free-form prose. The LLM returns one or more action invocations against the descriptors it was given.
5. **Restores credentials** to the proposed actions before showing them to the operator (so the preview reflects what will actually be applied).
6. **Renders a preview card** — a human-readable diff of what will change. Nothing is applied yet.
7. **Operator confirms** — only then does the manager execute the actions against the live device drivers.

The credential-stripping step is critical: even if the LLM provider is fully trusted, an operator's SRT passphrase should never leave the manager's process boundary.

## Action descriptors

Every device driver registers a list of **action descriptors** with the manager at startup. An action descriptor is a structured definition of one operation the driver can perform — its name, its parameter schema, its preview text template, and (optionally) its execution mode.

This is what gets injected into the LLM prompt. The LLM only ever sees descriptors that the registered drivers actually expose; it cannot invent new actions or call private APIs.

| Driver | Action count | Examples |
|---|---|---|
| Edge | 10 | `flows.create`, `flows.update`, `flows.delete`, `flows.start`, `flows.stop`, `outputs.add`, `outputs.remove`, `tunnels.create`, `tunnels.delete`, `flow_groups.start` |
| Relay | 7 | `relay.get_config`, `relay.list_tunnels`, `relay.list_edges`, `relay.disconnect_edge`, `relay.close_tunnel`, `relay.authorize_tunnel`, `relay.revoke_tunnel` |
| Appear X | 7 | `appear_x.set_ip_input`, `appear_x.set_ip_output`, `appear_x.get_inputs`, `appear_x.get_outputs`, `appear_x.get_services`, `appear_x.get_alarms`, `appear_x.get_chassis` |

When a new device driver is added (see [Device Drivers](/manager/device-drivers/)), its action descriptors are picked up automatically — the AI assistant immediately gains the ability to operate on that device type without any prompt-engineering changes.

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

When the AI proposes an action, the operator sees a **preview card** rather than a chat-style summary. Preview cards are generated from the action descriptor's `preview` template, not from LLM-generated text — so the operator always sees an accurate diff of what will actually run, regardless of how the LLM phrased its response.

Preview cards include:

- A title and short description of the action
- A structured diff (added / changed / removed fields)
- The target device(s)
- An "Apply" button (single action) or "Apply all" (multi-action plans)
- A "Discard" button

Operators can also edit the preview before applying — the AI's proposal is a starting point, not a contract.

## Generic vs driver-specific UI

The preview rendering is **driver-aware**. Each driver can register a custom UI component for its action types (e.g., the edge driver renders flow create/update with a familiar flow form), and the manager falls back to a generic descriptor-based renderer for any driver that doesn't supply one. This means a third-party device gateway can plug into the AI workflow without writing custom UI — the generic renderer reads the descriptor's parameter schema and produces a sensible form.

## Audit trail

Every AI-driven action lands in the manager's audit log, tagged with:

- The user who confirmed the action
- The provider and model that generated it
- The action descriptor name and parameters (after credential restoration)
- The target device(s)
- The execution result

Failed actions (validation errors, device offline, push failures) are also logged. The audit log is the authoritative record of who told the AI to do what.

## What the AI cannot do

By design, the AI assistant cannot:

- See or transmit unstripped credentials (SRT passphrases, RTSP credentials, RTMP keys, bearer tokens, manager-issued node secrets, tunnel encryption keys)
- Modify users, RBAC roles, or any settings outside the registered driver descriptors
- Bypass per-user device-access restrictions — actions are executed under the requesting user's identity and respect the same node-access policy as manual actions
- Apply changes without operator confirmation — even when the LLM is highly confident, the preview-card workflow always inserts a human in the loop
