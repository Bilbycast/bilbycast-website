---
title: Environment Variables
description: Environment variables used across bilbycast components.
sidebar:
  order: 1
---

## What belongs in the environment, and what doesn't

Environment variables are for **host- and deployment-level** facts: how this
machine is wired, where its files live, which secrets it holds, and the OS
tuning it needs. Everything else — anything that changes how media is
handled, per input, per output, per flow or per node — belongs in
configuration, where the manager can show it, set it, validate it and audit
it. An environment variable is invisible to the manager UI, undiscoverable
across a fleet, and impossible to attribute to a person or a time.

That gives three groups:

| Group | Lives in | Examples |
|-------|----------|----------|
| Secrets and bootstrap | Environment | `BILBYCAST_JWT_SECRET`, `BILBYCAST_MASTER_KEY`, `BILBYCAST_DATABASE_URL` |
| Host / OS tuning | Environment | CPU pinning, `BILBYCAST_MLOCKALL`, `BILBYCAST_ENABLE_TXTIME`, the bond routing-table bases |
| Behaviour | Configuration | Node **Tuning** tab, per-input and per-output fields, manager **Settings** page |

Manager file settings can also be written in the config TOML instead of the
environment; where both are present the environment wins, in **both**
directions — setting a variable to `false` disables the thing, it does not
fall through to a stored value.

Variables marked **deprecated** below have moved into configuration but are
still read for one more release. All of those are on the **edge**, and on the
edge the **configuration field wins**: the variable is a fallback *below* it and
above the built-in default. Env-above-config would recreate the trap this move
exists to close — an operator sets the field in the manager, sees it saved, and
a systemd unit on the box silently outranks it.

Variables marked **removed** do nothing at all. That includes the manager's two
migrated knobs, which are no longer read from the environment: they were
documented as winning for one release, but the manager re-reads its settings
from Postgres every 60 seconds and that refresh overwrote the environment-pinned
value, so the guarantee lasted a minute and said nothing about it.

Either way, using one is reported. The edge raises a `deprecated_env_var` event
that appears on the manager's Events page, carrying the variable, its value, the
replacement and its status — `deprecated`, `removed`, or `unparseable` for a
still-read variable whose value could not be read and was therefore discarded
rather than honoured; the manager logs a warning at startup naming the
replacement setting. A unit file that lies is worse than no unit file.

## Manager Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BILBYCAST_JWT_SECRET` | Yes | 64-char hex string (32 bytes) for JWT signing |
| `BILBYCAST_MASTER_KEY` | Yes | 64-char hex string (32 bytes) for envelope encryption at rest (derives per-domain KEKs via HKDF) |
| `BILBYCAST_NEW_MASTER_KEY` | No | New master key for `rotate-master-key` CLI command (rotation only) |
| `BILBYCAST_TLS_CERT` | Conditional | TLS certificate PEM path (file-based TLS mode). Refused unless `BILBYCAST_TLS_KEY` is set too — the manager bails at startup rather than mix a cert from the environment with a key from the config file. |
| `BILBYCAST_TLS_KEY` | Conditional | TLS private key PEM path (file-based TLS mode). Same pairing rule as `BILBYCAST_TLS_CERT`. |
| `BILBYCAST_TLS_MODE` | No | `"direct"` (default) or `"behind_proxy"` |
| `BILBYCAST_TRUST_PROXY_HEADER` | No | Set to `"1"`/`"true"` to honour `X-Forwarded-For` for client-IP resolution (login rate-limit bucket key + audit IP). **Off by default.** Required in `behind_proxy` mode — without it the rate limiter buckets on the load balancer's IP. Only enable behind a trusted LB that strips inbound XFF before adding its own, or a client can forge its own bucket key. |
| `BILBYCAST_TRUSTED_PROXIES` | No | Comma-separated CIDR allowlist of proxies whose `X-Forwarded-For` is trusted (only when `BILBYCAST_TRUST_PROXY_HEADER` is on). Default: `127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7`. |
| `BILBYCAST_SESSION_CACHE_FRESHNESS_SECS` | No | **Removed** — moved to the `session_cache_freshness_secs` setting (Settings → Advanced): cluster-wide, applied live on the instance serving you, picked up by an HA peer within 60 s, recorded in the audit log. No longer read from the environment; a host that still sets it is named in a startup warning alongside the replacement. Session-cache freshness floor in seconds (default: 60). |
| `BILBYCAST_ACME_ENABLED` | No | Enable automatic Let's Encrypt certificates (`true`/`false`) |
| `BILBYCAST_ACME_DOMAIN` | Conditional | Domain for ACME certificate (required if ACME enabled) |
| `BILBYCAST_ACME_EMAIL` | No | Contact email for Let's Encrypt |
| `BILBYCAST_ACME_HTTP_PORT` | No | Port for HTTP-01 challenge (default: 80) |
| `BILBYCAST_ACME_STAGING` | No | Set to `"1"`/`"true"` to use the Let's Encrypt **staging** directory (untrusted test certs, high rate limits) instead of production |
| `BILBYCAST_ACME_DIR` | No | ACME account/cache/state directory (where issued certs + account keys are cached) |
| `BILBYCAST_PORT` | No | Override listen port (default: 8443) |
| `BILBYCAST_LISTEN_ADDRS` | No | Comma-separated bind addresses for the main HTTPS/WSS listener (default `0.0.0.0,[::]` = dual-stack). Examples: `0.0.0.0` (v4 only), `[::]` (v6 only), `192.0.2.5,[2001:db8::5]` (specific interfaces). Port still comes from `BILBYCAST_PORT`. |
| `BILBYCAST_ACME_LISTEN_ADDRS` | No | Comma-separated bind addresses for the ACME HTTP-01 challenge listener (default `0.0.0.0,[::]`). Same shape as `BILBYCAST_LISTEN_ADDRS`; port from `BILBYCAST_ACME_HTTP_PORT`. |
| `BILBYCAST_DATABASE_URL` | No | Postgres DSN (default: `postgres://bilbycast:bilbycast_dev@localhost:5433/bilbycast` — points at the dev docker-compose cluster) |
| `BILBYCAST_DATA_DIR` | No | Override the on-disk data directory (instance-id cache, backup archives, HA drain sentinel) |
| `BILBYCAST_INSTANCE_ID` | No | Explicit instance UUID for HA / multi-instance deployments. Unset → load/generate `<data_dir>/instance_id` |
| `BILBYCAST_REGION` | No | Freeform region tag for multi-region / HA deployments. Empty/unset → `"unknown"` (solo install) |
| `BILBYCAST_VISUAL_HISTORY_DIR` | No | Where the [Visual Flow Editor](/manager/visual-flow-editor/) writes its redacted, **disposable** Git mirror of deployments. Postgres remains the authoritative record — this directory can be deleted and rebuilt. |
| `BILBYCAST_VISUAL_DEPLOY_SETTLE_SECS` | No | **Removed** — moved to the `visual_deploy_settle_secs` setting (Settings → Advanced), on the same terms and for the same reason as `BILBYCAST_SESSION_CACHE_FRESHNESS_SECS` above. No longer read from the environment; startup warns and names the setting. How long after a visual deployment the manager watches the node's alarms before deciding it settled. Default 20. |
| `BILBYCAST_VISUAL_EDITOR_ASSET_DIR` | No | Absolute path overriding the embedded graph-editor bundle, so a tested build can be deployed without rebuilding or restarting the manager. |

### Prometheus /metrics auth

The Prometheus scrape endpoint (`/api/v1/metrics`) is **fail-closed** — with neither variable set it rejects all requests. Configure at least one to allow scraping.

| Variable | Required | Description |
|----------|----------|-------------|
| `BILBYCAST_METRICS_TOKENS` | Conditional | Comma-separated bearer tokens accepted on the `Authorization: Bearer …` header for `/api/v1/metrics` |
| `BILBYCAST_METRICS_ALLOWLIST` | Conditional | Comma-separated list of scraper IPs allowed to reach `/api/v1/metrics` without a bearer token. Matched by **exact IP string** (e.g. `127.0.0.1`, `::1`) — not CIDR ranges. |

### OIDC / SSO (licensed — `FEATURE_SSO`)

Single sign-on is a licensed feature. Setting `BILBYCAST_OIDC_ENABLED=true` **without** the required issuer/client variables is a fatal startup error.

| Variable | Required | Description |
|----------|----------|-------------|
| `BILBYCAST_OIDC_ENABLED` | No | Set to `"1"`/`"true"` to enable OIDC SSO login |
| `BILBYCAST_OIDC_ISSUER_URL` | Conditional | OIDC provider issuer URL (required when OIDC enabled) |
| `BILBYCAST_OIDC_CLIENT_ID` | Conditional | OAuth2 client ID (required when OIDC enabled) |
| `BILBYCAST_OIDC_CLIENT_SECRET` | Conditional | OAuth2 client secret (required when OIDC enabled) |
| `BILBYCAST_OIDC_REDIRECT_URL` | Conditional | Redirect/callback URL registered with the provider |
| `BILBYCAST_OIDC_PROVIDER_ID` | No | Identifier for the configured provider |
| `BILBYCAST_OIDC_ROLE_CLAIM` | No | Token claim to read the user's role from |
| `BILBYCAST_OIDC_ROLE_MAP` | No | Mapping of IdP role/claim values to bilbycast roles |
| `BILBYCAST_OIDC_ROLE_SYNC` | No | Set to `"1"`/`"true"` to sync roles from the IdP on each login |
| `BILBYCAST_OIDC_GROUP_SYNC` | No | Set to `"1"`/`"true"` to sync IdP group claims into manager Groups on OIDC login. Off by default. |

## Edge and Relay Variables

| Variable | Description |
|----------|-------------|
| `BILBYCAST_ALLOW_INSECURE` | Set to `"1"` to allow `accept_self_signed_cert` in manager connection config. Safety guard against accidental use in production. |
| `BILBYCAST_MEDIA_DIR` | Edge: override the media-player library directory. Defaults to XDG → `$HOME/.bilbycast/media/` → `./media/`. 4 GiB per file, 16 GiB total cap. |
| `BILBYCAST_REPLAY_DIR` | Edge: override the replay-server storage root. Defaults to XDG → `$HOME/.bilbycast/replay/` → `./replay/`. |
| `BILBYCAST_MLOCKALL` | Edge: set to `"1"` to `mlockall()` the process at startup, locking pages to prevent paging-induced jitter. Off by default; recommended for low-latency production hosts. |
| `BILBYCAST_PROBE_SESSION_LIMITS` | Edge: **deprecated** — use `tuning.probe_session_limits` in the node's config (Manager → node → Configure → Tuning). Still read for one release, below the config field; a node that still sets it raises a `deprecated_env_var` event. Set to `"0"` to disable the startup HW-encoder/decoder session-capacity probe. Default on. |
| `BILBYCAST_INGRESS_RESIDENCE_MS` | Edge: **deprecated** — use `tuning.ingress_residence_ms` for the node default, or the per-input `ingress_residence_ms` field on a UDP/RTP input. Still read for one release, below both; a node that still sets it raises a `deprecated_env_var` event. Ingress de-jitter hard-shed residence cap. Defaults to `max(4 × setpoint, 250)` ms so a larger buffer gets proportionally more burst headroom. |
| `BILBYCAST_ENABLE_TXTIME` | Edge: set to `"1"` to opt in to the `SO_TXTIME` + ETF-qdisc wire-emit releaser tier. (The former alias `BILBYCAST_ENABLE_SO_TXTIME` has been **removed** — one name for one knob.) **Off by default** — the default release path is `clock_nanosleep` on a `SCHED_FIFO` thread. Configure the ETF qdisc + PTP discipline first, else `SO_TXTIME` silently degrades. Set `BILBYCAST_ETF_SO_PRIORITY=5` alongside it — see that row below. See [Wire-Time Precision](/edge/wire-pacing/). |
| `BILBYCAST_FORCE_NANOSLEEP` | Edge: back-compat no-op — the `clock_nanosleep` tier is already the default. Only meaningful once `BILBYCAST_ENABLE_TXTIME=1` is set, where it forces the `clock_nanosleep` fallback for diagnostics. |
| `BILBYCAST_ETF_SO_PRIORITY` | Edge: the `SO_PRIORITY` pinned on `SO_TXTIME` outputs so they land on the traffic class that carries the ETF qdisc (a DSCP marking otherwise derives its own priority, routes the packet off that class, and `SO_TXTIME` is silently ignored). **Default 0, which is the wrong value for the qdisc the shipped `setup-etf-qdisc.sh` installs**: that priomap sends *only* socket-priority 5 to the ETF class and routes everything else — priority 0 included — to `fq_codel`, deliberately, so unstamped traffic like ARP and IGMP can't be blackholed. Set `BILBYCAST_ETF_SO_PRIORITY=5` whenever you set `BILBYCAST_ENABLE_TXTIME=1` on a host prepared by that script, or the outputs land on `fq_codel` and lose ETF launch-time pacing while still reporting the `so_txtime` tier. See [Wire-Time Precision](/edge/wire-pacing/). |
| `BILBYCAST_LOSSLESS_SO_PRIORITY` | Edge: `SO_PRIORITY` for compressed ("lossless"-class) outputs, pinning them to a **non-ETF** qdisc class so their userspace-paced sends are queued rather than late-dropped. Default 4. Applied **only** when `BILBYCAST_ENABLE_TXTIME=1`. The on-wire DSCP byte is unaffected. |
| `BILBYCAST_WIRE_EMIT_CPUS` | Edge: comma/range CPU-affinity set for wire-emit releaser threads. Empty/unset → no pinning. Sibling knobs (same parser): `BILBYCAST_CODEC_CPUS` (codec threads), `BILBYCAST_PID_BUS_CPUS` (PID-bus / TS-assembler), `BILBYCAST_PLL_CPUS` (PCR-ingress / PLL sampler). |
| `BILBYCAST_PROBE_4K` | Edge: **deprecated** — use `tuning.probe_4k` (Manager → node → Configure → Tuning). Still read for one release, below the config field. Set to `"0"` to skip the **second-tier 4K** HW session-capacity probe at startup (the 1080p tier still runs) — a faster boot on 1080p-only deployments. `tuning.probe_session_limits = false` disables both tiers. |
| `BILBYCAST_PTP_CONF_PATH` | Edge: override the path to the `ptp4l` config file the PTP reporter reads. For non-standard linuxptp layouts. |
| `BILBYCAST_PTP_SCRIPT` | Edge: path to the script the `bilbycast-ptp-helper` binary drives. Unset → the compiled-in default path. |
| `BILBYCAST_LIBMXL_SO` | Edge: override the `libmxl.so` search path for the boot probe. On a miss, the MXL capabilities are not advertised. (`mxl` builds only.) |
| `BILBYCAST_BOND_RT_TABLE_BASE` | Edge: base for the reserved policy-routing tables used by gateway-mode bond legs. Default `48128`. Override where existing host routing tables collide. |
| `BILBYCAST_BOND_RT_PRIO_BASE` | Edge: base for the reserved `ip rule` priorities on the same path. Default `10000`. |
| `BILBYCAST_CELLULAR_WAKE_DIR` | Edge: override the dormant-modem wake-keeper state directory. |
| `BILBYCAST_TESTGEN_VOICE_DIR` | Edge: override the test-generator voice-clip directory. Default `<media_dir>/testgen_voice/`. |
| `RUST_LOG` | Log level control (e.g. `bilbycast_edge=info`, `bilbycast_relay=debug`). Also selects the edge's per-event testbed trace, which has its own target: `RUST_LOG=info,bilbycast_edge::testbed_events=debug`. Keep the leading global level — a bare target directive sets the global default to `off` and silences every other log line. This replaced `BILBYCAST_TESTBED_TRACE_EVENTS`, which read an environment variable per event for something `RUST_LOG` already selects by target. |

### Removed (edge)

These do nothing. The edge still *detects* each one at startup and reports it —
a `journalctl` warning plus a Warning `deprecated_env_var` event carrying
`status: "removed"` — because a unit file stating an intent the edge is not
applying is worse than one that says nothing.

| Variable | What to use instead |
|----------|---------------------|
| `BILBYCAST_INGRESS_BUFFER_MS` | `tuning.ingress_dejitter_ms` (Manager → node → Configure → Tuning). This variable never had any effect, in any release: the node-wide setpoint it carried was consulted only *after* the per-input `ingress_dejitter_ms` had already answered, so no value it held could change behaviour. The config field is the one that works. |
| `BILBYCAST_ENABLE_SO_TXTIME` | `BILBYCAST_ENABLE_TXTIME` — the alias was collapsed onto one name. |
| `BILBYCAST_EGRESS_PACING` | The per-output `egress_pacing` config field. |
| `BILBYCAST_EGRESS_BUFFER_MS` | The per-output `egress_buffer_ms` config field. |
| `BILBYCAST_EGRESS_RESIDENCE_MS` | The per-output `egress_buffer_ms` config field, which the residence is derived from. No field carries a residence directly — the egress servo derives it from the cushion it is asked to hold. |
| `BILBYCAST_BOND_FWMARK_BASE` | `BILBYCAST_BOND_RT_TABLE_BASE` / `BILBYCAST_BOND_RT_PRIO_BASE`. Nothing ever read the fwmark variable. |
| `BILBYCAST_MEDIA_PLAYER_INCREMENTAL_MP4` | Nothing — the bounded incremental MP4/MOV reader is now unconditional in release builds. This selected the whole-file demux, which holds an entire asset resident: a 4 GiB file is a 4 GiB spike, and that out-of-memory is exactly what the bounded reader was written to fix. A control whose "off" position is a known OOM does not belong on an operator's screen, so unlike its two siblings it was **not** given a config field. It survives in debug builds only, for diagnostics. |

### Media-player rollback levers (edge) — now config fields

These are still **on by default** and still exist so one node can be reverted
without rolling back a release. Two of them have moved into the node's
configuration, at **Manager → node → Configure → Tuning → Media Player**, so
they are visible per node, audited in Config History, and settable without SSH.
The third was withdrawn rather than moved.

Both surviving levers apply on save and are read when a media-player input next
starts, so **restart the flow** to apply — no node restart. A per-input setting
always overrides the node-wide default.

| Variable | Status | What to use instead |
|----------|--------|---------------------|
| `BILBYCAST_MEDIA_PLAYER_CONTROLLER` | **Deprecated** — still read for one release, *below* the config field | `tuning.media_player_controller`, or the targeted per-input `operator_control`. Turning it off falls back to the legacy sequential playout loop and withdraws the media-player control capability, so the manager's **Next** button disappears node-wide. |
| `BILBYCAST_MEDIA_PLAYER_PCR_DEADLINES` | **Deprecated** — still read for one release, *below* the config field | `tuning.media_player_pcr_deadlines`, or the new per-input `pcr_deadlines` on a `media_player` input. Turning it off paces TS playout from the legacy byte-rate estimate instead of deadlines anchored on the asset's own PCR. Failure modes are both host-dependent (a stalling disk, a clock step) and asset-dependent (a spliced file), which is why both layers exist. |

A node that still sets either raises a Warning `deprecated_env_var` event
carrying `status: "deprecated"`, visible on the manager's Events page. **The
config field wins and the variable is only the fallback beneath it** — see the
precedence rule at the top of this page.

Requires edge capability `media_player_tuning`. An edge without it hides the
Media Player section of the Tuning tab, because such an edge accepts these
fields on a config push and ignores them, which looks exactly like success.

## Gateway SDK Variables

For vendor gateway sidecars built on `bilbycast-gateway-sdk`. Sidecars also read `BILBYCAST_ALLOW_INSECURE` and `RUST_LOG` from the tables above.

| Variable | Description |
|----------|-------------|
| `BILBYCAST_SDK_ALLOW_PLAINTEXT_WS` | Set to `"1"` to permit a plaintext `ws://` manager URL. Requires the config field `allow_plaintext_ws = true` **as well** — either key alone is refused, and the error names the half that is missing. Same both-keys shape as `accept_self_signed_cert` + `BILBYCAST_ALLOW_INSECURE`, and for the same reason: a sidecar carries its node secret on that link, so one variable set anywhere must not be able to downgrade it to cleartext. Integration tests only, never a shipping sidecar. |

## Generating Secrets

```bash
# Generate JWT secret (64-char hex = 32 bytes)
openssl rand -hex 32

# Generate master key (64-char hex = 32 bytes)
openssl rand -hex 32
```

Both secrets are validated at startup — weak or short values are rejected.
