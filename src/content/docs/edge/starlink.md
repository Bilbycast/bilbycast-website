---
title: Starlink Dish Telemetry
description: Poll a Starlink terminal's own status endpoint for connectivity, obstruction, throughput, latency, drop-rate and hardware alerts, and read it back per network interface and per bond leg. Read-only — the edge never configures, steers or reboots the dish.
sidebar:
  label: Starlink Telemetry
  order: 10
---

An edge node that egresses over a Starlink terminal can poll **the dish itself** for live link state and show it next to the interface it belongs to: connected / searching / booting, sky obstruction, downlink and uplink throughput, round-trip latency to the Starlink PoP, ping drop rate, hardware alerts, uptime and the dish's firmware version.

Two things it deliberately is not:

- **It does not control the dish.** The edge asks the terminal one fixed question — *what is your status* — and there is no command, field or button anywhere in bilbycast that does more: no reboot, no stow, no re-aim, no configuration write, no firmware action. Nothing is installed on the Starlink hardware, no sidecar runs alongside it, and no Starlink account credential is involved.
- **It does not feed media scheduling.** The [bonding](/edge/bonding/) scheduler measures each leg's real throughput, loss and RTT for itself and never reads these figures. A dish reporting an obstruction does not, by itself, change how the bond splits traffic. Treat this page's numbers as instrumentation for the operator watching the show, not as an input to the transport.

A node egressing over a mobile uplink has a direct equivalent — same **Uplink Monitoring** tab, same per-interface and bond-leg strips, same event shape: see [Cellular Uplink Telemetry](/edge/cellular/).

## What you need

- **A terminal the node can reach on its LAN.** Every Starlink dish answers its status endpoint at `192.168.100.1:9200`, in the clear and unauthenticated on the local network. There is no username, password, API key or token to configure, and nothing lands in `secrets.json` — the whole configuration lives in `config.json` and is safe for the manager to hold.
- **Nothing to install or enable in the build.** Unlike [display](/edge/display/) or [SDI](/edge/sdi/), this is not behind a build feature. Every release binary can poll a dish; a node with no dish configured runs no poller work at all.
- **`CAP_NET_ADMIN`, so the edge can keep the route to the dish alive.** The packaged systemd unit already grants it — see [The route to the dish](#the-route-to-the-dish) for what happens if you run outside it.
- **The dish address, not the router address.** Starlink's router answers a *different* query on its own endpoint (`:9000`). Point an uplink at it and the edge tells you so explicitly: the reachability test reports that the response carried no dish status and names `192.168.100.1:9200` as the address to use.

## Turn it on

In the manager: **Admin → Nodes**, click the node, **Configure**, then the **Uplink Monitoring** tab → **Starlink dish uplinks** → **Add Dish**. Three fields — *Interface (edge netdev)*, *Dish gRPC address (host\[:port\])*, and *Source IP*, which stays blank unless this host has more than one dish.

Use **Test reachability** before you save. It runs one live status read against the address you typed and prints back the decoded state, hardware and software version, device id, obstruction fraction, PoP ping latency and drop rate, throughput, bar count and any active alerts — or the exact failure cause. It persists nothing, so it is safe to hammer while you sort out cabling.

The same thing in `config.json`:

```json
"starlink_uplinks": [
  {
    "interface": "wlo5",
    "address": "192.168.100.1:9200"
  }
]
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `interface` | string | *required* | The kernel netdev this telemetry annotates — `"wlo5"`, `"eth2"`, … Max 64 characters, unique across entries. It is both the key the UI joins on **and** the device the dish route is programmed against. |
| `address` | string | `"192.168.100.1:9200"` | Dish status endpoint as a bare host or `host:port` — no scheme, no path (max 253 characters). A bare host gets port 9200. Overridable for a re-IP'd or NATed terminal, but SpaceX fixes the default on every dish, so most installs never touch it. |
| `source_address` | string | *unset* | Local IP to bind this dish's poll to. **Only needed when one host polls more than one dish** — see [More than one dish on one host](#more-than-one-dish-on-one-host). Must be a bare IP address. |
| `gateway` | string | *unset* | Next-hop for the route the edge maintains to the dish subnet. Must be a bare IP address. Not exposed in the manager form — set it in `config.json` when the derived gateway is wrong. An entry that already carries one keeps it when you edit that dish from the UI. |

Config validation rejects, with a message naming the offending uplink: an empty or duplicated `interface`, an empty `address` or one containing `://` or `/`, and a `source_address` or `gateway` that is not a valid IP.

A pushed change is applied live. The poller re-reads the node's configuration on every cycle, so adding, editing or removing a dish takes effect within ~10 seconds — no flow restart, no node restart.

:::caution[`interface` must be the exact netdev name on the edge host]
This is the name of a network interface **on the edge node** — check it against `ip -br link` on the node, or pick it from the drop-down the manager form offers rather than typing it.

A name that matches no interface on the host goes wrong in two places at once, and on most dish deployments the loud half is what you will actually see:

- **Nothing renders.** The sample is cached under a name no interface matches, so no strip appears — not on the Network Interfaces card, not on any bond leg. No error, no event.
- **The dish route is never programmed.** The interface name is also what gateway resolution runs against, and with no such interface neither the kernel default-route lookup nor the `.1` fallback can produce a next hop, so the route described below is silently skipped. On a leg that depends on that route — the Starlink Mini Wi-Fi case this page is written around — the poll then fails every cycle, the row renders `⚠ UNREACHABLE`, and a `starlink_uplink_unreachable` Warning fires after three cycles.

So a typo'd interface is a common cause of an unreachable event that reads like a cabling or routing fault. The purely silent outcome only holds on a host that already reaches `192.168.100.0/24` some other way.
:::

## The route to the dish

This is the part that bites deployments, so it is worth understanding before you install anything.

The dish's status endpoint sits on its **own** `/24` — `192.168.100.0/24` — which is not the subnet the Starlink router hands your host, and not on the host's default route. Reaching it means having a route to that subnet via the Starlink LAN gateway. On a Wi-Fi leg like a Starlink Mini, that route is also fragile in the ordinary course of events: it goes away on a re-associate or a new DHCP lease.

**The edge programs and re-asserts that route itself. You do not add it by hand, and you should not try to own it.** On every poll cycle (10 s) the edge re-installs the `/24` containing the dish address via the leg's gateway, on that leg's device, in the **main** routing table, with replace semantics. It is idempotent, and it survives Wi-Fi re-associations and lease changes with no operator action.

The gateway is resolved in this order:

1. an explicit `gateway` on the uplink entry, when set;
2. otherwise the interface's **real default-route next-hop**, read from the kernel — so it works on whatever addressing your site uses, with no assumption about the subnet;
3. only when that interface has no default route installed at all, `.1` of its own `/24`.

Because the route is scoped to the dish's `/24` in the main table — never a default route, never a policy rule — it cannot shadow your own default route or your bond legs' policy routing.

:::note[What the edge does *not* maintain]
Only the dish telemetry route. If the interface is also a **bond leg**, its egress default route and `ip rule` are yours to keep up, and those *are* flushed when a Wi-Fi link cycles. [Bonding Network Setup](/edge/bonding-network-setup/#wi-fi--starlink-uplinks-as-a-bond-leg) covers the leg side. A common confusion on site: the dish telemetry keeps working across a re-associate while the media leg goes quiet, because the edge owns one route and not the other.
:::

### Running outside the packaged unit

Route programming needs `CAP_NET_ADMIN`. The packaged systemd unit grants it ambiently, so a normal install has nothing to set up. Run the binary yourself as an unprivileged user and the route install fails silently — it is logged at debug level, the edge carries on, and the dish stays unreachable until a route exists. Add the equivalent by hand, for a leg `wlo5` whose Starlink gateway is `192.168.4.1`:

```bash
sudo ip route replace 192.168.100.0/24 via 192.168.4.1 dev wlo5
```

Persist it (netplan `routes:` under the interface) so it survives a reboot. A hand-added route is harmless once the capability is restored — the edge replaces rather than duplicates.

Route programming is also skipped when the dish `address` is a hostname or an IPv6 address, when the interface is down or has no address yet, or when no gateway can be derived. In those cases the poll still runs; it just needs a route to already exist.

## More than one dish on one host

Every Starlink dish hard-codes the **same** management address. There is no way to change it on the dish. So two dishes on one host, reached over two interfaces, collide: a single `192.168.100.0/24` route in the main table can only point one way, and it is re-asserted every cycle for each configured uplink in turn, so it is not something you can rely on to disambiguate.

What separates them is a **source-IP bind plus per-leg policy routing**:

1. Leave `address` at `192.168.100.1:9200` on *every* dish — it is genuinely the same address.
2. Give each uplink the `source_address` of the leg it lives on. The edge binds that dish's poll to that local IP.
3. Add a policy route per leg on the host, so a packet from that source IP leaves the right interface. This part is manual — the edge binds the poll but does not install these rules.

```json
"starlink_uplinks": [
  { "interface": "wlo5",  "address": "192.168.100.1:9200", "source_address": "192.168.4.102" },
  { "interface": "wwan0", "address": "192.168.100.1:9200", "source_address": "192.168.5.102" }
]
```

```bash
# leg 1 — wlo5
ip rule  add from 192.168.4.102 table 80
ip route add 192.168.100.0/24 via 192.168.4.1 dev wlo5  table 80
# leg 2 — wwan0
ip rule  add from 192.168.5.102 table 81
ip route add 192.168.100.0/24 via 192.168.5.1 dev wwan0 table 81
```

Config validation enforces the rule so you cannot half-do it: when two or more uplinks share an `address`, each **must** carry a distinct `source_address`. A missing or duplicated bind is rejected at save time with a message saying why. A single-dish install is unaffected — leave `source_address` unset.

:::caution[Loosen reverse-path filtering on the legs, or the replies vanish]
A multi-homed host with per-leg tables is asymmetric by construction, and Linux's strict reverse-path filter drops the dish's reply on the way back in — silently, with no log, no error and no event beyond a plain `starlink_uplink_unreachable`. Set loose mode on the dish-bearing interfaces:

```bash
sudo sysctl -w net.ipv4.conf.wlo5.rp_filter=2 net.ipv4.conf.wwan0.rp_filter=2
```

Per-interface `rp_filter` resolves as `max(conf.all, conf.<iface>)`, so also check `net.ipv4.conf.all.rp_filter` — a `1` there overrides your per-interface `2`. Persist both in a `/etc/sysctl.d/` drop-in; netplan cannot set them. The same caveat applies to bonded 5G modem legs and is covered in [Bonding Network Setup](/edge/bonding-network-setup/).
:::

## What is reported

Each dish is sampled every **10 seconds**, with any single attempt abandoned after at most 6 seconds so a hung dish cannot hold up the cycle. The sample is read into the node's next health report, which the manager receives every ~15 seconds — so allow roughly 25 seconds from configuring a dish to seeing its first numbers.

| Field | Meaning |
|-------|---------|
| `state` | Dish connectivity: `connected`, `searching`, `booting`, `offline` or `unknown`. `offline` is the edge's own marker for a dish that did not answer the poll. `unknown` means the dish reported a state this build does not map. |
| `currently_obstructed` | Whether the dish sees a sky obstruction right now. Shown as an amber **Obstructed** pill, which overrides the state pill. |
| `obstruction_fraction` | Fraction of the dish's rolling window that was obstructed, `0`–`1`. Displayed as `OBS n.n%`. The headline quality axis — this is the satellite equivalent of a signal-strength reading. |
| `pop_ping_drop_rate` | Fraction of the dish's pings to the Starlink PoP that were dropped, `0`–`1`. Displayed as `DROP n.n%`. The reliability axis. |
| `pop_ping_latency_ms` | Round-trip time from the dish to the Starlink PoP. Displayed as `PING nms`, and it is the one figure shown in the compact bond-leg strip. |
| `downlink_bps` / `uplink_bps` | Instantaneous throughput reported by the dish, shown as `↓` / `↑`. This is the dish's own view of its traffic, not your flow's bitrate. |
| `seconds_to_first_nonempty_slot` | The dish's own prediction of how long until its next usable slot. |
| `alerts` | Active hardware alerts, empty when clear: `thermal_throttle`, `thermal_shutdown`, `motors_stuck`, `unexpected_location`, `mast_not_near_vertical`, `slow_ethernet_speeds`. A flag this build has no name for appears as `alert_<n>` rather than being hidden. |
| `uptime_s` | Dish uptime. |
| `device_id`, `hardware_version`, `software_version`, `country_code` | Terminal identity and firmware. Useful for correlating a fleet-wide behaviour change with a dish firmware roll. |
| `snr` | Legacy signal-to-noise figure. Current firmware does not report it, so expect it to be absent; it is surfaced when an older dish still sends it. |
| `bars` | Derived `0`–`5` quality figure — see below. |
| `sampled_at_unix_ms` | When this snapshot was taken. Drives the `⟳ Ns` age hint next to the strip, which turns amber past 30 s and red past 60 s. |

### Quality bars

`bars` is the **worse** of two independent axes, so one bad axis is enough to pull the count down:

| Bars | PoP-ping drop rate | Obstruction fraction |
|------|--------------------|----------------------|
| 5 | ≤ 0.5 % | ≤ 0.1 % |
| 4 | ≤ 2 % | ≤ 0.5 % |
| 3 | ≤ 5 % | ≤ 1 % |
| 2 | ≤ 10 % | ≤ 2 % |
| 1 | ≤ 25 % | ≤ 5 % |
| 0 | > 25 % | > 5 % |

Bars are **0 whenever the dish is not `connected`** — searching, booting, unknown and unreachable all read zero, and only the state pill tells them apart. A dish that is connected but reports neither quality figure shows a grey, empty glyph rather than a misleading five.

Colour follows the bar count: **green at 4–5**, **amber at 2–3**, **red at 0–1**, grey when there is no figure. Read the colour first; the raw percentages are on the strip and in the hover tooltip.

## Where it shows up

- **Network Interfaces card**, on the node detail page — the full strip: bar glyph, `STARLINK` badge, state pill, `↓`/`↑` throughput, `OBS` / `PING` / `DROP` figures, any active alerts, and the sample age.
- **Bond legs**, on the flow's bonded-path table — a compact strip (bars, badge, state pill, ping latency). The join is by interface name, and only some legs carry one. A leg gets a strip when **all** of the following hold:
  - it is on the **sending** side (a bonded output). Receive-side legs never report an egress interface.
  - it is a **UDP** leg or a **relay** leg — not QUIC, not RIST.
  - it is pinned in **interface mode**, i.e. it names an `interface` and has no `gateway`. A gateway-mode leg steers through a policy route rather than a NIC pin, reports its binding as `gateway`, and carries no interface to join on.

  That is a real limitation, not a rendering quirk, and it is the same rule the [cellular signal strip](/edge/cellular/#on-bond-legs) follows. If your legs are QUIC or RIST, or gateway-mode, the muted dash is expected — the dish is being polled perfectly well and the Network Interfaces card still shows it. Pin the leg to the interface if you want the strip.
- **Events page** — filter by the `starlink` category to see every dish event on the fleet, then narrow with the free-text search, which matches the event **message wording**: `obstructed`, `unreachable`, `alert`. Severity, node and date range filter alongside it.

:::note[Search matches the message, not the `error_code`]
`details.error_code` is on every event payload and is shown as a badge on the row, and it is what you should key an **external** alarm rule on — it is the stable identifier, while message wording is prose. But it is not a filter and not a search target on the Events page: typing `starlink_uplink_unreachable` into the search box returns nothing, because the message that was stored reads *starlink uplink 'wlo5' unreachable*. Search for `unreachable` instead, or fetch the events through the manager's API and match on the field.
:::

The node's own local monitor page does **not** carry this. Dish telemetry travels to the manager on the health report; the node's local `/health` surface deliberately leaves it out.

## Events

All are node-level (no flow), in category `starlink`, and carry `details.error_code` and `details.interface`. The full catalogue lives on [Events & Alarms](/edge/events-and-alarms/#starlink-dish-starlink).

The obstruction, alert and unreachable events are debounced or hysteretic, so a marginal link does not flood the feed. `starlink_state_changed` is the exception: it fires on **every** connectivity transition, which is deliberate — a run of `connected` ↔ `searching` pairs in the feed is itself the diagnostic that the dish keeps losing lock.

| `error_code` | Severity | Fires when | Operator action |
|--------------|----------|-----------|-----------------|
| `starlink_state_changed` | info, or **warning** into `unknown` | Dish connectivity changes — carries `details.from` and `details.to`. The first observation after a node start is not a transition and emits nothing. | Repeated `connected` ↔ `searching` means the dish keeps losing lock: check obstruction and the mount. A move into `unknown` while the quality figures stay sane points at a dish firmware state this build does not map, not at the link. |
| `starlink_obstructed` | warning | The dish reports a live sky obstruction. Carries `details.obstruction_fraction`. | Check the dish's view of the sky — this is nearly always a physical fix (relocate, raise, clear the branch). Expect throughput dips and short freezes on any unprotected feed riding that link. |
| `starlink_obstruction_cleared` | info | The obstruction goes away **and** the rolling obstruction fraction is back under 1 %. | None. The two-part condition is deliberate — a marginal mount that keeps re-clipping will not oscillate between the two events. |
| `starlink_alert` | warning | A dish hardware alert becomes active. One event per newly-raised alert; a steady alert does not re-fire, and a cleared one can fire again later. Carries `details.alert`. | `thermal_throttle` / `thermal_shutdown` — the dish is about to cap or drop throughput; shade or ventilate it. `motors_stuck` / `mast_not_near_vertical` — physical intervention. `slow_ethernet_speeds` — cabling between dish and router. |
| `starlink_uplink_unreachable` | warning | Three consecutive polls fail — roughly 30 seconds, longer if the dish black-holes rather than refuses. Carries `details.consecutive_failures`. Fires once, not per cycle. | This is the **management path**, not the media path. Work the checklist below. Do not treat it as "the link is down" — see the note under it. |
| `starlink_uplink_recovered` | info | A poll succeeds after being unreachable. | None. |

:::note[`starlink_uplink_unreachable` does not mean your feed is down]
Media egresses over the terminal's ordinary default route; telemetry goes to the dish's separate management subnet. Lose the route to the management subnet and the feed keeps running perfectly while this event fires. Alarm on it as *"we've lost visibility of the dish"*, and judge the feed itself from flow and bond-path health.
:::

## When telemetry does not appear

Work down this list — it is roughly in order of how often each one is the answer.

1. **Is the strip missing, or errored?** A configured dish that cannot be reached renders an explicit red `⚠ UNREACHABLE` row carrying the failure cause, not a blank. Nothing at all usually means the `interface` name does not match a real netdev, or the entry never saved.
2. **Give it ~25 seconds.** 10 s poll plus a 15 s health tick. The manager form's own confirmation, and the reachability test, are quicker checks than watching the card.
3. **Run Test reachability.** It reports the exact cause — connection refused, no response, wrong endpoint — without saving anything.
4. **Wrong endpoint?** If the failure says the response carried no dish status, the address is pointed at the Starlink router rather than the dish. Use `192.168.100.1:9200`.
5. **Route present?** `ip route get 192.168.100.1` on the node should resolve via the Starlink gateway on the dish's interface. If it does not, and you are not running under the packaged systemd unit, the edge lacks `CAP_NET_ADMIN` to install it — add the route by hand as shown above.
6. **Multi-homed host?** Confirm each uplink has its own `source_address`, that a matching `ip rule` and table exist, and that `rp_filter` is `2` on those interfaces **and** not forced to `1` by `net.ipv4.conf.all.rp_filter`.
7. **Bond leg with no strip but a healthy Network Interfaces card?** Expected on a receive-side leg, a QUIC or RIST leg, or a gateway-mode leg — none of those carry an egress interface to join on. Pin a sending-side UDP or relay leg to the interface (and leave its `gateway` unset) to see the strip.

## What this does not do

- **No control of any kind.** No reboot, stow, un-stow, re-aim, factory reset, Wi-Fi or router configuration, firmware action, or account operation. There is no hidden command and no plan to add one.
- **No traffic influence.** Nothing on the media path reads these figures. Bonding capacity, leg selection and failover are driven by the bond's own measurements.
- **No history.** Only the current snapshot is published. There is no dish-telemetry time series, graph or export — build history from the event feed, or from your own scrape of the manager.
- **No alarm thresholds you can set.** Obstruction, alerts and unreachability fire on the fixed conditions in the table above; the bar thresholds are fixed too. Build your own severity policy on the `error_code` values.
- **No Starlink router telemetry.** Only the dish is polled. The router's own endpoint answers a different query and is explicitly rejected.
- **IPv4 route maintenance only.** The automatic route covers an IPv4 dish address. A hostname or IPv6 address still polls fine, but you own the route.
- **What is reported depends on dish firmware.** Figures the edge does not recognise are skipped rather than treated as an error, so a firmware update that adds fields degrades cleanly — you simply do not see the new ones until an edge release adds them. The one thing that can move the other way is the connectivity state: if a firmware release introduces or renumbers a state, the pill can read **Unknown** while every quality figure beside it stays correct. That combination is a mapping gap, not a link fault.
