---
title: Bonding Network Setup — Multiple 5G Modems
description: Wire several outdoor 5G modems (e.g. Teltonika OTD500) behind a PoE switch and present each as an independent egress path to bilbycast-edge for multi-path bonding — physical-NIC and VLAN-tagged designs.
sidebar:
  label: Bonding Network Setup
  order: 9
---

[Multi-Path Bonding](/edge/bonding/) aggregates several IP uplinks into one
reliable flow. This page is the **network plumbing** that sits underneath it:
how to connect several outdoor 5G modems — using the **Teltonika OTD500** as a
running example, though any IP modem/router works the same way — behind a
single PoE switch, and present each one to the edge host as its own
independently-routable interface so the bonding scheduler can pin a path to
each modem.

There are two ways to do that, and you can mix them:

- **Design A — one physical NIC per modem.** Dead simple, no VLANs on the host.
- **Design B — one NIC, VLAN-tagged.** One cable carries every modem as a
  tagged sub-interface. Scales to many modems on a single fast NIC.

## Why each modem needs its own interface

The bond scheduler sends each path out a *specific* uplink. On the host that
means each modem must appear as a **distinct, independently-routable network
interface** — a real NIC, or a VLAN sub-interface. The bonded output then pins
each path to one of them (the `interface` field on a UDP path, which uses
`SO_BINDTODEVICE` on Linux).

If every modem shares one interface and subnet, the kernel routing table
collapses them onto a single default route and the "bond" is cosmetic — all
paths leave through whichever modem wins the route lookup.

Giving each path **its own interface — a physical NIC or a VLAN sub-interface —
is the easiest and most robust way to do this**, and it's what this guide
recommends: the device binding is unambiguous and each interface needs only a
single route. A shared-interface alternative (one NIC, multiple IPs, policy
routing) exists for when you can't add interfaces or grant `CAP_NET_RAW` — see
[Alternative: one interface, multiple IPs](#alternative-one-interface-multiple-ips).

## Topology

```
 ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   outdoor 5G modems
 │  OTD500 #1  │   │  OTD500 #2  │   │  OTD500 #3  │   (PoE-in, IP55)
 │ 5G ▸ NAT ▸  │   │ 5G ▸ NAT ▸  │   │ 5G ▸ NAT ▸  │
 │ LAN 10.0.11.1│  │ LAN 10.0.12.1│  │ LAN 10.0.13.1│
 └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
        │ PoE (power+data, single Cat6)     │
        └──────────────┬───────────────────┘
                       ▼
              ┌──────────────────┐
              │   PoE switch     │  access port per modem (one VLAN each)
              │  (managed if     │
              │   using VLANs)   │
              └────────┬─────────┘
                       │  Design A: one access port → one NIC per modem
                       │  Design B: one tagged trunk → one NIC, VLAN sub-ifs
                       ▼
              ┌──────────────────┐
              │   Edge host      │  one interface per modem →
              │ (bilbycast-edge) │  one bond path per interface
              └──────────────────┘
```

## What you need

- A **PoE switch** that can power the modems. The OTD500 takes **802.3af/at
  (PoE / PoE+)** on its PoE-in port (42.5–57 V; ≤ ~30 W). PoE++ (802.3bt)
  switches are backward-compatible and power it fine. For **Design B** the
  switch must be **managed / VLAN-capable**; Design A only needs per-port VLAN
  separation if all modems share one switch.
- **N outdoor 5G modems.** The OTD500 is IP55, dual-SIM + eSIM, gigabit
  Ethernet, and ships **without a PSU** — it's powered over the PoE-in cable.
- **Outdoor/shielded Cat6** for each modem run, and an **Ethernet surge
  arrestor** on each run where it enters the building (the modems sit outside;
  that copper is a surge path into your switch and host).
- An **edge host** with either N spare NICs (Design A) or one spare NIC
  (Design B).

## Two designs at a glance

| | Design A — physical NIC per modem | Design B — one NIC, VLAN-tagged |
|---|---|---|
| Host NICs used | One per modem | One total |
| Switch | Per-port VLAN/subnet isolation | Managed, 802.1Q trunk |
| Scales to many modems | Limited by NIC count | Yes — bounded by NIC bandwidth |
| Cabling to host | One cable per modem | One cable |
| Host config | Address per NIC | Trunk + VLAN sub-interfaces |
| Best when | A few modems, spare NICs, want simplest | Many modems, one fast NIC (e.g. 25G), want to scale |

> **The switch config is nearly identical in both designs** — one VLAN per
> modem, each modem on an *access* port. The only difference is how the **edge
> host** consumes those VLANs: as separate untagged ports into separate NICs
> (A), or as one tagged trunk into one NIC (B).

## Addressing convention

A clean, memorable scheme: **VLAN _N_ ↔ subnet `10.0.N.0/24`**, with the modem
at `.1` (the gateway for that path) and the host at `.2`. Each modem **must**
be on its own subnet — the host needs a distinct gateway per path.

| Path | VLAN | Modem LAN IP | Host IP | Gateway (modem) |
|------|------|--------------|---------|-----------------|
| 1 | 11 | `10.0.11.1/24` | `10.0.11.2/24` | `10.0.11.1` |
| 2 | 12 | `10.0.12.1/24` | `10.0.12.2/24` | `10.0.12.1` |
| 3 | 13 | `10.0.13.1/24` | `10.0.13.2/24` | `10.0.13.1` |

## Step 1 — Configure each 5G modem

Each modem is a **VLAN-unaware NAT router**. You only change two things, and
they're identical except the subnet:

1. **Set a unique LAN IP** per the table above.
2. **Disable its DHCP server** (the host uses a static address). On an isolated
   per-VLAN segment you *can* leave DHCP on, but static is simplest for a
   server host.

Leave the cellular/WAN side as your carrier needs it (SIM + APN), and **do not**
configure VLANs on the modem — the switch does the tagging.

**OTD500 specifics (running example):**

- Insert an activated SIM, power it from the switch's PoE port (single cable),
  and browse to its default `https://192.168.1.1`.
- Log in with `admin` / `admin` — you're forced to set a new password, then the
  Setup Wizard runs (time, then Mobile/APN; APN is usually auto-detected).
- Change the LAN IP under **Network → Interfaces → LAN → General Setup**; toggle
  DHCP on the **DHCP Server** tab. Saving the new LAN IP drops the WebUI session
  — reconnect at the new address.

> **Gotcha:** two factory-fresh modems are both `192.168.1.1`. If they land on
> the same segment before you re-IP them, they collide. Either set the switch
> VLANs first (so each is isolated from the start), or configure the modems one
> at a time on the bench, then deploy.

## Step 2 — Configure the switch (common to both designs)

Create **one VLAN per modem** and make each modem's port an **access** port:

- Modem port → **access / PVID = that modem's VLAN**, untagged toward the
  (VLAN-unaware) modem.
- Ensure **PoE is enabled** on the modem ports.

The exact CLI/GUI varies by vendor; conceptually, for VLANs 11 and 12:

```
# create VLANs
vlan 11,12

# port to modem #1 — access, untagged, PVID 11
interface <port-to-modem-1>
  switchport access vlan 11      # or: vlan pvid 11 + participation include 11

# port to modem #2 — access, untagged, PVID 12
interface <port-to-modem-2>
  switchport access vlan 12
```

The edge-facing port is where the two designs diverge.

## Design A — one physical NIC per modem

**Switch:** make each edge-facing port an **access** port in the matching
modem VLAN — one port per modem, each cabled to its own NIC on the host.

```
interface <edge-port-for-modem-1>
  switchport access vlan 11      # → host NIC #1
interface <edge-port-for-modem-2>
  switchport access vlan 12      # → host NIC #2
```

**Host:** each NIC gets its modem's subnet. With netplan:

```yaml
network:
  version: 2
  ethernets:
    eth1:                          # cabled to modem #1's VLAN
      addresses: [10.0.11.2/24]
      dhcp4: false
      routes:
        - { to: default, via: 10.0.11.1, metric: 1011 }
    eth2:                          # cabled to modem #2's VLAN
      addresses: [10.0.12.2/24]
      dhcp4: false
      routes:
        - { to: default, via: 10.0.12.1, metric: 1012 }
```

The host now has `eth1`, `eth2`, … — one per modem. See
[Host routing explained](#host-routing-explained) for why the routes look like
that. Skip ahead to [Wire it into bonding](#wire-it-into-bonding).

## Design B — one NIC, VLAN-tagged

One host NIC carries every modem as a tagged VLAN. This is the
**802.1Q trunk with an optional native VLAN** pattern: a single physical port
can carry untagged frames (the NIC's existing use, if any) **and** tagged
frames for each modem VLAN at the same time.

**Switch:** make the edge-facing port a **trunk** — a **tagged** member of every
modem VLAN. Optionally keep an **untagged native VLAN** if the NIC still serves
its existing role.

```
interface <edge-trunk-port>
  switchport trunk allowed vlan 11,12      # tagged members
  # (optional) switchport trunk native vlan 1   # untagged passthrough
```

> Keep the modem VLANs **strictly tagged** on this trunk. Don't make a modem
> VLAN the native/untagged VLAN, or its traffic leaks into the untagged
> segment.

**Host:** one trunk interface plus a VLAN sub-interface per modem. Replace
`enp1s0f0` with your switch-facing NIC:

```yaml
# /etc/netplan/60-bonding-5g.yaml  (chmod 600)
network:
  version: 2
  ethernets:
    enp1s0f0:                      # 25G/10G trunk to the switch
      dhcp4: false
      dhcp6: false
      mtu: 1500                    # modem LAN is gigabit/1500 — don't jumbo
      optional: true
  vlans:
    wan5g11:                       # tagged VLAN 11 → modem #1
      id: 11
      link: enp1s0f0
      mtu: 1500
      addresses: [10.0.11.2/24]
      dhcp4: false
      routes:
        - { to: default, via: 10.0.11.1, metric: 1011 }
    wan5g12:                       # tagged VLAN 12 → modem #2
      id: 12
      link: enp1s0f0
      mtu: 1500
      addresses: [10.0.12.2/24]
      dhcp4: false
      routes:
        - { to: default, via: 10.0.12.1, metric: 1012 }
    # add a third modem by copy-paste: bump 13 everywhere.
```

Naming the sub-interfaces without dots (`wan5g11`, not `enp1s0f0.11`) keeps the
`sysctl` paths below clean and reads better in the bonding interface picker.

Apply:

```bash
sudo netplan try          # auto-reverts in 120 s if you lose the box
sudo netplan apply
```

## Host routing explained

The interface-per-path design needs just **one route per modem interface** — a
default route via that modem, in the main table, at a **high metric**:

```yaml
routes:
  - { to: default, via: 10.0.11.1, metric: 1011 }
```

When the bond pins a path to an interface (the `interface` field →
`SO_BINDTODEVICE`), the kernel scopes the route lookup to that interface and
finds *its* default route → out the right modem. The high metric keeps these
off the host's real default route, so un-pinned traffic still uses your
management/WAN link. That's the whole routing story — **no policy tables, no
`ip rule` juggling** (those are only needed for the shared-interface
[alternative](#alternative-one-interface-multiple-ips) below).

Then set **loose reverse-path filtering** on the modem interfaces so
asymmetric/multi-homed return traffic isn't dropped (netplan can't set this;
use a sysctl drop-in):

```ini
# /etc/sysctl.d/90-bonding-5g.conf
net.ipv4.conf.wan5g11.rp_filter = 2
net.ipv4.conf.wan5g12.rp_filter = 2
```

```bash
sudo sysctl --system      # re-run after netplan apply (the sub-ifs must exist)
```

Per-interface `rp_filter` wins via `max(conf.all, conf.<iface>)`, so this
relaxes only the modem interfaces — the rest of the host stays strict.

## Alternative: one interface, multiple IPs

If you can't give each path its own interface — or can't grant `CAP_NET_RAW` for
`SO_BINDTODEVICE` — put **all modems on one L2 segment and the host on one
interface with multiple IPs**, then bind each bond path to a different **source
IP** (the path's `bind` field) instead of an interface.

Because every IP lives on the *same* device, `SO_BINDTODEVICE` can't tell the
paths apart, so this is the one case that genuinely needs **policy routing** —
one table per modem plus a source rule:

```yaml
# one shared interface carrying every modem subnet:
addresses: [10.0.11.2/24, 10.0.12.2/24]
routes:
  - { to: default, via: 10.0.11.1, table: 11 }
  - { to: default, via: 10.0.12.1, table: 12 }
routing-policy:
  - { from: 10.0.11.2/32, table: 11 }
  - { from: 10.0.12.2/32, table: 12 }
```

and the bond paths bind source IPs rather than interfaces:

```json
{ "type": "udp", "remote": "203.0.113.5:5000", "bind": "10.0.11.2:0" }
```

**Trade-offs:** it's unprivileged (no `CAP_NET_RAW`), but every modem shares one
broadcast domain — no L2 isolation, and you watch for DHCP/ARP cross-talk and
maintain the routing tables by hand. Prefer separate interfaces unless one of
those constraints forces this. `rp_filter = 2` still applies.

**Prerequisites:** nothing to install. The `ip`/iproute2 tooling and the
kernel's policy-routing support (`CONFIG_IP_MULTIPLE_TABLES`) ship enabled on
every mainstream distro; netplan writes the rules and tables for you (via the
systemd-networkd backend), and numeric table IDs need no `/etc/iproute2/rt_tables`
entry. Verify support with `ip rule list` — it should print the default rules,
not an error.

## Verify each path independently

After a modem's 5G is registered:

```bash
ip -br addr show            # each interface up with its .2 address
ping -I 10.0.11.2 -c2 10.0.11.1     # on-link → reaches modem #1's gateway
ping -I wan5g11   -c2 1.1.1.1       # device-bound → out the 5G path
ip route get 1.1.1.1 oif wan5g11    # shows: via 10.0.11.1 dev wan5g11
curl --interface wan5g11 -s https://api.ipify.org   # each modem → different carrier IP
```

Run the `curl` test per interface — each should report a **different** public
IP (one per carrier/SIM). That's the clearest proof the paths are truly
independent.

## Wire it into bonding

Each bond path pins to one modem interface. In a
[bonded output](/edge/bonding/#bonded-output-sender), every path targets the
**same** remote edge (your bond peer) but leaves via a **different** interface
(and a matching per-path port the receiver binds):

```json
"scheduler": "media_aware",
"paths": [
  { "id": 0, "name": "5g-1",
    "transport": { "type": "udp", "remote": "203.0.113.5:5000", "interface": "wan5g11" } },
  { "id": 1, "name": "5g-2",
    "transport": { "type": "udp", "remote": "203.0.113.5:5001", "interface": "wan5g12" } }
]
```

For **Design A**, set `interface` to the physical NIC instead (`eth1`, `eth2`).
The far-end [bonded input](/edge/bonding/#bonded-input-receiver) binds matching
per-path ports (`0.0.0.0:5000`, `:5001`) with the same path `id`s.

> **`SO_BINDTODEVICE` needs `CAP_NET_RAW`** on Linux. Grant it without running
> the edge as root:
> ```bash
> sudo setcap cap_net_raw+ep /path/to/bilbycast-edge
> ```
> or add `AmbientCapabilities=CAP_NET_RAW` to the systemd unit. macOS/FreeBSD
> use `IP_BOUND_IF` and need no privilege.

Everything else about the bond — scheduler choice, ARQ/NACK tuning, monitoring,
stats — is on the [Multi-Path Bonding](/edge/bonding/) page.

## Power & outdoor notes

- **PoE budget:** confirm the switch's total PoE budget covers all modems
  (OTD500 ≤ ~30 W each). PoE++ switches negotiate down to the OTD500's
  802.3af/at automatically.
- **Surge protection:** fit an Ethernet surge arrestor on each outdoor run, and
  ground it. The modems are outside; that copper carries surge into your gear.
- **Weatherproofing:** seal cable glands, leave a drip loop, and use
  outdoor/UV-rated, ideally shielded, cable.
- **MTU:** keep modem-facing interfaces at 1500 (the modem LAN ports are
  gigabit). A VLAN sub-interface's MTU must be ≤ its parent's.

## Choosing a design

- **A few modems, spare NICs, want it dead-simple →** Design A.
- **Many modems, one fast NIC (e.g. a single 25G port), want to scale and/or
  keep that NIC's existing untagged role →** Design B.
- **Mixed →** combine them: some modems on dedicated NICs, others trunked over
  one NIC. The bond doesn't care — it only sees interface names.

## Troubleshooting

- **All modems unreachable / collide on setup** — factory default is
  `192.168.1.1` on every unit; re-IP one at a time or pre-assign switch VLANs.
- **Bond paths all leave via one modem** — the interfaces aren't pinned, or the
  per-interface default route is missing. Check `ip route get <peer> oif <if>`
  and confirm `interface` is set on each path.
- **Path interface up but no internet** — missing/duplicate default route, or
  `rp_filter` dropping returns. Verify with the `ping -I <if>` and `curl
  --interface` tests; set `rp_filter = 2` on that interface.
- **Untagged traffic leaks between paths (Design B)** — a modem VLAN is acting
  as the trunk's native VLAN; keep modem VLANs strictly tagged.
- **`SO_BINDTODEVICE` errors / permission denied** — `CAP_NET_RAW` not granted;
  see above.
</content>
</invoke>
