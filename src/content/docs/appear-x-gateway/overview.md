---
title: Appear X Gateway Overview
description: API gateway bridging Appear X broadcast encoder/gateway platform to bilbycast-manager.
sidebar:
  order: 1
---

bilbycast-appear-x-api-gateway is a sidecar service that bridges the Appear X broadcast encoder/gateway platform to bilbycast-manager. It translates the Appear X JSON-RPC 2.0 API into the bilbycast WebSocket protocol, enabling centralized management of Appear X hardware alongside native bilbycast edge nodes.

## How It Works

The gateway connects to two systems simultaneously:

1. **bilbycast-manager** — via outbound WebSocket (same protocol as edge and relay nodes)
2. **Appear X unit** — via HTTPS JSON-RPC 2.0 polling

```
bilbycast-manager ◄──── WebSocket ────► bilbycast-appear-x-api-gateway ◄──── HTTPS ────► Appear X Unit
```

The gateway:
- Polls the Appear X unit for inputs, outputs, services, alarms, and IP interfaces
- Translates stats and health into the bilbycast manager protocol
- Receives commands from the manager and translates them into Appear X JSON-RPC calls
- Appears as a managed device in the manager dashboard

## Supported Commands

| Command | Description |
|---------|-------------|
| `get_inputs` | List all input channels |
| `get_outputs` | List all output channels |
| `get_services` | List running services |
| `get_alarms` | List active alarms |
| `get_ip_interfaces` | List network interfaces |
| `set_ip_input` | Configure an IP input |
| `set_ip_output` | Configure an IP output |

## Quick Start

```bash
cargo build --release
./target/release/bilbycast-appear-x-api-gateway --config config.toml
```

See the [Setup Guide](/appear-x-gateway/setup-guide/) for configuration details and the [Architecture](/appear-x-gateway/architecture/) for the integration design.

## Extending to Other Devices

The Appear X gateway serves as the reference implementation for the **API gateway sidecar pattern**. This same pattern can be used to integrate any third-party broadcast device with bilbycast-manager. See [Adding New Gateways](/appear-x-gateway/architecture/) for the implementation guide.
