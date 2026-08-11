---
title: Aligned Output (Cross-Node Alignment)
description: Put two edge nodes forwarding the same feed on one shared timeline, so a downstream switcher can cut between them without a timing jump.
sidebar:
  order: 5
---

Two edge nodes forwarding the same contribution feed do not put it on the wire at the same moment. Each emits when its own network path delivers, so they differ by the difference in path latency. Cut between them on a downstream switcher and you get a timing jump.

An **alignment group** removes that difference. The manager works out one shared timeline, hands it to every member node, and each edge holds its packets until that timeline says to release. Every member then runs the same arithmetic on the same numbers, so they line up analytically rather than by chasing each other.

The result is a clean **cut** between nodes. It is not a seamless SMPTE 2022-7 merge — the two streams remain separate streams, they simply arrive in step.

Find it at **Alignment** in the sidebar. The entry appears only when at least one of your nodes supports it.

## What can join a group

This is deliberately narrow. Each member is one **UDP or RTP output**, on a flow that:

- has exactly **one input**;
- is **not** an assembled (PID-bus) flow;
- has its input set to **passthrough clock**, or uses a **bonded** input;
- has the output set to **PCR** egress pacing, with **no transcoding** on it.

A group needs at least **two** members and at most **eight**. A node can only appear once — two outputs on the same box already share a clock, so aligning them against each other measures nothing.

:::caution[Alignment and clock regeneration cannot both be on]
Alignment works by reading the timing that is already in the stream. That only works if the node forwards it untouched, which is what **passthrough clock** means.

Turning alignment on therefore means **giving up PCR/PTS regeneration** on that input. If you rely on the node re-stamping timing for a downstream receiver, alignment is not available for that flow.
:::

The manager checks all of this for you as you add each member, and tells you exactly which condition a candidate fails.

## Creating a group

1. Go to **Alignment** and click **+ New group**. Give it a name.
2. Set the **offset** — see [Choosing the offset](#choosing-the-offset) below.
3. Add members using the node → flow → output picker. Each row runs a live readiness check.
4. Save.

The group starts at **Pending** while it collects a reading from every member, then moves to **Armed**.

The same offset must also be set on each output itself, under **Configure → Outputs** on that node. The manager verifies the two agree and refuses the group if they do not.

:::note[Why the manager verifies the offset instead of pushing it]
Changing the hold time on a live output steps its output timing. That is a disruptive act, so it belongs in a config change you make deliberately — not something that happens as a side effect of editing a group.

A mismatch is worth catching precisely because it is invisible otherwise: the group would be misaligned by exactly the difference, and every node would still report healthy.
:::

## Choosing the offset

The offset is the headroom each node has to hold packets before releasing them. It is bounded **150–800 ms**.

**It is headroom for the difference between your nodes, not for total latency.** If your two paths are 200 ms and 260 ms, the spread is 60 ms — not 260 ms. Sizing the offset against total end-to-end latency is the common mistake, and it pushes the output past what the edge will hold, at which point it sheds most of the stream.

Start at the default and adjust using the two states the page shows:

| State | What it means | What to do |
|---|---|---|
| **Deficit** | A member released **late** — its path needs more headroom than the offset allows. | **Raise** the offset. |
| **Clamped** | A member released **early** — the offset asks it to hold longer than it will. | **Lower** the offset. |

These call for opposite remedies, which is why they are shown as separate states rather than one "misaligned" warning.

## Reading the group state

| State | Meaning |
|---|---|
| **Pending** | Collecting readings from members. Not yet aligned. |
| **Armed** | Shared timeline published, and every member is holding it. |
| **Degraded** | Still armed and still on air, but at least one member has fallen off the timeline. |
| **Spread too wide** | The measured difference between nodes is larger than the offset can absorb, so the group deliberately **did not** arm. |

:::tip[Spread too wide is a refusal, not a failure]
Arming a group whose members are further apart than the offset can bridge would align nothing while showing green. The manager would rather tell you. Either raise the offset, or reduce the difference between the paths.
:::

**Degraded** exists because "armed" would otherwise mean two different things at once — that the timeline was published, and that the group is actually aligned. A source restart takes every member off the timeline while leaving the published timeline perfectly intact. Degraded members stay on air; the group recovers in place once the cause clears.

## Re-minting

If a group has drifted, press **Re-mint**. This genuinely re-derives the timeline from current traffic: it withdraws the old one from every member first, waits for fresh readings, then re-arms all of them on the same packet.

Expect a brief step in output timing while this happens. That step *is* the correction.

## Alarms

Alarms land on the **member node**, under category `alignment`, so they appear next to that node's other events.

| Event | Meaning |
|---|---|
| `alignment_member_deficit` | Releasing late — raise the offset. |
| `alignment_member_clamped` | Releasing early — lower the offset. |
| `alignment_member_disengaged` | Fell back to local pacing. Running, but **not** aligned. |
| `alignment_member_not_engaged` | Holding the timeline but no stream is reaching it — the feed to that node has stopped. |
| `alignment_member_unreachable` | Stopped reporting. |
| `alignment_offset_mismatch` | That output's configured offset disagrees with the group's. |
| `alignment_generation_skew` | Stuck on an older timeline. Usually heals by itself within a few seconds. |
| `alignment_spread_exceeded` | The nodes are further apart than the offset can absorb. |

## Requirements and limits

- **Every member node must support alignment.** Older nodes ignore the setting silently — which looks exactly like success — so the manager hides the controls for them rather than letting you configure something that will not happen. Upgrade the node if it does not appear in the picker.
- **Compressed UDP/RTP forwarding only.** Two independent encoders never produce the same bitstream, so transcoded outputs can never be aligned this way.
- **This gives a clean cut, not a hitless merge.** For hitless, use [SMPTE 2022-7 redundancy](/edge/supported-protocols/) on a single node.

## See also

- [Master Clock & A/V Sync](/edge/clocking/) — how the edge derives output timing, and why a node's own clock cannot be shared
- [Wire-Time Precision](/edge/wire-pacing/) — the release mechanism alignment builds on
- [Configuration](/edge/configuration/) — the per-output `epoch_lock` fields
