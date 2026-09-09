---
title: Install the Relay
description: Download, install, and run bilbycast-relay.
sidebar:
  order: 2
---

In its forwarding role the relay is a stateless QUIC forwarder for NAT traversal between edges. It carries opaque ciphertext only — relay operators can't see your media. **You only need a relay if your edge sites can't reach each other directly** (different ASNs, double-NAT, restrictive firewalls). Two edges on the same LAN, or edges connected over a site-to-site VPN, don't need it. The optional [viewer-distribution](/relay/viewer-distribution/) role is a second, **stateful** subsystem living in the same binary — see [Forwarder or distribution build?](#forwarder-or-distribution-build) below, because it changes what you firewall, restart and load-balance.

## What you'll need

- A Linux host on a public IP, or behind a static port-forward of UDP 4433. Can share a box with the manager — the relay installs alongside under its own paths (`/opt/bilbycast/relay/`, `/etc/bilbycast/`, `/var/lib/bilbycast/relay/`) and its own `bilbycast-relay` service user, so the two coexist cleanly.
- About 5 minutes.

The relay is statically linked against musl, has no runtime dependencies, and runs on `x86_64` and `aarch64`.

## Forwarder or distribution build?

Every release publishes **two artefacts per architecture**, and which one you install decides what the relay can do — and how you operate it:

| Artefact | What it is | State |
|---|---|---|
| `bilbycast-relay-<arch>-linux` | The lean **opaque forwarder**. QUIC tunnels, the native-UDP carrier, bond legs. | Stateless. |
| `bilbycast-relay-<arch>-linux-distribution` | The forwarder **plus** the [viewer-distribution](/relay/viewer-distribution/) role — WHEP SFU, LL-HLS/CMAF origin, DVR, and the `bilbycast-portal` binary inside the tarball. | **Stateful** (see below). |

The release installer ([below](#the-one-shot-installer)) installs the **`distribution`** artefact by default; pass `--variant default` for the lean forwarder. The bare `bilbycast-relay-<arch>-linux` download in [step 1](#1-download) is the **lean** build — it has no WHEP, no origin and no DVR. Handed a `distribution` block anyway, it logs a startup warning naming the feature it was built without, and it never advertises the `viewer-distribution` capability, so the manager hides that surface for the node.

### A distribution relay is stateful

The distribution role is not a pass-through. It keeps state in two places, and neither is shared with a sibling relay:

- **On disk** — the LL-HLS/CMAF origin writes segments under `distribution.origin_storage_dir` (default `/var/lib/bilbycast/relay/origin`). The relay creates that directory at startup, marks it with a `.bilbycast-origin` file, and on restart **adopts** what is already there rather than wiping it, so the DVR window survives a bounce. It also refuses a non-empty directory that carries no marker — give the origin a directory of its own.
- **In memory** — one WHEP session per viewer, each with its own DTLS/SRTP keys and pinned ICE candidate, plus a per-source-IP viewer cap. None of it survives a restart: a distribution relay bounce drops every connected viewer, who must reload.

The operational consequence is that a stream's DVR window and its WHEP sessions live on **one specific relay**. Round-robin load balancing across a pool serves those viewers 404s and dead WebRTC offers, so viewer traffic needs sticky routing to the relay that is actually ingesting the stream. Forwarder traffic on 4433/4434 is unaffected — that half really is interchangeable.

## Ports & firewall

A forwarder relay listens on three ports; a `-distribution` build binds two more:

| Port | Protocol | Source | Purpose |
|------|----------|--------|---------|
| **4433** | UDP (QUIC / TLS 1.3) | Every edge that pairs through this relay | QUIC tunnel data plane. Override with `--quic-addr`. |
| **4434** | UDP (plain) | Every edge using a native SRT/RIST or bond-leg tunnel through this relay | Native-UDP carrier data plane (on by default). Override with `--udp-relay-addrs`; disable with `--no-udp-relay`. |
| **4480** | TCP (HTTP) | Manager host, your monitoring host | REST stats + `/health`. Optional — close it if you don't query stats remotely. Override with `--api-addr`. |
| **4485** | TCP (HTTP) | Browser viewers, via your TLS terminator | `-distribution` builds only. WHEP/WHIP signalling, the `/watch` + `/dvr` player pages, the `/origin` LL-HLS/CMAF surface and `/distribution/health`. Not covered by `api_token` — see [Relay security, layer 6](/relay/security/). Override with `distribution.http_addrs`. |
| **4486** | UDP (QUIC) | Edges publishing viewer streams to this relay | `-distribution` builds only. Elementary-stream ingest. Override with `distribution.ingest_addrs`. |

If you only use QUIC tunnels you can leave 4434 closed (or pass `--no-udp-relay`). Open it whenever edges carry native SRT/RIST or bond legs over this relay — a native-UDP-carrier bind failure is non-fatal (the relay logs it and continues QUIC-only).

4485 and 4486 are bound on both address families **by default** on a `-distribution` binary — which is what the [installer](#the-one-shot-installer) fits unless you pass `--variant default` — because `distribution.enabled` defaults to `true`. The only way to close them on that build is `"distribution": { "enabled": false }` in `relay.json`. Front 4485 with a TLS-terminating reverse proxy: browsers refuse WebRTC and playback from a non-secure origin. The optional `bilbycast-portal` binds loopback (`127.0.0.1:8088`) and needs no firewall rule of its own — put it behind the same proxy.

The relay itself connects **outbound** to the manager on TCP 8443 (`wss://`), so no inbound port is needed for control. If you front the relay with a load balancer (multiple relay instances for HA), the LB needs UDP/QUIC pass-through on 4433 — not TLS termination, since QUIC carries its own TLS 1.3.

### Bind address vs advertised address

QUIC binds on `0.0.0.0:4433` (every interface) by default — that's what the relay **listens** on. Remote edges need a different value: the **public address they dial** to reach you. These two are distinct any time the relay sits behind NAT, a cloud-instance public-IP mapping, or a load balancer:

- **Bind address** (`quic_addr` / `quic_addrs`, and `udp_relay_addrs` for the native-UDP carrier) — the listen sockets. `0.0.0.0:4433` / `0.0.0.0:4434` are correct for most installs.
- **Advertised address** (`public_quic_addr`, plus `public_udp_addr` for the native-UDP carrier) — what edges connect to. Set this to a hostname or IP edges can actually reach. The manager reads it from health and pre-populates the tunnel-creation dropdown. Without it, the manager can't auto-fill a usable relay address for tunnel configs and the relay shows as disabled in the dropdown.

Prefer a DNS name when you have one (`relay.example.com:4433`). It survives Lightsail static-IP releases, cloud instance migrations, and lets you front a pool of relays behind one record. Edges resolve the name on every connect attempt, so an IP change behind the record is picked up automatically without a tunnel reconfig. Falls back to a raw IP literal cleanly when DNS isn't an option (`54.1.2.3:4433`, `[2001:db8::1]:4433`).

Full network map: [Deployment overview](/getting-started/deployment/).

## The one-shot installer

Everything in steps 1–4 below is also available as a single signed script published with each release. It downloads and cosign-verifies `manifest.json`, pulls the matching arch + variant tarball and checks its SHA-256 against the verified manifest, creates the `bilbycast-relay` system user, installs the binary at `/opt/bilbycast/relay/bilbycast-relay`, writes `/etc/bilbycast/relay.json`, installs the **hardened** systemd unit, and polls `/health` for up to 60 s before declaring success:

```bash
curl -fsSL https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/install-relay.sh \
  | sudo bash -s -- \
      --manager wss://manager.example.com:8443/ws/node \
      --registration-token <token-from-manager-ui> \
      --api-token <32-128-char-secret> \
      --require-bind-auth
```

Other flags: `--quic-addr`, `--api-addr`, `--channel` (`stable` | `nightly` | `beta`), `--variant` (`distribution` | `default`), `--with-portal <manager-base-url>`, `--player-origin <relay-origin>`, and `--upgrade-installer` (refresh the unit + script, leave config untouched). With no flags at all it installs a standalone relay with defaults.

**It installs the `distribution` artefact unless you pass `--variant default`** — see [Forwarder or distribution build?](#forwarder-or-distribution-build) above for what that binds and what it stores.

The numbered steps that follow are the manual equivalent, for operators who want to place each piece by hand.

## 1. Download

```bash
curl -fsSL -O https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/bilbycast-relay-$(uname -m)-linux
curl -fsSL -O https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/bilbycast-relay-$(uname -m)-linux.sha256
sha256sum -c bilbycast-relay-$(uname -m)-linux.sha256

# Rename to bilbycast-relay so subsequent commands are arch-agnostic
mv bilbycast-relay-$(uname -m)-linux bilbycast-relay
chmod +x bilbycast-relay
```

You should see `bilbycast-relay-x86_64-linux: OK` (or `aarch64`). The rename keeps the rest of this page concise; the canonical name is what the `.sha256` file expects, so we verify under that name before moving.

That asset is the **lean forwarder**. If you want [viewer distribution](/relay/viewer-distribution/) — WHEP, LL-HLS/CMAF origin, DVR — swap `bilbycast-relay-$(uname -m)-linux` for `bilbycast-relay-$(uname -m)-linux-distribution` everywhere it appears in that block: both `curl` lines, the `sha256sum -c` and the `mv` (or use the [installer](#the-one-shot-installer), which fits that variant by default). The `bilbycast-portal` binary ships only inside the distribution **tarball**, not next to the bare binary.

### Verify the Sigstore signature (optional)

Every release ships a Sigstore-signed `manifest.json` alongside the bare binaries. The `sha256sum -c` step above catches mid-transfer corruption; verifying the signature additionally proves the manifest was published by the Bilbycast release workflow on a tagged commit.

Install [cosign](https://github.com/sigstore/cosign) — on Ubuntu / Debian the simplest path is the upstream static binary with SHA-256 verification:

```bash
COSIGN_VERSION=v2.4.1
case "$(uname -m)" in
    x86_64)  COSIGN_ARCH=amd64 ;;
    aarch64) COSIGN_ARCH=arm64 ;;
    *) echo "Unsupported architecture: $(uname -m)"; exit 1 ;;
esac
COSIGN_ASSET="cosign-linux-${COSIGN_ARCH}"
curl -fsSL -o /tmp/cosign \
  "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/${COSIGN_ASSET}"
expected="$(curl -fsSL "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign_checksums.txt" | awk -v a="${COSIGN_ASSET}" '$2 == a {print $1}')"
got="$(sha256sum /tmp/cosign | awk '{print $1}')"
[[ -n "${expected}" && "${got}" == "${expected}" ]] || { echo "cosign checksum mismatch"; exit 1; }
sudo install -m 0755 /tmp/cosign /usr/local/bin/cosign && rm /tmp/cosign
```

Then verify the manifest:

```bash
curl -fsSL -O https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/manifest.json
curl -fsSL -O https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/manifest.sig.bundle

cosign verify-blob \
  --bundle manifest.sig.bundle \
  --certificate-identity-regexp 'https://github.com/Bilbycast/bilbycast-relay/.github/workflows/nightly-release.yml@refs/tags/v.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  manifest.json
```

A successful verify prints `Verified OK`. The same Sigstore-signed manifest drives the [upgrade flow](#upgrading) below, so this is the verifier's main checkpoint.

## 2. Standalone (zero config)

The simplest deployment — useful for testing or when you don't need the relay reporting back to the manager:

```bash
./bilbycast-relay
```

Defaults: QUIC on `0.0.0.0:4433`, REST on `0.0.0.0:4480`. Override with `--quic-addr` or `--api-addr`. Ctrl-C to stop.

## 3. Attached to the manager (recommended)

In the manager UI:

1. Go to **Admin → Nodes**, click **+ Add Node**, pick device type **Relay**.
2. Copy the one-shot registration token.

Next to the relay binary, write `relay.json` (replace `REPLACE_WITH_YOUR_MANAGER_HOSTNAME`, `REPLACE_WITH_YOUR_RELAY_HOSTNAME`, and `<token-from-manager>` with the real values — don't paste this verbatim):

```json
{
  "quic_addr": "0.0.0.0:4433",
  "api_addr": "0.0.0.0:4480",
  "public_quic_addr": "REPLACE_WITH_YOUR_RELAY_HOSTNAME:4433",
  "require_bind_auth": true,
  "manager": {
    "enabled": true,
    "urls": [
      "wss://REPLACE_WITH_YOUR_MANAGER_HOSTNAME:8443/ws/node"
    ],
    "registration_token": "<token-from-manager>"
  }
}
```

`public_quic_addr` is the address edges will dial — see [Bind address vs advertised address](#bind-address-vs-advertised-address) above. Prefer a DNS name (e.g. `relay.example.com:4433`) over a raw IP. If the relay shares a host with the manager (typical for small deployments on a single cloud instance), neither the manager nor the relay can discover this from the WS connection alone — you have to set it explicitly. Unspecified values (`0.0.0.0:4433`, `[::]:4433`) are rejected at config load.

`urls` is an array (1-16 entries, each must be `wss://`). For a single manager that's one entry; for an HA-paired manager cluster you'd list both hostnames — the relay tries them in order and rotates on WebSocket close with a 5-second backoff.

Launch:

```bash
./bilbycast-relay --config relay.json
```

For a self-signed manager cert (only relevant if you skipped ACME / Let's Encrypt on the manager), add `"accept_self_signed_cert": true` inside the `manager` block **and** export `BILBYCAST_ALLOW_INSECURE=1` before launching. The env var is a deliberate safety guard.

On first connect the relay swaps the registration token for a permanent `node_id` + `node_secret`, **rewrites `relay.json` in place** with those values (removing the now-spent registration token), and reconnects automatically going forward. Registration isn't the only rewrite — the relay re-writes the file whenever the manager changes something that has to survive a restart:

- **Registration** — `node_id` + `node_secret` in, spent `registration_token` out.
- **`rotate_secret`** — the manager replaces `manager.node_secret` in place.
- **A [viewer-distribution](/relay/viewer-distribution/) push** — `distribution.enabled`, the token secret, the three token gates (`require_viewer_token` / `require_origin_token` / `require_ingest_token`), `public_ip`, `public_base_url`, `portal_url`, cascade sources, and the node-wide origin storage policy. Per-stream overrides deliberately do **not** persist; they belong to a session.

Don't be surprised when your `relay.json` looks different after the first boot — that's the persistence working as intended, and it's why you configure distribution from the manager rather than by hand. The file's runtime user (`bilbycast-relay` on the systemd install in step 4) must be able to write it; step 4 sets the ownership accordingly.

## 4. systemd service

For production, run the relay as a systemd service. This is the unit the release tarball ships and [the installer](#the-one-shot-installer) fits — reproduce it at `/etc/systemd/system/bilbycast-relay.service` if you're placing things by hand:

```ini
[Unit]
Description=bilbycast-relay stateless QUIC relay
Documentation=https://bilbycast.com/docs
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bilbycast-relay
Group=bilbycast-relay
WorkingDirectory=/var/lib/bilbycast/relay
ExecStart=/opt/bilbycast/relay/bilbycast-relay --config /etc/bilbycast/relay.json

Restart=always
RestartSec=3
# Crash-loop ceiling — pairs with the upgrade script's health probe so a bad
# upgrade gets rolled back instead of respawning forever.
StartLimitInterval=300
StartLimitBurst=10
KillSignal=SIGTERM
TimeoutStopSec=10

# Hardening. ProtectSystem=strict makes the whole filesystem read-only, so the
# two paths the relay genuinely writes have to be named: /etc/bilbycast for the
# relay.json rewrites described above, /var/lib/bilbycast/relay for the
# distribution origin store.
ProtectSystem=strict
ReadWritePaths=/etc/bilbycast /var/lib/bilbycast/relay
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
RestrictNamespaces=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=false
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources

LimitNOFILE=65536
EnvironmentFile=-/etc/bilbycast/relay.env

[Install]
WantedBy=multi-user.target
```

Then:

```bash
# Dedicated service account — deliberately NOT the shared `bilbycast` user the
# edge and manager use, so services on one host keep separate permissions.
sudo useradd -r -s /usr/sbin/nologin -d /var/lib/bilbycast/relay bilbycast-relay || true
sudo mkdir -p /opt/bilbycast/relay /var/lib/bilbycast/relay /etc/bilbycast
sudo install -m 0755 -o bilbycast-relay -g bilbycast-relay bilbycast-relay /opt/bilbycast/relay/
sudo chown bilbycast-relay:bilbycast-relay /var/lib/bilbycast/relay
# relay.json: bilbycast-relay OWNS it (not root) — the relay rewrites this file
# on first connect to swap the registration_token for the permanent node_id +
# node_secret, and again on a rotate_secret or a distribution push. Root-owned
# 0640 would block those writes and you'd be stuck on next restart with a spent
# registration token.
sudo install -m 0640 -o bilbycast-relay -g bilbycast-relay relay.json /etc/bilbycast/relay.json
# Optional: RUST_LOG and friends, read by EnvironmentFile= above.
printf 'RUST_LOG=bilbycast_relay=info\n' | sudo tee /etc/bilbycast/relay.env > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now bilbycast-relay
sudo systemctl status bilbycast-relay --no-pager
```

Expected: `active (running)`. Logs: `sudo journalctl -u bilbycast-relay -f`.

`/var/lib/bilbycast/relay` isn't optional decoration on a `-distribution` build: it's where the origin store lives, and `OriginStore` calls `create_dir_all` on it at startup — an unprivileged service user with no such directory, or `ProtectSystem=strict` without the matching `ReadWritePaths`, fails there. A lean forwarder never writes it, so the directory costs nothing on that build either.

### Co-existing with the manager on the same box

If this box also runs the manager, the two installs occupy separate trees so they don't collide:

| | Manager | Relay |
|---|---|---|
| Binary | `/opt/bilbycast-manager/bilbycast-manager` | `/opt/bilbycast/relay/bilbycast-relay` |
| Config + secrets | `/etc/bilbycast-manager/manager.env` | `/etc/bilbycast/relay.json` |
| State | — | `/var/lib/bilbycast/relay` (distribution origin store) |
| Systemd unit | `bilbycast-manager.service` | `bilbycast-relay.service` |
| Service user | `bilbycast` | `bilbycast-relay` |

The relay runs as its own `bilbycast-relay` account rather than sharing the `bilbycast` user — a deliberate split so the relay's hardened unit can be granted exactly two writable paths without handing it anything else on the box.

## Structured logging (SIEM export)

Optional top-level `logging` block in `relay.json`. When a `json_target` is set, every operational event the relay emits — the same events catalogued in [Relay events and alarms](/relay/events-and-alarms/) — is additionally written as one JSON line to the chosen sink, so a Splunk / Skyline DataMiner / Loki / syslog stack picks the relay up without polling the manager. It is purely additive: the manager push and the Prometheus surface are unaffected.

```json
{
  "logging": {
    "json_target": {
      "kind": "file",
      "path": "/var/log/bilbycast/relay-events.jsonl",
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
| `json_target.format` | string | No | `"raw"` | Envelope shape, on all three variants. `"raw"` — generic single-line JSON. `"splunk"` — wraps the envelope in a top-level `{"event": ...}` object for a Splunk HTTP Event Collector. `"dataminer"` — Skyline DataMiner field renames. |
| `json_target.path` | string | `file` only | - | Absolute path to the active log file. 1–4096 characters, no NUL bytes. The parent directory is created best-effort at startup. |
| `json_target.max_size_mb` | integer | No | `64` | `file` only. Rotate when the active file exceeds this size. Range 1–4096. Backups are `<path>.1` (most recent) … `<path>.N`. |
| `json_target.max_backups` | integer | No | `5` | `file` only. Rotated backups retained; the oldest beyond this is dropped. Range 0–100. |
| `json_target.addr` | string | `syslog` only | - | Syslog destination as `ip:port`, e.g. `"127.0.0.1:514"` — parsed as a socket address, so a DNS name is refused. RFC 5424 over **UDP**, fire-and-forget — a black-holed collector never blocks the relay. |

The schema is identical to the edge's, so one SIEM pickup config ingests both unchanged. Under the hardened unit above, a `file` target needs its directory added to `ReadWritePaths` — `ProtectSystem=strict` makes `/var/log` read-only otherwise.

## Upgrading

The relay ships an operator-run upgrade script. It downloads the latest signed `manifest.json` + `manifest.sig.bundle`, verifies the Sigstore signature against the publishing workflow's identity (auto-installing cosign with checksum verification if it isn't already on the host), pulls the tarball matching this host's architecture (x86_64 / aarch64) and installed variant, verifies SHA-256 against the signed manifest, atomically swaps the binary with a `.previous` backup, restarts the systemd unit, polls `/health`, and **auto-rolls back** to the previous binary on a failed health probe.

The simplest path is curl-pipe-bash from the latest release:

```bash
curl -fsSL https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/upgrade-relay.sh \
    | sudo bash
```

Operators who'd rather review the script first can grab it once and re-run it as needed:

```bash
curl -fsSL -o upgrade-relay.sh \
    https://github.com/Bilbycast/bilbycast-relay/releases/latest/download/upgrade-relay.sh
chmod +x upgrade-relay.sh
sudo ./upgrade-relay.sh                         # apply latest stable
sudo ./upgrade-relay.sh --dry-run               # download + verify only; print plan
sudo ./upgrade-relay.sh --target-version 0.7.0  # pin to a specific tag
```

The opaque forwarder is stateless — a restart drops connected edges, which all reconnect automatically. For zero-disruption forwarder upgrades, run multiple relay instances behind a load balancer and roll through them one at a time. That does nothing for viewers on a `-distribution` relay: their WHEP sessions end with the process and they have to reload (the on-disk DVR window is adopted back on start, so the playable depth survives the bounce). Pass `--help` for every flag, including `--service`, `--binary-path`, `--health-url`, `--health-timeout`, `--no-rollback`, `--no-verify-cosign` (for air-gapped boxes that can't install cosign), `--channel` (`stable` | `nightly` | `beta`) and `--variant` (`auto` | `distribution` | `default`).

`--variant` defaults to `auto`, which inspects the installed binary and keeps the relay on the build it is already running — so an upgrade can't silently swap a distribution relay for the lean forwarder and take its viewers off air. Name a variant explicitly only when you actually want to move between the two.

The script **requires** the systemd unit from step 4 — it reads `systemctl cat bilbycast-relay` to auto-detect the binary path. On a foreground-only install it errors out with `systemd unit 'bilbycast-relay' not found`. For a foreground install, do the swap by hand:

```bash
# 1. Stop the foreground ./bilbycast-relay process (Ctrl-C in its terminal).

# 2. Backup the running binary so you can roll back if needed.
rm -f bilbycast-relay.previous
mv bilbycast-relay bilbycast-relay.previous

# 3. Re-run step 1's download block to fetch + verify the new binary
#    into CWD (the final `mv … bilbycast-relay && chmod +x` lands it
#    next to the .previous backup).

# 4. Restart.
./bilbycast-relay --config relay.json

# Rollback (if the new version misbehaves):
#   mv bilbycast-relay.previous bilbycast-relay
```

## Going further

The single-host systemd install above is the right shape for most deployments. For larger or more redundant setups:

- **Multiple relays behind a load balancer** — the forwarder is stateless, so an LB doing UDP/QUIC pass-through on 4433 (and 4434, if you carry native SRT/RIST or bond legs) across several relay instances gives you horizontal scale + zero-disruption upgrades. Roll one relay at a time using the upgrade script above; edges reconnect transparently. This applies to **forwarding only** — viewer traffic on 4485 can't be round-robined, because a stream's DVR window and WHEP sessions live on the one relay that ingested it. Scale that tier with [cascade sources](/relay/viewer-distribution/) and sticky routing instead.
- **Geographic redundancy** — run a relay in each region; edges can be configured with multiple relay candidates and will fail over on tunnel loss.
- [Relay security](/relay/security/) — bind tokens, end-to-end tunnel encryption, why operators can't see media.

## Where to read next

- [Relay architecture](/relay/architecture/) — internal design and stateless forwarding.
- [Relay events and alarms](/relay/events-and-alarms/) — what's emitted when tunnels go up or down.
- [Relay stats reference](/relay/stats-reference/) — Prometheus metrics.
