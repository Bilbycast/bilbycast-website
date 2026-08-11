---
title: Environment Variables
description: Environment variables used across bilbycast components.
sidebar:
  order: 1
---

## Manager Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BILBYCAST_JWT_SECRET` | Yes | 64-char hex string (32 bytes) for JWT signing |
| `BILBYCAST_MASTER_KEY` | Yes | 64-char hex string (32 bytes) for envelope encryption at rest (derives per-domain KEKs via HKDF) |
| `BILBYCAST_NEW_MASTER_KEY` | No | New master key for `rotate-master-key` CLI command (rotation only) |
| `BILBYCAST_TLS_CERT` | Conditional | TLS certificate PEM path (file-based TLS mode) |
| `BILBYCAST_TLS_KEY` | Conditional | TLS private key PEM path (file-based TLS mode) |
| `BILBYCAST_TLS_MODE` | No | `"direct"` (default) or `"behind_proxy"` |
| `BILBYCAST_TRUST_PROXY_HEADER` | No | Set to `"1"`/`"true"` to honour `X-Forwarded-For` for client-IP resolution (login rate-limit bucket key + audit IP). **Off by default.** Required in `behind_proxy` mode — without it the rate limiter buckets on the load balancer's IP. Only enable behind a trusted LB that strips inbound XFF before adding its own, or a client can forge its own bucket key. |
| `BILBYCAST_TRUSTED_PROXIES` | No | Comma-separated CIDR allowlist of proxies whose `X-Forwarded-For` is trusted (only when `BILBYCAST_TRUST_PROXY_HEADER` is on). Default: `127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7`. |
| `BILBYCAST_SESSION_CACHE_FRESHNESS_SECS` | No | Session-cache freshness floor in seconds (default: 60) |
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
| `BILBYCAST_VISUAL_DEPLOY_SETTLE_SECS` | No | How long after a visual deployment the manager watches the node's alarms before deciding it settled. Default 20. A critical alarm naming a resource the deployment changed moves it to `degraded`. |
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
| `BILBYCAST_PROBE_SESSION_LIMITS` | Edge: set to `"0"` to disable the startup HW-encoder/decoder session-capacity probe. Default on. |
| `BILBYCAST_INGRESS_BUFFER_MS` | Edge: default ingress de-jitter buffer depth when a per-input `ingress_dejitter_ms` is unset. Overrides the 60 ms default. |
| `BILBYCAST_INGRESS_RESIDENCE_MS` | Edge: ingress de-jitter hard-shed residence cap. Defaults to `max(4 × setpoint, 250)` ms so a larger buffer gets proportionally more burst headroom. |
| `BILBYCAST_ENABLE_TXTIME` | Edge: set to `"1"` (alias `BILBYCAST_ENABLE_SO_TXTIME=1`) to opt in to the `SO_TXTIME` + ETF-qdisc wire-emit releaser tier. **Off by default** — the default release path is `clock_nanosleep` on a `SCHED_FIFO` thread. Configure the ETF qdisc + PTP discipline first, else `SO_TXTIME` silently degrades. See [Wire-Time Precision](/edge/wire-pacing/). |
| `BILBYCAST_FORCE_NANOSLEEP` | Edge: back-compat no-op — the `clock_nanosleep` tier is already the default. Only meaningful once `BILBYCAST_ENABLE_TXTIME=1` is set, where it forces the `clock_nanosleep` fallback for diagnostics. |
| `BILBYCAST_ETF_SO_PRIORITY` | Edge: override the `SO_PRIORITY` value mapped onto the ETF qdisc class for `SO_TXTIME` outputs. Default follows the standard TC map. |
| `BILBYCAST_LOSSLESS_SO_PRIORITY` | Edge: `SO_PRIORITY` for compressed ("lossless"-class) outputs, pinning them to a **non-ETF** qdisc class so their userspace-paced sends are queued rather than late-dropped. Default 4. Applied **only** when `BILBYCAST_ENABLE_TXTIME=1`. The on-wire DSCP byte is unaffected. |
| `BILBYCAST_WIRE_EMIT_CPUS` | Edge: comma/range CPU-affinity set for wire-emit releaser threads. Empty/unset → no pinning. Sibling knobs (same parser): `BILBYCAST_CODEC_CPUS` (codec threads), `BILBYCAST_PID_BUS_CPUS` (PID-bus / TS-assembler), `BILBYCAST_PLL_CPUS` (PCR-ingress / PLL sampler). |
| `BILBYCAST_PROBE_4K` | Edge: set to `"0"` to skip the **second-tier 4K** HW session-capacity probe at startup (the 1080p tier still runs) — a faster boot on 1080p-only deployments. `BILBYCAST_PROBE_SESSION_LIMITS=0` disables both tiers. |
| `BILBYCAST_PTP_CONF_PATH` | Edge: override the path to the `ptp4l` config file the PTP reporter reads. For non-standard linuxptp layouts. |
| `BILBYCAST_LIBMXL_SO` | Edge: override the `libmxl.so` search path for the boot probe. On a miss, the MXL capabilities are not advertised. (`mxl` builds only.) |
| `BILBYCAST_BOND_RT_TABLE_BASE` | Edge: base for the reserved policy-routing tables used by gateway-mode bond legs. Default `48128`. Override where existing host routing tables collide. |
| `BILBYCAST_BOND_RT_PRIO_BASE` | Edge: base for the reserved `ip rule` priorities on the same path. Default `10000`. |
| `BILBYCAST_CELLULAR_WAKE_DIR` | Edge: override the dormant-modem wake-keeper state directory. |
| `BILBYCAST_TESTGEN_VOICE_DIR` | Edge: override the test-generator voice-clip directory. Default `<media_dir>/testgen_voice/`. |
| `RUST_LOG` | Log level control (e.g., `bilbycast_edge=info`, `bilbycast_relay=debug`) |

### Media-player rollback levers (edge)

Each of these is **on by default** and exists so one node can be reverted without rolling back a release. They are diagnostic controls, not tuning knobs — leave them alone unless you are working a specific fault.

| Variable | Description |
|----------|-------------|
| `BILBYCAST_MEDIA_PLAYER_CONTROLLER` | Set to `0`/`false`/`off` to fall back to the legacy sequential playout loop. This also withdraws the media-player control capability, so the manager's **Next** button disappears. The per-input `operator_control: false` setting is the targeted alternative and takes precedence. |
| `BILBYCAST_MEDIA_PLAYER_PCR_DEADLINES` | Set to `0`/`false`/`off` to pace TS playout from the legacy byte-rate estimate instead of deadlines anchored on the source's own PCR. The PCR-anchored mode fixes an unbounded overshoot on variable-bitrate assets; its own failure modes are asset- and host-dependent, which is why the lever exists. |
| `BILBYCAST_MEDIA_PLAYER_INCREMENTAL_MP4` | Set to `0`/`false`/`off` to fall back to the whole-file MP4/MOV demux, which holds an entire asset in RAM — a 4 GiB file is a 4 GiB resident spike. Diagnostic use only. |

## Generating Secrets

```bash
# Generate JWT secret (64-char hex = 32 bytes)
openssl rand -hex 32

# Generate master key (64-char hex = 32 bytes)
openssl rand -hex 32
```

Both secrets are validated at startup — weak or short values are rejected.
