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
- [Flow Assembly (PID Bus — SPTS / MPTS from N inputs)](#flow-assembly-pid-bus--spts--mpts-from-n-inputs)
- [MPTS → SPTS filtering](#mpts--spts-filtering)
- [SMPTE 2022-1 FEC Configuration](#smpte-2022-1-fec-configuration)
- [SMPTE 2022-7 SRT Redundancy](#smpte-2022-7-srt-redundancy)
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
  "flows": [
    {
      "id": "main-feed",
      "name": "Main Program Feed",
      "enabled": true,
      "input": {
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
      },
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
      ]
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
| `setup_enabled` | boolean | No | `true` | When true, the browser-based setup wizard is accessible at `/setup`. Set to false to disable after provisioning. |
| `server` | object | Yes | - | API server configuration. |
| `monitor` | object | No | `null` | Web monitoring dashboard configuration. |
| `manager` | object | No | `null` | Manager WebSocket connection configuration. See [Manager Configuration](#manager-configuration). |
| `inputs` | array | No | `[]` | Top-level input definitions. Each has a stable `id` and `name` plus the type-tagged fields. See [Input Types](#input-types). |
| `outputs` | array | No | `[]` | Top-level output definitions. Same shape. See [Output Types](#output-types). |
| `flows` | array | No | `[]` | Flows, which reference inputs and outputs **by ID**. See [Flow Configuration](#flow-configuration). |
| `tunnels` | array | No | `[]` | List of IP tunnel configurations. See [Tunnel Configuration](#tunnel-configuration). |
| `resource_limits` | object | No | `null` | Host CPU / RAM thresholds that raise events when exceeded. See [Resource Limits](#resource-limits). |
| `tuning` | object | No | `null` | Node-wide defaults for ingress de-jitter and the startup hardware probes. See [Node Tuning](#node-tuning). |

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
| `auth` | object | No | `null` | OAuth 2.0 / JWT authentication configuration. When absent or `enabled: false`, all endpoints are open. |

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
| `enabled` | boolean | Yes | - | Master switch. When `false`, all endpoints are open. |
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
| `input_ids` | array | Yes | - | IDs of the inputs this flow uses. In a passthrough flow **at most one is active at a time**; the rest are standby, switched with a Take. In an assembled flow every member runs concurrently. |
| `output_ids` | array | Yes | - | IDs of the outputs this flow feeds. May be empty — an empty list makes this an *input-host* flow that owns its inputs and publishes them for sibling flows to consume. |
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

Each entry in the top-level `inputs` array carries an `id`, a `name`, and a `type` discriminator selecting the variant: `rtp`, `udp`, `srt`, `rist`, `rtmp`, `rtsp`, `webrtc`, `whep`, `media_player`, `test_pattern`, `bonded`, `replay`, or `sdi`.

### Fields shared across input types

| Field | Type | Default | Applies to | Description |
|-------|------|---------|-----------|-------------|
| `passthrough_clock` | boolean | `false` | TS-carrying inputs | Forward the source's PCR and PES timestamps **unchanged**. By default the edge regenerates them against its own master clock (encoder-style), which is what you want for a jittery or free-running source. Set `true` for relay / transparent-forwarder behaviour — and note it is **required** for [epoch lock](#epoch-lock-cross-node-alignment). |
| `ingress_dejitter_ms` | integer | `null` | RTP, UDP | De-jitter buffer depth, 20–2000 ms. Recovers the source rate from inter-PCR observations and releases packets paced at that rate, so analysers, the PCR PLL, the PID bus and every output see a smooth cadence regardless of network jitter. Cooperates with SMPTE 2022-7 — it runs after the merge. Unset falls back to the node-wide [`tuning.ingress_dejitter_ms`](#node-tuning); with that unset too, this input runs ingress passthrough. |
| `ingress_residence_ms` | integer | `max(4 × setpoint, 250)` | RTP, UDP | Hard-shed residence cap for this input's de-jitter buffer, `ingress_dejitter_ms + 40` – 5000 ms. A packet older than the cap is shed rather than released late, which is what bounds ingress latency when a burst or a source-rate offset outruns the servo's ±5 % authority. Unset falls back to the node-wide [`tuning.ingress_residence_ms`](#node-tuning). **Rejected at config load without `ingress_dejitter_ms` on the same input** — there is no buffer to cap, so accepting it would be a silent no-op. |
| `interface_binding` | object | `null` | Most inputs and outputs | Pin this endpoint to a specific NIC by name. Also honoured per-leg inside 2022-7 redundancy and per-endpoint inside SRT bonding. |

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

**Validation rules:**
- `bind_addr` must be a valid `ip:port` socket address.
- `interface_addr` must be a valid IP address in the same address family as `bind_addr`.

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
| `local_addr` | string | Yes | - | Local socket address to bind (`ip:port`). |
| `remote_addr` | string | Conditional | `null` | Remote address to connect to. Required for `caller` and `rendezvous` modes. |
| `latency_ms` | integer | No | `120` | SRT receive latency buffer in milliseconds. Higher values provide more resilience to network jitter at the cost of increased delay. |
| `passphrase` | string | No | `null` | AES encryption passphrase. Must be 10-79 characters. When `null`, encryption is disabled. |
| `aes_key_len` | integer | No | `16` | AES key length in bytes: `16` (AES-128), `24` (AES-192), or `32` (AES-256). Only meaningful if `passphrase` is set. |
| `crypto_mode` | string | No | `null` | Cipher mode: `"aes-ctr"` (default) or `"aes-gcm"` (authenticated encryption). AES-GCM requires libsrt >= 1.5.2 on the peer and only supports AES-128/256 (not AES-192). |
| `redundancy` | object | No | `null` | SMPTE 2022-7 redundancy configuration for a second SRT leg. See [SRT Redundancy](#smpte-2022-7-srt-redundancy). |

**Validation rules:**
- `local_addr` must be a valid socket address.
- `remote_addr` is required for `caller` and `rendezvous` modes and must be a valid socket address.
- `passphrase` must be 10-79 characters.
- `aes_key_len` must be 16, 24, or 32.
- `crypto_mode` must be `"aes-ctr"` or `"aes-gcm"`. AES-GCM with `aes_key_len` 24 is rejected.

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
| `av_sync_marker` | boolean | No | `false` | A/V-sync test mode (EBU R 49 / SMPTE 2-pop style). When `true`, the tone gates into a ~80 ms burst on the timecode second boundary and a luma flash patch appears next to the timecode on the same frames. Offset between audible pip and visible flash reads off directly as A/V skew. Requires `audio_enabled = true`. |
| `ts_packets_per_datagram` | integer | No | `7` | Number of 188-byte MPEG-TS packets bundled into each UDP datagram on the flow's broadcast channel and the QUIC/UDP tunnel path (both forward each datagram unchanged). Range 1–348 (348 × 188 = 65424 B, the largest that fits one UDP datagram). Default `7` → 7 × 188 = 1316 B, the standard / SRT datagram size. Lower it (e.g. 4–5) for a constrained / low-MTU internet or cellular path where a big datagram IP-fragments and drops; raise it (8+) to test jumbo datagrams on a LAN. Independent of any downstream UDP/RTP/SRT output, which re-chunk to their own fixed 1316 B wire size. |

Requires the edge build to include the `media-codecs` and `fdk-aac` features (both on by default).

### Bonded Input

Receives a media flow over the bilbycast multi-path bonding stack — the protocol that replaces appliances like Peplink/SpeedFusion with a media-aware bonded transport. Multiple network paths are aggregated for throughput and failover; per-packet sequencing reorders into a single ordered stream at this end.

```json
{
  "type": "bonded",
  "id": "in-bonded",
  "name": "Bonded receive",
  "local_addr": "0.0.0.0:5500",
  "encryption_key": "<32-byte hex>"
}
```

The full Bonded protocol — path adapters, link selection, latency budgets — is covered in [Bonding](/edge/bonding/). The fields on the input config track the protocol's configuration knobs; the bonded sender at the other end uses the matching [Bonded Output](#bonded-output).

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
| `video_encode` | object | Yes | — | Mandatory H.264/HEVC encoder block. `chroma` must be `yuv420p` or `yuv422p`, `bit_depth` `8` (a constraint of the 8-bit 4:2:2 capture format); every backend is reachable, including `h264_auto` / `hevc_auto`. |
| `audio_encode` | object | No | AAC-LC | AAC family only (`aac_lc` / `he_aac_v1` / `he_aac_v2`). Unset gives an AAC-LC default. |

Signal loss does **not** stop the stream — the card keeps delivering frames (bars/black) with the cable out and the edge keeps encoding them, so bitrate and `state` read healthy on a dead feed; `InputStats.sdi_stats.signal_present` is the honest indicator. Build prereqs, per-port health payload, and event catalogue: `bilbycast-edge/docs/sdi.md`.

---

## Output Types

Each output has a `type` discriminator. All outputs share `id` and `name` fields.

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
| `local_addr` | string | Yes | - | Local socket address to bind. Use `"0.0.0.0:0"` for caller mode (ephemeral port). |
| `remote_addr` | string | Conditional | `null` | Remote address. Required for `caller` and `rendezvous`. |
| `latency_ms` | integer | No | `120` | SRT send latency in milliseconds. |
| `passphrase` | string | No | `null` | AES encryption passphrase (10-79 characters). |
| `aes_key_len` | integer | No | `16` | AES key length: 16, 24, or 32. |
| `crypto_mode` | string | No | `null` | Cipher mode: `"aes-ctr"` (default) or `"aes-gcm"`. |
| `redundancy` | object | No | `null` | SMPTE 2022-7 redundancy for a second SRT output leg. |
| `program_number` | integer | No | `null` | MPTS → SPTS program filter. `null` = full MPTS passthrough; `Some(N)` = forward only program N as a rewritten single-program TS. Applied once and mirrored to both legs when 2022-7 is enabled. Must be `> 0`. See [MPTS → SPTS filtering](#mpts--spts-filtering). |

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

**LL-CMAF — HLS-only, FairPlay CBCS encryption:**

```json
{
  "type": "cmaf",
  "id": "ll-ios",
  "name": "Low-latency iOS",
  "ingest_url": "https://ll.cdn.example.com/live/ios",
  "low_latency": true,
  "chunk_duration_ms": 333,
  "segment_duration_secs": 2.0,
  "manifests": ["hls"],
  "encryption": {
    "scheme": "cbcs",
    "key_id": "0123456789abcdef0123456789abcdef",
    "key": "fedcba9876543210fedcba9876543210"
  }
}
```

**DASH-only — HEVC re-encode at 5 Mbps, ClearKey CENC + Widevine PSSH passthrough:**

```json
{
  "type": "cmaf",
  "id": "uhd-dash",
  "name": "UHD DASH egress",
  "ingest_url": "https://ingest.cdn.example.com/live/uhd",
  "segment_duration_secs": 4.0,
  "manifests": ["dash"],
  "video_encode": { "codec": "x265", "bitrate_kbps": 5000, "preset": "medium", "profile": "main10" },
  "audio_encode": { "codec": "he_aac_v1", "bitrate_kbps": 64 },
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
| `low_latency` | boolean | No | `false` | `false` = standard CMAF (whole-segment PUT). `true` = LL-CMAF (chunked-transfer PUT + `#EXT-X-PART` in HLS and `availabilityTimeOffset` in DASH). |
| `chunk_duration_ms` | integer | No | `500` | Sub-segment chunk cadence for LL-CMAF. Range 100-2000. Only meaningful when `low_latency = true`; ignored otherwise. |
| `manifests` | array&lt;string&gt; | No | `["hls", "dash"]` | Which manifests to publish. Non-empty subset of `["hls", "dash"]`. Use `["hls"]` for Apple-only, `["dash"]` for Widevine/PlayReady-centric CDNs, both for maximum reach. |
| `encryption` | object | No | `null` | ClearKey CENC encryption block — see below. Omit for clear (unencrypted) output. |
| `audio_encode` | object | No | `null` | Optional AAC re-encode (codec: `aac_lc`, `he_aac_v1`, `he_aac_v2`). Omit for AAC passthrough. MP2/AC-3/Opus are rejected — CMAF audio is AAC-family only. |
| `transcode` | object | No | `null` | Optional PCM channel-shuffle / sample-rate / bit-depth conversion, sits between the AAC decoder and the target encoder. Only effective when `audio_encode` is set; rejected at validation otherwise. |
| `video_encode` | object | No | `null` | Optional re-encode (same schema as ST 2110 video inputs: `x264`, `x265`, `h264_nvenc`, `hevc_nvenc`). HEVC (`x265`, `hevc_nvenc`) requires `manifests: ["dash"]` — HLS fMP4 HEVC client support is inconsistent. Omit for passthrough. |
| `program_number` | integer | No | `null` | MPTS → SPTS program filter. `null` = source must already be SPTS (CMAF is inherently single-program). `Some(N)` = filter to program N before segmenting. Must be `> 0`. |

**Encryption block (`encryption`):**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `scheme` | string | Yes | - | `"cenc"` (AES-CTR — Widevine/PlayReady standard, pairs with DASH) or `"cbcs"` (AES-CBC with 1:9 pattern — FairPlay / Apple standard, pairs with HLS). |
| `key_id` | string | Yes | - | Key identifier. Exactly 32 hex characters (16 bytes). |
| `key` | string | Yes | - | AES-128 content key. Exactly 32 hex characters (16 bytes). |
| `pssh_boxes` | array&lt;string&gt; | No | `[]` | Pre-built Widevine / PlayReady / FairPlay `pssh` boxes for commercial DRM passthrough. Each entry is a hex-encoded `pssh` ISO-BMFF box (32-4096 bytes, fourcc `pssh` at bytes 4-7). The edge copies each entry verbatim into the init segment's `moov` alongside the ClearKey `pssh` box it emits automatically. |

**How encryption works on the wire:**
- CMAF uses ISO/IEC 23001-7 Common Encryption with subsample encryption: video NAL prefixes and parameter sets stay in the clear (~first 32 bytes per NAL), the rest is encrypted under the chosen scheme.
- Each segment carries `senc` (sample encryption), `saio` (sample auxiliary info offsets), `saiz` (sample auxiliary info sizes), and `tenc` (track encryption) boxes.
- The init segment's `moov` carries one or more `pssh` boxes — the edge-emitted ClearKey `pssh` plus any operator-supplied commercial-DRM boxes.
- Commercial DRM license servers (Widevine, PlayReady, FairPlay) are operator-managed; bilbycast does not proxy license requests.

**Limitations:**
- Output only. Players are browsers, iOS/tvOS/Android apps, smart TVs, STBs — the edge does not ingest CMAF.
- HEVC (`x265`, `hevc_nvenc`) on HLS is rejected client-side by many Apple devices. The edge does not reject the combination — operators who need HEVC should emit `manifests: ["dash"]`.
- `transcode` requires `audio_encode`; rejected at validation when set alone.

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
| `audio_encode` | object | No | `null` | Optional Phase B `audio_encode` block (codec: `opus`). When absent, Opus sources are carried natively and **AAC sources automatically fall back to video-only** because WebRTC does not carry AAC. When present, the input AAC is decoded via the Phase A `engine::audio_decode::AacDecoder` (FDK AAC by default, supporting AAC-LC/HE-AAC v1/v2/multichannel) and re-encoded as Opus via the `engine::audio_encode::AudioEncoder` (ffmpeg subprocess for Opus) — see [Audio Gateway — `audio_encode`](/edge/audio-gateway/#the-audio_encode-block--compressed-audio-egress-rtmp--hls--webrtc). |

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
| `resolution` | string | No | `null` | `"auto"` or `"WIDTHxHEIGHT"` (e.g. `"1920x1080"`). |
| `refresh_hz` | integer | No | `null` | Refresh rate in Hz. Range 1–240. `null` uses the connector's preferred mode. |
| `sync_mode` | string | No | `"vsync_to_display"` | v1 only accepts `"vsync_to_display"`. |

Connectors are enumerated at edge startup and surfaced in `HealthPayload.display_devices` — the manager UI populates the **Device** dropdown from this list. HDMI hotplug discovery is startup-only in v1; new cables require restarting the edge.

Full reference, including A/V sync, supported codecs, capacity budget, and the `display_*` event catalogue: [Display Output](/edge/display/).

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
  "remote_addr": "203.0.113.10:5500",
  "encryption_key": "<32-byte hex>",
  "path_mtu": 1000
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
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
  "id": "mpts-flow",
  "name": "Dual-program feed",
  "thumbnail_program_number": 1,
  "input": { "type": "udp", "bind_addr": "0.0.0.0:5020" },
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
  ]
}
```

The archive receives the full MPTS. The `prog1-viewer` UDP output sends only program 1 as a rewritten SPTS (PAT lists one entry, program 1's PMT + ES PIDs). The RTMP output publishes program 2's elementary streams. The manager UI thumbnail shows a frame from program 1.

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
  -b, --bind <ADDRESS>         Override API listen address
      --monitor-port <PORT>    Override monitor dashboard port
  -l, --log-level <LEVEL>      Log level: trace, debug, info, warn, error [default: info]
  -h, --help                   Print help
  -V, --version                Print version
```

| Argument | Config field overridden | Example |
|----------|----------------------|---------|
| `--port` | `server.listen_port` | `--port 9443` |
| `--bind` | `server.listen_addr` | `--bind 127.0.0.1` |
| `--monitor-port` | `monitor.listen_port` | `--monitor-port 9091` |
| `--log-level` | (runtime only, not in config) | `--log-level debug` |

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
  "version": 1,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "flows": []
}
```

### Reloading from disk

Use `POST /api/v1/config/reload` to re-read both `config.json` and `secrets.json` from disk. This is useful after manual edits or after deploying new config files via external tooling (e.g., Ansible, Chef).

---

## Common Configuration Scenarios

### Minimal: RTP receive and forward (no auth)

```json
{
  "version": 1,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "flows": [
    {
      "id": "passthrough",
      "name": "RTP Passthrough",
      "enabled": true,
      "input": {
        "type": "rtp",
        "bind_addr": "0.0.0.0:5000"
      },
      "outputs": [
        {
          "type": "rtp",
          "id": "out-1",
          "name": "Forwarded Output",
          "dest_addr": "192.168.1.50:5004"
        }
      ]
    }
  ]
}
```

### Multicast receive with FEC and trust boundary filters

```json
{
  "version": 1,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "flows": [
    {
      "id": "multicast-feed",
      "name": "Multicast with FEC and Trust Boundary",
      "enabled": true,
      "input": {
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
      },
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
      ]
    }
  ]
}
```

### SRT bidirectional with 2022-7 redundancy

```json
{
  "version": 1,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "flows": [
    {
      "id": "srt-redundant",
      "name": "SRT with Hitless Redundancy",
      "enabled": true,
      "input": {
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
      },
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
      ]
    }
  ]
}
```

### Multi-output: RTP to SRT, RTMP, and HLS simultaneously

```json
{
  "version": 1,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "flows": [
    {
      "id": "multi-output",
      "name": "Multi-Output Fan-Out",
      "enabled": true,
      "input": {
        "type": "rtp",
        "bind_addr": "239.1.1.1:5000",
        "interface_addr": "192.168.1.100"
      },
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
      ]
    }
  ]
}
```

### Full production config with TLS + auth + monitoring

```json
{
  "version": 1,
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
  "flows": [
    {
      "id": "main-feed",
      "name": "Main Program Feed",
      "enabled": true,
      "input": {
        "type": "rtp",
        "bind_addr": "239.1.1.1:5000",
        "interface_addr": "10.0.0.100",
        "fec_decode": {
          "columns": 10,
          "rows": 10
        }
      },
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
      ]
    }
  ]
}
```

### IPv6 multicast configuration

```json
{
  "version": 1,
  "server": {
    "listen_addr": "0.0.0.0",
    "listen_port": 8080
  },
  "flows": [
    {
      "id": "ipv6-mcast",
      "name": "IPv6 Multicast Flow",
      "enabled": true,
      "input": {
        "type": "rtp",
        "bind_addr": "[ff7e::1]:5000",
        "interface_addr": "::1"
      },
      "outputs": [
        {
          "type": "rtp",
          "id": "ipv6-out",
          "name": "IPv6 Output",
          "dest_addr": "[ff7e::2]:5004",
          "interface_addr": "::1"
        }
      ]
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
  "id": "studio-a-stereo",
  "name": "Studio A — stereo",
  "enabled": true,
  "clock_domain": 0,
  "input": {
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
  },
  "outputs": []
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
  "id": "anc-flow",
  "name": "ANC (timecode + SCTE-104)",
  "enabled": true,
  "clock_domain": 0,
  "input": {
    "type": "st2110_40",
    "bind_addr": "239.0.0.20:5000",
    "payload_type": 100
  },
  "outputs": [
    {
      "type": "st2110_40",
      "id": "anc-out",
      "name": "ANC loopback",
      "dest_addr": "239.2.0.20:5000",
      "dscp": 46,
      "payload_type": 100
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
  "id": "studio-a-video",
  "name": "Studio A — video",
  "enabled": true,
  "clock_domain": 0,
  "input": {
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
  },
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
| `video_encode` | object | Yes (input only) | Mandatory H.264/HEVC encoder block for the ingress encode stage. Same schema as the transcode `video_encode`. A `video-encoder-*` backend must be compiled in. |
| `redundancy` | object | No | SMPTE 2022-7 Red/Blue dual-network operation. |

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
| `audio_encode.channels` | `1` or `2` |
| `audio_encode` on WebRTC + `video_only=true` | rejected (audio MID required in SDP) |

Requires `ffmpeg` in `PATH` at runtime — outputs without `audio_encode` keep working without ffmpeg installed. RTMP and WebRTC run one persistent ffmpeg per encoded output; HLS forks ffmpeg per segment.

### Flow groups (essence bundles)

A flow group binds multiple per-essence flows into a single logical unit
sharing a PTP `clock_domain`. The schema lives at the top level of the
config:

```json
{
  "version": 1,
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
