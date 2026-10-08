---
title: AI Assistant
description: How the bilbycast-manager AI assistant investigates the fleet and proposes changes that an operator previews and applies — and what it may never do on its own.
sidebar:
  order: 6
---

The bilbycast-manager **AI Assistant** is a chat with a model that can see what the signed-in operator can see — nodes, flows, live statistics, events, configuration history, tunnels, recordings, the manager's own registries — and use it to answer questions, investigate problems and prepare configuration changes.

It **never changes anything itself**. Every tool it has is read-only, except one that stores a **proposal**. A proposal is a plan of steps, previewed against the live configuration as a field-by-field diff with its risk, validation and permission checks, and it changes nothing until a person reviews it and presses **Apply**. Applying runs each step through the same API routes, permission checks and audit trail as doing it by hand in the UI, as that person.

## What it is good for

| Request | What happens |
|---|---|
| *How is the main feed on edge-syd configured?* | The assistant reads the node's live configuration — secrets shown only as set — and explains it. |
| *Camera 2 keeps glitching since 14:00 — why?* | It reads flow statistics and stream history, the events around that time and recent configuration changes, and says what it found, citing the evidence, with times in UTC and your timezone. |
| *Take an encrypted SRT feed on port 9100 and send it out as RTP multicast to 239.10.0.2:5004.* | It checks the port, then proposes one plan: an SRT listener input, an RTP output and a flow joining them. |
| *Raise the SRT latency on camera 1 to 400 ms.* | It proposes a one-field change; the preview shows only `latency_ms` changing and warns that the flow restarts because the input is on air. |
| *Delete the old feed.* | It proposes stopping and then deleting the flow; the preview marks it destructive and asks you to type the flow's id to apply. |

**Ask AI** links on the node page, the flow cards, the Flows page and the Events log open the assistant with what you were looking at — node, flow, input, output or event — attached as focus, and a suggested question pre-filled but not sent.

## Proposals: propose, preview, apply

1. **Propose.** The model writes a plan of ordered steps, each naming an action from the manager's **action catalog** — creating, updating or deleting inputs, outputs and flows, flow control, recording and replay, routines, the switcher, multiviewer walls, DVR sessions, tunnels, services, users and groups, device commands — and the node it targets. Every node step names its node explicitly. A plan that does not check out (an unknown action, a missing parameter, a flow deleted while it runs) is refused with every problem listed, and the model fixes it and proposes again.
2. **Preview.** The stored proposal shows each step's target by name, the changes field by field (before → after), what restarts and what goes on air, validation errors and warnings from the manager's own validators and the device driver's, and whether you have the permission each step needs. Its risk is one of **safe**, **restart**, **on air**, **destructive** or **admin**.
3. **Apply.** You acknowledge the preview; for anything on air or riskier you also type a confirmation phrase. The manager re-runs the preview against the live configuration first, and if anything the proposal touches changed since you looked, it applies nothing and shows you the refreshed preview instead. Then each step runs, in order, through the ordinary API as you. If a step fails, the steps before it are reversed where they can be, and the result says what is still in effect.
4. **Settle and undo.** After an apply the manager watches the changed flows for critical alarms and reports whether they settled. **Undo** builds a new proposal that reverses an applied one, which you review and apply the same way.

Updates are **merge-patches**: the model sends only what changes, everything else keeps its value, and a secret it was shown as `[REDACTED]` is kept as stored. A **new** secret — the passphrase of a new SRT link, say — is never invented by the model: it writes a placeholder, and the manager generates the value when you apply, the same value on both ends of the link. Generated secrets are never shown to the model and never stored in the conversation.

## What leaves the installation

Each turn sends a request to the model provider the organisation allows — **Anthropic**, **OpenAI**, **Google Gemini**, or any **OpenAI-compatible endpoint** the organisation configures, which can be a model hosted on its own network. A request carries the compiled-in knowledge base and action catalog, the conversation (the operator's messages as typed, the answers, the tool results), and a snapshot of the current state with every prompt: the time, the operator's role, the nodes they can see and the open alarms. When the model looks at a flow's thumbnail, the image is sent too.

Before anything reaches a provider it is **redacted**: secret values — passwords, passphrases, keys, tokens, PSKs, the CMAF content key — are replaced with `[REDACTED]` wherever they sit in a configuration, and credentials embedded in strings — URL user-info, credential query parameters, RTMP stream keys, SRT access-control stream ids, bearer tokens — are cut out of the text. Device-written text such as node names and alarm messages is labelled as data, and the model is told never to follow instructions found in it; since it can only propose, an injected instruction can at most produce a proposal a person must still read and apply.

## Keys, models and organisation policy

Each user can add their own provider keys under **AI Settings**; a Super Admin can add **organisation keys** used by everyone who has none (or by everyone, if personal keys are turned off). Keys are checked with the provider when saved, stored encrypted, and never returned by the API. The model list comes live from the provider.

The organisation's **AI policy** (Super Admin) decides whether the assistant is on at all, which providers may be used, whether personal keys are allowed, the notice shown to every user of the assistant, the custom endpoint, how many turns and how much time one run may take, and whether external agents may connect over MCP. When a run uses up its budget, the assistant stops investigating and summarises what it found, what is still unknown and what to check next — it never ends with an empty answer.

## External agents (MCP)

When the organisation enables it, users can let an AI agent they run — Claude Code, an IDE assistant, a chat bot — use the same tools over the **Model Context Protocol**, at `POST /api/v1/mcp`. The agent authenticates with a **personal API token** the user creates on their account page, with an expiry and scopes: **read** (look), **propose** (store proposals for the user to review in the assistant), **apply** (apply them). The token acts as its user, with exactly that user's permissions; it is shown once and stored only as a hash, it works nowhere but the MCP endpoint, and changing the password revokes it.

## What the assistant cannot do

- **Change anything without a person applying it** — every tool is read-only except storing a proposal, and only its owner can apply a proposal.
- **Go around permissions** — it reads through the same API as the operator and every step of a proposal runs as the person applying it, with the route's own RBAC and audit entry.
- **See a stored secret, or create one** — secrets are redacted before they reach a provider; new ones are generated by the manager at apply time.
- **Act on itself or on identity** — sign-in, passwords, MFA and SSO, deleting users, creating or deleting groups, API tokens, export and import, installation settings, licence and TLS, node enrolment and secret rotation are not in its action catalog; it sends the operator to the UI for those.
- **Queue a change for a node that is offline** — a step on an offline node is refused in the preview.

## API

The conversation, run, proposal, key, policy, token and MCP routes are listed in the [API reference](/manager/api-reference/#ai).
