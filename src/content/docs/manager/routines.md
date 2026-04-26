---
title: Routines
description: Cron-scheduled flow automation for bilbycast — set-and-forget broadcast programming with DST-correct IANA timezones, missed-fire safety, and per-action audit.
sidebar:
  order: 3
---

**Routines** are bilbycast-manager's automation surface. A routine is a named bundle of actions (start a flow, stop a flow, restart a flow, or activate a [Switcher](/manager/switcher/) preset) plus zero or more **schedules** that fire it on a recurring or one-shot cadence.

If the Live Switcher is the director's manual console, Routines are the programme schedule — sponsor blocks, prime-time switches, weekday news cuts, weekend feeds, and "set up the rig at 6am every weekday" maintenance windows.

## Why it matters

Live broadcast plants run on the clock. The same channel that's on national news at 18:00 is running sponsor blocks at 18:30 and the late-night feed at 22:00. Routines let an admin programme that schedule once, then leave the manager to fire it — every day, every week, with full audit and DST correctness.

Operators can manually fire any routine with one click — useful for emergency takes, dry-runs, and ad-hoc switches outside the scheduled programme.

## Action types

A routine has one or more actions. Each action is one of:

| Action | What it does |
|---|---|
| `flow_start` | Start a flow on a target edge node. |
| `flow_stop` | Stop a flow on a target edge node. |
| `flow_restart` | Restart a flow on a target edge node. |
| `activate_switcher_preset` | Run the same logic the [Switcher's](/manager/switcher/) Activate button does — including per-node Operate permission checks. |

A routine with multiple actions fans them out concurrently. The aggregated outcome is `success` (all actions ACK'd OK), `partial` (some failed), or `failed` (all failed). Partial and failed outcomes raise real-time alarms; success is silent (recorded in activation history but not in the events feed) so a busy schedule doesn't drown the alarm panel.

## Scheduling

The recurrence picker has five preset frequencies:

| Frequency | Example summary |
|---|---|
| **Once** | "Once on 2026-05-30 22:00 — Australia/Sydney" |
| **Daily** | "Daily at 18:00 — Australia/Sydney" |
| **Weekdays** | "Weekdays (Mon–Fri) at 18:00 — Australia/Sydney" |
| **Weekly** | "Mon, Wed, Fri at 18:00 — Australia/Sydney" |
| **Custom** | _operator-supplied 5-field cron expression_ |

Every schedule is evaluated in an **IANA timezone** — your browser's timezone by default — so a "Daily at 18:00 in Sydney" rule keeps firing at 18:00 local even after a daylight-saving boundary. Operators never have to write cron unless they want to: the picker compiles the choice down to the right expression and round-trips via a stored human-readable summary.

You can also set a **valid-from** and **valid-until** window so a schedule only runs between two dates (Olympic-style limited campaigns, fixed sports seasons, retiring an old promo).

## Skip-next-fire

If a director needs to skip a single scheduled fire — say, a sponsor block shouldn't run during a memorial broadcast — they can click **Skip next fire** on the schedule row without disabling the schedule entirely. The scheduler advances past the upcoming fire and clears the override automatically. No admin call required; operator-friendly by design.

## Missed-fire policy

If the manager is offline when a scheduled fire was due, anything older than **15 minutes** past its `next_fire_at` is **not replayed**. It's logged as `missed` in the activation history and emits a `routine_fire_missed` warning event. Fires within the 15-minute window do replay on the next tick.

The broadcast rationale: don't replay sponsor blocks at midnight just because the server was off all afternoon. The 15-minute grace window covers expected ops events (HA failover, deploy window, brief outage) without forcing an operator to manually rebuild the queue.

## DST correctness

| Scenario | Behaviour |
|---|---|
| **Spring-forward** (e.g. `Australia/Sydney` 2:30 doesn't exist on the changeover day) | A `02:30 daily` rule fires once at 03:00 on the changeover day, then back to 02:30 on subsequent days. |
| **Fall-back** (the local 02:30 happens twice on the changeover day) | A `02:30 daily` rule fires once at the *first* 02:30 occurrence; the second 02:30 wall clock is silently skipped. |

Driven by `chrono-tz` and the `cron` crate, validated by unit tests on `Australia/Sydney` boundaries.

## HA-safe scheduling

In an [Active/Active HA pair](/manager/active-active-ha/) two manager instances see the same `routine_schedules` rows. The scheduler uses Postgres `pg_try_advisory_xact_lock(<schedule_id>)` per due row to claim a fire — the first instance wins, the second backs off cleanly. No leader election, no clock drift to manage, no double-fire risk.

## Real-time events

Surfaced on the manager's Events page under category `routine`:

| Event | Severity | When |
|---|---|---|
| `routine_fire_partial` | warning | Some actions in a fire failed. `details.failed_actions[]` tells the operator which. |
| `routine_fire_failed` | critical | Every action in a fire failed. Wakes the alarm panel. |
| `routine_fire_missed` | warning | A fire was older than the 15-minute window and wasn't replayed. `details.lag_seconds`. |

Success fires don't emit a real-time event — they're visible in the activation history but they don't drown the alarm panel.

## Permissions

- **Creating, editing, deleting** routines and schedules requires the **Admin** role in the owner group.
- **Manually activating** a routine requires the **Operator** role plus per-node **Operate** permission for every action's target node.
- Scheduled fires run as the **system actor** (`user_id = NULL`). Permission is verified at routine-creation time, not at fire time, so scheduled programming doesn't break because the morning operator went on leave.

## Composes with Multi-tenant Groups

Routines are first-class tenant-scoped resources — an admin in *Acme* manages *Acme*'s routines without seeing *Globex*'s. Cross-tenant composition is rejected at create time: a routine in *Acme* cannot reference a switcher preset whose owner group is *Globex*.

## Reference

- Operator walk-through: [`USER_GUIDE.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/USER_GUIDE.md) ("Routines (scheduled flow automation)").
- Architecture, scheduler internals, missed-fire policy: [`routines.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/routines.md).
- API reference: [`API.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/API.md) ("Routines (scheduled flow automation)").
