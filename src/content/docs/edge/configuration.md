---
title: Configuration Guide
description: Complete reference for the bilbycast-edge JSON configuration file.
sidebar:
  order: 3
---

Complete reference for the bilbycast-edge JSON configuration file. This guide covers every field, validation rule, and common configuration patterns.

---

## Table of Contents

- [Configuration File Basics](#configuration-file-basics)
- [Full Annotated Example](#full-annotated-example)
- [Top-Level Structure (AppConfig)](#top-level-structure-appconfig)
- [Server Configuration](#server-configuration)
- [TLS Configuration](#tls-configuration)
- [Auth Configuration](#auth-configuration)
- [Monitor Configuration](#monitor-configuration)
- [Manager Configuration](#manager-configuration)
- [Tunnel Configuration](#tunnel-configuration)
- [Flow Configuration](#flow-configuration)
- [Input Types](#input-types)
  - [RTP Input](#rtp-input)
  - [UDP Input](#udp-input)
  - [Multicast reception: SSM, ASM and socket binding](#multicast-reception-ssm-asm-and-socket-binding)
  - [SRT Input](#srt-input)
  - [RIST Input](#rist-input)
  - [RTMP Input](#rtmp-input)
  - [RTSP Input](#rtsp-input)
  - [WebRTC/WHIP Input](#webrtcwhip-input)
  - [WHEP Input](#whep-input)
  - [Media Player Input](#media-player-input)
  - [TestPattern Input](#testpattern-input)
  - [Bonded Input](#bonded-input)
  - [Replay Input](#replay-input)
  - [SDI Input (Blackmagic DeckLink)](#sdi-input-blackmagic-decklink)
- [Output Types](#output-types)
  - [RTP Output](#rtp-output)
  - [UDP Output](#udp-output)
  - [Egress pacing](#egress-pacing)
  - [Epoch lock (cross-node alignment)](#epoch-lock-cross-node-alignment)
  - [SRT Output](#srt-output)
  - [RIST Output](#rist-output)
  - [RTMP Output](#rtmp-output)
  - [HLS Output](#hls-output)
  - [CMAF Output](#cmaf-output)
  - [WebRTC Output](#webrtc-output)
  - [Display Output](#display-output)
  - [SDI Output (Blackmagic DeckLink)](#sdi-output-blackmagic-decklink)
  - [Bonded Output](#bonded-output)
- [Recording (Flow Attribute)](#recording-flow-attribute)
- [Resource Limits](#resource-limits)
- [Node Tuning](#node-tuning)
- [Structured JSON Logging](#structured-json-logging-logging)
- [Upgrade Configuration](#upgrade-configuration)
- [Flow Assembly (PID Bus — SPTS / MPTS from N inputs)](#flow-assembly-pid-bus--spts--mpts-from-n-inputs)
- [MPTS → SPTS filtering](#mpts--spts-filtering)
- [TS PID remapping (`pid_map` and `pid_overrides`)](#ts-pid-remapping-pid_map-and-pid_overrides)
- [SMPTE 2022-1 FEC Configuration](#smpte-2022-1-fec-configuration)
- [SMPTE 2022-7 SRT Redundancy](#smpte-2022-7-srt-redundancy)
- [Native libsrt SRT bonding (socket groups)](#native-libsrt-srt-bonding-socket-groups)
- [SRT Connection Modes](#srt-connection-modes)
- [CLI Argument Overrides](#cli-argument-overrides)
- [Config Persistence Behavior](#config-persistence-behavior)
- [Common Configuration Scenarios](#common-configuration-scenarios)

---

## Configuration File Basics

bilbycast-edge reads its configuration from two JSON files:

- **`config.json`** — Operational configuration (specified by `--config`, default: `./config.json`). Contains server settings, flow definitions (including user-configured parameters like SRT passphrases, RTSP credentials, RTMP stream keys, bearer tokens, HLS auth tokens), and tunnel routing.
- **`secrets.json`** — Infrastructure credentials (auto-derived: same directory as `config.json`). Contains manager auth secrets, tunnel encryption keys, API auth config (JWT secret, client credentials), TLS cert/key paths. Written with `0600` permissions on Unix.

If neither file exists at startup, an empty default configuration is used. Both files are loaded and merged into a single in-memory config, then validated at startup. Changes made through the API or manager commands are automatically persisted — flow configs and operational fields to `config.json`, infrastructure secrets to `secrets.json` — using atomic writes (write to temp file, then rename).

**Migration**: If upgrading from a version that used a single `config.json` with secrets, the node automatically splits them on first startup.

---

## Full Annotated Example

```json
{
  "version": 2,
  "device_name": "Studio-A Encoder",
  "setup_enabled": true,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080,
    "tls": {
      "cert_path": "/etc/bilbycast/cert.pem",
      "key_path": "/etc/bilbycast/key.pem"
    },
    "auth": {
      "enabled": true,
      "jwt_secret": "a-cryptographically-random-string-of-at-least-32-characters",
      "token_lifetime_secs": 3600,
      "public_metrics": true,
      "clients": [
        {
          "client_id": "admin",
          "client_secret": "admin-secret-here",
          "role": "admin"
        },
        {
          "client_id": "grafana",
          "client_secret": "grafana-secret-here",
          "role": "monitor"
        }
      ]
    }
  },
  "monitor": {
    "listen_addr": "0.0.0.0",
    "listen_port": 9090
  },
  "inputs": [
    {
      "id": "rtp-main",
      "name": "Main RTP feed",
      "type": "rtp",
      "bind_addr": "239.1.1.1:5000",
      "interface_addr": "192.168.1.100",
      "fec_decode": {
        "columns": 10,
        "rows": 10
      },
      "allowed_sources": ["10.0.0.1", "10.0.0.2"],
      "allowed_payload_types": [33],
      "max_bitrate_mbps": 100.0,
      "tr07_mode": true
    }
  ],
  "outputs": [
    {
      "type": "rtp",
      "id": "rtp-local",
      "name": "Local Playout",
      "dest_addr": "192.168.1.50:5004",
      "interface_addr": "192.168.1.100",
      "fec_encode": {
        "columns": 10,
        "rows": 10
      },
      "dscp": 46
    },
    {
      "type": "srt",
      "id": "srt-remote",
      "name": "Remote Site via SRT",
      "mode": "caller",
      "local_addr": "0.0.0.0:0",
      "remote_addr": "203.0.113.10:9000",
      "latency_ms": 500,
      "passphrase": "my-encryption-passphrase",
      "aes_key_len": 32
    },
    {
      "type": "rtmp",
      "id": "twitch-out",
      "name": "Twitch Stream",
      "dest_url": "rtmp://live.twitch.tv/app",
      "stream_key": "live_123456789_abcdefghijklmnop",
      "reconnect_delay_secs": 5,
      "max_reconnect_attempts": 10
    }
  ],
  "flows": [
    {
      "id": "main-feed",
      "name": "Main Program Feed",
      "enabled": true,
      "input_ids": ["rtp-main"],
      "output_ids": ["rtp-local", "srt-remote", "twitch-out"]
    }
  ]
}
```

---

## Top-Level Structure (AppConfig)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `version` | integer | Yes | - | Schema version. Currently must be `2`. |
| `node_id` | string | No | Auto-generated | Persistent UUID v4 identifying this edge node. Auto-generated on first startup and saved to config. Used as the NMOS IS-04 Node ID. |
| `device_name` | string | No | `null` | Optional human-readable label for this edge node (e.g. "Studio-A Encoder"). Max 256 characters. |
| `setup_enabled` | boolean | No | `true` | When true, the browser-based setup wizard is accessible at `/setup`. The edge flips it to `false` — and persists that — the first time the node registers successfully with a manager, so a managed node closes the wizard by itself. Flip it by hand on nodes that never register. |
| `setup_token` | string | No | Auto-generated | One-shot bearer token gating `/setup` against non-loopback callers. Minted on first boot while `setup_enabled` is true, and cleared alongside it on the first successful manager registration. Persisted **encrypted in `secrets.json`, never in `config.json`** — do not hand-author it. Re-print it with `--print-setup-token`. |
| `server` | object | Yes | - | API server configuration. |
| `monitor` | object | No | `null` | Web monitoring dashboard configuration. |
| `manager` | object | No | `null` | Manager WebSocket connection configuration. See [Manager Configuration](#manager-configuration). |
| `inputs` | array | No | `[]` | Top-level input definitions. Each has a stable `id` and `name` plus the type-tagged fields. See [Input Types](#input-types). |
| `outputs` | array | No | `[]` | Top-level output definitions. Same shape. See [Output Types](#output-types). |
| `flows` | array | No | `[]` | Flows, which reference inputs and outputs **by ID**. See [Flow Configuration](#flow-configuration). |
| `tunnels` | array | No | `[]` | List of IP tunnel configurations. See [Tunnel Configuration](#tunnel-configuration). |
| `resource_limits` | object | No | `null` | Host CPU / RAM thresholds that raise events when exceeded. See [Resource Limits](#resource-limits). |
| `tuning` | object | No | `null` | Node-wide defaults for ingress de-jitter and the startup hardware probes. See [Node Tuning](#node-tuning). |
| `flow_groups` | array | No | `[]` | SMPTE ST 2110 essence bundles — several flows that share PTP timing and NMOS activation. See [Flow groups](#flow-groups-essence-bundles). |
| `logging` | object | No | `null` | Structured-JSON log shipper for SIEM / NMS pickup. See [Structured JSON Logging](#structured-json-logging-logging). |
| `nmos_registration` | object | No | `null` | NMOS IS-04 registration-client configuration — the edge POSTs its IS-04 resources to an external registry. See [NMOS](/edge/nmos/). |
| `upgrades` | object | No | `null` | Manager-driven binary upgrades. Off unless `enabled`. See [Upgrade Configuration](#upgrade-configuration). |
| `bond_uplinks` | array | No | `[]` | Per-NIC hard ceilings for the shared-leg capacity broker. Only needed on a metered link whose capacity the broker cannot infer; listing an uplink is **not** what enables the broker. See [Bonding](/edge/bonding/). |
| `shared_leg_broker` | boolean | No | unset → **on** | Explicit on/off for the shared-leg capacity broker. Unset means enabled; `false` reverts to uncoordinated per-bond contention. See [Bonding](/edge/bonding/). |
| `cellular_uplinks` | array | No | `[]` | Read-only cellular telemetry sources (RutOS routers; ModemManager modems are auto-detected and need no entry). See [Cellular](/edge/cellular/). |
| `starlink_uplinks` | array | No | `[]` | Read-only Starlink dish telemetry sources. See [Starlink](/edge/starlink/). |

:::note[Inputs and outputs are first-class, not nested in flows]
An input or output is a top-level entity with its own stable ID, and it can exist without being attached to any flow. Flows reference them via `input_ids` / `output_ids`.

Assignment is exclusive: an input or output can belong to **one** flow at a time. This is what makes an input reusable across configurations, editable without touching the flow that carries it, and hot-attachable to a running flow.
:::

---

## Server Configuration

The `server` object controls the API server listener. New installs bind **loopback only** — `127.0.0.1` and `[::1]` — so the API is not reachable off-box out of the box. LAN exposure requires an explicit `0.0.0.0` / `[::]` bind (via `listen_addrs` or launching with `--bind-addrs 0.0.0.0,[::]`) **and** enabling authentication (see the `auth` sub-object).

```json
{
  "server": {
    "listen_addrs": ["0.0.0.0", "[::]"],
    "listen_port": 8080,
    "tls": { ... },
    "auth": { ... }
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `listen_addrs` | array | No | `["127.0.0.1", "[::1]"]` | List of addresses to bind the API server to (dual-stack). Takes precedence over the legacy single `listen_addr`. Defaults to loopback only; set to `["0.0.0.0", "[::]"]` (or use `--bind-addrs`) for LAN exposure. |
| `listen_addr` | string | No | `"127.0.0.1"` | Legacy single bind address. Superseded by `listen_addrs` when that field is present. Defaults to loopback. |
| `listen_port` | integer | Yes | `8080` | TCP port for the API server. |
| `tls` | object | No | `null` | TLS configuration for HTTPS (`tls` feature enabled by default). |
| `auth` | object | No | `null` | OAuth 2.0 / JWT authentication configuration. When absent or `enabled: false`, all endpoints are open to non-browser callers — see [Browser-origin policy](#browser-origin-policy), which refuses browser-initiated state changes either way. |
| `nmos_browser_control` | array | No | `null` | Origins of browser-hosted NMOS controllers (sony/nmos-js and the like) permitted to drive IS-05 connection management from a web page. Each entry is one exact `scheme://host[:port]` — `http` or `https`, no path, no wildcard, no surrounding whitespace, at most 16 entries. Empty or unset means `/x-nmos/**` advertises safe methods only, so a browser never even sends the `PATCH .../staged`. Read once when the router is built, so a pushed change lands at the node's next restart. |

### Browser-origin policy

The private API emits no `Access-Control-*` header on any route — only `/x-nmos/**` and the WHIP/WHEP signalling routes carry CORS at all — and a separate guard refuses **browser-initiated state changes** on both `/api/v1/**` and `/x-nmos/**` with HTTP 403. It runs whether or not `auth` is enabled.

A request is allowed through when, in this order:

1. it uses a safe method (`GET` / `HEAD` / `OPTIONS`); or
2. it is authenticated — a valid Bearer token, whatever its `Origin`; or
3. it carries no browser fingerprint (no `Sec-Fetch-*` header) and either no `Origin` or an `Origin` matching the authority it was addressed to; or
4. on `/x-nmos/**` only, its `Origin` is listed in `server.nmos_browser_control`.

Everything else gets 403 with an error naming the three ways out. Native NMOS controllers, `curl`, CI and the manager are unaffected — they send no `Origin` / `Sec-Fetch-*`. The allowlist does nothing on `/api/v1/**`: that policy is constructed empty, because neither the monitor dashboard nor the setup wizard writes to it cross-origin.

---

## TLS Configuration

Optional sub-object of `server`. The `tls` feature is enabled by default.

```json
{
  "tls": {
    "cert_path": "/etc/bilbycast/cert.pem",
    "key_path": "/etc/bilbycast/key.pem"
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cert_path` | string | Yes | Path to PEM-encoded TLS certificate file (or fullchain). Cannot be empty. |
| `key_path` | string | Yes | Path to PEM-encoded TLS private key file. Cannot be empty. |

If TLS is configured but the binary was built without the `tls` feature, a warning is logged and the server starts without TLS.

---

## Auth Configuration

Optional sub-object of `server`. See the [Security Guide](api-security.md) for detailed usage.

```json
{
  "auth": {
    "enabled": true,
    "jwt_secret": "at-least-32-characters-of-random-data",
    "token_lifetime_secs": 3600,
    "public_metrics": true,
    "clients": [
      {
        "client_id": "admin",
        "client_secret": "strong-secret",
        "role": "admin"
      }
    ]
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | Yes | - | Master switch. When `false`, all endpoints are open to non-browser callers — the [browser-origin policy](#browser-origin-policy) still refuses browser-initiated state changes. |
| `jwt_secret` | string | Yes (if enabled) | - | HMAC-SHA256 signing secret. Must be >= 32 characters. |
| `token_lifetime_secs` | integer | No | `3600` | JWT token lifetime in seconds. |
| `public_metrics` | boolean | No | `true` | Whether `/metrics` and `/health` are accessible without auth. |
| `clients` | array | Yes (if enabled) | - | Registered OAuth clients. At least one required. |

**Client fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `client_id` | string | Yes | Unique client identifier. Cannot be empty. |
| `client_secret` | string | Yes | Client authentication secret. Cannot be empty. |
| `role` | string | Yes | Must be `"admin"` or `"monitor"`. |

---

## Monitor Configuration

Optional top-level object. When present, bilbycast-edge starts a second HTTP server serving a self-contained HTML monitoring dashboard.

```json
{
  "monitor": {
    "listen_addr": "0.0.0.0",
    "listen_port": 9090
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `listen_addr` | string | Yes | IP address for the dashboard server. |
| `listen_port` | integer | Yes | TCP port for the dashboard. Must differ from `server.listen_port` if the same `listen_addr` is used. |

**Validation:** The monitor address must differ from the API server address (same IP + same port is rejected).

---

## Manager Configuration

Optional connection to a bilbycast-manager instance for centralized monitoring and remote control. All communication uses an outbound WebSocket connection from the edge to the manager — no inbound connections are required, making this work behind NAT and firewalls.

```json
{
  "manager": {
    "enabled": true,
    "urls": ["wss://manager-host:8443/ws/node"],
    "accept_self_signed_cert": false,
    "cert_fingerprint": "ab:cd:ef:01:23:45:67:89:..."
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | No | `false` | Enable the manager connection. |
| `urls` | array of string | Yes (if enabled) | - | Ordered list of manager WebSocket URLs (1-16 entries), each `wss://` (TLS required). Example: `["wss://manager-host:8443/ws/node"]`. For an HA-paired manager cluster, list both hostnames — the edge tries them in order and rotates on WebSocket close with a 5-second backoff. Each entry max 2048 chars. |
| `accept_self_signed_cert` | boolean | No | `false` | Accept self-signed TLS certificates from the manager. **Dev/testing only** — disables all TLS validation. Requires `BILBYCAST_ALLOW_INSECURE=1` environment variable as a safety guard. |
| `cert_fingerprint` | string | No | `null` | SHA-256 fingerprint of the manager's TLS certificate for certificate pinning. Format: hex with colons, e.g. `"ab:cd:ef:01:23:..."`. When set, connections to servers presenting a different certificate are rejected, even if the certificate is CA-signed. Protects against compromised CAs. The server's fingerprint is logged on first connection. |
| `registration_token` | string | No | `null` | One-time registration token from the manager. Used on first connection only. After successful registration, the token is cleared and replaced by `node_id` + `node_secret`. **Stored in `secrets.json`.** |
| `node_id` | string | No | `null` | Persistent node ID assigned by the manager during registration. Saved automatically. |
| `node_secret` | string | No | `null` | Persistent node secret assigned by the manager during registration. **Stored in `secrets.json`** (encrypted at rest). |

### Registration Flow

1. Create a node in the manager UI — you receive a one-time registration token.
2. Provide the token via the setup wizard (`http://<edge-ip>:8080/setup`) or in `secrets.json`.
3. Start the edge. It connects to the manager, sends the token, and receives `node_id` + `node_secret`.
4. Credentials are saved automatically: `node_id` to `config.json`, `node_secret` to `secrets.json`.
5. The registration token is cleared. Future connections use `node_id` + `node_secret`.
6. If the connection drops, the edge auto-reconnects with exponential backoff (1s to 60s).

### Validation Rules

- `url` must start with `wss://` (plaintext `ws://` is rejected).
- `url` max 2048 characters.
- `registration_token` max 4096 characters.
- `accept_self_signed_cert: true` is rejected unless `BILBYCAST_ALLOW_INSECURE=1` is set.

---

## Tunnel Configuration

IP tunnels create encrypted point-to-point links between edge nodes, either through a bilbycast-relay server (for NAT traversal) or directly via QUIC (when one edge has a public IP).

### Relay Mode

Both edges connect outbound to a bilbycast-relay server. The relay pairs them by tunnel UUID and forwards traffic. End-to-end encryption ensures the relay cannot read payloads.

`relay_addrs` is an ordered list: index 0 is the primary, and an optional second entry is a backup. When the primary becomes unreachable, the edge automatically fails over to the backup; when the primary recovers, an RTT-gated probe fails back. See [Redundant Relay Failover](#redundant-relay-failover).

```json
{
  "tunnels": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "name": "Stadium to Studio",
      "protocol": "udp",
      "mode": "relay",
      "direction": "egress",
      "local_addr": "0.0.0.0:9000",
      "relay_addrs": [
        "relay-primary.example.com:4433",
        "relay-backup.example.com:4433"
      ],
      "tunnel_encryption_key": "0123456789abcdef...",
      "tunnel_bind_secret": "fedcba9876543210..."
    }
  ]
}
```

The legacy single-field `"relay_addr": "host:port"` form is still accepted on load and migrated into `relay_addrs[0]` automatically; new configs should use `relay_addrs`.

### Direct Mode

One edge has a public IP. Direct QUIC connection between edges — no relay needed.

```json
{
  "tunnels": [
    {
      "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
      "name": "Direct Link",
      "protocol": "tcp",
      "mode": "direct",
      "direction": "ingress",
      "local_addr": "127.0.0.1:9000",
      "direct_listen_addr": "0.0.0.0:4433",
      "tunnel_psk": "abcdef0123456789..."
    }
  ]
}
```

### Tunnel Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | Yes | - | Unique tunnel identifier. Must be a valid UUID. Both edges in a tunnel pair must use the same ID. |
| `name` | string | Yes | - | Human-readable name. |
| `enabled` | boolean | No | `true` | Whether the tunnel is active. |
| `protocol` | string | Yes | - | `"tcp"` (reliable, ordered — QUIC streams) or `"udp"` (unreliable — QUIC datagrams, best for SRT and media). |
| `mode` | string | Yes | - | `"relay"` (via relay server) or `"direct"` (QUIC peer-to-peer). |
| `direction` | string | Yes | - | `"ingress"` (receives tunnel traffic, forwards to `local_addr`) or `"egress"` (listens on `local_addr`, sends into tunnel). |
| `local_addr` | string | Yes | - | For **egress**: listen address for local traffic to tunnel (e.g. `"0.0.0.0:9000"`). For **ingress**: forward destination for received traffic (e.g. `"127.0.0.1:9000"`). |
| `relay_addrs` | string[] | Relay mode | `[]` | Ordered list of relay server QUIC addresses (e.g. `["relay1:4433", "relay2:4433"]`). Index 0 is the primary; a second entry enables automatic primary↔backup failover. Max 2 entries. Required for relay mode. |
| `relay_addr` | string | No | `null` | **Legacy.** Single relay address. Accepted on load for backward compatibility and migrated into `relay_addrs[0]`. Prefer `relay_addrs` in new configs. |
| `max_rtt_failback_increase_ms` | integer | No | `50` | When the active backup is in use and the primary recovers, failback is refused if the primary's measured QUIC RTT exceeds the backup's by more than this many ms. Prevents flapping back to a degraded primary. |
| `tunnel_encryption_key` | string | Relay mode | `null` | End-to-end ChaCha20-Poly1305 encryption key. Hex-encoded, exactly 64 chars (32 bytes). Required for relay mode. Both edges must share the same key. **Stored in `secrets.json`.** |
| `tunnel_bind_secret` | string | No | `null` | HMAC-SHA256 bind authentication secret. Hex-encoded, exactly 64 chars. Proves authorization to bind on the relay. **Stored in `secrets.json`.** |
| `peer_addr` | string | Direct egress | `null` | Remote peer QUIC address (e.g. `"203.0.113.50:4433"`). Required for direct mode, egress direction. |
| `direct_listen_addr` | string | Direct ingress | `null` | QUIC listen address (e.g. `"0.0.0.0:4433"`). Required for direct mode, ingress direction. |
| `tunnel_psk` | string | No | `null` | Pre-shared key for direct mode authentication. Hex-encoded, 64 chars. Both edges must share the same PSK. **Stored in `secrets.json`.** |
| `tls_cert_pem` | string | No | Auto-generated | TLS certificate PEM for direct mode listener. Auto-generated if absent. **Stored in `secrets.json`.** |
| `tls_key_pem` | string | No | Auto-generated | TLS private key PEM for direct mode listener. **Stored in `secrets.json`.** |

### Tunnel Validation Rules

- `id` must be a valid UUID.
- `relay_addrs` (or legacy `relay_addr`) required when `mode` is `"relay"`; at least one, at most two entries; each 1–256 chars; duplicates rejected.
- `tunnel_encryption_key` required for relay mode; must be exactly 64 hex characters.
- `tunnel_bind_secret` must be exactly 64 hex characters if present.
- `peer_addr` required for direct mode egress.
- `direct_listen_addr` required for direct mode ingress.
- `tunnel_psk` must be exactly 64 hex characters if present.
- All address fields must be valid socket addresses.

### Redundant Relay Failover

When `relay_addrs` contains a second entry, the edge provides automatic primary↔backup failover:

- **Detection.** The QUIC transport uses a 5 s keep-alive interval and a 25 s max-idle timeout, so a dead relay is detected after ~25 s of silence. This window is sized to tolerate Starlink satellite handovers and mobile cell-handoffs without flapping.
- **Failover.** Once the primary is detected down, the edge reconnects and walks to the next relay in `relay_addrs`. Each reconnect attempt is bounded to 6 s so a dead primary cannot stall the loop behind the transport timeout. Expected end-to-end failover budget is **~30–40 s** on WAN links (both edges detect independently; the slower side sets total latency).
- **Waiting convergence.** If the two edges initially land on different relays, the first-to-bind sees `Waiting`; after 10 s it steps forward to the next relay so the pair converges on the same one.
- **Failback.** A background probe (every 60 s) measures the primary's QUIC RTT. When the primary's RTT is within `max_rtt_failback_increase_ms` (default 50 ms) of the currently-active backup, traffic fails back to the primary. This RTT gate prevents returning to a degraded primary that is reachable but slow.
- **Event visibility.** Each failover emits a Warning event to the manager with `from_relay_addr`, `to_relay_addr`, `from_idx`, `to_idx` details.

Tunnel-level failover is not *hitless* — expect a ~30 s gap on the tunneled flow during failover. For hitless redundancy within a flow, use SMPTE 2022-7 dual-leg or SRT bonding end-to-end; tunnel-level redundancy only protects against relay-server failure. A tunnel with a single `relay_addrs` entry will simply reconnect to that same address until it returns.

---

## Flow Configuration

A flow connects one or more inputs to any number of outputs, **by reference**. The inputs and outputs themselves are defined once at the top level.

```json
{
  "id": "main-feed",
  "name": "Main Program Feed",
  "enabled": true,
  "input_ids": ["srt-in-1", "srt-in-backup"],
  "output_ids": ["udp-out-1", "rtmp-out-1"]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | Yes | - | Unique identifier. Cannot be empty. Must be unique across all flows. |
| `name` | string | Yes | - | Human-readable display name. Cannot be empty. |
| `enabled` | boolean | No | `true` | Whether to auto-start this flow on startup or creation. |
| `input_ids` | array | No | `[]` | IDs of the inputs this flow uses. In a passthrough flow **at most one is active at a time**; the rest are standby, switched with a Take. In an assembled flow every member runs concurrently. May be empty — an empty list makes this an *output-only* flow that owns its outputs and consumes another flow's published inputs. |
| `output_ids` | array | No | `[]` | IDs of the outputs this flow feeds. May be empty — an empty list makes this an *input-host* flow that owns its inputs and publishes them for sibling flows to consume. |
| `media_analysis` | boolean | No | `true` | Enable media content analysis (codec, resolution, frame rate detection). |
| `thumbnail` | boolean | No | `true` | Enable thumbnail generation. |
| `thumbnail_program_number` | integer | No | `null` | When the input is an MPTS, render the thumbnail from this program only. Must be `> 0` if set. See [MPTS → SPTS filtering](#mpts--spts-filtering). |
| `thumbnail_interval_secs` | integer | No | `5` | Capture cadence, 1–60 s. Freeze detection samples on its own fixed floor, decoupled from this, so a fast preview does not false-trip "frozen". |
| `bandwidth_limit` | object | No | `null` | Per-flow bandwidth monitoring (RP 2129). See [Bandwidth Limit](#bandwidth-limit). |
| `bandwidth_profile` | string | No | auto | Broadcast-channel sizing: `"standard"` (TS contribution to ~500 Mbps), `"high_bitrate"` (0.5–3 Gbps compressed), `"uncompressed"` (ST 2110-20/-23, MXL). Auto-derived from the input set; set this only to override. |
| `assembly` | object | No | `null` | PID-bus assembly block. `null` (or `"kind": "passthrough"`) forwards the active input verbatim. `"spts"` / `"mpts"` builds a fresh MPEG-TS from elementary streams pulled off any of the flow's inputs. See [Flow Assembly (PID Bus)](/edge/flow-assembly/). |
| `content_analysis` | object | No | `null` | In-depth content analysis tier — `lite`, `audio_full` or `video_full`. Each tier is an independent subscriber that drops rather than backpressuring the media path. |
| `recording` | object | No | `null` | Continuous recording to disk for replay. See [Recording (Flow Attribute)](#recording-flow-attribute). |
| `master_clock` | object | No | `null` | Override the per-flow master clock. Auto-selected by flow role when unset — see [Master Clock & A/V Sync](/edge/clocking/). |
| `flow_group_id` | string | No | `null` | ST 2110 flow-group membership. |
| `clock_domain` | integer | No | `null` | PTP clock domain for ST 2110 flows. Advertised on NMOS IS-04. |

:::caution[Changing some fields restarts the flow]
Most edits are applied surgically — adding or removing an input, editing a standby input's definition, or adding an output does not interrupt what is on air.

Five flow-level fields are read once when the flow starts and therefore **force a full restart** when changed: `bandwidth_limit`, `content_analysis`, `recording`, `master_clock` and `assembly`. Changing a hitless leg list does the same.
:::

### Bandwidth Limit

Optional per-flow bandwidth monitoring for SMPTE RP 2129 trust boundary enforcement. Monitors the flow's input bitrate and takes action when it exceeds the configured limit for the grace period. Works with all input types (RTP, UDP, SRT, RTMP, RTSP, WebRTC).

```json
{
  "bandwidth_limit": {
    "max_bitrate_mbps": 25.0,
    "action": "alarm",
    "grace_period_secs": 5
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `max_bitrate_mbps` | float | Yes | - | Expected maximum bitrate in Mbps. Must be positive and at most 10000 (10 Gbps). |
| `action` | string | Yes | - | `"alarm"`: raise warning event + flag on dashboard. `"block"`: drop all packets until bandwidth normalizes. |
| `grace_period_secs` | integer | No | `5` | Seconds the bitrate must continuously exceed the limit before triggering (1-60). |

**Alarm action:** Emits a warning event and flags the flow on the dashboard. The flow continues operating. An info event is emitted when bitrate returns to normal.

**Block action:** Gates the flow — drops all incoming packets while bandwidth exceeds the limit. The flow stays alive and automatically resumes when bandwidth normalizes via a probe-and-check mechanism. Blocked packets are counted in `packets_filtered`.

:::note
This is distinct from `max_bitrate_mbps` on RTP input, which is a hard token-bucket rate limiter that drops excess packets immediately. `bandwidth_limit` monitors aggregate flow bitrate over time with a grace period and configurable response actions.
:::

---

## Input Types

Each entry in the top-level `inputs` array carries an `id`, a `name`, and a `type` discriminator selecting the variant. There are twenty-three:

`rtp`, `rtp_audio`, `udp`, `srt`, `rist`, `rtmp`, `rtsp`, `webrtc`, `whep`, `media_player`, `test_pattern`, `mosaic`, `bonded`, `replay`, `sdi`, `st2110_20`, `st2110_23`, `st2110_30`, `st2110_31`, `st2110_40`, `mxl_video`, `mxl_audio`, `mxl_anc`.

The transport types are documented below. The five ST 2110 types and `rtp_audio` have their own section further down ([SMPTE ST 2110](#smpte-st-2110)); `mosaic` — the multiviewer wall compositor, feature-gated on `multiviewer` — is documented under [Multiviewer](/edge/multiviewer/); and the three `mxl_*` types — feature-gated on `mxl`, whose library is probed at boot — under [MXL](/edge/mxl/).

### Fields shared across input types

| Field | Type | Default | Applies to | Description |
|-------|------|---------|-----------|-------------|
| `active` | boolean | `true` | All inputs | Every member of a flow runs and holds its connection (warm passive), but only the active one publishes to the flow's broadcast channel. In a passthrough flow at most one member is active at a time. Switched at runtime with `activate_input` / a Take — a whole-config push deliberately does **not** move it. |
| `group` | string | `null` | All inputs | Optional free-form tag for UI grouping. Max 64 characters. |
| `passthrough_clock` | boolean | `false` | TS-carrying inputs | Forward the source's PCR and PES timestamps **unchanged**. By default the edge regenerates them against its own master clock (encoder-style), which is what you want for a jittery or free-running source. Set `true` for relay / transparent-forwarder behaviour — and note it is **required** for [epoch lock](#epoch-lock-cross-node-alignment). |
| `ingress_dejitter_ms` | integer | `null` | RTP, UDP | De-jitter buffer depth, 20–2000 ms. Recovers the source rate from inter-PCR observations and releases packets paced at that rate, so analysers, the PCR PLL, the PID bus and every output see a smooth cadence regardless of network jitter. Cooperates with SMPTE 2022-7 — it runs after the merge. Unset falls back to the node-wide [`tuning.ingress_dejitter_ms`](#node-tuning); with that unset too, this input runs ingress passthrough. |
| `ingress_residence_ms` | integer | `max(4 × setpoint, 250)` | RTP, UDP | Hard-shed residence cap for this input's de-jitter buffer, `ingress_dejitter_ms + 40` – 5000 ms. A packet older than the cap is shed rather than released late, which is what bounds ingress latency when a burst or a source-rate offset outruns the servo's ±5 % authority. Unset falls back to the node-wide [`tuning.ingress_residence_ms`](#node-tuning). **Rejected at config load without `ingress_dejitter_ms` on the same input** — there is no buffer to cap, so accepting it would be a silent no-op. |
| `ingress_delay_ms` | integer | `null` | RTP, UDP, SRT, RTMP, RTSP | Fixed delay line ahead of the flow, 0–1000 ms. Unlike the `ingress_dejitter_ms` servo it **preserves** jitter — it shifts every packet by the same amount rather than re-pacing. Setting both on one input logs a warning and de-jitter wins. On an SRT input it stacks on top of `latency_ms` (libsrt's own jitter buffer), which is usually redundant and raises a Warning `srt` event. |
| `interface_binding` | object | `null` | Most inputs and outputs | Pin this endpoint to a specific NIC by name. Also honoured per-leg inside 2022-7 redundancy. A per-endpoint copy is accepted inside [native SRT bonding](#native-libsrt-srt-bonding-socket-groups) but is not applied there — see the caution in that section. |

:::note[Transcoding is available on the input side too]
`audio_encode`, its companion `transcode`, and `video_encode` are accepted on **eleven** input types — `rtp`, `udp`, `srt`, `rist`, `rtmp`, `rtsp`, `webrtc`, `whep`, `media_player`, `replay` and `test_pattern` — not only on outputs.

Normalising a feed once at ingress amortises the codec cost across every output attached to the flow, instead of paying it per output. The blocks take the same shape wherever they appear: see [Audio Gateway](/edge/audio-gateway/#the-audio_encode-block--compressed-audio-egress-rtmp--hls--webrtc) for `audio_encode` / `transcode` and the [Codec matrix](/edge/codec-matrix/) for `video_encode`.
:::

:::note[passthrough_clock and clock regeneration are opposites]
Leave `passthrough_clock` unset (regeneration on) for ordinary contribution — it re-anchors output timing to a clean local reference.

Set it to `true` when the source timing must reach the wire untouched: transparent forwarding, and any output participating in cross-node alignment. You cannot have both on the same input.
:::

### RTP Input

Receives RTP-wrapped MPEG-TS packets (SMPTE ST 2022-2). Requires valid RTP v2 headers. Supports unicast, multicast, IPv4, and IPv6. For raw TS without RTP headers, use the UDP input type.

```json
{
  "type": "rtp",
  "bind_addr": "239.1.1.1:5000",
  "interface_addr": "192.168.1.100",
  "fec_decode": {
    "columns": 10,
    "rows": 10
  },
  "allowed_sources": ["10.0.0.1"],
  "allowed_payload_types": [33],
  "max_bitrate_mbps": 100.0,
  "tr07_mode": true
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"rtp"`. |
| `bind_addr` | string | Yes | - | Local socket address to bind (`ip:port`). For multicast, use the group address (e.g., `"239.1.1.1:5000"`). For unicast, use `"0.0.0.0:5000"`. IPv6: `"[::]:5000"` or `"[ff7e::1]:5000"`. |
| `interface_addr` | string | No | `null` | Network interface IP for multicast group join. Required for multicast on multi-homed hosts. Must be the same address family as `bind_addr`. |
| `source_addr` | string | No | `null` | Source-Specific Multicast (S,G) filter — join only this sender's traffic. See [Multicast reception](#multicast-reception-ssm-asm-and-socket-binding). |
| `fec_decode` | object | No | `null` | SMPTE 2022-1 FEC decode parameters. See [FEC Configuration](#smpte-2022-1-fec-configuration). |
| `tr07_mode` | boolean | No | `null` | Enable VSF TR-07 mode to detect and report JPEG XS streams in the transport stream. |
| `allowed_sources` | array of strings | No | `null` | Source IP allow-list (RP 2129 C5). Only RTP packets from these source IPs are accepted. Each entry must be a valid IP address. When `null`, all sources are allowed. |
| `allowed_payload_types` | array of integers | No | `null` | RTP payload type allow-list (RP 2129 U4). Only packets with these PT values (0-127) are accepted. When `null`, all payload types are allowed. |
| `max_bitrate_mbps` | float | No | `null` | Maximum ingress bitrate in megabits per second (RP 2129 C7). Excess packets are dropped. Must be positive. When `null`, no rate limiting is applied. |

**Validation rules:**
- `bind_addr` must be a valid `ip:port` socket address.
- `interface_addr` must be a valid IP address (no port) in the same address family as `bind_addr`.
- `allowed_payload_types` values must be 0-127.
- `max_bitrate_mbps` must be positive.

### UDP Input

Receives raw UDP datagrams without requiring RTP headers. Suitable for raw MPEG-TS over UDP from OBS, ffmpeg (`-f mpegts udp://`), srt-live-transmit, VLC, or any source that sends plain TS.

```json
{
  "type": "udp",
  "bind_addr": "0.0.0.0:5000",
  "interface_addr": "192.168.1.100"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"udp"`. |
| `bind_addr` | string | Yes | - | Local socket address to bind (`ip:port`). For multicast, use the group address. |
| `interface_addr` | string | No | `null` | Network interface IP for multicast group join. Must be the same address family as `bind_addr`. |
| `source_addr` | string | No | `null` | Source-Specific Multicast (S,G) filter — join only this sender's traffic. See [Multicast reception](#multicast-reception-ssm-asm-and-socket-binding). |

**Validation rules:**
- `bind_addr` must be a valid `ip:port` socket address.
- `interface_addr` must be a valid IP address in the same address family as `bind_addr`.

### Multicast reception: SSM, ASM and socket binding

Applies to the `rtp` and `udp` inputs above, to all five ST 2110 input types and `rtp_audio`, and to each leg of a 2022-7 `redundancy` block — every one of those carries its own `source_addr`, so a Red/Blue plant whose two paths have different source IPs can filter each leg independently. The RIST input has no `source_addr`.

**ASM (any-source) is the default.** Leaving `source_addr` unset issues a plain `IP_ADD_MEMBERSHIP` join: the host accepts traffic sent to the group from any sender, and a mis-configured second encoder on the same group is indistinguishable from the real one.

**SSM (source-specific)** sets `source_addr` to the sender's **unicast** address and issues an `IP_ADD_SOURCE_MEMBERSHIP` join instead, so the kernel filters in the network stack. Validation rejects a `source_addr` when `bind_addr` is not multicast (there is no group to filter), a multicast `source_addr`, and an address-family mismatch between the two.

**How the receive socket binds.** On Linux the socket is bound to `<group>:<port>`, so two inputs on the same port subscribed to different groups each see only their own group's traffic. `SO_REUSEADDR` stays set, so several inputs may still deliberately share one `<group>:<port>`. If the group-address bind is refused the edge falls back to the wildcard `0.0.0.0:<port>` / `[::]:<port>` and logs a warning naming the group and "no same-port group isolation" — there is no event and no config surface for that fallback, so it is a log line to watch for. Non-Linux hosts always bind the wildcard and therefore have **no** same-port group isolation: every socket on that port sees every group any socket on the host has joined.

### SRT Input

Receives RTP encapsulated in SRT. Supports caller, listener, and rendezvous modes with optional encryption and SMPTE 2022-7 redundancy.

```json
{
  "type": "srt",
  "mode": "listener",
  "local_addr": "0.0.0.0:9000",
  "remote_addr": null,
  "latency_ms": 500,
  "passphrase": "my-encryption-key",
  "aes_key_len": 32,
  "crypto_mode": "aes-gcm",
  "redundancy": {
    "mode": "listener",
    "local_addr": "0.0.0.0:9001",
    "latency_ms": 500,
    "passphrase": "my-encryption-key",
    "aes_key_len": 32,
    "crypto_mode": "aes-gcm"
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"srt"`. |
| `mode` | string | Yes | - | SRT connection mode: `"caller"`, `"listener"`, or `"rendezvous"`. See [SRT Connection Modes](#srt-connection-modes). |
| `local_addr` | string | Conditional | `null` | Listen address (`ip:port`) — **required** for `listener` and `rendezvous`. For `caller` it is the optional **source** bind: omit it and the socket binds `0.0.0.0:0` (ephemeral). Never set it equal to `remote_addr` on a caller; validation rejects that as a self-connect. |
| `remote_addr` | string | Conditional | `null` | Remote address to connect to. Required for `caller` and `rendezvous` modes. |
| `latency_ms` | integer | No | `120` | SRT receive latency buffer in milliseconds. Higher values provide more resilience to network jitter at the cost of increased delay. |
| `passphrase` | string | No | `null` | AES encryption passphrase. Must be 10-79 characters. When `null`, encryption is disabled. |
| `aes_key_len` | integer | No | `16` | AES key length in bytes: `16` (AES-128), `24` (AES-192), or `32` (AES-256). Only meaningful if `passphrase` is set. |
| `crypto_mode` | string | No | `null` | Cipher mode: `"aes-ctr"` (default) or `"aes-gcm"` (authenticated encryption). AES-GCM requires libsrt >= 1.5.2 on the peer and only supports AES-128/256 (not AES-192). |
| `redundancy` | object | No | `null` | SMPTE 2022-7 redundancy configuration for a second SRT leg. See [SRT Redundancy](#smpte-2022-7-srt-redundancy). |

**Validation rules:**
- `local_addr` is required for `listener` and `rendezvous` modes; on a `caller` it is optional, and when present must not equal `remote_addr`. Any value given must be a valid socket address.
- `remote_addr` is required for `caller` and `rendezvous` modes and must be a valid socket address.
- `passphrase` must be 10-79 characters.
- `aes_key_len` must be 16, 24, or 32.
- `crypto_mode` must be `"aes-ctr"` or `"aes-gcm"`. AES-GCM with `aes_key_len` 24 is rejected.

#### SRT advanced socket parameters

Beyond the fields above, an SRT input or output accepts the full libsrt socket-tuning set. Every field below is optional and sits on **both** `srt` inputs and `srt` outputs, with identical names and identical bounds — one validator serves both sides. Unset means "leave libsrt's own default alone"; the Default column is libsrt's value, not something the edge writes. Under [native SRT bonding](#native-libsrt-srt-bonding-socket-groups) these are parent-level settings and apply to **all** members uniformly.

| Field | Type | Default | Bounds / notes |
|-------|------|---------|----------------|
| `recv_latency_ms` | integer | `latency_ms` | Receiver-side latency override — how long the receiver buffers before delivering. Overrides `latency_ms` for the receive direction only. |
| `peer_latency_ms` | integer | `latency_ms` | Sender-side latency override — the minimum latency the sender asks the receiver to hold. |
| `peer_idle_timeout_secs` | integer | `30` | Drop the connection after this long with no data. 30 s suits broadcast; lower it only if you want faster failover than SRT's own recovery. |
| `stream_id` | string | unset | Max **512** characters (SRT spec). Callers send it in the handshake for identification; a listener that sets it accepts only matching connections. Plain strings and the structured `#!::key=value,…` form both work. |
| `packet_filter` | string | unset | SRT FEC, e.g. `"fec,cols:10,rows:5,layout:staircase,arq:onreq"`. Max 512 chars; `cols` and `rows` each 1–256. Negotiated in the handshake, so **both peers must agree**. **Rejected in `rendezvous` mode** — libsrt 1.5.5 cannot negotiate the filter extension when both sides induct simultaneously, and the handshake silently loops on retry. |
| `max_bw` | integer | unset (libsrt default) | Total send-rate cap in **bytes/sec**. Must be `>= 0` when set; `0` means unlimited. |
| `input_bw` | integer | `0` (auto) | Estimated input rate in bytes/sec, feeding congestion control. `0` auto-detects from the data rate. |
| `overhead_bw` | integer | `25` | Retransmission headroom as a **percentage** over the input rate. Range **5–100**. |
| `max_rexmit_bw` | integer | `-1` | Retransmission bandwidth cap in bytes/sec (token-bucket shaper). `-1` unlimited, `0` disables retransmission entirely, `> 0` caps it. Values below `-1` are rejected. |
| `retransmit_algo` | string | `"default"` | `"default"` or `"reduced"` (libsrt 1.5.5's efficient algorithm). |
| `send_drop_delay` | integer | `-1` | Extra delay in ms before the sender drops a packet. `-1` = off. Must be `>= -1`. |
| `loss_max_ttl` | integer | `0` | Reorder tolerance in packets. `0` = adaptive. Must be `>= 0`. |
| `tlpkt_drop` | boolean | `true` in live mode | Too-late packet drop: discard packets that arrive after their TSBPD deadline. Turn **off** for recording / archival paths where completeness beats timeliness. |
| `flight_flag_size` | integer | `25600` | Flow-control window, in packets. Must be `>= 32`. |
| `send_buffer_size` | integer | `8192` | Send buffer, in packets. Must be `>= 32`. |
| `recv_buffer_size` | integer | `8192` | Receive buffer, in packets. Must be `>= 32`. |
| `payload_size` | integer | `1316` | Bytes of payload per SRT packet. Range **188–1456**. `1316 = 7 × 188` is the MPEG-TS-aligned default. |
| `mss` | integer | `1500` | Maximum Segment Size in bytes, including the SRT header. Range **76–9000**. Lower it for VPN / tunnel paths that fragment; raise it for jumbo frames. |
| `ip_tos` | integer | `0` | `IP_TOS` byte (DSCP × 4 + ECN). Range **0–255**. |
| `ip_ttl` | integer | `64` | IP Time To Live. Range **1–255**. |
| `connect_timeout_secs` | integer | `3` | Caller/rendezvous connect timeout. |
| `enforced_encryption` | boolean | `true` | Reject peers that do not present matching encryption. |
| `km_refresh_rate` | integer | ~16 M | Key-material refresh period, in packets. Must be `> 0`. |
| `km_pre_announce` | integer | `4096` | Packets of advance notice before a key refresh. Must be `> 0`. |
| `external_address` | string | unset | Public `host:port` this listener is reachable on from outside (a firewall port-forward). Listener mode only. **Hint to the manager UI** — the edge binds `local_addr` and ignores this semantically; the manager's topology matcher uses it so cross-NAT links draw correctly. |

### RIST Input

Receives RIST Simple Profile (VSF TR-06-1:2020) — reliable RTP transport with RTCP NACK-based retransmission. Interoperable with librist `ristsender` / `ristreceiver`. RIST is always compiled in — there is no feature flag. It binds an even RTP port `P` locally and RTCP on `P+1`, learning the peer's RTCP address dynamically. Optional SMPTE 2022-7 redundancy merges a second RIST leg.

```json
{
  "type": "rist",
  "bind_addr": "0.0.0.0:6000",
  "buffer_ms": 1000,
  "max_nack_retries": 10,
  "rtcp_interval_ms": 100
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"rist"`. |
| `bind_addr` | string | Yes | - | Local socket address to bind (`ip:port`). The port **must be even** — RIST binds RTCP on `port+1`. |
| `buffer_ms` | integer | No | `1000` | Receiver jitter / retransmit buffer depth in milliseconds. Range 50–30000. |
| `max_nack_retries` | integer | No | `10` | Maximum NACK retransmission attempts per lost packet. |
| `cname` | string | No | `null` | CNAME emitted in RTCP SDES packets. Auto-generated when absent. |
| `rtcp_interval_ms` | integer | No | `null` | RTCP emission interval in milliseconds (TR-06-1 requires ≤ 100 ms). |
| `redundancy` | object | No | `null` | SMPTE 2022-7 redundancy — the primary `bind_addr` is leg 1; this defines leg 2. |
| `external_address` | string | No | `null` | Optional public `host:port` reachable from outside this node's network (advertised, not consumed). |
| `pid_map` / `pid_overrides` | object | No | `null` | TS PID rewriting on the ingested stream. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). RIST has **no** `source_addr` — SSM filtering is not available on this input type. |

### RTMP Input

Accepts incoming RTMP publish connections from OBS, ffmpeg, Wirecast, etc.

```json
{
  "type": "rtmp",
  "listen_addr": "0.0.0.0:1935",
  "app": "live",
  "stream_key": "my_secret_key"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"rtmp"`. |
| `listen_addr` | string | Yes | - | Local socket address to accept publishers on, e.g. `"0.0.0.0:1935"`. |
| `external_address` | string | No | `null` | Public `host:port` this listener is reachable on from outside. Advertised to the manager's topology matcher only — the edge binds `listen_addr` regardless. |
| `app` | string | No | `"live"` | The RTMP URL's application (path) component. A publisher connecting to another app is refused. |
| `stream_key` | string | No | `null` | Expected stream key. `null` accepts any key. |
| `max_publishers` | integer | No | `1` | **Accepted but currently inert** — nothing in the RTMP server reads it. The real ceiling is a hard-coded 8 concurrent connections per RTMP input, enforced by a semaphore in the accept loop and not operator-settable, with a separate single-publisher gate on top. |

`audio_encode`, `transcode`, `video_encode`, `program_number`, `pid_map` and `pid_overrides` are also accepted here — see the sections those fields link to elsewhere on this page. `passthrough_clock` and `ingress_delay_ms` are covered by the [shared input-field table](#fields-shared-across-input-types).

### RTSP Input

Pulls H.264 or H.265/HEVC video and AAC audio from RTSP sources (IP cameras, media servers). Uses the `retina` RTSP client with automatic reconnection. Produces MPEG-TS with proper PAT/PMT program tables. Audio-only streams are supported (PAT/PMT are emitted even without video).

```json
{
  "type": "rtsp",
  "rtsp_url": "rtsp://camera.local:554/stream1",
  "username": "admin",
  "password": "secret",
  "transport": "tcp"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"rtsp"`. |
| `rtsp_url` | string | Yes | - | RTSP source URL. Must start with `rtsp://` or `rtsps://`. |
| `username` | string | No | `null` | RTSP authentication username (Digest or Basic). |
| `password` | string | No | `null` | RTSP authentication password. |
| `transport` | string | No | `"tcp"` | `"tcp"` (interleaved, reliable) or `"udp"` (lower latency). |
| `timeout_secs` | integer | No | `10` | Connection timeout in seconds. |
| `reconnect_delay_secs` | integer | No | `5` | Delay between reconnection attempts on failure. |

### WebRTC/WHIP Input

Accepts WebRTC contributions from publishers (OBS, browsers) via the WHIP protocol (RFC 9725). The `webrtc` feature is enabled by default.

```json
{
  "type": "webrtc",
  "bearer_token": "my-auth-token"
}
```

Publishers POST an SDP offer to `/api/v1/flows/{flow_id}/whip` and receive an SDP answer. The Bearer token (if configured) must be included in the `Authorization` header.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"webrtc"`. |
| `bearer_token` | string | No | `null` | Required from WHIP publishers for authentication. |
| `video_only` | boolean | No | `false` | Ignore audio tracks from publisher. |
| `public_ip` | string | No | `null` | Public IP to advertise in ICE candidates (for NAT traversal). |
| `stun_server` | string | No | `null` | STUN server URL for ICE candidate gathering. |

### WHEP Input

Pulls media from an external WHEP server. The edge acts as a WHEP client. The `webrtc` feature is enabled by default.

```json
{
  "type": "whep",
  "whep_url": "https://server.example.com/whep/stream",
  "bearer_token": "optional-token"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"whep"`. |
| `whep_url` | string | Yes | - | WHEP endpoint URL to pull from. |
| `bearer_token` | string | No | `null` | Bearer token for WHEP authentication. |
| `video_only` | boolean | No | `false` | Receive only video (ignore audio). |
| `accept_self_signed_cert` | boolean | No | **`true`** | Skip TLS certificate validation when pulling from the WHEP server. It defaults to **true** for historical compatibility — set it `false` for any production pull from an external server. Unlike the `manager` block's identically-named field, this one is **not** gated by `BILBYCAST_ALLOW_INSECURE`. |
| `cert_fingerprint` | string | No | `null` | SHA-256 fingerprint of the expected WHEP server's leaf certificate (colon-separated hex). When set, full CA-chain validation runs **and** the leaf must match — it overrides `accept_self_signed_cert`. |
| `program_number` | integer | No | `null` | MPTS program selector for the synthesised TS. Must be `> 0` if set. |
| `pid_map` | object | No | `null` | Flat source-PID → target-PID rewrite. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `pid_overrides` | object | No | `null` | Per-program PID pinning. Synthetic-TS path, so exactly one entry keyed `1`. |
| `audio_encode` / `transcode` / `video_encode` | object | No | `null` | Optional input-side re-encode blocks, normalising the pulled feed once at ingress. |

### Media Player Input

Replays one or more local files (MPEG-TS, MP4 / MOV / MKV, or still images) as a paced fresh MPEG-TS feed onto the flow's broadcast channel, so every output type works unchanged. The marquee use case is a slate / standby fallback on a PID-bus Hitless leg of an assembled flow — the live primary takes precedence; if it stalls past the hitless threshold, playback of the local file kicks in transparently. Files live under the edge's media library directory (`BILBYCAST_MEDIA_DIR`) and are uploaded from the manager.

```json
{
  "type": "media_player",
  "id": "slate-1",
  "name": "Standby slate",
  "sources": [
    { "kind": "ts",    "name": "loop.ts" },
    { "kind": "mp4",   "name": "promo.mp4" },
    { "kind": "image", "name": "slate.png", "fps": 5, "bitrate_kbps": 250, "audio_silence": true }
  ],
  "loop_playback": true,
  "shuffle": false,
  "paced_bitrate_bps": null
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | — | Must be `"media_player"`. |
| `sources` | array | Yes | — | 1–256 entries. Each is a source tagged by `kind` (`"ts"`, `"mp4"`, or `"image"`) with a `name` referencing a file in the media library. |
| `loop_playback` | boolean | No | `true` | Restart at the head of the playlist when the last source ends. |
| `shuffle` | boolean | No | `false` | Randomise source order each time the playlist starts. |
| `paced_bitrate_bps` | integer | No | `null` | TS-only override for the egress pacer when the source has no usable PCR. Range 100 000 – 200 000 000. Leave `null` to pace from PCR. |
| `program_number` | integer | No | `null` | MPTS program filter. Must be `> 0` if set. |
| `ts_packets_per_datagram` | integer | No | `7` | 188-byte TS packets bundled into each broadcast-channel / tunnel datagram. Range 1–348. |
| `pid_map` / `pid_overrides` | object | No | `null` | TS PID rewriting on the generated stream. Synthetic-TS path, so `pid_overrides` takes exactly one entry keyed `1`. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `operator_control` | boolean | No | node default (on) | Run this player through the transition state machine — the path the manager's **Next** button drives. `false` pins this input to the legacy sequential loop, and a `Next` issued against it is answered `media_player_control_unavailable`. Unset falls back to [`tuning.media_player_controller`](#node-tuning). |
| `pcr_deadlines` | boolean | No | node default (on) | Pace this input's TS playout on deadlines anchored to the asset's own PCR. `false` selects the legacy byte-rate estimate, whose error integrates without bound on variable-bitrate assets. Per-input because the failure it guards against is *asset*-dependent — a spliced file whose PCR steps mid-asset — so one playlist can be moved without changing the node. Unset falls back to [`tuning.media_player_pcr_deadlines`](#node-tuning). |

**Source fields:** `kind` (`"ts"` / `"mp4"` / `"image"`) and `name` are required on every entry. Image sources also take `fps` (1–60, default 5), `bitrate_kbps` (50–50 000, default 250), and `audio_silence` (default `true`). `mp4` sources must be **plain (unfragmented)** H.264 + AAC — fragmented MP4 is rejected with a Critical `media_player_source_unsupported` event.

### TestPattern Input

Generates a synthetic colour-bars-and-tone test pattern as an MPEG-TS stream with H.264 video and AAC audio. Useful for end-to-end pipeline tests, smoke-testing newly-deployed flows, and exercising downstream gear without a real source.

```json
{
  "type": "test_pattern",
  "id": "in-test",
  "name": "Test pattern",
  "width": 1280,
  "height": 720,
  "fps": 25,
  "video_bitrate_kbps": 2000,
  "audio_enabled": true,
  "tone_hz": 1000.0,
  "tone_dbfs": -20.0,
  "av_sync_marker": false,
  "av_sync_style": "flash",
  "audio_channels": 2,
  "audio_content": "tone",
  "screen_id": "STUDIO A",
  "ts_packets_per_datagram": 7
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | — | Must be `"test_pattern"`. |
| `width` | integer | No | `1280` | Video width in pixels. Must be divisible by 2. |
| `height` | integer | No | `720` | Video height in pixels. Must be divisible by 2. |
| `fps` | integer | No | `25` | Frame rate. Range 1–60. |
| `video_bitrate_kbps` | integer | No | `2000` | Target video bitrate in kbit/s. |
| `audio_enabled` | boolean | No | `true` | When `false`, emits a video-only TS. |
| `tone_hz` | number | No | `1000.0` | Audio tone frequency. Range 50–8000. |
| `tone_dbfs` | number | No | `-20.0` | Audio level in dBFS (negative). `-20 dBFS` is the broadcast reference. |
| `av_sync_marker` | boolean | No | `false` | A/V-sync test mode (EBU R 49 / SMPTE 2-pop style). When `true`, the tone gates into a ~80 ms burst on the timecode second boundary and a visual marker appears on the same frames. Offset between audible pip and visible marker reads off directly as A/V skew. Overrides `audio_content` while on, and requires `audio_enabled = true`. |
| `av_sync_style` | string | No | `"flash"` | Visual style of that marker. `"flash"` — a corner luma patch that flashes on the beep (EBU R 49 / 2-pop). `"sweep"` — a dot orbits a ring once per second and the beep fires as it crosses 12 o'clock, so skew reads off the dot's position rather than off a memory of the flash. |
| `audio_channels` | integer | No | `2` | Synthetic audio channels. Legal values are `1`, `2`, `6`, `8` — the AAC channel modes the encoder can open (7 has none, so it is rejected at config load). Distinct from the SDI input's `0`/`2`/`8`/`16`. |
| `audio_content` | string | No | `"tone"` | What each channel carries. `"tone"` — the same sine on every channel, classic line-up. `"channel_ident"` — each channel announces its own 1-based number: a looped spoken digit when a voice clip is present in the testgen-voice directory (`BILBYCAST_TESTGEN_VOICE_DIR`), otherwise N counted beeps per cycle. |
| `channel_ident_layout` | string | No | `"sequential"` | How those idents are arranged in time, when `audio_content = "channel_ident"`. `"sequential"` — one channel per one-second slot, the BLITS / GLITS approach, so the numbers survive a summed downmix; N channels take N seconds per loop. `"simultaneous"` — every channel announces at once: right when soloing one channel at a time, a cacophony on a downmix. |
| `screen_id` | string | No | `null` | Burnt-in identifier near the top of frame so several generators are told apart on a multiviewer. Max 32 characters; rendered uppercase, and characters the 5×7 glyph set does not cover are dropped rather than rejected. |
| `ts_packets_per_datagram` | integer | No | `7` | Number of 188-byte MPEG-TS packets bundled into each UDP datagram on the flow's broadcast channel and the QUIC/UDP tunnel path (both forward each datagram unchanged). Range 1–348 (348 × 188 = 65424 B, the largest that fits one UDP datagram). Default `7` → 7 × 188 = 1316 B, the standard / SRT datagram size. Lower it (e.g. 4–5) for a constrained / low-MTU internet or cellular path where a big datagram IP-fragments and drops; raise it (8+) to test jumbo datagrams on a LAN. Independent of any downstream UDP/RTP/SRT output, which re-chunk to their own fixed 1316 B wire size. |
| `program_number` | integer | No | `null` | MPTS program selector. Must be `> 0` if set. |
| `pid_map` | object | No | `null` | Flat source-PID → target-PID rewrite. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `pid_overrides` | object | No | `null` | Per-program PID pinning. Synthetic-TS path, so the map must hold exactly one entry keyed `1`. |
| `audio_encode` / `transcode` / `video_encode` | object | No | `null` | Optional input-side re-encode blocks — normalise the generated feed once at ingress rather than per output. |

Requires the edge build to include the `media-codecs` and `fdk-aac` features (both on by default).

### Bonded Input

Receives a media flow over the bilbycast multi-path bonding stack — the protocol that replaces appliances like Peplink/SpeedFusion with a media-aware bonded transport. Multiple network paths are aggregated for throughput and failover; per-packet sequencing reorders into a single ordered stream at this end.

```json
{
  "type": "bonded",
  "id": "in-bonded",
  "name": "Bonded receive",
  "bond_flow_id": 42,
  "hold_ms": 400,
  "keepalive_ms": 200,
  "paths": [
    { "id": 0, "name": "path-a", "weight_hint": 1, "transport": { "type": "udp", "bind": "0.0.0.0:7100" } },
    { "id": 1, "name": "path-b", "weight_hint": 1, "transport": { "type": "udp", "bind": "0.0.0.0:7102" } }
  ]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | — | Must be `"bonded"`. |
| `bond_flow_id` | integer | Yes | — | Bond identifier; must match the sender's value. |
| `paths` | array | Yes | — | Receive legs, each with a unique `id`, a `name`, a `weight_hint`, and a `transport` block carrying that leg's own `bind` address. **There is no top-level `local_addr`** — bind addresses are per-leg. |
| `hold_ms` | integer | No | — | Reorder hold before a gap is declared. |
| `hold_max_ms` | integer | No | — | Upper bound on that hold. |
| `nack_delay_ms` / `max_nack_retries` | integer | No | — | Cross-leg ARQ timing and retry ceiling. |
| `keepalive_ms` | integer | No | `200` | Keepalive interval, which also drives per-path RTT / liveness. |
| `encryption_key` | string | No | `null` | 64 hex characters — the 32-byte ChaCha20-Poly1305 AEAD key opening the encrypted UDP legs. Must match the sender's. |
| `fec` | object | No | `null` | Proactive FEC; geometry must match the sender's. |
| `ingress_dejitter_ms` | integer | No | `null` | **Ignored on a bonded input** — setting it above 0 logs a warning and raises `bond_ingress_dejitter_ignored`. Use the hold / latency knobs instead. |
| `equalization` | string | No | `auto` | `auto` / `on` / `off` per-leg latency equalization. Should match the sender. |
| `max_bonding_latency_ms` | integer | No | derived | Equalization latency budget and loss-recovery deadline. |

The full Bonded protocol — path adapters, link selection, latency budgets — is covered in [Bonding](/edge/bonding/). The bonded sender at the other end uses the matching [Bonded Output](#bonded-output).

### Replay Input

Plays back a recording (or a single clip from a recording) onto a flow's broadcast channel as if it were a live source. Paced by PCR — only available when the edge was built with the `replay` feature (default on).

```json
{
  "type": "replay",
  "id": "in-replay",
  "name": "Replay",
  "recording_id": "record-flow",
  "clip_id": null,
  "start_paused": true,
  "loop_playback": false
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | — | Must be `"replay"`. |
| `recording_id` | string | Yes | — | Recording subdirectory under the replay root. |
| `clip_id` | string | No | `null` | When set, only that clip's `[in_pts, out_pts]` range plays. |
| `start_paused` | boolean | No | `true` | When `true`, the input idles on flow start until a `play_clip` / `cue_clip` command activates playback. |
| `loop_playback` | boolean | No | `false` | When `true`, restart at the beginning on EOF. |
| `pid_map` / `pid_overrides` | object | No | `null` | TS PID rewriting on playback. Synthetic-TS path, so `pid_overrides` takes exactly one entry keyed `1`. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |

Playback supports variable speed (0.1×–1.0× via `set_speed`), frame-step forward and back (`step_frame`), MP4 export of a clip or whole recording (`export_clip` / `export_recording`), and a recordings library (`list_recordings` / `delete_recording`). Full operator workflow: [Replay](/edge/replay/) and [Replay (operator UI)](/manager/replay/).

### SDI Input (Blackmagic DeckLink)

Captures SDI directly off a Blackmagic **DeckLink** card — video plus embedded audio — encodes in-process, and publishes a standard A+V MPEG-TS flow with no external SDI→IP converter in the path. Self-clocked (no PTP requirement). Gated on the `sdi-decklink` Cargo feature, which is compiled into every `*-full` release; the schema is always present so configs round-trip on builds without it, and the capability is advertised only when the host has Blackmagic Desktop Video and a card.

```json
{
  "type": "sdi",
  "id": "sdi1",
  "name": "SDI 1",
  "device": "DeckLink Quad (1)",
  "format": "auto",
  "pixel_format": "uyvy422",
  "audio_channels": 2,
  "video_encode": { "codec": "h264_nvenc", "chroma": "yuv420p", "bitrate_kbps": 10000, "gop_size": 50 }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | — | Must be `"sdi"`. |
| `device` | string | Yes | — | DeckLink display name as listed by the boot probe and `HealthPayload.sdi_devices[]`, e.g. `"DeckLink Quad (1)"`. |
| `format` | string | No | `"auto"` | `"auto"` (card input-format detection — recommended) or a DeckLink mode FourCC (`"Hi50"`, `"Hp25"`, …). A forced mode that mismatches the source makes the card report no signal. |
| `pixel_format` | string | No | `"uyvy422"` | `"uyvy422"` (8-bit) is the only implemented format. `"v210"` is rejected at config load (no 10-bit unpacker). |
| `audio_channels` | integer | No | `2` | Embedded-audio channels to capture: `0` (video-only), `2`, `8`, or `16`. |
| `scte35_extraction` | boolean | No | `false` | Translate SCTE-104 VANC (DID `0x41` / SDID `0x07`) cue-out / cue-in / cancel into an SCTE-35 section on PID `0x01FC`, stream type `0x86`, in the egress TS. |
| `timecode_extraction` | boolean | No | `false` | Decode SMPTE 12M-2 ATC VANC timecode (DID `0x60`) into `InputStats.sdi_stats.timecode`. Continuous state, not an event — a locked source updates it every frame. |
| `captions_extraction` | boolean | No | `false` | Detect CEA-608/708 caption **presence** from VANC (DID `0x61`) — presence and cc_count only, no text decode. Fires `sdi_captions_detected` once per caption type per session. |
| `video_encode` | object | Yes | — | Mandatory H.264/HEVC encoder block. `chroma` must be `yuv420p` or `yuv422p`, `bit_depth` `8` (a constraint of the 8-bit 4:2:2 capture format); every backend is reachable, including `h264_auto` / `hevc_auto`. Backend / chroma / bit-depth support: [Codec matrix](/edge/codec-matrix/). |
| `audio_encode` | object | No | AAC-LC | AAC family only (`aac_lc` / `he_aac_v1` / `he_aac_v2`). Unset gives an AAC-LC default. |
| `pid_overrides` | object | No | `null` | Accepted and validated, but **not applied** on the SDI path — the capture pipeline runs no ingress post-process stage. |

Signal loss does **not** stop the stream — the card keeps delivering frames (bars/black) with the cable out and the edge keeps encoding them, so bitrate and `state` read healthy on a dead feed; `InputStats.sdi_stats.signal_present` is the honest indicator. Build prereqs, per-port health payload, and event catalogue: `bilbycast-edge/docs/sdi.md`.

---

## Output Types

Each output has a `type` discriminator. There are twenty:

`rtp`, `rtp_audio`, `udp`, `srt`, `rist`, `rtmp`, `hls`, `cmaf`, `webrtc`, `display`, `sdi`, `bonded`, `st2110_20`, `st2110_23`, `st2110_30`, `st2110_31`, `st2110_40`, `mxl_video`, `mxl_audio`, `mxl_anc`.

The five ST 2110 types and `rtp_audio` are covered in [SMPTE ST 2110](#smpte-st-2110) below; the three `mxl_*` types under [MXL](/edge/mxl/).

Four fields are shared by every output type:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | — | Unique output ID. Cannot be empty; max 64 characters. |
| `name` | string | — | Human-readable display name. Max 256 characters. |
| `active` | boolean | `true` | A passive output stays in config but is never spawned by the engine — the flow loop skips it. Toggle it at runtime with `POST /api/v1/outputs/{id}/active`, no re-creation needed. |
| `group` | string | `null` | Optional free-form tag for UI grouping. Max 64 characters. |

### RTP Output

Sends RTP-wrapped MPEG-TS packets to a unicast or multicast destination. Supports SMPTE 2022-1 FEC encoding.

```json
{
  "type": "rtp",
  "id": "rtp-out-1",
  "name": "Local Playout",
  "dest_addr": "192.168.1.50:5004",
  "bind_addr": "192.168.1.100:0",
  "interface_addr": "192.168.1.100",
  "fec_encode": {
    "columns": 10,
    "rows": 10
  },
  "dscp": 46
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"rtp"`. |
| `id` | string | Yes | - | Unique output ID within the flow. Cannot be empty. |
| `name` | string | Yes | - | Human-readable display name. |
| `dest_addr` | string | Yes | - | Destination socket address (`ip:port`). For multicast, use the group address (e.g., `"239.1.2.1:5004"`). IPv6: `"[::1]:5004"`. |
| `bind_addr` | string | No | `"0.0.0.0:0"` | Source bind address. Use to control the source IP/port of outgoing packets. Must be same address family as `dest_addr`. |
| `interface_addr` | string | No | `null` | Network interface IP for multicast send. Must be same address family as `dest_addr`. |
| `fec_encode` | object | No | `null` | SMPTE 2022-1 FEC encode parameters. See [FEC Configuration](#smpte-2022-1-fec-configuration). |
| `dscp` | integer | No | `46` | DSCP value for QoS marking (RP 2129 C10). Range 0-63. Default 46 = Expedited Forwarding (RFC 4594). |
| `program_number` | integer | No | `null` | MPTS → SPTS program filter. `null` = full MPTS passthrough; `Some(N)` = forward only program N as a rewritten single-program TS. Applied before FEC, so the receiver's FEC protects the filtered SPTS. Must be `> 0`. See [MPTS → SPTS filtering](#mpts--spts-filtering). |
| `redundancy` | object | No | `null` | SMPTE 2022-7 hitless redundancy — duplicate this output onto a second RTP leg. |
| `pid_map` | object | No | `null` | Flat source-PID → target-PID rewrite. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `pid_overrides` | object | No | `null` | Per-program PID pinning for the transcoded elementary streams. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `cbr_pad_to_kbps` | integer | No | `null` | Inflate the emitted TS to a stable CBR target by injecting NULL packets. Range 1000–1000000 kbit/s, and it must exceed the declared `audio_encode` + `video_encode` budget by at least 5 % or there is no room to pad. Incompatible with `epoch_lock` — the padder seeds its budget from this node's own clock, so two members' inter-PCR byte streams diverge. |
| `delay` | object | No | `null` | Fixed output delay for path synchronisation. See [Output Delay](/edge/supported-protocols/#output-delay-path-synchronisation). Note the documented bounds are advisory: nothing enforces them at config load. |
| `audio_encode` / `transcode` / `video_encode` | object | No | `null` | Optional egress re-encode blocks. See [Audio Gateway](/edge/audio-gateway/#the-audio_encode-block--compressed-audio-egress-rtmp--hls--webrtc) and [Video transcoding](/edge/supported-protocols/#video-transcoding-video_encode). |
| `interface_binding` | object | No | `null` | Pin this output to a named NIC. See the [shared field table](#fields-shared-across-input-types). |
| `egress_pacing` | string | No | auto | Wire-emission pacing model. See [Egress pacing](#egress-pacing). |
| `egress_buffer_ms` | integer | No | `null` | Servo de-jitter cushion. Only valid with `egress_pacing: "servo"`. See [Egress pacing](#egress-pacing). |
| `epoch_lock` | object | No | `null` | Cross-node egress alignment. See [Epoch lock](#epoch-lock-cross-node-alignment). |

**Validation rules:**
- `id` cannot be empty.
- `dest_addr`, `bind_addr`, and `interface_addr` must all use the same address family.
- `dscp` must be 0-63.
- `program_number` must be `> 0` if set (program_number 0 is reserved for the NIT).

### UDP Output

Sends raw MPEG-TS over UDP without RTP headers. Datagrams are TS-aligned (7×188 = 1316 bytes). If the input is RTP-wrapped, RTP headers are automatically stripped. Compatible with ffplay, VLC, and standard IP/TS multicast receivers.

```json
{
  "type": "udp",
  "id": "udp-out-1",
  "name": "Local Playout (raw TS)",
  "dest_addr": "192.168.1.50:5004",
  "dscp": 46
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"udp"`. |
| `id` | string | Yes | - | Unique output ID within the flow. |
| `name` | string | Yes | - | Human-readable display name. |
| `dest_addr` | string | Yes | - | Destination socket address (`ip:port`). For multicast, use the group address. |
| `bind_addr` | string | No | `"0.0.0.0:0"` | Source bind address. Must be same address family as `dest_addr`. |
| `interface_addr` | string | No | `null` | Network interface IP for multicast send. |
| `dscp` | integer | No | `46` | DSCP value for QoS marking. Range 0-63. |
| `program_number` | integer | No | `null` | MPTS → SPTS program filter. `null` = full MPTS passthrough; `Some(N)` = forward only program N as a rewritten single-program TS. Must be `> 0`. See [MPTS → SPTS filtering](#mpts--spts-filtering). |
| `transport_mode` | string | No | `null` | Set to `"audio_302m"` to ship 48 kHz LPCM as SMPTE 302M-in-MPEG-TS. Mutually exclusive with `program_number`, `pid_map`, `audio_encode` and `video_encode`. |
| `pid_map` | object | No | `null` | Flat source-PID → target-PID rewrite. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `pid_overrides` | object | No | `null` | Per-program PID pinning for the transcoded elementary streams. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `cbr_pad_to_kbps` | integer | No | `null` | Inflate the emitted TS to a stable CBR target by injecting NULL packets. Range 1000–1000000 kbit/s, and it must exceed the declared `audio_encode` + `video_encode` budget by at least 5 %. Incompatible with `epoch_lock`. |
| `delay` | object | No | `null` | Fixed output delay for path synchronisation. See [Output Delay](/edge/supported-protocols/#output-delay-path-synchronisation). The documented bounds are advisory — nothing enforces them at config load. |
| `audio_encode` / `transcode` / `video_encode` | object | No | `null` | Optional egress re-encode blocks. See [Audio Gateway](/edge/audio-gateway/#the-audio_encode-block--compressed-audio-egress-rtmp--hls--webrtc) and [Video transcoding](/edge/supported-protocols/#video-transcoding-video_encode). |
| `interface_binding` | object | No | `null` | Pin this output to a named NIC. See the [shared field table](#fields-shared-across-input-types). |
| `egress_pacing` | string | No | auto | Wire-emission pacing model. See [Egress pacing](#egress-pacing). |
| `egress_buffer_ms` | integer | No | `null` | Servo de-jitter cushion. Only valid with `egress_pacing: "servo"`. See [Egress pacing](#egress-pacing). |
| `epoch_lock` | object | No | `null` | Cross-node egress alignment. See [Epoch lock](#epoch-lock-cross-node-alignment). |

**Validation rules:**
- `id` cannot be empty.
- `dest_addr` must be a valid socket address.
- `dscp` must be 0-63.
- `program_number` must be `> 0` if set.

### Egress pacing

UDP and RTP outputs choose **when** each datagram leaves the wire. Both accept the same two fields.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `egress_pacing` | string | auto | `"forward"`, `"pcr"` or `"servo"` — see below. |
| `egress_buffer_ms` | integer | `null` | De-jitter cushion in milliseconds of content, 20–2000. **Only valid with `"servo"`** and rejected otherwise. Holds roughly this much content in the egress queue, absorbing arrival jitter at the cost of that much latency. |

| Mode | What it does | When to use it |
|---|---|---|
| `forward` | Emit at the input's own cadence, no re-pacing. Lowest latency. | A clean upstream — the common case. |
| `pcr` | Re-pace at the instants the stream's own PCR implies. | SMPTE 2022-7 dual-leg coherence, strict receivers, or smoothing a bond-reassembled cadence. **Required for [epoch lock](#epoch-lock-cross-node-alignment).** |
| `servo` | Closed-loop release-rate servo. | A genuinely bursty, unpaced ingress. |

**Unset is auto**, resolved when the output starts: `"pcr"` when the flow has a `bonded` input — the bond releases recovered packets in bursts, and forwarding at that cadence puts the burst structure straight onto the wire — and `"forward"` otherwise. A bounded residence cap guards against latency runaway in every mode.

:::caution[Upgrade note for bonded flows]
An existing bonded flow whose UDP/RTP outputs never set `egress_pacing` changes from `forward` to `pcr` on the release that introduced auto-resolution. Pin `"forward"` explicitly before upgrading if you need the old wire behaviour.

Because resolution happens when the output starts, adding or removing a bonded input on a **running** flow does not re-pace outputs already running. The edge raises `egress_pacing_auto_stale` naming them; restart those outputs (or the flow) to re-resolve.
:::

### Epoch lock (cross-node alignment)

Puts this output on a **shared timeline** with the same output on other nodes, so independent nodes forwarding the same feed emit the same content at the same instant and a downstream switcher can cut between them cleanly. Available on **UDP and RTP outputs only**.

Arming a group is a manager operation — a single node cannot mint its own shared timeline. Configure the fields here, then create the group under **Alignment** in the manager. Full operator guide: [Aligned Output](/manager/aligned-output/).

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `egress_offset_ms` | integer | Yes | - | Hold time before release, 150–800. **Must be identical on every member of the group** — a mismatch misaligns the group by exactly the difference while every node reports healthy. |
| `group_label` | string | No | `null` | Operator label surfaced on telemetry so the manager can group members visually. No behaviour. Max 64 chars. |
| `pcr_pid` | integer | No | `null` | PCR PID to anchor on, for a source carrying more than one program. Must be `< 0x1FFF`. Required unless the source is single-program. |
| `source_anchor` | object | No | `null` | The shared timeline itself. **Written by the manager, not by hand.** |

```json
{
  "type": "udp",
  "id": "udp-out-1",
  "name": "Aligned Playout",
  "dest_addr": "239.1.2.3:5004",
  "egress_pacing": "pcr",
  "epoch_lock": { "egress_offset_ms": 300, "group_label": "MCR-A" }
}
```

**`egress_offset_ms` budgets the difference between your nodes, not total latency.** The manager derives the timeline from the slowest member's arrival, so each node's required hold is its lead over the slowest, plus this margin — absolute path latency cancels out. Sizing it against end-to-end latency instead pushes the output past the edge's residence cap, at which point it sheds most of the stream.

**Requirements — validation enforces every one:**

- Explicit `egress_pacing: "pcr"` on this output (never auto, `forward` or `servo`).
- Exactly **one input** on the flow, and the flow is **not** assembled (no PID bus).
- **No transcoding** on this output, and an unambiguous PCR PID.
- Every input on the flow is `bonded`, or sets `passthrough_clock: true`.

:::caution[Alignment and clock regeneration are mutually exclusive]
Alignment reads the timing already in the stream, which only works if the node forwards it untouched. In default muxer mode the edge re-anchors output timing to *its own* clock, so the result carries that node's ingest latency — exactly the quantity alignment must cancel.

Setting `passthrough_clock: true` keeps the rewriter out of the path. Turning alignment on therefore means giving up PCR/PTS regeneration on those inputs.
:::

A violated flow-level requirement is handled two different ways, and only one of them is harmless. When a flow is **started, restarted or hot-edited**, the edge strips `epoch_lock` from that flow's outputs and keeps running, logging why — a live flow must not be taken off air by a mis-specified alignment knob, and the absent alignment telemetry is what tells the manager the group never armed. But **whole-config validation rejects the same block outright**, and that is what runs at node startup: an `epoch_lock` block that violates a flow-level requirement and has been saved into `config.json` will stop the edge from booting on its next restart, not merely disarm alignment. The same validation guards a whole-config push from the manager, the REST flow endpoints (HTTP 400) and the setup wizard, so the usual way you meet a bad block is an error message rather than a silent strip. Fix a rejected block — do not leave it in place on the strength of the runtime strip.

Nodes that do not support alignment ignore the block **silently**, which looks exactly like success — so the manager hides the controls for them rather than letting you configure something that will not happen.

### SRT Output

Sends RTP encapsulated in SRT.

```json
{
  "type": "srt",
  "id": "srt-out-1",
  "name": "Remote Site",
  "mode": "caller",
  "local_addr": "0.0.0.0:0",
  "remote_addr": "203.0.113.10:9000",
  "latency_ms": 500,
  "passphrase": "encryption-key-here",
  "aes_key_len": 32,
  "redundancy": {
    "mode": "caller",
    "local_addr": "0.0.0.0:0",
    "remote_addr": "203.0.113.11:9000",
    "latency_ms": 500,
    "passphrase": "encryption-key-here",
    "aes_key_len": 32
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"srt"`. |
| `id` | string | Yes | - | Unique output ID within the flow. Cannot be empty. |
| `name` | string | Yes | - | Human-readable display name. |
| `mode` | string | Yes | - | SRT connection mode: `"caller"`, `"listener"`, or `"rendezvous"`. |
| `local_addr` | string | Conditional | `null` | Listen address — **required** for `listener` and `rendezvous`. For `caller` it is the optional source bind; omit it (or set `"0.0.0.0:0"`) for an ephemeral port. |
| `remote_addr` | string | Conditional | `null` | Remote address. Required for `caller` and `rendezvous`. |
| `latency_ms` | integer | No | `120` | SRT send latency in milliseconds. |
| `passphrase` | string | No | `null` | AES encryption passphrase (10-79 characters). |
| `aes_key_len` | integer | No | `16` | AES key length: 16, 24, or 32. |
| `crypto_mode` | string | No | `null` | Cipher mode: `"aes-ctr"` (default) or `"aes-gcm"`. |
| `redundancy` | object | No | `null` | SMPTE 2022-7 redundancy for a second SRT output leg. Mutually exclusive with `bonding`. |
| `bonding` | object | No | `null` | Native libsrt socket-group bonding. See [Native libsrt SRT bonding](#native-libsrt-srt-bonding-socket-groups). |
| `program_number` | integer | No | `null` | MPTS → SPTS program filter. `null` = full MPTS passthrough; `Some(N)` = forward only program N as a rewritten single-program TS. Applied once and mirrored to both legs when 2022-7 is enabled. Must be `> 0`. See [MPTS → SPTS filtering](#mpts--spts-filtering). |
| `transport_mode` | string | No | `null` | Set to `"audio_302m"` to ship 48 kHz LPCM as SMPTE 302M-in-MPEG-TS. Mutually exclusive with `packet_filter`, `program_number`, `redundancy`, `pid_map`, `audio_encode` and `video_encode` — 302M is a lossless PCM wrap, so there is nothing left to filter, remap or re-encode. |
| `pid_map` | object | No | `null` | Flat source-PID → target-PID rewrite. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `pid_overrides` | object | No | `null` | Per-program PID pinning for the transcoded elementary streams. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `cbr_pad_to_kbps` | integer | No | `null` | Inflate the emitted TS to a stable CBR target by injecting NULL packets. Range 1000–1000000 kbit/s; must exceed the declared `audio_encode` + `video_encode` budget by at least 5 %. |
| `webrtc_compatible` | boolean | No | `false` | Force a browser-safe H.264 egress — the answer to "route this SRT feed to a WebRTC audience through mediamtx / Janus". When true the edge always re-encodes video: **zero B-frames** (the load-bearing constraint — B-frames give non-monotonic RTP timestamps that browser jitter buffers and WHEP SFUs freeze on), 8-bit 4:2:0, profile downgraded to `main` if higher, `tune=zerolatency`, whatever the source GOP. Requires an H.264 encoder backend compiled in and rejects an explicit HEVC `video_encode.codec`, both at config load. |
| `delay` | object | No | `null` | Fixed output delay for path synchronisation. See [Output Delay](/edge/supported-protocols/#output-delay-path-synchronisation). |
| `audio_encode` / `transcode` / `video_encode` | object | No | `null` | Optional egress re-encode blocks. See [Audio Gateway](/edge/audio-gateway/#the-audio_encode-block--compressed-audio-egress-rtmp--hls--webrtc) and [Video transcoding](/edge/supported-protocols/#video-transcoding-video_encode). |
| `interface_binding` | object | No | `null` | Pin this output to a named NIC. |

Beyond these, an SRT output accepts the full libsrt socket-tuning set — the same fields, names and bounds as an SRT input. See [SRT advanced socket parameters](#srt-advanced-socket-parameters).

### RIST Output

Sends RIST Simple Profile (VSF TR-06-1:2020) reliable RTP to a peer, with RTCP NACK-based retransmission. Interoperable with librist `ristreceiver`. RIST is always compiled in — there is no feature flag. Binds a local even RTP port (RTCP on `port+1`) and transmits to the peer's even RTP port; the peer's RTCP is learned dynamically. Optional SMPTE 2022-7 redundancy duplicates the output to a second leg.

```json
{
  "type": "rist",
  "id": "rist-out-1",
  "name": "Remote Site",
  "remote_addr": "203.0.113.10:6000",
  "buffer_ms": 1000,
  "rtcp_interval_ms": 100
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"rist"`. |
| `id` | string | Yes | - | Unique output ID within the flow. |
| `name` | string | Yes | - | Human-readable display name. |
| `remote_addr` | string | Yes | - | Remote RIST address (`ip:port`). Port **must be even**. |
| `local_addr` | string | No | `"0.0.0.0:0"` | Local bind for the sender's RTP socket. When set, the port must be even. |
| `buffer_ms` | integer | No | `1000` | Sender retransmit buffer depth in milliseconds. |
| `retransmit_buffer_capacity` | integer | No | `2048` | Retransmit buffer capacity in packets. |
| `cname` | string | No | `null` | CNAME emitted in RTCP SDES packets. |
| `rtcp_interval_ms` | integer | No | `null` | RTCP emission interval in milliseconds. |
| `redundancy` | object | No | `null` | SMPTE 2022-7 redundancy — duplicate this output to a second leg. |
| `program_number` | integer | No | `null` | MPTS → SPTS program filter. Must be `> 0` if set. See [MPTS → SPTS filtering](#mpts--spts-filtering). |
| `pid_map` / `pid_overrides` | object | No | `null` | TS PID rewriting on the emitted stream. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `delay` | object | No | `null` | Fixed output delay for path synchronisation. See [Output Delay](/edge/supported-protocols/#output-delay-path-synchronisation). |
| `audio_encode` / `transcode` / `video_encode` | object | No | `null` | Optional egress re-encode blocks. See [Audio Gateway](/edge/audio-gateway/#the-audio_encode-block--compressed-audio-egress-rtmp--hls--webrtc) and [Video transcoding](/edge/supported-protocols/#video-transcoding-video_encode). |

### RTMP Output

Publishes to an RTMP/RTMPS server (e.g., Twitch, YouTube Live, Facebook Live). Demuxes H.264 and AAC from MPEG-2 TS and muxes into FLV.

```json
{
  "type": "rtmp",
  "id": "twitch",
  "name": "Twitch Stream",
  "dest_url": "rtmp://live.twitch.tv/app",
  "stream_key": "live_123456789_abcdefghijklmnop",
  "reconnect_delay_secs": 5,
  "max_reconnect_attempts": 10
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"rtmp"`. |
| `id` | string | Yes | - | Unique output ID. Cannot be empty. |
| `name` | string | Yes | - | Human-readable display name. |
| `dest_url` | string | Yes | - | RTMP server URL. Must start with `rtmp://` or `rtmps://`. RTMPS requires the `tls` feature (enabled by default). |
| `stream_key` | string | Yes | - | Stream key for authentication with the RTMP server. Cannot be empty. |
| `reconnect_delay_secs` | integer | No | `5` | Seconds to wait before reconnecting after a failure. Must be > 0. |
| `max_reconnect_attempts` | integer | No | `null` (unlimited) | Maximum reconnection attempts. When `null`, reconnects indefinitely. |
| `program_number` | integer | No | `null` | MPTS program selector. `null` = lock onto the lowest program_number in the PAT (deterministic default); `Some(N)` = extract elementary streams from program N only. RTMP is single-program by spec, so this only changes *which* program is published. Must be `> 0`. See [MPTS → SPTS filtering](#mpts--spts-filtering). |
| `pid_overrides` | object | No | `null` | Per-program PID pinning for the regenerated elementary streams. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `audio_encode` / `transcode` / `video_encode` | object | No | `null` | Optional egress re-encode blocks. RTMP audio is AAC-family only — see the [codec matrix below](#audio-gateway-extensions). |

**Limitations:**
- Output only. RTMP input is not supported.
- Only H.264 video and AAC audio are supported (no HEVC/VP9).

### HLS Output

Segments MPEG-2 TS data and uploads via HTTP for HLS ingest (e.g., YouTube HLS).

```json
{
  "type": "hls",
  "id": "youtube-hls",
  "name": "YouTube HLS",
  "ingest_url": "https://a.upload.youtube.com/http_upload_hls?cid=xxxx&copy=0&file=index.m3u8",
  "segment_duration_secs": 2.0,
  "auth_token": "ya29.a0ARrdaM...",
  "max_segments": 5
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"hls"`. |
| `id` | string | Yes | - | Unique output ID. Cannot be empty. |
| `name` | string | Yes | - | Human-readable display name. |
| `ingest_url` | string | Yes | - | HLS ingest base URL. Must start with `http://` or `https://`. |
| `segment_duration_secs` | float | No | `2.0` | Target segment duration in seconds. Range: 0.5-10.0. |
| `auth_token` | string | No | `null` | Bearer token sent with each HTTP upload request. |
| `max_segments` | integer | No | `5` | Maximum segments in the rolling playlist. Range: 1-30. |
| `program_number` | integer | No | `null` | MPTS → SPTS program filter. `null` = each segment carries the full MPTS; `Some(N)` = each segment carries only program N as a rewritten single-program TS. Must be `> 0`. See [MPTS → SPTS filtering](#mpts--spts-filtering). |
| `pid_map` | object | No | `null` | Flat source-PID → target-PID rewrite applied to the segmented TS. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `audio_encode` | object | No | `null` | Optional audio re-encode — `aac_lc`, `he_aac_v1`, `he_aac_v2`, `mp2` or `ac3`. See the [codec matrix below](#audio-gateway-extensions). |
| `transcode` | object | No | `null` | PCM channel-shuffle / sample-rate / bit-depth conversion between decoder and encoder. **Rejected at validation without `audio_encode`.** |

**Limitations:**
- Output only. Segment-based transport inherently adds 1-4 seconds of latency.

### CMAF Output

Pushes fragmented MP4 (ISO BMFF) segments to an HTTP(S) ingest endpoint with parallel HLS (`.m3u8`) and MPEG-DASH (`.mpd`) manifests built off the same segment set. Supports whole-segment PUT (standard CMAF) and chunked-transfer streaming PUT (low-latency CMAF), plus ClearKey CENC encryption with optional Widevine / PlayReady / FairPlay PSSH passthrough.

**Standard CMAF — HLS + DASH, AAC passthrough, unencrypted:**

```json
{
  "type": "cmaf",
  "id": "cdn-primary",
  "name": "CDN primary push",
  "ingest_url": "https://ingest.cdn.example.com/live/channel1",
  "auth_token": "Bearer-xyz",
  "segment_duration_secs": 4.0,
  "max_segments": 6,
  "manifests": ["hls", "dash"]
}
```

**LL-CMAF — HLS-only, chunked-transfer PUT (clear):**

```json
{
  "type": "cmaf",
  "id": "ll-ios",
  "name": "Low-latency iOS",
  "ingest_url": "https://ll.cdn.example.com/live/ios",
  "low_latency": true,
  "chunk_duration_ms": 333,
  "segment_duration_secs": 2.0,
  "manifests": ["hls"]
}
```

:::caution[`low_latency` and `encryption` do not combine]
An `encryption` block alongside `low_latency: true` is **refused at config load** — the low-latency chunk writer applies no CENC transform, so the media would go out in the clear while every surface reported it encrypted. Pick one: `low_latency: false` for an encrypted output, or drop `encryption`.
:::

**DASH-only — HEVC re-encode at 5 Mbps, ClearKey CENC + Widevine PSSH passthrough.** Note the absence of `audio_encode`: an encrypted CMAF output is video-only (see Limitations), so an audio block here would be accepted and then silently ignored.

```json
{
  "type": "cmaf",
  "id": "uhd-dash",
  "name": "UHD DASH egress",
  "ingest_url": "https://ingest.cdn.example.com/live/uhd",
  "segment_duration_secs": 4.0,
  "manifests": ["dash"],
  "video_encode": { "codec": "x265", "bitrate_kbps": 5000, "preset": "medium", "profile": "main10" },
  "encryption": {
    "scheme": "cenc",
    "key_id": "0123456789abcdef0123456789abcdef",
    "key": "fedcba9876543210fedcba9876543210",
    "pssh_boxes": ["<widevine-pssh-hex>", "<playready-pssh-hex>"]
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"cmaf"`. |
| `id` | string | Yes | - | Unique output ID. Cannot be empty. |
| `name` | string | Yes | - | Human-readable display name. |
| `ingest_url` | string | Yes | - | CMAF ingest base URL. Must start with `http://` or `https://`, max 2048 chars, no control characters. |
| `auth_token` | string | No | `null` | Bearer token sent as `Authorization: Bearer <token>` on every PUT. Max 4096 chars, no control/whitespace characters. |
| `segment_duration_secs` | float | No | `2.0` | Target closed-GoP segment duration in seconds. Range 1.0-10.0. Used as the GoP alignment target when `video_encode` is set. |
| `max_segments` | integer | No | `5` | Rolling playlist depth. Range 1-30. |
| `dvr_window_secs` | float | No | `null` | Rolling playlist window expressed in **time**, for DVR / scrub-back. Supersedes `max_segments` when set — the entry count is derived as `ceil(dvr_window_secs / segment_duration_secs)`, so the window keeps its intended duration if segment length changes. Minimum `1.0`; rejected when the derivation exceeds 21600 entries. The playlist *slides*, so origin retention must be sized to match or clients seek to evicted segments. |
| `thumbnails` | object | No | `null` | Publish a scrub-preview thumbnail track — sprite sheets plus a WebVTT index — PUT beside the media. See the sub-table below. |
| `low_latency` | boolean | No | `false` | `false` = standard CMAF (whole-segment PUT). `true` = LL-CMAF (chunked-transfer PUT + `#EXT-X-PART` in HLS and `availabilityTimeOffset` in DASH). Mutually exclusive with `encryption` — the pair is refused at config load. |
| `chunk_duration_ms` | integer | No | `500` | Sub-segment chunk cadence for LL-CMAF. Range 100-2000. Only meaningful when `low_latency = true`; ignored otherwise. |
| `manifests` | array&lt;string&gt; | No | `["hls", "dash"]` | Which manifests to publish. Non-empty subset of `["hls", "dash"]`. Use `["hls"]` for Apple-only, `["dash"]` for Widevine/PlayReady-centric CDNs, both for maximum reach. |
| `encryption` | object | No | `null` | ClearKey CENC encryption block — see below. Omit for clear (unencrypted) output. **Refused together with `low_latency: true`**, and an encrypted output is video-only. |
| `audio_encode` | object | No | `null` | Optional AAC re-encode (codec: `aac_lc`, `he_aac_v1`, `he_aac_v2`). Omit for AAC passthrough. MP2/AC-3/Opus are rejected — CMAF audio is AAC-family only. |
| `transcode` | object | No | `null` | Optional PCM channel-shuffle / sample-rate / bit-depth conversion, sits between the AAC decoder and the target encoder. Only effective when `audio_encode` is set; rejected at validation otherwise. |
| `video_encode` | object | No | `null` | Optional re-encode. Unlike every other surface, CMAF needs an **explicit** backend — one of `x264`, `x265`, `h264_nvenc`, `hevc_nvenc`, `h264_qsv`, `hevc_qsv`, `h264_vaapi`, `hevc_vaapi`, `h264_rkmpp`, `hevc_rkmpp`. The `h264_auto` / `hevc_auto` / `auto` aliases the ST 2110 video inputs accept are **rejected at config load** here, because the CMAF re-encoder resolves no alias. HEVC is *recommended* with `manifests: ["dash"]` (see Limitations) but not enforced. Backend / chroma / bit-depth support: [Codec matrix](/edge/codec-matrix/). Omit for passthrough. |
| `program_number` | integer | No | `null` | MPTS → SPTS program filter. `null` = source must already be SPTS (CMAF is inherently single-program). `Some(N)` = filter to program N before segmenting. Must be `> 0`. |

**Encryption block (`encryption`):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `scheme` | string | Yes | - | `"cenc"` (AES-CTR — Widevine/PlayReady standard, pairs with DASH) or `"cbcs"` (AES-CBC with 1:9 pattern — FairPlay / Apple standard, pairs with HLS). |
| `key_id` | string | Yes | - | Key identifier. Exactly 32 hex characters (16 bytes). |
| `key` | string | Yes | - | AES-128 content key. Exactly 32 hex characters (16 bytes). |
| `pssh_boxes` | array&lt;string&gt; | No | `[]` | Pre-built Widevine / PlayReady / FairPlay `pssh` boxes for commercial DRM passthrough. Each entry is a hex-encoded `pssh` ISO-BMFF box (32-4096 bytes, fourcc `pssh` at bytes 4-7). The edge copies each entry verbatim into the init segment's `moov` alongside the ClearKey `pssh` box it emits automatically. |

**Thumbnail track (`thumbnails`):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `interval_secs` | integer | No | `2` | Seconds between preview frames. Range 1-30. The default matches a typical segment duration, so there is one preview per segment and the scrub bar has no gaps. |
| `frames_per_sheet` | integer | No | `20` | Frames packed into one sprite sheet before it is published. Range 1-200. This is the **lag of the newest preview**, not a size knob — a sheet only exists once it is full, so the most recent `interval_secs × frames_per_sheet` of the window has no picture. |
| `width` | integer | No | `160` | Preview frame width in pixels. Range 64-640. |
| `height` | integer | No | `90` | Preview frame height in pixels. Range 36-360. |

Three cross-checks run at config load. `interval_secs × frames_per_sheet` must be **strictly less** than the playlist window (`dvr_window_secs`, or `max_segments × segment_duration_secs` when that is unset) — otherwise no sheet would ever describe a segment the playlist still lists. The sheet is laid out ten frames wide, and both axes are capped at 4096 px, so `width × 10` and `ceil(frames_per_sheet / 10) × height` must each stay within it.

The track reuses the replay filmstrip's frame capture, so it needs a build carrying the `replay` feature (on by default, and present in all three published release artefacts). Without it the config still validates and the output still runs — but no preview is ever published, and a Warning `config` event says so.

**How encryption works on the wire:**
- CMAF uses ISO/IEC 23001-7 Common Encryption with subsample encryption: video NAL prefixes and parameter sets stay in the clear (~first 32 bytes per NAL), the rest is encrypted under the chosen scheme.
- Each segment carries `senc` (sample encryption), `saio` (sample auxiliary info offsets), `saiz` (sample auxiliary info sizes), and `tenc` (track encryption) boxes.
- The init segment's `moov` carries one or more `pssh` boxes — the edge-emitted ClearKey `pssh` plus any operator-supplied commercial-DRM boxes.
- Commercial DRM license servers (Widevine, PlayReady, FairPlay) are operator-managed; bilbycast does not proxy license requests.

**Limitations:**
- Output only. Players are browsers, iOS/tvOS/Android apps, smart TVs, STBs — the edge does not ingest CMAF.
- HEVC (`x265`, `hevc_nvenc`) on HLS is rejected client-side by many Apple devices. The edge does not reject the combination — operators who need HEVC should emit `manifests: ["dash"]`.
- `transcode` requires `audio_encode`; rejected at validation when set alone.
- `encryption` and `low_latency: true` are **mutually exclusive** — refused at config load, because the low-latency chunk writer applies no CENC transform and the media would go out in the clear while every surface said it was encrypted.
- **Encrypted outputs are video-only.** Audio encryption is written but unwired, so an encrypted output settles its init segment on a video-only track list and any source audio is dropped with a one-time warning. `audio_encode` alongside `encryption` is accepted by validation and then has no effect.
- **LL-CMAF outputs are video-only too**, for a separate structural reason: each low-latency chunk carries a single `traf`, so `low_latency: true` publishes a video-only `init.mp4` whatever the source carries.

**Reference:** `bilbycast-edge/docs/cmaf.md` in the repo covers the ISO-BMFF box writer, LL-CMAF threading model, DASH MPD profile (dynamic, `availabilityStartTime`, `minimumUpdatePeriod`, `timeShiftBufferDepth`, `SegmentTemplate`), HEVC `hvc1` vs `hev1` signalling, and the CENC subsample algorithm.

### WebRTC Output

Supports two modes: WHIP client (push to external endpoint) and WHEP server (serve viewers). The `webrtc` feature is enabled by default.

**WHIP Client mode** — push to an external WHIP endpoint:

```json
{
  "type": "webrtc",
  "id": "whip-push",
  "name": "Push to CDN",
  "mode": "whip_client",
  "whip_url": "https://whip.example.com/ingest/stream1",
  "bearer_token": "my-auth-token"
}
```

**WHEP Server mode** — serve browser viewers:

```json
{
  "type": "webrtc",
  "id": "whep-serve",
  "name": "Browser Viewers",
  "mode": "whep_server",
  "max_viewers": 20,
  "bearer_token": "viewer-auth-token"
}
```

Viewers POST an SDP offer to `/api/v1/flows/{flow_id}/whep` and receive an SDP answer.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | - | Must be `"webrtc"`. |
| `id` | string | Yes | - | Unique output ID. |
| `name` | string | Yes | - | Human-readable display name. |
| `mode` | string | No | `"whip_client"` | `"whip_client"` (push to endpoint) or `"whep_server"` (serve viewers). |
| `whip_url` | string | WHIP only | - | WHIP endpoint URL. Required for `whip_client` mode. |
| `bearer_token` | string | No | `null` | Bearer token for authentication. |
| `max_viewers` | integer | No | `10` | Max concurrent viewers (WHEP server mode only, 1-100). |
| `public_ip` | string | No | `null` | Public IP for ICE candidates (NAT traversal). |
| `video_only` | boolean | No | `false` | Only send video. When set, any `audio_encode` block is rejected at validation (an audio MID is required in the SDP to carry Opus). |
| `program_number` | integer | No | `null` | MPTS program selector. `null` = lock onto the lowest program_number in the PAT (deterministic default); `Some(N)` = extract elementary streams from program N only. WebRTC is single-program by spec, so this only changes *which* program is sent. Must be `> 0`. See [MPTS → SPTS filtering](#mpts--spts-filtering). |
| `accept_self_signed_cert` | boolean | No | **`true`** | WHIP-client mode only: skip TLS certificate validation on the WHIP endpoint. It defaults to **true**, so a WHIP push validates no CA chain unless you set this `false` or set `cert_fingerprint`. |
| `cert_fingerprint` | string | No | `null` | SHA-256 fingerprint of the expected WHIP endpoint's leaf certificate (colon-separated hex). When set, full CA-chain validation runs **in addition**, and it overrides `accept_self_signed_cert`. |
| `video_encode` | object | No | `null` | Optional video re-encode. **H.264 only** — `x265`, `hevc_nvenc`, `hevc_qsv`, `hevc_vaapi`, `hevc_rkmpp` and `hevc_auto` are all rejected at config load, because browsers cannot decode HEVC and a rebuild would not help. `h264_auto` is allowed. Backend / chroma / bit-depth support: [Codec matrix](/edge/codec-matrix/). |
| `webrtc_compatible` | boolean | No | `false` | Force a browser-safe H.264 egress: zero B-frames (non-monotonic RTP timestamps are what browser jitter buffers freeze on), 8-bit 4:2:0, profile downgraded to `main` if higher, `tune=zerolatency` — whatever the source GOP. Requires an H.264 encoder backend compiled in, and rejects an explicit HEVC `video_encode.codec`. |
| `transcode` | object | No | `null` | PCM channel-shuffle / sample-rate / bit-depth conversion. **Rejected at validation without `audio_encode`.** |
| `pid_overrides` | object | No | `null` | Per-program PID pinning for the regenerated elementary streams. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `audio_encode` | object | No | `null` | Optional Phase B `audio_encode` block (codec: `opus`). When absent, Opus sources are carried natively and **AAC sources automatically fall back to video-only** because WebRTC does not carry AAC. When present, the input AAC is decoded via the Phase A `engine::audio_decode::AacDecoder` (FDK AAC by default, supporting AAC-LC/HE-AAC v1/v2/multichannel) and re-encoded as Opus in-process via the `engine::audio_encode::AudioEncoder` (libavcodec + libopus, from the default `media-codecs` feature) — see [Audio Gateway — `audio_encode`](/edge/audio-gateway/#the-audio_encode-block--compressed-audio-egress-rtmp--hls--webrtc). |

**Audio:** Opus passthrough by default — Opus flows natively on WebRTC paths. AAC contribution sources need an `audio_encode: { codec: "opus" }` block to be carried as Opus; without it, AAC sources fall back to video-only.

### Display Output

Plays the flow's video to a locally-attached HDMI / DisplayPort connector and (optionally) routes its audio to an ALSA device. Linux-only and gated on the `display` Cargo feature (on by default in every release tarball).

```json
{
  "type": "display",
  "id": "out-confidence",
  "name": "Green-room HDMI",
  "device": "HDMI-A-1",
  "audio_device": "hw:0,3"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | — | Must be `"display"`. |
| `device` | string | Yes | — | KMS connector name from the edge's display enumeration: `"HDMI-A-1"`, `"DP-2"`, `"DVI-D-1"`. Validated against `^[A-Z][A-Z0-9-]{0,63}$`. |
| `audio_device` | string | No | `null` | ALSA device id (`"hw:0,3"`, `"plughw:0,3"`, `"default"`, `"sysdefault"`, `"pulse"`). Omit for video-only. |
| `program_number` | integer | No | `null` | MPTS program filter (1-based; `0` reserved). `null` selects the lowest program in the active input's PAT. |
| `audio_track_index` | integer | No | `null` | Audio elementary-stream index within the chosen program. Must be < 16. |
| `audio_channel_pair` | array | No | `[0, 1]` | Stereo pair to render from decoded multichannel audio. Both indices < 8 and not equal. |
| `resolution` | string | No | `null` | **Deprecated and ignored at runtime** — superseded by `scaling_mode`. Still accepted so old configs round-trip; setting it logs a warning. |
| `refresh_hz` | integer | No | `null` | **Deprecated and ignored at runtime** — same story as `resolution`. |
| `sync_mode` | string | No | `"vsync_to_display"` | `"vsync_to_display"` (default, audio-master: video is paced to the measured ALSA playout clock) or `"genlock"` (the display's audio is locked to the flow master clock, so the panel stays rate-coherent with the flow's wire outputs). Lip-sync is identical either way. |
| `mpeg2_cpu_decode` | boolean | No | `null` | Per-output override of the fleet-wide MPEG-2 CPU pin. MPEG-2 decodes on CPU on every hardware backend except NVDEC — a capability fact on RKMPP (no MPEG-2 decoder exists there), a conservative default on VAAPI. Unset keeps the pin; `false` opts this output onto the hardware backend; `true` forces CPU even on NVDEC. H.264 / HEVC on the same output keep the hardware path either way, and the *runtime-learned* pin behind `display_hw_decode_mpeg2_pinned` is deliberately not overridable. |

Connectors are enumerated at edge startup and surfaced in `HealthPayload.display_devices` — the manager UI populates the **Device** dropdown from this list. HDMI hotplug discovery is startup-only in v1; new cables require restarting the edge.

The remaining fields — `scaling_mode`, `hw_decode`, `show_audio_bars`, `present_lead_ms` and `present_vblank_cadence` — plus A/V sync, supported codecs, the capacity budget and the `display_*` event catalogue, are documented in [Display Output](/edge/display/).

### SDI Output (Blackmagic DeckLink)

Native SDI playout via a Blackmagic **DeckLink** card: the flow's video and audio are decoded and scheduled against the card's clock, with no external IP→SDI converter. Gated on the `sdi-decklink` Cargo feature (compiled into every `*-full` release); the schema is always present so configs round-trip on builds without it.

```json
{
  "type": "sdi",
  "id": "sdi-out-1",
  "name": "SDI playout",
  "device": "DeckLink Quad (1)",
  "mode": "Hi50",
  "pixel_format": "uyvy422",
  "audio_channels": 2
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | Yes | — | Must be `"sdi"`. |
| `id` | string | Yes | — | Unique output ID within the flow. |
| `name` | string | Yes | — | Human-readable display name. |
| `device` | string | Yes | — | DeckLink device display name, e.g. `"DeckLink Quad (1)"`. |
| `mode` | string | Yes | — | DeckLink mode FourCC to play out (`"Hi50"`, `"Hp25"`, …). Determines the raster + frame rate the card opens at; must match the decoded video's raster. |
| `pixel_format` | string | No | `"uyvy422"` | Wire pixel format. `"uyvy422"` (8-bit) is the only one implemented. |
| `audio_channels` | integer | No | `2` | Embedded-audio channels to play out: `0` (video-only), `2`, `8`, or `16`. Audio is scheduled at 48 kHz on the card. |
| `program_number` | integer | No | `null` | MPTS program filter (1-based). `null` selects the lowest program in the PAT. |
| `scte35_injection` | boolean | No | `false` | Translate inbound SCTE-35 cues into SCTE-104 VANC on playout. |
| `audio_offset_ms` | integer | No | `0` | Operator A/V-sync trim for embedded audio, `-1000`..`1000` ms. Positive delays audio; negative advances it. |

Two SDI ports are not co-clocked unless the card is genlocked. Full reference: `bilbycast-edge/docs/sdi.md`.

### Bonded Output

Sends a media flow over the bilbycast multi-path bonding stack — the bonded transport that replaces appliances like Peplink/SpeedFusion with a media-aware multi-path egress. Multiple network paths are aggregated for throughput and failover.

```json
{
  "type": "bonded",
  "id": "out-bonded",
  "name": "Bonded send",
  "bond_flow_id": 42,
  "scheduler": "adaptive",
  "encryption_key": "<64 hex characters>",
  "path_mtu": 1000,
  "paths": [
    { "id": 0, "name": "lte-0", "weight_hint": 1, "transport": { "type": "udp", "remote": "203.0.113.10:7100" } },
    { "id": 1, "name": "lte-1", "weight_hint": 1, "transport": { "type": "udp", "remote": "203.0.113.10:7102" } }
  ]
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `bond_flow_id` | integer | Yes | — | Bond identifier; must match the receiver's value. |
| `paths` | array | Yes | — | Send legs, each with a unique `id`, a `name`, a `weight_hint`, an optional `max_bitrate_bps` ceiling, an optional per-leg `fec`, and a `transport` block. **There is no top-level `remote_addr`** — endpoints are per-leg. |
| `scheduler` | string | No | `adaptive` | `round_robin`, `weighted_rtt`, `media_aware` or `adaptive`. |
| `congestion` | object | No | `null` | Tuning for the `adaptive` scheduler's per-leg capacity controller. |
| `fec` | object | No | `null` | Proactive FEC geometry; must match the receiver's. |
| `redundancy` | object | No | `null` | Duplicate-across-legs redundancy tier. |
| `encryption_key` | string | No | `null` | 64 hex characters — the 32-byte ChaCha20-Poly1305 AEAD key applied per datagram on UDP legs (QUIC legs are already TLS). Both ends must share it. |
| `retransmit_capacity` | integer | No | auto-derived | Sender retransmit ring capacity in packets. Set only to override the derivation. |
| `equalization` | string | No | `auto` | `auto` / `on` / `off`. Should match the receiver. |
| `max_bonding_latency_ms` | integer | No | derived | Equalization latency budget and loss-recovery deadline. |
| `keepalive_ms` | integer | No | `200` | Keepalive interval. |
| `program_number` | integer | No | `null` | MPTS → SPTS program filter. Must be `> 0` if set. |
| `pid_map` | object | No | `null` | Flat source-PID → target-PID rewrite. See [TS PID remapping](#ts-pid-remapping-pid_map-and-pid_overrides). |
| `priority` | object | No | `null` | Bond priority tier, used by the shared-leg capacity broker. |
| `path_mtu` | integer | No | `1500` | Smallest IP-layer path MTU (bytes) across this bond's legs. The bonded output re-chunks outbound MPEG-TS at 188-byte packet boundaries into datagrams that fit this MTU *after* every per-datagram overhead (IP/UDP, bond header, AEAD envelope, relay / native-UDP tunnel framing, FEC repair headroom), so no leg emits an IP-fragmented datagram. Range `[576, 9000]`. Default `1500` (standard ethernet) derives the classic 1316-byte (7 × 188) TS datagram; a measured ~1000 B cellular bearer derives 752 B (4 × 188). Sender-side only — the bonded input needs no change. See the cellular note below. |

Cellular CGNAT paths routinely drop IP fragments and black-hole PMTU discovery (no ICMP frag-needed returned), so an oversized datagram — a whole I-frame, say — is lost wholesale and unrecoverably even while the leg reports `state=alive` with healthy RTT. Setting `path_mtu` to the measured MTU of the constrained leg eliminates fragmentation; any residual loss is then per-small-datagram and recoverable by the bond's ARQ + FEC. Measure the constrained leg with a DF ping sweep: `ping -M do -s <n>`.

The full Bonded protocol — path adapters, link selection, latency budgets, FEC, and the `path_mtu` reference — is covered in [Bonding](/edge/bonding/). At the receiving end, use a matching [Bonded Input](#bonded-input).

---

## Recording (Flow Attribute)

Continuous flow recording to disk is a per-flow attribute (`recording`) rather than an output type — the writer is a sibling subscriber on the broadcast channel, not an egress. It can never block live outputs.

```json
"flows": [{
  "id": "record-flow",
  "name": "Record live SRT to disk",
  "enabled": true,
  "input_ids": ["live-srt-in"],
  "output_ids": [],
  "recording": {
    "enabled": true,
    "storage_id": "record-flow",
    "segment_seconds": 10,
    "retention_seconds": 86400,
    "max_bytes": 53687091200,
    "pre_buffer_seconds": null
  }
}]
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | No | `true` | When `false`, the writer is built but doesn't subscribe — useful for cron-armed recording via routines. |
| `storage_id` | string | No | flow id | Subdirectory under the replay root. Alphanumeric + `._-`, ≤ 64 chars. |
| `segment_seconds` | integer | No | `10` | Wall-clock segment roll cadence. Range `[2, 60]`. |
| `retention_seconds` | integer | No | `86400` | Oldest-first prune by mtime. `0` = unlimited. |
| `max_bytes` | integer | No | `53687091200` | Oldest-first prune by total size. `0` = unlimited. |
| `pre_buffer_seconds` | integer | No | `null` | When set, the writer auto-arms in **pre-buffer** mode and rolls segments under the matching retention so an operator pressing Start later picks up the last `N` seconds of pre-roll. Range `[1, 300]`. |
| `filmstrip_seconds` | integer | No | `null` | When set, a sibling subscriber writes one 160×90 JPEG every N seconds to `<recording_dir>/thumbs/<pts_90khz>.jpg`, which the manager's Replay page renders as the scrubber filmstrip. Range `[1, 30]`; `null` disables it. Separate from the flow-level `thumbnail` flag — that streams to the manager over WebSocket, this writes to disk for later scrub. It carries real per-interval decode CPU plus disk growth, so size it when planning a compliance recorder, and it needs a build with `media-codecs` (default on). |

A flow with `output_ids: []` and `recording.enabled: true` is a **monitor-only** recorder — recommended for compliance recording.

Storage root resolution order: `BILBYCAST_REPLAY_DIR` → `$XDG_DATA_HOME/bilbycast/replay/` → `$HOME/.bilbycast/replay/` → `./replay/`. Per-recording cap via `max_bytes`; no global root cap.

Full reference, including playback as an input, error catalogue, and Phase 2 / 1.5 features: [Replay](/edge/replay/).

---

## Resource Limits

Optional top-level `resource_limits` block. When set, the edge samples CPU and RAM usage on a periodic tick and emits Warning / Critical events under category `system_resources` when thresholds are exceeded. Optionally gates new flow creation when resources are critical.

```json
{
  "version": 2,
  "resource_limits": {
    "cpu_warning_percent": 80,
    "cpu_critical_percent": 95,
    "ram_warning_percent": 80,
    "ram_critical_percent": 95,
    "critical_action": "alarm",
    "grace_period_secs": 10
  },
  "inputs": [],
  "outputs": [],
  "flows": []
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cpu_warning_percent` | number | `80` | CPU usage warning threshold (0–100). |
| `cpu_critical_percent` | number | `95` | CPU usage critical threshold. |
| `ram_warning_percent` | number | `80` | RAM usage warning threshold (0–100). |
| `ram_critical_percent` | number | `95` | RAM usage critical threshold. |
| `critical_action` | string | `"alarm"` | What to do when any metric is critical. `"alarm"` — events only, flows continue. `"gate_flows"` — additionally reject new flow creation while any metric is critical. |
| `grace_period_secs` | integer | `10` | Seconds the metric must continuously exceed the threshold before the event fires (debounce). |

Omit the block to disable system-resource alarms entirely. The edge's resource-budget probe (advertised on `HealthPayload.resource_budget`) is independent — that's a one-shot hardware-capability snapshot at startup, not a runtime metric.

---

## Node Tuning

Optional top-level `tuning` block carrying node-wide defaults. Every field is optional, and an absent field means the built-in default — an absent block therefore changes nothing.

These knobs were environment variables until 2026-08, which meant the manager could neither show them nor set them: tuning a node meant editing a systemd unit and restarting, per node, with no audit trail and no way to tell one node's tuning from another's. They are ordinary config fields now and arrive over the same validated `UpdateConfig` path as everything else.

```json
{
  "version": 2,
  "tuning": {
    "ingress_dejitter_ms": 80,
    "ingress_residence_ms": 400,
    "probe_session_limits": true,
    "probe_4k": true,
    "media_player_controller": true,
    "media_player_pcr_deadlines": true
  }
}
```

| Field | Type | Range | Default | Description |
|-------|------|-------|---------|-------------|
| `ingress_dejitter_ms` | integer | 20–2000 | `null` — no node-wide de-jitter | Default ingress de-jitter setpoint. Setting it both **switches the buffer on** and sizes it, for every raw UDP and RTP input that does not carry its own `ingress_dejitter_ms`. A per-input value overrides it. |
| `ingress_residence_ms` | integer | `setpoint + 40` – 5000, where `setpoint` is `tuning.ingress_dejitter_ms` or the built-in 60 ms when that is unset | `max(4 × setpoint, 250)` | Default hard-shed residence cap for that buffer. A packet older than the cap is shed rather than released late, which is what bounds ingress latency when a burst or a source-rate offset outruns the servo's ±5 % authority. A per-input `ingress_residence_ms` overrides it. |
| `probe_session_limits` | boolean | - | `true` | Run the startup hardware encoder / decoder session-capacity probe. `false` trades the manager's "sessions used **of** max" denominator for a faster boot, and disables **both** probe tiers. |
| `probe_4k` | boolean | - | `true` | Run the second-tier 4K session-capacity probe. Ignored when `probe_session_limits` is `false`. |
| `media_player_controller` | boolean | - | `true` | Node-wide default for media-player operator transport control. `false` selects the legacy sequential playout loop **and** withdraws the `media-player-control-v1` capability, so the manager's **Next** button disappears from every media-player flow on this node rather than being offered and refused. A per-input `operator_control` overrides it. |
| `media_player_pcr_deadlines` | boolean | - | `true` | Node-wide default for PCR-anchored TS playout pacing. `false` selects the legacy byte-rate estimate. Use this layer when the *host* is the problem — a stalling disk, a clock step; use the per-input `pcr_deadlines` when one asset is. A per-input value overrides it. |

**`ingress_dejitter_ms` reaches raw UDP and RTP inputs only.** SRT already de-jitters at the transport layer (TSBPD), RTMP and RTSP synthesise their own clock, and a bonded input's reordering buffer would shed the bond's own bursts — those transports deliberately run ingress passthrough and the node-wide setpoint does not enrol them.

**The two probe switches are read once at node start.** Pushing a change to either takes effect at the node's next restart, and the edge says so with a Warning `tuning_requires_restart` event rather than leaving you to infer it from an unchanged Resources card. The two ingress knobs and the two media-player knobs apply on the push and are read when an input next starts, so **restarting the flow** is enough — no node restart.

Each field replaces an environment variable. The config field always wins — a legacy variable that is still read at all sits *below* this block, never above it, because an environment variable that outranked the UI would recreate the silent no-op the migration exists to close. A node that still sets one raises a Warning `deprecated_env_var` event naming the field that replaces it, so a stale unit file shows up on the manager's Events page instead of quietly doing nothing.

**UI:** Manager → node → **Configure** → **Tuning**. The tab is gated on the `node_tuning` capability advertised on `HealthPayload.capabilities`, so an edge too old to honour the block does not offer it.

The **Media Player** section of that tab is gated separately, on `media_player_tuning`. Those two fields landed after `node_tuning` shipped, so an edge from that release advertises `node_tuning`, accepts them on a push and ignores them — precisely the accept-and-ignore failure `node_tuning` exists to prevent, which reusing the bit would have recreated. The rest of the tab still renders on such an edge.

---

## Structured JSON Logging (`logging`)

Optional top-level `logging` block. When a `json_target` is configured, **every operational event the edge emits** — the same events that ride the manager WebSocket `event` channel and are catalogued in [Events and Alarms](/edge/events-and-alarms/) — is additionally written as one JSON line to the chosen sink. This is how a Splunk / Skyline DataMiner / Loki / generic syslog stack picks the edge up without polling the manager. It is purely additive: the manager push and the Prometheus `/metrics` surface are unaffected.

```json
{
  "logging": {
    "json_target": {
      "kind": "file",
      "path": "/var/log/bilbycast/events.jsonl",
      "format": "splunk",
      "max_size_mb": 64,
      "max_backups": 5
    }
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `json_target` | object | No | `null` | The sink. Absent disables the shipper. |
| `json_target.kind` | string | Yes | - | Selects the variant: `"stdout"`, `"file"` or `"syslog"`. |
| `json_target.format` | string | No | `"raw"` | Envelope shape, on all three variants. `"raw"` — generic single-line JSON. `"splunk"` — wraps the envelope in a top-level `{"event": ...}` object so a Splunk HTTP Event Collector forwarder ingests the same line. `"dataminer"` — Skyline DataMiner field renames (`error_code` → `parameter_id`). |
| `json_target.path` | string | `file` only | - | Absolute path to the active log file. 1–4096 characters, no NUL bytes. The parent directory is created best-effort when the shipper starts, so a fresh `"/tmp/events.jsonl"` needs no `mkdir -p`; startup fails only if the open itself fails, which on a running host means a permissions problem rather than a missing directory. |
| `json_target.max_size_mb` | integer | No | `64` | `file` only. Rotate when the active file exceeds this size. Range 1–4096. Backups are `<path>.1` (most recent) … `<path>.N`. |
| `json_target.max_backups` | integer | No | `5` | `file` only. Rotated backups retained; the oldest beyond this is dropped. Range 0–100. `0` truncates on rotate and keeps no backups. |
| `json_target.addr` | string | `syslog` only | - | Syslog destination as `host:port`, e.g. `"127.0.0.1:514"`. RFC 5424 over **UDP**, fire-and-forget — a black-holed collector never blocks the edge. |

Validation rejects an empty or over-long `path`, a `path` containing a NUL byte, a `max_size_mb` outside 1–4096, a `max_backups` above 100, and a syslog `addr` that does not parse as a socket address. `stdout` takes no further fields — use it in a container where the runtime already forwards stdout.

An `update_config` push that omits `logging` preserves what the node already holds (the same treatment as `monitor`, `upgrades`, `resource_limits`, `nmos_registration` and `tuning`), so a push from a manager that does not manage this block cannot silently switch a SIEM feed off.

---

## Upgrade Configuration

Optional top-level `upgrades` block controlling manager-driven binary upgrades. **Off unless `enabled`** — even when the manager schedules one, a node with `enabled: false` rejects it with `error_code: "upgrade_disabled"` and downloads nothing. Operator workflow, rollout strategy and audit trail: [Remote Upgrade](/manager/remote-upgrade/).

```json
{
  "upgrades": {
    "enabled": true,
    "allowed_channels": ["stable"],
    "install_root": "/opt/bilbycast/edge",
    "boot_health_window_secs": 120,
    "max_boot_attempts": 3
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | No | `false` | Master switch. Operators opt in per node. |
| `allowed_channels` | array | No | `["stable"]` | Channels this node will install. `"nightly"` and `"beta"` are available for testbed nodes; a command carrying any other channel is rejected with `upgrade_channel_not_allowed`. |
| `min_version` | string | No | `null` | Minimum semver floor. Any manifest declaring a lower version is refused. |
| `rollback_grace` | integer | No | `1` | How many minor versions back from the installed version the node will still roll *forward* to. Anything older than `current_minor - rollback_grace` is rejected with `upgrade_version_too_old`, even when the manifest is newer than `min_version`. |
| `install_root` | string | No | `/opt/bilbycast/edge` | On-disk install root. The edge writes `versions/<v>/`, the `current` and `previous` symlinks, and `state.json` beneath it — so the service user must own it. See [Ubuntu service install](/edge/install-ubuntu-service/). |
| `boot_health_window_secs` | integer | No | `120` | Window after a respawn in which the new binary must produce healthy manager beats. Failing that, the boot watchdog rolls the symlink back to `previous` and emits `upgrade_rolled_back`. |
| `max_boot_attempts` | integer | No | `3` | Boot attempts on the new binary before automatic rollback. `state.json.boot_attempts` increments on every respawn into `pending_health`; the watchdog reverts on the next boot past this. |
| `manual_only` | boolean | No | `false` | When true the manager may **stage** an upgrade (download, verify, extract under `versions/<new>/`) but the symlink swap waits for a local `kill -SIGUSR1 <pid>`, so a human approves the switchover. |

---

## Flow Assembly (PID Bus — SPTS / MPTS from N inputs)

A flow can optionally carry an `assembly` block that tells the runtime to stop forwarding one input verbatim and instead **build a fresh MPEG-TS from elementary streams pulled off any of the flow's inputs**. Every output type (UDP, RTP, SRT, RIST, RTMP/RTMPS, HLS, CMAF / CMAF-LL, WebRTC) consumes the assembled TS unchanged — no output-type gate.

Three `kind` values:

| Kind | Programs | PCR |
|---|---|---|
| `passthrough` | must be empty | none — forwards the active input verbatim (same behaviour as `assembly = null`) |
| `spts` | exactly one | flow-level *or* program-level `pcr_source` |
| `mpts` | one or more, unique `program_number` per program | every program needs an effective `pcr_source` |

Slot sources: **`pid`** (explicit PID off a named input), **`essence`** (first video / audio / subtitle / data ES off a named input, resolved against the input's live PSI catalogue), or **`hitless`** (primary-preference pre-bus merger with 200 ms stall timer — not 2022-7 seq-aware).

PCM / AES3 inputs (ST 2110-30, ST 2110-31, `rtp_audio`) become TS carriers by setting `audio_encode` on the **input** — `aac_lc` / `he_aac_v1` / `he_aac_v2` / `s302m` (ST 2110-31 must use `s302m`).

The plan is hot-swappable at runtime — `UpdateFlowAssembly` replaces the running plan, unchanged slots keep their bus fan-ins (no packet gap), PMT `version_number` bumps mod 32 for changed programs, PAT only when the program set changes, and PSI is re-emitted immediately so receivers see the new PMT before any packet lands on a new `out_pid`. Transitions across the passthrough boundary (passthrough ↔ spts/mpts) are rejected — use a full `UpdateFlow`.

Full reference, examples, validation rules, and monitoring: **[Flow Assembly (PID Bus)](/edge/flow-assembly/)**.

---

## MPTS → SPTS filtering

All outputs — and the thumbnail generator — accept an optional `program_number` selector for down-selecting an MPTS (Multi-Program Transport Stream) input to a single program. Whether the filter rewrites TS bytes or just picks which elementary streams to extract depends on the output type.

### Behaviour matrix

| Output | `program_number = null` (default) | `program_number = N` |
|--------|-----------------------------------|----------------------|
| **UDP / RTP / SRT / HLS** (TS-native) | full MPTS passthrough (current behaviour) | PAT rewritten to a single-program form; only program N's PMT, ES, and PCR PIDs survive. FEC (2022-1) and hitless redundancy (2022-7) operate on the filtered bytes. |
| **RTMP / WebRTC** (re-muxing) | lock onto the lowest `program_number` in the PAT (deterministic — replaces the old "first PMT seen" race) | extract elementary streams from program N's PMT only |
| **Thumbnail generator** (`thumbnail_program_number` on `FlowConfig`) | ffmpeg picks the first program it finds | TS is pre-filtered so ffmpeg only sees program N |

### Rules

- **`program_number` is per-output.** One flow can run three outputs in parallel — one forwarding full MPTS to an archive, one filtered to program 1, and another to program 2 — all sharing the same broadcast channel.
- **`program_number = 0` is rejected** at config load and on manager commands. Program number 0 is reserved for the NIT in the MPEG-TS specification and never identifies a real program.
- **Disappearing programs** (selected program not in the PAT, or a PAT version bump removes it): the output emits nothing until the program reappears. The filter automatically recovers on the next PAT that re-advertises the target.
- **SPTS inputs** are unaffected — there's only one program, so `program_number = 1` (or whatever it is) filters to the same stream that was already there.

### Example — 2-program MPTS fanning out to three destinations

```json
{
  "inputs": [
    { "id": "mpts-in", "name": "MPTS ingest", "type": "udp", "bind_addr": "0.0.0.0:5020" }
  ],
  "outputs": [
    {
      "type": "udp", "id": "archive", "name": "Archive full MPTS",
      "dest_addr": "10.0.0.5:6000"
    },
    {
      "type": "udp", "id": "prog1-viewer", "name": "Program 1 → ffplay",
      "dest_addr": "127.0.0.1:6001",
      "program_number": 1
    },
    {
      "type": "rtmp", "id": "prog2-rtmp", "name": "Program 2 → CDN",
      "dest_url": "rtmp://live.example.com/app",
      "stream_key": "my-key",
      "program_number": 2
    }
  ],
  "flows": [
    {
      "id": "mpts-flow",
      "name": "Dual-program feed",
      "thumbnail_program_number": 1,
      "input_ids": ["mpts-in"],
      "output_ids": ["archive", "prog1-viewer", "prog2-rtmp"]
    }
  ]
}
```

The archive receives the full MPTS. The `prog1-viewer` UDP output sends only program 1 as a rewritten SPTS (PAT lists one entry, program 1's PMT + ES PIDs). The RTMP output publishes program 2's elementary streams. The manager UI thumbnail shows a frame from program 1.

---

## TS PID remapping (`pid_map` and `pid_overrides`)

Two different knobs, on most TS-carrying inputs and outputs, that both change which PIDs land on the wire.

### `pid_map` — flat PID rewrite

A `{ source_pid: target_pid }` object applied to the emitted transport stream. At most 256 entries; both sides must sit in `0x0010`–`0x1FFE` (`0x0000`–`0x000F` and `0x1FFF` are reserved); an entry whose source equals its target is rejected as a no-op, and each target PID may be used only once.

### `pid_overrides` — per-program PID pinning

An object keyed by **`program_number`**, each value pinning the PIDs of that program's regenerated elementary streams so a downstream decoder stays locked across a switcher hop.

| Key | Description |
|-----|-------------|
| `pmt_pid` | PMT PID for this program. |
| `video_pid` | Video PES PID. |
| `audio_pid` | Audio PES PID. On the passthrough path with a multi-audio program this remaps only the *first* audio PID; use `audio_pids` for the rest. |
| `audio_pids` | `{ source_audio_pid: target_audio_pid }` remap for multi-language / multi-track programs. **Passthrough only** — ignored on the synthetic-TS path, which never carries more than one audio ES. Where it overlaps `audio_pid`, this map wins. |
| `pcr_pid` | PCR PID. Unset means PCR rides the video PID (or audio, if there is no video). It must point at an ES PID that really exists in the PMT — the muxer will not synthesise PCR on a standalone PID. |

Every PID must be in `0x0010`–`0x1FFE`. Within one program, `pmt_pid`, `video_pid` and `audio_pid` must differ; `pcr_pid` may alias video or audio (the standard pattern) but never the PMT PID. `program_number` `0` is rejected — it is reserved for the NIT.

The map behaves differently depending on where the TS comes from:

- **Synthetic-TS carriers** (RTMP, RTSP, WebRTC, ST 2110-20, `test_pattern`, `media_player`, `replay`) emit exactly one program, so the map must hold **exactly one entry, keyed `1`**. Anything else is rejected at config load, naming Flow Assembly as the route to multi-program output.
- **TS-source transcoders and passthrough rewriters** key the map by the **live `program_number`**. Programs not listed pass through untouched.

`audio_pids` is matched against the live PMT by literal source PID, so an upstream renumber silently inerts the entry rather than erroring — the manager surfaces that against the PSI catalogue.

`pid_overrides` is accepted and validated on the SDI input but **not applied**: the SDI capture path runs no ingress post-process stage.

---

## SMPTE 2022-1 FEC Configuration

Forward Error Correction parameters used by `fec_decode` (on RTP inputs) and `fec_encode` (on RTP outputs).

```json
{
  "columns": 10,
  "rows": 10
}
```

| Field | Type | Required | Range | Description |
|-------|------|----------|-------|-------------|
| `columns` | integer | Yes | 1-20 | L parameter: number of columns in the FEC matrix. |
| `rows` | integer | Yes | 4-20 | D parameter: number of rows in the FEC matrix. |

The FEC matrix protects `columns x rows` media packets with `columns + rows` parity packets. Larger matrices provide better protection at the cost of higher latency and bandwidth overhead.

Common configurations:
- `5 x 5` -- Low overhead, moderate protection
- `10 x 10` -- Good balance of overhead and protection
- `20 x 20` -- Maximum protection, higher latency

---

## SMPTE 2022-7 SRT Redundancy

Both SRT input and SRT output support SMPTE 2022-7 hitless redundancy via a second SRT leg. The parent SRT config defines leg 1; the `redundancy` block defines leg 2.

For input: packets from both legs are merged using RTP sequence numbers, providing seamless failover if one path fails.

For output: packets are duplicated and sent on both legs simultaneously.

```json
{
  "redundancy": {
    "mode": "listener",
    "local_addr": "0.0.0.0:9001",
    "remote_addr": null,
    "latency_ms": 500,
    "passphrase": "encryption-key",
    "aes_key_len": 32
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `mode` | string | Yes | - | SRT mode for leg 2: `"caller"`, `"listener"`, or `"rendezvous"`. |
| `local_addr` | string | Yes | - | Local bind address for leg 2. |
| `remote_addr` | string | Conditional | `null` | Remote address for leg 2 (required for caller/rendezvous). |
| `latency_ms` | integer | No | `120` | SRT latency for leg 2. |
| `passphrase` | string | No | `null` | AES encryption passphrase for leg 2 (10-79 characters). |
| `aes_key_len` | integer | No | `16` | AES key length for leg 2 (16, 24, or 32). |
| `crypto_mode` | string | No | `null` | Cipher mode for leg 2: `"aes-ctr"` or `"aes-gcm"`. |

Legs can use different SRT modes, different ports, different latency values, and even different encryption settings (though using the same settings is recommended for simplicity).

---

## Native libsrt SRT bonding (socket groups)

SRT inputs and outputs also support **native libsrt socket-group bonding** via an inline `bonding` block — not `redundancy`, which is the app-layer alternative and is refused alongside it. Where `redundancy` merges two independent SRT sessions inside the edge, bonding is the libsrt wire protocol: the peer sees a single bonded session and speaks the group handshake, so it interoperates with `srt-live-transmit grp:BROADCAST://` / `grp:BACKUP://`, Haivision socket groups, and any other libsrt peer.

This is unrelated to the [bilbycast bonding stack](/edge/bonding/), which is a proprietary multi-path transport needing a bilbycast node at both ends.

```json
{
  "type": "srt",
  "mode": "caller",
  "latency_ms": 200,
  "bonding": {
    "mode": "broadcast",
    "endpoints": [
      { "addr": "203.0.113.10:9000" },
      { "addr": "203.0.113.11:9000" }
    ]
  }
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mode` | string | Yes | `"broadcast"` (all members active, libsrt dedups) or `"backup"` (primary / failover). |
| `endpoints` | array | Yes | 2–8 member entries; duplicate addresses are rejected. |
| `endpoints[].addr` | string | Yes | Caller mode: remote peer address. Listener mode: the list is advisory — the parent `local_addr` is the single bind, because the libsrt group handshake is multiplexed on one listener. |
| `endpoints[].local_addr` | string | No | Caller-only source bind for this member. Rejected in listener mode. **Accepted and resolved but never applied** — see the caution below. |
| `endpoints[].weight` | integer | No | Backup-mode priority, `0` = equal. Rejected with a non-zero value in broadcast mode. **Accepted but never applied** — see the caution below. |
| `endpoints[].interface_binding` | object | No | Names a NIC whose primary IP is resolved into this member's `local_addr` when that is unset — and therefore inherits the same gap. |

**Rules:**
- `bonding` and `redundancy` are **mutually exclusive** on the same SRT input or output — bonding replaces the app-layer 2022-7 merge with the wire-native group handshake.
- `rendezvous` mode does not support bonding (libsrt's group handshake has no rendezvous variant); the combination is rejected at config load.
- Every SRT option on the parent — latency, encryption, `stream_id`, `packet_filter`, MSS, `payload_size`, retransmit algorithm — applies to **all** members uniformly.
- Bonded outputs compose with every other per-output stage: `program_number`, `audio_encode` (with its companion `transcode`), `video_encode`, output `delay`, and `transport_mode: "audio_302m"`.

:::caution[Per-member `local_addr`, `interface_binding` and `weight` do not reach libsrt]
Only each endpoint's `addr` is handed to the group builder — it carries a plain list of peer socket addresses and has no per-member source bind or priority slot. A per-endpoint `local_addr` (including one resolved from `interface_binding`, which does raise a Critical `srt_strict_binding_unsupported` event when the NIC cannot be resolved) and a per-endpoint `weight` are validated at config load and then dropped, so every member leaves on the host's default source address and backup-mode ordering is libsrt's own. To pin bonded legs to specific NICs today, use policy routing on the host rather than these fields. The `weight` reported back in `srt_bonding_stats` is libsrt's value for the member, not the one configured here.
:::

Per-leg telemetry is surfaced as `srt_bonding_stats` on the input / output snapshot: an `aggregate` block plus one entry per member carrying `endpoint`, `socket_status`, `member_status` (`running` / `idle` / `pending` / `broken`), `weight` and the member's own SRT stats.

---

## SRT Connection Modes

| Mode | Initiator | `remote_addr` required | Use case |
|------|-----------|----------------------|----------|
| `caller` | This endpoint connects to a remote listener | Yes | Sending to a known destination. Most common for outputs. |
| `listener` | This endpoint waits for incoming connections | No | Accepting streams from remote callers. Most common for inputs (ingest servers). |
| `rendezvous` | Both sides connect simultaneously | Yes | NAT traversal. Both sides must use rendezvous mode and know each other's address. |

---

## CLI Argument Overrides

Command-line arguments override values from the config file. This is useful for deployment automation and containerization.

```
bilbycast-edge [OPTIONS]

Options:
  -c, --config <PATH>          Path to configuration file [default: ./config.json]
  -p, --port <PORT>            Override API listen port
  -b, --bind <ADDRESS>         Override API listen address (legacy single-address)
      --bind-addrs <ADDRS>     Override API dual-stack listener addresses (comma-separated,
                               e.g. 0.0.0.0,[::]); takes precedence over --bind
      --monitor-port <PORT>    Override monitor dashboard port
  -l, --log-level <LEVEL>      Log level: trace, debug, info, warn, error [default: info]
      --print-setup-token      Print the one-shot setup-wizard bearer token and exit
      --print-capabilities     Print compiled-in features + advertised capabilities and exit
  -h, --help                   Print help
  -V, --version                Print version
```

| Argument | Config field overridden | Example |
|----------|----------------------|---------|
| `--port` | `server.listen_port` | `--port 9443` |
| `--bind` | `server.listen_addr` (legacy single address) | `--bind 127.0.0.1` |
| `--bind-addrs` | `server.listen_addrs`, which supersedes `server.listen_addr` — so it outranks `--bind` | `--bind-addrs 0.0.0.0,[::]` |
| `--monitor-port` | `monitor.listen_port` | `--monitor-port 9091` |
| `--log-level` | (runtime only, not in config) | `--log-level debug` |
| `--print-setup-token` | (none — prints the token from `secrets.json` and exits) | `--print-setup-token` |
| `--print-capabilities` | (none — prints and exits; loads no config, opens no socket, runs no hardware probe) | `--print-capabilities` |

The log level can also be set via the `RUST_LOG` environment variable, which takes precedence over the `--log-level` argument when set. Supports fine-grained filtering (e.g., `RUST_LOG=bilbycast_edge=debug,tower_http=info`).

**Examples:**

```bash
# Use a specific config file
bilbycast-edge --config /etc/bilbycast/production.json

# Override port for containerized deployment
bilbycast-edge --config config.json --port 443 --bind 0.0.0.0

# Debug logging
bilbycast-edge --config config.json --log-level debug

# Fine-grained logging via environment
RUST_LOG=bilbycast_edge=debug,tower_http=info bilbycast-edge --config config.json
```

---

## Config Persistence Behavior

bilbycast-edge automatically persists configuration changes to disk when flows are modified through the API. Flow configs (including user parameters like SRT passphrases, RTSP credentials, RTMP keys) go to `config.json`, infrastructure secrets go to `secrets.json`:

- **Create flow** (`POST /api/v1/flows`) -- Appends the new flow and saves (flow parameters stay in `config.json`).
- **Update flow** (`PUT /api/v1/flows/{id}`) -- Replaces the flow in-place and saves.
- **Delete flow** (`DELETE /api/v1/flows/{id}`) -- Removes the flow and saves.
- **Add output** (`POST /api/v1/flows/{id}/outputs`) -- Appends the output and saves.
- **Remove output** (`DELETE /api/v1/flows/{id}/outputs/{oid}`) -- Removes the output and saves.
- **Replace config** (`PUT /api/v1/config`) -- Replaces the entire config and saves.
- **Get config** (`GET /api/v1/config`) -- Returns the config with infrastructure secrets stripped. Flow parameters (passphrases, credentials, keys) are included in the response.

### Atomic writes

All config saves use an atomic write strategy: both `config.json` and `secrets.json` are written to temporary files (`.json.tmp`), then atomically renamed to the target paths. This prevents corruption if the process is interrupted during a write. `secrets.json` is written with `0600` permissions (owner-only) on Unix.

### Default config

If the config file does not exist when bilbycast-edge starts, an empty default configuration is used:

```json
{
  "version": 2,
  "server": {
    "listen_addr": "127.0.0.1",
    "listen_addrs": ["127.0.0.1", "[::1]"],
    "listen_port": 8080
  },
  "inputs": [],
  "outputs": [],
  "flows": []
}
```

A fresh config binds **loopback only**, by design: the edge's control plane is the outbound manager WebSocket, so it needs no inbound listener to be managed, and the local API ships with auth disabled. Widen it deliberately — `--bind-addrs 0.0.0.0,[::]` or `server.listen_addrs` — and enable `server.auth` when you do.

### Reloading from disk

Use `POST /api/v1/config/reload` to re-read both `config.json` and `secrets.json` from disk. This is useful after manual edits or after deploying new config files via external tooling (e.g., Ansible, Chef).

---

## Common Configuration Scenarios

### Minimal: RTP receive and forward (no auth)

```json
{
  "version": 2,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "inputs": [
    {
      "id": "in-1",
      "name": "RTP Ingest",
      "type": "rtp",
      "bind_addr": "0.0.0.0:5000"
    }
  ],
  "outputs": [
    {
      "type": "rtp",
      "id": "out-1",
      "name": "Forwarded Output",
      "dest_addr": "192.168.1.50:5004"
    }
  ],
  "flows": [
    {
      "id": "passthrough",
      "name": "RTP Passthrough",
      "enabled": true,
      "input_ids": ["in-1"],
      "output_ids": ["out-1"]
    }
  ]
}
```

### Multicast receive with FEC and trust boundary filters

```json
{
  "version": 2,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "inputs": [
    {
      "id": "mcast-in",
      "name": "Multicast Ingest",
      "type": "rtp",
      "bind_addr": "239.1.1.1:5000",
      "interface_addr": "10.0.0.100",
      "fec_decode": {
        "columns": 10,
        "rows": 10
      },
      "allowed_sources": ["10.0.0.1"],
      "allowed_payload_types": [33],
      "max_bitrate_mbps": 50.0,
      "tr07_mode": true
    }
  ],
  "outputs": [
    {
      "type": "rtp",
      "id": "local-out",
      "name": "Local Multicast Output",
      "dest_addr": "239.1.2.1:5004",
      "interface_addr": "10.0.0.100",
      "fec_encode": {
        "columns": 10,
        "rows": 10
      },
      "dscp": 46
    }
  ],
  "flows": [
    {
      "id": "multicast-feed",
      "name": "Multicast with FEC and Trust Boundary",
      "enabled": true,
      "input_ids": ["mcast-in"],
      "output_ids": ["local-out"]
    }
  ]
}
```

### SRT bidirectional with 2022-7 redundancy

```json
{
  "version": 2,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "inputs": [
    {
      "id": "srt-in",
      "name": "SRT Redundant Ingest",
      "type": "srt",
      "mode": "listener",
      "local_addr": "0.0.0.0:9000",
      "latency_ms": 500,
      "passphrase": "my-secure-passphrase-1234",
      "aes_key_len": 32,
      "redundancy": {
        "mode": "listener",
        "local_addr": "0.0.0.0:9001",
        "latency_ms": 500,
        "passphrase": "my-secure-passphrase-1234",
        "aes_key_len": 32
      }
    }
  ],
  "outputs": [
    {
      "type": "srt",
      "id": "srt-out",
      "name": "SRT Redundant Output",
      "mode": "caller",
      "local_addr": "0.0.0.0:0",
      "remote_addr": "203.0.113.10:9000",
      "latency_ms": 500,
      "passphrase": "output-passphrase-1234567",
      "aes_key_len": 32,
      "redundancy": {
        "mode": "caller",
        "local_addr": "0.0.0.0:0",
        "remote_addr": "203.0.113.11:9000",
        "latency_ms": 500,
        "passphrase": "output-passphrase-1234567",
        "aes_key_len": 32
      }
    }
  ],
  "flows": [
    {
      "id": "srt-redundant",
      "name": "SRT with Hitless Redundancy",
      "enabled": true,
      "input_ids": ["srt-in"],
      "output_ids": ["srt-out"]
    }
  ]
}
```

### Multi-output: RTP to SRT, RTMP, and HLS simultaneously

```json
{
  "version": 2,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "inputs": [
    {
      "id": "fanout-in",
      "name": "Program Ingest",
      "type": "rtp",
      "bind_addr": "239.1.1.1:5000",
      "interface_addr": "192.168.1.100"
    }
  ],
  "outputs": [
    {
      "type": "rtp",
      "id": "local",
      "name": "Local Playout",
      "dest_addr": "192.168.1.50:5004"
    },
    {
      "type": "srt",
      "id": "remote-srt",
      "name": "Remote Site SRT",
      "mode": "caller",
      "local_addr": "0.0.0.0:0",
      "remote_addr": "203.0.113.10:9000",
      "latency_ms": 300
    },
    {
      "type": "rtmp",
      "id": "twitch",
      "name": "Twitch",
      "dest_url": "rtmp://live.twitch.tv/app",
      "stream_key": "live_xxxxxxxxxxxx"
    },
    {
      "type": "hls",
      "id": "youtube-hls",
      "name": "YouTube HLS",
      "ingest_url": "https://a.upload.youtube.com/http_upload_hls?cid=xxxx",
      "segment_duration_secs": 2.0
    }
  ],
  "flows": [
    {
      "id": "multi-output",
      "name": "Multi-Output Fan-Out",
      "enabled": true,
      "input_ids": ["fanout-in"],
      "output_ids": ["local", "remote-srt", "twitch", "youtube-hls"]
    }
  ]
}
```

### Full production config with TLS + auth + monitoring

```json
{
  "version": 2,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8443,
    "tls": {
      "cert_path": "/etc/bilbycast/cert.pem",
      "key_path": "/etc/bilbycast/key.pem"
    },
    "auth": {
      "enabled": true,
      "jwt_secret": "K7nXp2qR8vF3mBwYd0hL5jZ1tA6gCeHsN9uIoP4xWkQrJfMaVbDcEiGyTlUwSzO",
      "token_lifetime_secs": 3600,
      "public_metrics": true,
      "clients": [
        {
          "client_id": "ops-admin",
          "client_secret": "admin-secret-change-me",
          "role": "admin"
        },
        {
          "client_id": "grafana",
          "client_secret": "grafana-read-secret",
          "role": "monitor"
        }
      ]
    }
  },
  "monitor": {
    "listen_addr": "0.0.0.0",
    "listen_port": 9090
  },
  "inputs": [
    {
      "id": "program-in",
      "name": "Program Ingest",
      "type": "rtp",
      "bind_addr": "239.1.1.1:5000",
      "interface_addr": "10.0.0.100",
      "fec_decode": {
        "columns": 10,
        "rows": 10
      }
    }
  ],
  "outputs": [
    {
      "type": "rtp",
      "id": "local-playout",
      "name": "Local Playout",
      "dest_addr": "10.0.0.50:5004",
      "dscp": 46
    },
    {
      "type": "srt",
      "id": "remote-site",
      "name": "Remote Site",
      "mode": "caller",
      "local_addr": "0.0.0.0:0",
      "remote_addr": "203.0.113.10:9000",
      "latency_ms": 500,
      "passphrase": "secure-transport-key-1234",
      "aes_key_len": 32
    }
  ],
  "flows": [
    {
      "id": "main-feed",
      "name": "Main Program Feed",
      "enabled": true,
      "input_ids": ["program-in"],
      "output_ids": ["local-playout", "remote-site"]
    }
  ]
}
```

### IPv6 multicast configuration

```json
{
  "version": 2,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "inputs": [
    {
      "id": "ipv6-in",
      "name": "IPv6 Multicast Ingest",
      "type": "rtp",
      "bind_addr": "[ff7e::1]:5000",
      "interface_addr": "::1"
    }
  ],
  "outputs": [
    {
      "type": "rtp",
      "id": "ipv6-out",
      "name": "IPv6 Output",
      "dest_addr": "[ff7e::2]:5004",
      "interface_addr": "::1"
    }
  ],
  "flows": [
    {
      "id": "ipv6-mcast",
      "name": "IPv6 Multicast Flow",
      "enabled": true,
      "input_ids": ["ipv6-in"],
      "output_ids": ["ipv6-out"]
    }
  ]
}
```

## SMPTE ST 2110

bilbycast-edge supports SMPTE **ST 2110-20** (single-stream uncompressed
video, RFC 4175) and **ST 2110-23** (one video essence partitioned across
multiple -20 sub-streams) as both input and output, plus **ST 2110-30**
(linear PCM L16/L24), **ST 2110-31** (AES3 transparent for Dolby E and
similar), and **ST 2110-40** (RFC 8331 ancillary data including SCTE-104,
SMPTE 12M timecode, and CEA-608/708 captions). ST 2110-22 (JPEG XS
compressed video) is not yet implemented.

PTP integration is best-effort and reads from an external `ptp4l` daemon's
management Unix socket — no PTP daemon ships in the edge. SMPTE 2022-7
Red/Blue dual-network operation is opt-in via the `redundancy` block on
each ST 2110 input/output.

### Flow-level fields

Both fields are optional and backward-compatible — existing configs
deserialize unchanged.

| Field | Type | Purpose |
|-------|------|---------|
| `clock_domain` | u8 | IEEE 1588 PTP domain (0–127). Setting this on a flow makes the edge spawn a PTP state reporter and surface lock state through `FlowStats.ptp_state`. |
| `flow_group_id` | string | Logical bundle id; multiple essence flows on a single edge can share a group so the manager treats them as one unit. |

### ST 2110-30 / -31 audio input

```json
{
  "inputs": [
    {
      "id": "studio-a-stereo-in",
      "name": "Studio A — stereo",
      "type": "st2110_30",
      "bind_addr": "239.0.0.10:5000",
      "interface_addr": "10.0.0.5",
      "sample_rate": 48000,
      "bit_depth": 24,
      "channels": 2,
      "packet_time_us": 1000,
      "payload_type": 97,
      "redundancy": {
        "addr": "239.1.0.10:5000",
        "interface_addr": "10.1.0.5"
      }
    }
  ],
  "flows": [
    {
      "id": "studio-a-stereo",
      "name": "Studio A — stereo",
      "enabled": true,
      "clock_domain": 0,
      "input_ids": ["studio-a-stereo-in"],
      "output_ids": []
    }
  ]
}
```

`type: "st2110_31"` uses an identical struct — only the depacketizer
label changes. AES3 transparency preserves user bits, channel status,
validity, and parity bits.

### ST 2110-30 / -31 audio output

```json
{
  "type": "st2110_30",
  "id": "monitor-out",
  "name": "Loopback to monitor",
  "dest_addr": "239.2.0.10:5000",
  "dscp": 46,
  "sample_rate": 48000,
  "bit_depth": 24,
  "channels": 2,
  "packet_time_us": 1000,
  "payload_type": 97,
  "redundancy": {
    "addr": "239.3.0.10:5000",
    "interface_addr": "10.1.0.5"
  }
}
```

### ST 2110-40 ancillary input/output

```json
{
  "inputs": [
    {
      "id": "anc-in",
      "name": "ANC ingest",
      "type": "st2110_40",
      "bind_addr": "239.0.0.20:5000",
      "payload_type": 100
    }
  ],
  "outputs": [
    {
      "type": "st2110_40",
      "id": "anc-out",
      "name": "ANC loopback",
      "dest_addr": "239.2.0.20:5000",
      "dscp": 46,
      "payload_type": 100
    }
  ],
  "flows": [
    {
      "id": "anc-flow",
      "name": "ANC (timecode + SCTE-104)",
      "enabled": true,
      "clock_domain": 0,
      "input_ids": ["anc-in"],
      "output_ids": ["anc-out"]
    }
  ]
}
```

### ST 2110-20 uncompressed video input/output

Uncompressed 4:2:2 video over RFC 4175. On **input**, RFC 4175 is
depacketized, the raw YUV is fed into an in-process H.264/HEVC encoder
(the mandatory `video_encode` block), and the result is muxed to MPEG-TS
on the flow's broadcast channel. On **output**, the flow's H.264/HEVC is
decoded, converted to planar 4:2:2 at the configured bit depth, and RFC
4175 packetized onto the wire.

```json
{
  "inputs": [
    {
      "id": "studio-a-video-in",
      "name": "Studio A — video",
      "type": "st2110_20",
      "bind_addr": "239.0.0.30:5000",
      "interface_addr": "10.0.0.5",
      "width": 1920,
      "height": 1080,
      "frame_rate_num": 30000,
      "frame_rate_den": 1001,
      "pixel_format": "yuv422_10bit",
      "payload_type": 96,
      "video_encode": { "codec": "x264", "bitrate_kbps": 20000, "preset": "fast" }
    }
  ],
  "outputs": [
    {
      "type": "st2110_20",
      "id": "video-out",
      "name": "Video egress",
      "dest_addr": "239.2.0.30:5000",
      "dscp": 46,
      "width": 1920,
      "height": 1080,
      "frame_rate_num": 30000,
      "frame_rate_den": 1001,
      "pixel_format": "yuv422_10bit",
      "payload_type": 96
    }
  ],
  "flows": [
    {
      "id": "studio-a-video",
      "name": "Studio A — video",
      "enabled": true,
      "clock_domain": 0,
      "input_ids": ["studio-a-video-in"],
      "output_ids": ["video-out"]
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `bind_addr` / `dest_addr` | string | Yes | Multicast (or unicast) socket address for the essence. |
| `width` / `height` | integer | Yes | Active raster dimensions. |
| `frame_rate_num` / `frame_rate_den` | integer | Yes | Frame-rate fraction (e.g. `30000` / `1001` for 29.97 fps, `60` / `1` for 60 fps). |
| `pixel_format` | string | Yes | Wire pgroup format. Only `"yuv422_8bit"` and `"yuv422_10bit"` are accepted. |
| `payload_type` | integer | No (`96`) | Dynamic RTP payload type, `96`–`127`. |
| `source_addr` | string | No | SSM (S,G) source filter for the input's primary leg. See [Multicast reception](#multicast-reception-ssm-asm-and-socket-binding). |
| `video_encode` | object | Yes (input only) | Mandatory H.264/HEVC encoder block for the ingress encode stage. A `video-encoder-*` backend must be compiled in. Backend / chroma / bit-depth support: [Codec matrix](/edge/codec-matrix/). |
| `redundancy` | object | No | SMPTE 2022-7 Red/Blue dual-network operation. Each leg carries its own `source_addr`, so Red and Blue plants with different source IPs filter independently. |
| `wire_pacing` | object | No (output only) | **Deprecated and ignored at runtime** — pacing is automatic via the wire emitter. Retained so stored configs round-trip; the edge warns when it is set. See [Wire pacing](/edge/wire-pacing/). |

### ST 2110-23 partitioned video input/output

A single video essence carried across N ST 2110-20 sub-streams. Same
encode/decode path as -20; the `sub_streams` array replaces the single
`bind_addr` / `dest_addr`, and `partition_mode` describes how the frame
is split across them.

```json
{
  "type": "st2110_23",
  "id": "uhd-video",
  "name": "UHD 2SI",
  "sub_streams": [
    { "dest_addr": "239.4.0.1:5000" },
    { "dest_addr": "239.4.0.2:5000" },
    { "dest_addr": "239.4.0.3:5000" },
    { "dest_addr": "239.4.0.4:5000" }
  ],
  "partition_mode": "two_sample_interleave",
  "width": 3840,
  "height": 2160,
  "frame_rate_num": 60,
  "frame_rate_den": 1,
  "pixel_format": "yuv422_10bit"
}
```

`sub_streams` takes **2–16 entries**. On an input each is `{ bind_addr, interface_addr?, source_addr?, redundancy?, payload_type? }`; on an output each is `{ dest_addr, bind_addr?, interface_addr?, redundancy?, payload_type?, ssrc? }`. Every entry validates on its own — address, SSM source, RTP payload type (`96`–`127`) and its own 2022-7 Red/Blue block — so one sub-stream can sit on a different NIC or a different source from its siblings. The raster, frame-rate fraction, `pixel_format`, `clock_domain` and (on an input) the mandatory `video_encode` are parent-level and cover the whole essence. `wire_pacing` is accepted on the -23 **output** too, and is likewise deprecated and ignored.

### Validation limits

| Field | Allowed values |
|-------|----------------|
| `sample_rate` | `48000`, `96000` |
| `bit_depth` | `16`, `24` |
| `channels` | `1`, `2`, `4`, `8`, `16` |
| `packet_time_us` | `125` (AM), `1000` (PM) |
| `payload_type` | `96`–`127` |
| `clock_domain` | `0`–`127` |
| `dscp` | `0`–`63` (default `46` / EF) |

Combining `allowed_sources` with `redundancy` is rejected by validation —
the merger path doesn't expose per-packet `src` and the dual-leg path
won't silently bypass the source filter.

### Audio gateway extensions

Every audio output (`st2110_30`, `st2110_31`, `rtp_audio`) accepts an optional `transcode` block for sample-rate / bit-depth / channel-routing conversion via the `rubato` SRC. IS-08 channel maps hot-reload without a flow restart. Full field reference, presets, and worked examples live in [Audio Gateway](/edge/audio-gateway/).

The `rtp_audio` input/output type is wire-identical to ST 2110-30 (same RFC 3551 RTP + L16/L24 PCM payload) with relaxed constraints — sample rates 32 / 44.1 / 48 / 88.2 / 96 kHz, **no PTP requirement**, no `clock_domain`. Use it for WAN contribution, talkback, and ffmpeg/OBS interop.

`srt`, `udp`, and `rtp_audio` outputs accept `transport_mode: "audio_302m"` to ship 48 kHz LPCM as SMPTE 302M-in-MPEG-TS. Mutually exclusive with `packet_filter` (SRT), `program_number`, and SRT `redundancy`.

**Phase A compressed-audio ingress:** when a flow input carries AAC in MPEG-TS (RTMP / RTSP / SRT / UDP / RTP), the in-process `engine::audio_decode::AacDecoder` turns it into PCM so ST 2110-30/-31, `rtp_audio`, and the SMPTE 302M outputs can consume it without ffmpeg. Default FDK AAC backend supports AAC-LC, HE-AAC v1/v2, and multichannel up to 7.1; symphonia fallback supports AAC-LC mono/stereo only.

**Phase B `audio_encode` block on RTMP / HLS / WebRTC outputs:**

```json
{
  "type": "rtmp",
  "id": "yt-rtmp",
  "dest_url": "rtmps://a.rtmps.youtube.com/live2",
  "stream_key": "...",
  "audio_encode": {
    "codec": "aac_lc",
    "bitrate_kbps": 96
  }
}
```

| Field | Allowed values |
|---|---|
| `audio_encode.codec` (RTMP) | `aac_lc`, `he_aac_v1`, `he_aac_v2` |
| `audio_encode.codec` (HLS)  | `aac_lc`, `he_aac_v1`, `he_aac_v2`, `mp2`, `ac3` |
| `audio_encode.codec` (WebRTC) | `opus` |
| `audio_encode.bitrate_kbps` | `16`..=`512` |
| `audio_encode.sample_rate` | `8000`, `16000`, `22050`, `24000`, `32000`, `44100`, `48000` |
| `audio_encode.channels` | `1`–`8` for `aac_lc`; `1`–`6` for `ac3`; `1`–`2` for `mp2` / `he_aac_v1`; exactly `2` for `he_aac_v2` (Parametric Stereo — libfdk_aac hard-rejects mono) |
| `audio_encode.source_audio_pid` | `0x0010`–`0x1FFE` — pin which audio ES of a multi-track program is re-encoded. Unset locks onto the first audio stream in the program's PMT |
| `audio_encode.silent_fallback` | boolean, default `false` — inject a continuous silent PCM track when the source carries no audio PID, or stops delivering audio mid-stream |
| `audio_encode.opus_vbr_mode` | `"vbr"` or `"cbr"` |
| `audio_encode.opus_fec` | boolean |
| `audio_encode.opus_dtx` | boolean |
| `audio_encode.opus_frame_duration_ms` | `5`, `10`, `20`, `40` or `60` |
| `audio_encode` on WebRTC + `video_only=true` | rejected (audio MID required in SDP) |

Any `opus_*` field on a non-Opus codec is **rejected at config load** rather than ignored, so a misplaced knob shows up as an error instead of silently running Opus defaults.

Encoding runs **in-process on any default build** — the AAC family (`aac_lc` / `he_aac_v1` / `he_aac_v2`) through the `fdk-aac` feature, and Opus / MP2 / AC-3 through `media-codecs` (libavcodec + libopus). No ffmpeg binary is required. The ffmpeg subprocess survives only as the fall-through when those default features are compiled out.

### Flow groups (essence bundles)

A flow group binds multiple per-essence flows into a single logical unit
sharing a PTP `clock_domain`. The schema lives at the top level of the
config:

```json
{
  "version": 2,
  "flow_groups": [
    {
      "id": "studio-a-program",
      "name": "Studio A program",
      "clock_domain": 0,
      "flow_ids": ["studio-a-stereo", "anc-flow"]
    }
  ]
}
```
