---
title: Cellular Uplink Telemetry
description: Read-only radio state for a mobile uplink — signal, operator, access technology, registration and SIM state — surfaced per network interface, on bond legs, and as alarm events.
sidebar:
  order: 10
---

An edge node can report the **live radio state** of any cellular uplink it can see: signal strength and quality, the operator it is camped on, the access technology and band, and whether the SIM is registered, roaming, locked or missing. That state is attached to the network interface the uplink egresses on, joined onto bond legs pinned to that interface, and turned into a small set of debounced events you can alarm on.

Two sources feed it: a **modem the host owns** (USB or PCIe, read through ModemManager) and a **Teltonika RutOS router** on the LAN (read over its HTTP API). Both produce the same shape, so the manager renders them identically.

:::caution[This is telemetry. It does not touch your radio.]
The edge **observes and reports only**. It never configures the modem, never sets an APN, never locks a band, never chooses or forces a network, never reboots or switches SIM, and never steers media onto or off a cellular link because of what it read. Nothing is installed on a RutOS router, and the credential it uses is a read-only one. If the SIM's data cap matters to you, note that the edge reports usage where the device offers it but does **not** enforce a cap.

The one control surface that exists — waking a dormant USB modem — is deliberately outside this path: the edge writes a request file and an opt-in root daemon on the host does the work. See [Waking a dormant modem](#waking-a-dormant-modem).
:::

This page is about **monitoring** a cellular uplink. For bringing a USB modem up, source-routing it, and using it as a bonded transport path, see [USB Cellular Modem as a Bonding Path](/edge/bonding-cellular-modem/).

A node egressing over a Starlink terminal has a direct equivalent — same **Uplink Monitoring** tab, same per-interface and bond-leg strips, same event shape: see [Starlink Dish Telemetry](/edge/starlink/).

## The two sources

| | Host-attached modem | RutOS router |
|---|---|---|
| Typical hardware | Teltonika TRM500, Quectel RG520N, any ModemManager-supported USB/PCIe module | Teltonika RUT / RUTX / OTD series |
| Read via | ModemManager on the local system D-Bus | The router's HTTP API on the LAN |
| Operator action needed | **None** — auto-detected | **One config entry** per interface, plus a read-only router login |
| Credential | None (unprivileged local read) | Read-only RutOS user, stored encrypted on the node |
| Platform | Linux only | Any platform the edge runs on |
| Reports | Signal, operator, PLMN, band, tech, registration, SIM slot, roaming | The same, plus cell ID, modem temperature and data usage where the firmware offers them |

Why both: a modem plugged into the edge box is visible to the host and needs no configuration. A modem mounted outside on a PoE router is **not** visible to the host at all — the host only sees an Ethernet interface — so the only way to read its radio is to ask the router, which means an address and a login.

The edge advertises a `cellular` capability on its health tick as soon as the poller has at least one source (a detected modem or a configured router). Signal strips render wherever the data is present.

## Configuring a RutOS router

Nothing to do for a host-attached modem. For a router, add one entry per interface.

:::caution[`interface` must be the exact netdev name on the edge host]
This is the name of a network interface **on the edge node**, not on the router. For a router entry that means the LAN NIC the edge reaches the router on — counter-intuitive, because every other field in the entry describes the router. Check it against `ip -br link` on the node, or pick it from the drop-down the manager form offers rather than typing it.

A name that matches no interface on the host **fails silently**. The poll still succeeds, nothing is logged as an error, no event fires, and the telemetry simply never appears — not on the Network Interfaces card, not on any bond leg. **Test reachability** passes in that case too, because it validates the address and the credential and never touches the interface name. If a router you know is reachable renders nothing at all, check this first.
:::

**In the manager UI:** node → **Configure** → **Uplink Monitoring** tab → **Cellular** → **Add Router**. Fill in the interface (a datalist offers the node's live NIC names), the router address, scheme, API flavour, and the read-only username and password. **Test reachability** performs a real login and modem-status fetch against the router and reports the exact failure cause, so credentials are validated before you save rather than after. On a later edit the password field may be left blank to keep the stored one.

**In `config.json` directly:**

```jsonc
"cellular_uplinks": [
  {
    "interface": "eno4",         // required — the netdev this annotates
    "address": "192.168.1.1",    // required — bare host or IP, no scheme, no path
    "kind": "rutos",             // default "rutos"
    "scheme": "https",           // default "https"; "http" also accepted
    "api": "ubus",               // default "ubus"; "rest" for RutOS 7.x
    "username": "monitor",       // the read-only router user
    "verify_tls": false,         // default false — RutOS ships a self-signed cert
    "cert_fingerprint": null     // optional SHA-256 pin
    // no password here — see below
  }
]
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `interface` | yes | — | Kernel netdev name, max 64 characters. Must be unique across the list; a duplicate is rejected at load. |
| `address` | yes | — | Bare host or IP, max 253 characters. A value containing `://` or `/` is rejected — put the scheme in `scheme`. |
| `kind` | no | `"rutos"` | Only `"rutos"` is acted on. Max 32 characters. |
| `scheme` | no | `"https"` | Must be `"http"` or `"https"`. |
| `api` | no | `"ubus"` | Must be `"ubus"` or `"rest"`. `ubus` has the broadest firmware compatibility; `rest` is the RutOS 7.x API. |
| `username` | no | — | Max 64 characters. Validation does not require it, but a blank username will fail the router's login. |
| `password` | no | — | **Never write it here.** Max 256 characters. See below. |
| `verify_tls` | no | `false` | Off by default because RutOS presents a self-signed certificate that no CA chain will validate. |
| `cert_fingerprint` | no | — | SHA-256 of the router's certificate, 64 hex characters, `:` separators allowed. When set it **overrides** `verify_tls` and becomes the trust anchor — stronger than CA validation for a self-signed device. |

### Where the password lives

The router password is an infrastructure secret. It is held only in the node's `secrets.json`, keyed by interface, encrypted at rest with a machine-specific key and written `0600`:

```jsonc
// secrets.json — local to the node, never leaves it
"cellular_uplinks": { "eno4": { "password": "•••" } }
```

It is stripped from every config the node hands back, and re-merged from local storage when the manager pushes a config — so the manager never round-trips a credential it should not hold, and a config push that omits the password does not wipe it.

### Applying a change

`cellular_uplinks` is re-read from the live config on every poll cycle, so an added, edited or removed router takes effect **within about 10 seconds with no flow restart and no node restart**. Nothing on the media path is touched.

## Device-side prerequisites (RutOS)

On the router, before you point the edge at it:

- **Create a dedicated read-only user.** That account is the only credential in play, so keep its blast radius at zero. The edge needs it to reach the `gsm.modem0` object over ubus, or `GET /api/modems/status` on the REST API — nothing else.
- **Enable the HTTP API / web administration on the LAN interface** the edge reaches the router on. With `api: "ubus"` the edge posts to `/ubus`; with `api: "rest"` it posts to `/api/login` and then reads `/api/modems/status`.
- **Restrict Access Control to HTTPS on the LAN, and leave remote (WAN) access off.** Optionally disable the RMS cloud agent.
- **Do not use Modbus for this.** It is unauthenticated. If you use SNMP at all, use v3.

Field names vary by RutOS model and firmware, so the mapping is deliberately tolerant — it tries several key spellings and accepts a value whether the firmware sends it as a number or a string, and reports fewer fields rather than failing outright. If a figure you expect stays blank on a particular model, that mapping is the thing to check against the device's own API documentation.

## Where the telemetry appears

### On the Network Interfaces card

Node detail → **Network Interfaces**. Any interface with cellular state gets a full-width radio strip beneath its row: bars glyph, access-technology badge, registration pill, operator and band, the RSRP and SINR figures, a `ROAMING` marker when applicable, the source badge (`Modem` or `Router`), and a `⟳ Ns` freshness counter. Hovering the strip gives every field the source published, including RSRQ, RSSI, PLMN, cell ID, SIM slot, temperature and data used.

A configured router that cannot be reached does **not** vanish into a blank row — it renders as `⚠ UNREACHABLE` with the exact failure cause (login rejected, HTTP status, no response, unexpected response shape), so a typo in the address or a wrong password is diagnosable at a glance.

### On bond legs

A bonded flow's per-leg table gains a signal column when any leg maps to an interface carrying radio state, and shows a compact strip — bars, tech badge, operator — on the matching leg.

The join is by interface name, and only some legs carry one. Concretely, a leg gets a signal strip when **all** of the following hold:

- it is on the **sending** side (a bonded output). Receive-side legs never report an egress interface.
- it is a **UDP** leg or a **relay** leg — not QUIC, not RIST.
- it is pinned in **interface mode**, i.e. it names an `interface` and has no `gateway`. A gateway-mode leg steers through a policy route rather than a NIC pin, reports its binding as `gateway`, and carries no interface to join on.

That is a real limitation, not a rendering quirk: if you want the radio strip on a bond leg, pin the leg to the interface. See [Wire it into bonding](/edge/bonding-cellular-modem/#wire-it-into-bonding).

### Not on the node's own local dashboard

The node's own monitor dashboard and local health endpoint do **not** carry cellular state. This telemetry reaches the manager and only the manager. There is no Prometheus metric for it either — alarm on the events below instead.

## What is reported

```jsonc
"cellular": {
  "source": "modem_manager",          // or "rutos"
  "state": "registered_home",
  "access_tech": "5gnr_nsa",
  "operator": "Telstra",
  "plmn": "50501",
  "band": "n78",
  "signal": { "rsrp_dbm": -95, "rsrq_db": -11, "sinr_db": 12, "rssi_dbm": -67, "bars": 3 },
  "roaming": false,
  "sim_slot": 1,
  "keeper_active": true,
  "sampled_at_unix_ms": 1750000000000
}
```

`source` and `state` are always present (`state` reads `unknown` when the device did not say). Every other field is optional and omitted when the source did not publish it — an absent field means "the device didn't say", never "no".

| Field | What it means when you are judging a link |
|---|---|
| `state` | Registration and SIM state, normalised to one of `registered_home`, `registered_roaming`, `searching`, `denied`, `sim_missing`, `sim_pin_required`, `disabled`, `unknown`. Anything other than the two `registered_*` values means the link cannot pass traffic right now. `denied` is a network-side refusal (check the plan and the APN); `sim_pin_required` also covers a non-SIM operator lock. |
| `access_tech` | `5gnr_sa`, `5gnr_nsa`, `5gnr`, `lte`, `hspa`, `umts`, `edge`, `gprs`, `gsm`. A drop from `5gnr_nsa` to `lte` on a link that was fine before usually means the network withdrew the NR carrier, not that the modem broke. A router may report a string the edge does not recognise, in which case it is passed through in lower case rather than discarded. |
| `operator` / `plmn` | Who you are camped on, by name and by MCC+MNC. A changed PLMN on a roaming SIM explains a sudden latency or cost change. |
| `band` | Serving band, `n78` style for NR and `B3` style for LTE. Useful when comparing two antennas or two positions. |
| `signal.rsrp_dbm` | Reference Signal Received Power. The primary **strength** figure on LTE and NR — how much of the wanted signal reaches the antenna. Aim better than −95 dBm. |
| `signal.sinr_db` | Signal-to-Interference-plus-Noise Ratio. The primary **quality** figure — how clean that signal is. This is the one that predicts throughput. Above 13 dB is good, below 0 dB is unusable regardless of how strong RSRP looks. A strong-but-noisy cell (good RSRP, negative SINR) is the classic congested-site signature. |
| `signal.rsrq_db` | Received Signal Quality, a per-resource-block ratio. Secondary; useful for confirming a SINR reading. |
| `signal.rssi_dbm` | Wideband received power, including interference. The only strength figure that exists on 2G/3G; on LTE/NR prefer RSRP. |
| `signal.bars` | 0–5, derived from the figures above — see [Signal thresholds](#signal-thresholds). This is what the glyph and the colour are drawn from, and what the degraded-signal event fires on. |
| `roaming` | On an extra-cost network. |
| `sim_slot` | Active slot on a dual-SIM device. |
| `temperature_c` | Modem temperature, where the device reports it. Router sources only. |
| `data_used_bytes` / `data_limit_bytes` | Session or period usage and configured cap, where the device reports them. Router sources only, and **reported, never enforced**. |
| `keeper_active` | Whether the host's optional cellular keep-alive daemon is running. Modem sources only — see [Waking a dormant modem](#waking-a-dormant-modem). |
| `last_error` | Present only on a configured router that failed its last poll; carries the cause. |
| `sampled_at_unix_ms` | When this snapshot was taken. Drives the `⟳ Ns` age counter and the staleness eviction. |

:::note[Some fields never appear on a host-attached modem]
`cell_id`, `temperature_c`, `data_used_bytes` and `data_limit_bytes` are **never** populated for a `modem_manager` source. Serving-cell identity needs a privileged location-service call that this read-only path deliberately does not make, and the standard modem interfaces expose neither temperature nor usage. These four are router-only in practice.
:::

## Signal thresholds

Bars are the **worst of** RSRP and SINR — a link is only as good as its weakest axis, so a strong signal drowning in interference reads low, which is the honest answer. RSSI is used **only** when there is no RSRP at all, which in practice means 2G and 3G.

| Bars | RSRP (dBm) | SINR (dB) | RSSI (dBm, only when RSRP is absent) |
|---|---|---|---|
| 5 | ≥ −80 | ≥ 20 | ≥ −65 |
| 4 | ≥ −90 | ≥ 13 | ≥ −75 |
| 3 | ≥ −100 | ≥ 6 | ≥ −85 |
| 2 | ≥ −105 | ≥ 0 | ≥ −95 |
| 1 | ≥ −115 | ≥ −5 | ≥ −105 |
| 0 | below −115 | below −5 | below −105 |

The colour an operator reads first maps from the bar count:

| Colour | Bars | Read it as |
|---|---|---|
| Green | 4–5 | Healthy. RSRP −90 dBm or better **and** SINR 13 dB or better, whenever both are published — see the ladder above for the RSSI-only case. |
| Amber | 2–3 | Working but marginal. Reposition the antenna before you rely on it. |
| Red | 0–1 | Degraded — this is also where `cellular_signal_degraded` fires. |
| Grey | no reading | No signal figures published yet. Not the same as bad signal. |

Three behaviours are worth knowing, because each explains a reading that looks wrong:

- **Implausible readings are discarded, not displayed.** ModemManager publishes an out-of-range sentinel for any metric it is not currently measuring, which would otherwise show as something like −32768 dBm and poison both the bar count and the degraded-signal alarm. Readings outside the physically plausible window are dropped to blank: RSRP −156 to −30 dBm, RSRQ −45 to 0 dB, SINR −30 to 50 dB, RSSI −130 to −30 dBm.
- **A 5G NSA modem falls back to its LTE anchor for the numbers.** An idle NSA modem's NR carrier often reports nothing at all, because the network only adds the NR secondary cell under data demand. Rather than blanking RSRP, RSRQ and SINR, the edge reads the live LTE anchor figures. The access technology still reads `5gnr_nsa`.
- **Bars can appear with no dBm figures at all.** If no per-technology reading is plausible, the coarse 0–100 % signal-quality percentage the modem publishes is mapped to bars (percentage divided by 20, rounded, capped at 5). You get a glyph and no numbers on hover. Arming extended sampling on the host fixes it — see below.

### Getting real dBm figures out of a host modem

ModemManager only publishes the detailed per-technology signal figures when extended signal sampling is switched on. The edge asks for it best-effort every time it finds nothing plausible published, but that call needs a privilege a headless service does not always have. To guarantee the figures, arm it once on the host:

```bash
mmcli -m <N> --signal-setup=5
```

The optional [keep-alive daemon](/edge/bonding-cellular-modem/#install-the-keep-alive-daemon-optional-opt-in) re-arms this on every watch cycle, so on a host running the daemon it survives reboots and modem re-enumeration.

## Timing — how fresh the numbers are

| Behaviour | Value |
|---|---|
| Poll interval, all sources | 10 s |
| Per-source sample budget | 4 s, after which that source is treated as failed for the cycle |
| Router HTTP connect / request timeouts | 2 s / 4 s |
| Health tick that carries the data to the manager | 15 s |
| Snapshot age at which a reading is evicted | 60 s |
| First sample after node start | one poll interval, so about 10 s |

The poller writes into a cache; the health tick reads that cache. No HTTP request or D-Bus call ever happens on a health tick, and none of this runs anywhere near the media path — a hung router costs you a blank signal strip, never a glitch on air.

Eviction at 60 s is deliberate: when a modem disappears the strip goes to **no data** rather than freezing on the last good reading, so a stale number can never be mistaken for a live one. A *router* that fails its poll is different — it keeps its row and shows the error cause, because "I cannot reach your router" is more useful than silence.

## Events

All node-level (no flow id), category `cellular`. Every one carries `details.error_code` and `details.interface`.

The signal, unreachable and keeper events are debounced or hysteretic, so a marginal link does not flood the events page. `cellular_registration_changed` is the exception: it fires on **every** registration transition, which is deliberate — a run of `searching` ↔ `registered_home` pairs in the feed is itself the diagnostic that the modem keeps losing the network.

| `error_code` | Severity | Fires when | What to do |
|---|---|---|---|
| `cellular_registration_changed` | info, or warning | Registration state changes. Warning when the new state is `denied`, `sim_missing` or `sim_pin_required`; info otherwise. Carries `from`, `to`, `operator`, `access_tech`, `roaming`. | Info transitions are normal on a mobile link. On `denied`, check the plan and APN with the carrier. On `sim_missing`, reseat the SIM — on a USB module a cold power cycle clears a stuck one that a reboot does not. On `sim_pin_required`, unlock the SIM or clear the operator lock. |
| `cellular_signal_degraded` | warning | Bars drop to 1 or 0. | Reposition or re-aim the antenna, and read RSRP and SINR rather than the bar count — a good RSRP with a negative SINR is congestion or interference at the cell, which moving the antenna a metre will not fix. If this leg carries media, expect loss until it clears. |
| `cellular_signal_recovered` | info | Bars climb back to 3 or more. | Nothing. The gap between the two thresholds is hysteresis, so a link hovering at 2 bars does not flap the alarm. |
| `cellular_uplink_unreachable` | warning | A configured router fails 3 consecutive polls — so roughly 30 s. Carries `consecutive_failures`. | The signal strip shows the cause. Check the router is up and reachable from the node, that the LAN HTTP API is enabled, and that the read-only user still exists — a rejected login and an unreachable host both land here. |
| `cellular_uplink_recovered` | info | A router poll succeeds after being unreachable. | Nothing. |
| `cellular_keeper_missing` | warning | A host-attached modem sits `disabled` or `searching` for 3 consecutive polls with no keep-alive daemon running. Carries `state`. | The modem is parked and nobody on the node can wake it from the manager. Run the keep-alive daemon installer once on the host — see [Install the keep-alive daemon](/edge/bonding-cellular-modem/#install-the-keep-alive-daemon-optional-opt-in). Never fires for a router source: a router keeps its own bearer. |

## Waking a dormant modem

A USB modem with no traffic on it drops to idle, and the carrier may tear the bearer down. An operator who only has the manager UI then cannot start a flow over that leg: there is no traffic to wake the modem, and the edge has no rights to drive it — ModemManager denies the control action to a headless service, and even a successful connect would not apply the carrier's lease to the interface, so the bond leg would still have nothing to bind to.

The telemetry side of the answer is what this page owns:

- **`keeper_active`** on a modem source says whether the host's opt-in keep-alive daemon is currently running, detected from a heartbeat file no more than 120 s old. The strip shows a green `⬢ keeper` or an amber `⬡ no keeper` marker.
- **The `cellular-control` capability** is advertised on the health tick only while that heartbeat is fresh. The manager shows a **Wake** button — on the Network Interfaces card and inline on a dormant cellular bond leg — only when the bit is present, so the button is never offered when nothing could service it.
- **`cellular_keeper_missing`** fires when a parked modem has no daemon behind it, so the absence is visible rather than silent.

Everything else — installing the daemon, what Wake actually does, the optional APN override that rides the request — belongs to the host setup and is documented on [USB Cellular Modem as a Bonding Path](/edge/bonding-cellular-modem/#wake-a-dormant-modem-from-the-manager-no-shell). The edge's own part of it is a file write into a file the installer pre-creates under the edge's service account; it gains no modem privilege from it, and the read-only guarantee at the top of this page is unaffected.

Wake is hidden entirely for router sources. A RutOS router manages its own bearer and has nothing to wake.

## What this does not do

- **No configuration of the radio.** No APN, band lock, network selection, technology lock, reboot, SIM switch or factory reset — on either source. Read-only means read-only.
- **No traffic steering.** Nothing here moves media onto or off a cellular link, changes a bond scheduler's weights, or fails a leg over. Bonding makes those decisions from its own measurements of the path; radio state is for the human.
- **No data-cap enforcement.** Usage is reported where a router publishes it. Nothing acts on it.
- **No cell identity, temperature or usage from a host-attached modem** — see the note above. Those four fields are router-only.
- **No signal strip on gateway-mode, QUIC or RIST bond legs, and none on the receiving side.** There is no egress interface to join on. Pin the leg to an interface if you want the strip.
- **No Prometheus metric, and nothing on the node's local dashboard.** The manager is the only surface.
- **Nothing installed on the router.** No agent, no sidecar, no firmware change — one read-only HTTP login per poll.
- **Not a substitute for a link test.** Bars tell you what the radio sees; they do not tell you what the bearer will carry. A cellular bearer's usable MTU is frequently well below 1500, and an oversized datagram is lost wholesale on a carrier-NAT path with a perfectly green signal strip. Fit the datagram to the path — see [Fit the datagram size to the cellular MTU](/edge/bonding-cellular-modem/#fit-the-datagram-size-to-the-cellular-mtu).

## See also

- [USB Cellular Modem as a Bonding Path](/edge/bonding-cellular-modem/) — bringing a modem up, source policy routing, the keep-alive daemon, wiring it into a bond, MTU fitting.
- [Bonding Network Setup](/edge/bonding-network-setup/) — the outdoor-5G-router case, where the router presents a normal Ethernet interface.
- [Multi-Path Bonding](/edge/bonding/) — schedulers, per-leg statistics, bonding over a relay.
- [Starlink Dish Telemetry](/edge/starlink/) — the satellite equivalent of this page: same tab, same strips, same event shape.
- [Events & Alarms](/edge/events-and-alarms/) — the full event reference, including the `cellular` category.
