---
title: USB Cellular Modem as a Bonding Path
description: Bring up a host-attached USB cellular modem (e.g. Teltonika TRM500 / Quectel RG520N) via ModemManager and present it as an independent, source-routed egress path for bilbycast-edge multi-path bonding — with an optional keep-alive daemon for boot persistence, auto-reconnect, live signal telemetry, and one-click Wake from the manager UI.
sidebar:
  label: Cellular Modem Bonding Path
  order: 10
---

[Multi-Path Bonding](/edge/bonding/) aggregates several IP uplinks into one
reliable flow. There are two ways to attach a cellular uplink, and they need
different host setup:

- **An outdoor 5G *router*** (e.g. Teltonika **OTD500**) — a self-contained box
  with its own SIM, NAT, and DHCP that presents a normal Ethernet interface.
  That's covered in **[Bonding Network Setup](/edge/bonding-network-setup/)**.
- **A USB cellular *modem*** the edge host owns directly (e.g. Teltonika
  **TRM500** / Quectel **RG520N** 5G stick) — **this page.**

A USB modem is *not* a router. There's no box doing DHCP/NAT for you: the modem
presents a **raw-IP, point-to-point WWAN interface** (`wwan0`, `wwp0s20u4i4`, …)
whose IPv4 lease comes straight from the carrier via **ModemManager**, usually a
**CGNAT** address on a `/28` point-to-point link. So bringing it up means
*establishing a data bearer* and *applying the carrier's lease to the
interface* yourself — which is what the tooling here does.

## When to use which

| | USB cellular modem (this page) | Outdoor 5G router (OTD500) |
|---|---|---|
| Presents as | Raw-IP WWAN iface via ModemManager | Normal Ethernet iface (its LAN) |
| IP / DHCP | Carrier lease (CGNAT), no local DHCP | Router's own NAT + DHCP |
| Brought up by | `mmcli` + this script/daemon | The router itself |
| Powered by | Host USB | PoE |
| Best when | Modem plugged into the edge host | Modem mounted outside, on a PoE switch |

Both end the same way: each modem becomes **one pinned bond path**.

## Quick manual bring-up (for testing)

`packaging/setup-cellular-modem.sh` does the whole sequence — enable + register
the modem, establish the data bearer, apply the lease to the WWAN interface,
and install a **source-routed** default for the path. Only the **APN** is
required; the modem index and interface auto-detect.

```bash
sudo APN=<your-apn> bash packaging/setup-cellular-modem.sh
```

It prints the lease it applied, verifies egress with a source-pinned ping, and
confirms your host default route is **untouched**. Re-run any time — it's
idempotent (a no-op when the path is already up).

> **APN matters, and it isn't always obvious.** Retail and IoT SIMs on the same
> carrier often differ (e.g. an Optus retail SIM uses `connect`, a Truphone IoT
> SIM on Optus uses `truphone.com`). A wrong APN means the bearer never
> connects. If unsure, check what your SIM/plan documents, or read the network's
> attach APN: `mmcli -m <N> --simple-connect` fails fast on a bad APN.

For a dev box you can just re-run the script when you need the path. For
production, install the **daemon** below so it survives reboots and reconnects
on drop.

## Routing model — why source policy routing

This script deliberately uses **source-based policy routing**, *not* the
high-metric main-table default that [Bonding Network Setup](/edge/bonding-network-setup/#host-routing-explained)
uses for fixed router uplinks. The modem's default route lives in its **own
table** (default `70`), gated by an `ip rule` matching the modem's source
address:

```text
ip route add default via <gw> dev <wwan> onlink table 70
ip rule  add from <modem-ip> lookup 70 priority 1070
```

Two reasons this is the right default for a USB cellular modem:

1. **It's metered.** A high-metric default in the main table means that if your
   primary link flaps, the host *silently fails over onto cellular* and burns
   SIM data on background traffic (updates, the manager WebSocket, telemetry).
   Source policy routing makes that **impossible** — only traffic the edge
   explicitly pins to the modem (a bond leg) can ever use it.
2. **The host default route is never touched**, so SSH / management stay on your
   primary link throughout.

When the bond pins a leg to the modem interface (`SO_BINDTODEVICE`), the kernel
selects the modem's source address, the `ip rule` matches, and the packet
egresses via table `70`. Everything else ignores the modem entirely. The script
also sets `rp_filter = 2` on the WWAN interface so the multi-homed return
traffic isn't dropped.

## Install the keep-alive daemon (optional, opt-in)

A USB modem's bearer can drop on its own (idle, re-registration, signal), and
nothing it does survives a reboot. The optional daemon fixes both: it runs the
bring-up at boot and re-checks every `WATCH_INTERVAL` seconds, reconnecting the
bearer and re-applying the route if the carrier dropped it. While running it
also keeps ModemManager's extended **signal sampling** armed (so the manager's
live RSRP / RSRQ / SINR figures stay populated) and services **Wake** requests
from the manager UI — see [Wake a dormant modem from the manager](#wake-a-dormant-modem-from-the-manager-no-shell) below.

It is **opt-in** — install it only on hosts that actually use a USB cellular
modem as a bond leg. It does not touch bilbycast-edge itself.

```bash
# Install the daemon files (does NOT enable anything):
sudo packaging/install-cellular-modem.sh

# Set your APN, then enable:
sudo $EDITOR /etc/default/bilbycast-cellular-modem      # set APN=...
sudo systemctl enable --now bilbycast-cellular-modem.service
```

Or do it in one step:

```bash
sudo APN=connect packaging/install-cellular-modem.sh --enable
```

The installer places:

| File | Purpose |
|------|---------|
| `/opt/bilbycast/edge/current/packaging/setup-cellular-modem.sh` | bring-up + `--watch` logic (tracks edge upgrades) |
| `/etc/systemd/system/bilbycast-cellular-modem.service` | the daemon (`Type=simple`, `After=ModemManager.service`) |
| `/etc/default/bilbycast-cellular-modem` | config — **APN** + optional `MODEM_INDEX` / `MODEM_IFACE` / `IP_TYPE` / `TABLE` / `RULE_PREF` / `WATCH_INTERVAL` |

The installer never overwrites an existing env file, so your APN survives
reinstalls and edge upgrades. To install it together with a fresh edge, run
`install-edge.sh` first, then this — the daemon's `Before=bilbycast-edge.service`
ordering means the bond leg is up before the edge tries to pin to it.

```bash
systemctl status bilbycast-cellular-modem.service     # check it
sudo systemctl disable --now bilbycast-cellular-modem.service   # turn it off
```

## Wake a dormant modem from the manager (no shell)

With the keep-alive daemon enabled, an operator can wake a parked modem **from
the manager UI — no shell, no `sudo`**. This is the production answer to a real
problem: if the modem has been idle and its bearer dropped, and an operator
decides to start a flow over the cellular leg, there's no traffic to wake it and
the edge has no rights to drive ModemManager itself (ModemManager's
`Device.Control` is denied to a headless service).

The edge stays **read-only** toward the modem. Rather than calling `mmcli`, it
uses a **request/execute split** (mirroring the PTP helper's config file):

- The edge shows a **Wake** button on the node's **Network Interfaces** card and
  on each cellular **bond leg** — visible only when the daemon is running to
  service it (advertised via the `cellular-control` capability). It writes a
  request to `/var/lib/bilbycast/cellular-wake.req`.
- The daemon picks the request up within ~1 s, runs the bring-up immediately
  (short-circuiting its watch interval), and writes back the outcome. The button
  reports **connected** / **failed** / **requested**.
- An optional **APN** rides the request, so a wrong APN can be corrected from the
  UI without editing the env file.

If a modem is parked with **no daemon installed**, the manager raises a
`cellular_keeper_missing` warning instead of showing a dead button — the signal
to have the host's installer run `install-cellular-modem.sh --enable` once.

> The edge gains **no** modem privilege from any of this: it only writes a file
> the installer pre-creates under its own service account, and a root daemon
> executes the request. All privileged work stays in the opt-in daemon, and
> cellular *telemetry* remains strictly read-only.

## Wire it into bonding

The modem is now one interface (`wwan0`, or whatever auto-detected — check
`ip -br addr`). Pin a bond path to it exactly like any other interface in a
[bonded output](/edge/bonding/#bonded-output-sender):

```json
"scheduler": "media_aware",
"paths": [
  { "id": 0, "name": "cellular",
    "transport": { "type": "udp", "remote": "203.0.113.5:5000", "interface": "wwan0" } },
  { "id": 1, "name": "fixed",
    "transport": { "type": "udp", "remote": "203.0.113.5:5001", "interface": "eth0" } }
]
```

> **`SO_BINDTODEVICE` needs `CAP_NET_RAW`** on Linux — grant it without running
> the edge as root:
> ```bash
> sudo setcap cap_net_raw+ep /opt/bilbycast/edge/current/bilbycast-edge
> ```
> or add `AmbientCapabilities=CAP_NET_RAW` to the edge's systemd unit.

Scheduler choice, ARQ/NACK tuning, and stats are all on the
[Multi-Path Bonding](/edge/bonding/) page.

## Verify

```bash
ip -br addr show                       # WWAN iface up with its carrier lease
mmcli -m <N>                           # state: connected, signal quality
ping -I wwan0 -c3 8.8.8.8              # device-bound → out the cellular path
curl --interface wwan0 -s https://api.ipify.org   # the carrier's public IP
ip route show table 70                 # default via <gw> dev wwan0
ip route show default                  # your host default — should be UNCHANGED
```

The `curl` is the clearest proof: it returns the **carrier's** public IP, not
your fixed link's — so traffic is genuinely leaving via the modem.

## Troubleshooting

- **`mmcli -L` shows no modem** — the stick isn't enumerated. Check `lsusb` for
  the module and that ModemManager is running (`systemctl status ModemManager`).
  After a reset, an outdoor/USB module can take 30–120 s to re-appear; a *cold*
  power cycle clears a stuck module that a warm reboot didn't.
- **Bearer won't connect** — almost always the **APN**. Confirm the correct APN
  for your SIM/plan (retail vs IoT differ), set `APN=` and retry.
- **5G registration rejected with "UE identity cannot be derived" (5GMM cause
  #9)** — the SIM isn't happy on the carrier's **5G Standalone (SA)**. Keep 5G
  but force **NSA** (5G anchored on LTE, which registers cleanly), or fall back
  to LTE:
  ```bash
  mmcli -m <N> --command='AT+QNWPREFCFG="nr5g_disable_mode",1'   # Quectel: disable SA, keep NSA
  ```
  NSA is still 5G; only SA is disabled.
- **Registered but weak/fluctuating signal** — read the real metrics (RSRP /
  SINR), not bars. For a Quectel module: `mmcli -m <N> --command='AT+QENG="servingcell"'`.
  Aim for RSRP better than ~−95 dBm and SINR above 0; reposition the antenna at
  the margin.
- **Bond paths all leave via one link** — the modem path isn't pinned, or its
  table-`70` default is missing. Check `ip route show table 70` and confirm
  `interface` is set on the bond path.
- **Background traffic on the metered SIM** — you used a main-table default
  instead of the source-routed one. This script's policy routing prevents that;
  re-run it to restore the table-`70` rule.
- **`SO_BINDTODEVICE` permission denied** — `CAP_NET_RAW` not granted to the
  edge; see [Wire it into bonding](#wire-it-into-bonding).
