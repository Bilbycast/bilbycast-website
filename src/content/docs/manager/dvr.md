---
title: DVR Sessions
description: Turn a live flow into a browser-viewable, seekable feed — an edge producing two CMAF renditions, a relay holding the seek-back window, and revocable viewing access for people with no manager account.
sidebar:
  order: 5
---

A **DVR session** is one browser-viewable, seekable feed. It ties together three things an operator used to arrange by hand and then keep in step: a source flow on an **edge**, which produces two CMAF renditions of it; a **relay** running [viewer distribution](/relay/viewer-distribution/), which holds those renditions for as long as the seek-back window says; and the credential a viewer needs to watch. The session is the row that records that those parts belong together, so drift between them is reported instead of surfacing as a 404 partway through somebody's scrub, hours later.

Neither node owns the session. Hanging it off the edge flow would lose it when the flow is deleted; hanging it off the relay would make a relay rebuild forget what was being recorded. It is its own object, at **DVR Sessions** in the manager's left rail (`/dvr/sessions`).

## Before you start

| You need | Why |
|---|---|
| A relay advertising **`viewer-distribution`** *and* **`origin-policy`** | The first is what makes it selectable; the second is what lets it hold a per-stream retention override. A relay too old to advertise `origin-policy` would accept the retention push and apply none of it, so the manager declines to send it at all — the session stays visibly unconverged rather than reading as converged against a relay holding nothing |
| That relay's **public base URL** set | It is what the edge PUTs to and what a viewer is redirected to. The manager reads it off the relay's own health tick, so set it on the relay's Distribution tab first — a relay with none is refused with *"relay has no distribution base URL"* |
| An edge advertising **`video-encode`** | The proxy rendition is encoded on the edge. A build with no video encoder is not offered in the edge picker |
| A running **flow** on that edge carrying the signal | The picker reads the unit's live configuration, so flows authored on the unit itself are selectable, not just manager-pushed ones |
| **Admin** on the owner group to author, **Operator** to run it | See [Who may do what](#who-may-do-what) |

## A worked example

A one-hour review feed of a match, on `edge-truck-1`, held by `relay-syd`.

1. **DVR Sessions → New session.** Name it `Team A vs Team B`. As you type, the form shows what the feed will be called on the relay: `team-a-vs-team-b`, with `team-a-vs-team-b-proxy` for jog and shuttle. That name is derived from yours, is permanent, and appears in every viewing link — check it before you press Create.
2. Pick the **edge** (`edge-truck-1`), then the **source flow** on it, then the **relay** (`relay-syd`). Leave the window at its `3600` default.
3. **Create.** The session lands in **Draft**. Nothing is running and nothing has been sent to either node.
4. **Start.** The manager creates two CMAF outputs on the edge and attaches them to the flow, marks the session **On air**, and pushes `relay-syd` a retention override for both stream names.
5. **Issue link.** Give it a label — *Match director* — and leave the expiry blank for access that runs until you revoke it. The key is displayed **once**: `https://manager.example.com/watch/team-a-vs-team-b?k=<64 hex characters>`. Copy it now; only its SHA-256 is stored.

What that put on the two nodes:

| Where | What |
|---|---|
| `edge-truck-1`, on the source flow | Output `dvr-<session id>-main`, named `Team A vs Team B — main`: CMAF, HLS manifest, 2 s segments, `dvr_window_secs: 3600`, PUT to `https://relay-syd.example.com/origin/team-a-vs-team-b`, plus a scrub-preview thumbnail track |
| `edge-truck-1`, on the same flow | Output `dvr-<session id>-proxy`, named `Team A vs Team B — proxy (jog / shuttle)`: the same, PUT to `…/origin/team-a-vs-team-b-proxy`, re-encoded at 640x360, 3000 kbit/s CBR, `gop_size: 1`, no B-frames |
| `relay-syd` | A retention override on both stream names — `retention_secs: 3660`, `max_bytes_per_stream` sized to it — and its node-wide origin token gate turned **on** |

Stop the session and all of that is taken back off: the outputs are unassigned and deleted from the edge, and the relay is pushed a policy set that no longer names either stream, so both renditions fall back to the node's own default retention and are swept from there. Getting the disk back *now* is what [deleting the session](#deleting-a-session) does.

## Naming, and the feed name it derives

You name the session; the manager names the feed. The **stream id** is derived from the name — lower-cased, non-alphanumerics collapsed to `-`, trimmed, cut to 63 characters — and it is what the edge uploads to, what the relay stores under, and what appears in the viewer's URL. It cannot be changed afterwards, which is why the form shows it as you type.

- The proxy rendition's name is **derived, never stored**: `{stream_id}-proxy`. The player, the edge's second output and the relay's token widening each derive it independently, so a stored fourth answer would be one that could disagree with the other three.
- A stream id is **globally unique**, and that is load-bearing rather than tidy. The relay's origin store is keyed by name and never parses what it holds, so two sessions on one name do not conflict — they interleave, each overwriting the other's manifest, and the result plays as corruption. Two fixtures with the same name is an ordinary thing to want, so the form suffixes (`team-a-vs-team-b-2`) rather than refusing, and shows you the suffix.
- The indirect collision is caught at **Start**, not at Create: a session whose stream id is `show-proxy` alongside another whose id is `show` is accepted at Create and refused with `stream_collision` at the moment both would be active, because that is the only instant the collision exists. The form steers around it for sessions you can see — the suffixing above treats a derived `-proxy` name as taken too — so what reaches Start is an API caller, or a session in a group you cannot see.

## The seek-back window

`window_secs` is how far back a viewer can scrub, and one number drives both nodes: the edge trims its playlist to it and the relay is told to hold it. A playlist listing segments the relay has evicted 404s on seek; a relay holding segments the playlist no longer lists is wasted disk.

| | Value |
|---|---|
| Default | `3600` (1 hour) |
| Accepted | `60` to `43200` seconds (12 hours) |
| Retention actually pushed to the relay | `window_secs + 60` |
| Byte cap pushed alongside it | `retention_secs × 3.125 MB/s` (a 25 Mbit/s assumed peak per rendition) |

Two things about that table are worth knowing rather than discovering.

**The ceiling comes from the edge, not the relay.** A CMAF output bounds its *derived playlist length* at 21 600 entries, and at the fixed 2 s segment duration that is 43 200 s of window. The relay would accept more; the edge refuses the output at validation, so a longer window would be stored, activated, and then fail at provisioning. The manager therefore refuses it at the field, with `invalid_window` shown under the box.

**Retention exceeds the window on purpose.** The oldest segment a playlist advertises is always exactly `window` old, so retention equal to the window evicts it at the moment it is still being listed — a 404 for anyone seeking to the back of the bar. The extra 60 s is thirty segments of headroom for upload latency, clock skew and the relay's sweep interval.

The byte cap is a guard against one stream eating the volume, not a target: **retention is what governs how much is actually held.** It is set explicitly because the relay's node-wide default would otherwise bind first and silently truncate the window into that same 404 — at 8 Mbit/s a 2h30m window is around 9 GB for the main rendition alone. Sizing the disk stays your job: on measured rates (main ~8 Mbit/s, proxy ~2.6 Mbit/s) a 2h30m session is roughly 12 GB across both renditions.

## Scheduling a session in advance

A fixture with a known kick-off does not need somebody at a screen, and needing one is how a recording gets missed. **Schedule** on any session card sets a start time, a stop time, or both.

- The two are **independent**. "Start at kick-off, I'll stop it myself" and "running now, stop it at midnight" are both expressible; a stop time can be set on a session that is already running.
- Arming is checked against the **same bar as pressing Start** — an edge, a relay, a source flow, a valid stream id, a window in range, and permission on both nodes — because the scheduler will provision unattended. A session that could not start is refused while you are looking at the form, not at kick-off into a log nobody is reading.
- The scheduler ticks every **5 seconds**, separately from the retention pass, because a session armed for kick-off that goes on air a minute late has missed the thing it was armed for.
- A scheduled start that fails leaves the session **armed and retries**, and raises a Warning `dvr_schedule_start_failed` naming the reason. An edge a few seconds late coming up is the case this behaviour is for.
- Sending no times **disarms**, dropping an armed session back to Draft. An armed session can still be started by hand without disarming it first.
- A running session cannot be given a start time; stop it first. The Schedule dialog disables the start-time field and says why, and the API refuses one anyway with `already_running`.

## Session states

| Badge | Meaning |
|---|---|
| **Draft** | Authored but not running. Nothing is being produced for it |
| **Scheduled** | Armed. The manager starts it at the time shown, with nobody at a screen |
| **On air** | Running: the edge is producing both renditions, and the relay is asked to hold the window |
| **Stopped** | Ended. Nothing is being produced, and the relay is no longer asked to hold the window |

Those four say what the *manager is asking for*. Whether the relay has **confirmed** it is a separate fact, and it gets its own badge beside — never instead of — the state:

| Second badge | Meaning |
|---|---|
| **Window not applied** | The session is on air and the picture plays, but the retention it asked for never reached the relay. The seek-back depth is whatever that relay last held |
| **Release pending** | The session is not running, but the relay has not confirmed giving its window back — it was unreachable when the session stopped, and is still holding that disk |

A session showing **On air** with no second badge is converged: what the relay holds is what the session asks for. That comparison is a hash of the pushed policy body recorded at the last successful push, so it moves when the window moves and does not move when nothing has.

## What the relay is told, and when

A background reconciler owns the relay half. It runs a pass **every 60 seconds**, and a start or a stop converges that one relay immediately — scoped to it, so nothing drags every other relay in the estate into a request handler — so you are not waiting on a tick for a window you just set.

The push is **per relay, not per session**, and that is forced by the relay's semantics: its per-stream override set is replace-not-merge — deliberately, so an ended session's widened window is actually given back — so pushing one session's override would delete every other session's on that box. The reconciler always sends the union of the actives on that relay.

:::caution[Starting a DVR session gates every stream on its relay]
The origin token gate is **node-wide**. The first active session on a relay turns it on, and from that moment every stream that relay serves needs a viewer token, including any that are not part of a DVR session — a CDN or player pulling one without a token gets 401s. The manager raises a Warning `dvr_origin_gate_enabled` on the relay when it happens.

It does **not** reverse when the session stops. A relay the manager has taken responsibility for stays gated, because turning the gate off would briefly open every stream still on disk. Give those consumers a viewer token, or move them to a relay with no DVR sessions.
:::

Two more behaviours you will meet:

- **A relay that restarts comes back holding nothing.** Per-stream overrides are runtime state, not persisted to the relay's own config, so a session that ended while the relay was down cannot come back holding that stream's disk. The manager discards what it believed the relay was holding on reconnect and pushes again.
- **A push that does not land is reported once, on the transition.** `dvr_retention_push_failed` fires when a relay first refuses or is unreachable, and `dvr_retention_push_recovered` closes it. Alarming every pass would bury the event under 1 440 copies a day.

## The two renditions

A viewer is watching one thing; it is delivered as a pair, and one viewer token covers both.

| Rendition | Origin name | Encoding | What it serves |
|---|---|---|---|
| **main** | `{stream_id}` | **Passthrough** — the source re-wrapped, not re-encoded | Live, ordinary playback, the still after a scrub, and frame jog (at the cost of a decode from the preceding keyframe) |
| **proxy** | `{stream_id}-proxy` | 640x360, 3000 kbit/s CBR, **all-intra** (`gop_size: 1`, no B-frames) | Shuttle, reverse, and the moving picture while a scrub thumb is held |

The main rendition is passthrough because it is what a viewer actually watches: re-encoding it would cost a full-resolution encode per session and lose a generation for nothing. The proxy is small on purpose — it exists to be *seeked*, and every frame being a keyframe is expensive per pixel.

### Which encoder the proxy gets

`gop_size: 1` is the proxy's entire reason to exist, and a backend that ignores it **does not error** — it emits a long-GOP stream that plays perfectly and cannot be jogged. So the manager chooses from an allowlist of backends someone has watched produce all-intra output, reading what the edge advertises on its health tick:

| Backend | Chosen? |
|---|---|
| `h264_vaapi` | Yes — preferred |
| `h264_rkmpp` | Yes — preferred (RK3588) |
| `h264_nvenc` | **Never.** It refuses `gop_size: 1` outright, and it is the encoder a well-specified node is most likely to have |
| `h264_qsv`, anything else | Falls back to `x264` — an unmeasured backend is not assumed to work |
| `x264` | The fallback, always available, measured to do the job |

The encoder a running session actually got is shown on its card and carried in the `dvr_session_started` event, because an operator who assumed their GPU was doing the work has no other way to find out that it is not. It is cleared when the session stops, so it never describes a session that is producing nothing.

### The scrub preview track

The main rendition — and only the main rendition — carries a sprite-sheet thumbnail track: one frame every **2 seconds**, **20 frames per sheet**. It is what the player shows under the thumb while you drag outside its own back buffer, where a drag otherwise presents a frame or two out of forty seeks.

A sheet only exists once it is full, so the newest **40 seconds** of the window has no preview. That product has to stay under the shortest window a session may have (60 s), because the edge refuses a thumbnail track whose lag reaches its playlist window — past that point no sheet would ever describe a segment the playlist still lists.

The track goes on one rendition because a sheet describes a moment on the timeline, not a rendition; two would be two sets of the same pictures.

## Letting people watch

Every DVR feed is gated. There is no per-session choice, and removing it was deliberate: the relay's gate is node-wide, so a per-session flag could only ever gate somebody else's streams too. What a viewer may watch is decided by **the streams their token carries**, not by which relay they reached.

There are two ways in and neither replaces the other.

### Viewing links (grants)

Right for a one-off guest: no account, revocable, carrying its own entitlement.

**Issue link** on a session mints a 32-byte key, shown **once** — only its SHA-256 is stored, so an operator who loses it issues another and revokes the first. The link is the manager's own `/watch/{stream_id}?k=<key>`. Opening it validates the grant, mints a short-lived viewer token, and redirects to the relay's DVR player; the viewer never sees the manager again.

| Field | Behaviour |
|---|---|
| **Label** | 1–256 characters, not checked against anything — anyone holding the link can watch. It is what makes the revocation list readable six weeks later |
| **Expires** | Optional. Blank means access that runs until you revoke it; a time already in the past is refused rather than stored |
| **Uses** | Counted and timestamped for observability only, never a limit. "Has this link ever been used?" is what makes an unused grant safe to revoke |

:::caution[Revoking a link is not immediate — it takes up to three hours]
The relay's viewer token is a stateless HMAC with no revocation path, which is the right shape for something checked on every segment request and the wrong shape for "this person may watch this feed". So the long-lived, revocable thing is the grant, and the short-lived, un-revocable thing is what it is exchanged for at the moment of use.

**The token TTL is three hours, and that is the revocation latency.** Revoking a grant refuses new viewers at once, but a token already issued stays valid for up to that long, and nothing can recall it. The response to a revoke says so in those terms.
:::

A revoked grant is kept rather than deleted, struck through in the list. "Who could watch this, and when did that stop" is the question asked afterwards, and a deleted row answers nothing.

Every refusal on `/watch` returns the same 403 with the same wording. A viewer holding a bad link learns only that it does not work — not whether the feed exists, whether the key was once valid, or whether it was revoked rather than expired.

### Portal logins

Right for staff who watch regularly, where issuing and chasing links is the worse job. The viewer signs in to the [portal](/relay/portal/) — a separate binary running beside the relay — sees the feeds they are entitled to, clicks one, and lands in the player.

**Portal logins** on the DVR Sessions page is where you manage that:

- A login is an **identity-provider username, verbatim and case-sensitive**. The manager is not the identity provider: it stores an entitlement against a name it cannot verify, so `A.Smith` and `a.smith` are two different people. Deleting a leaver upstream does not delete these rows.
- Usernames are unique **per group**, not globally. One person can legitimately be a viewer for two tenants' feeds, and those are separate decisions made by separate operators.
- The **display name** is a label for this list only. The manager has no way to look a real name up.
- Adding a name grants nothing. It is the tick list against each name that decides what they see, and saving it **replaces** the set rather than merging — you are looking at a checklist, so what you see is what is true afterwards. Up to 256 sessions per login.
- Only sessions that are **on air** appear in the portal. A feed that is not running is absent rather than broken.

The portal **asks** the manager on every page load rather than being pushed to, so withdrawing access takes effect on the viewer's next click instead of on the next successful push to a box that might be unreachable. It holds no secret and signs nothing — it asks the manager to mint a token, and the manager re-checks the entitlement before it does.

#### The portal service token

The portal authenticates to the manager with a shared bearer token, generated at **Portal logins → connection panel** and visible only to a **SuperAdmin**: the credential is not group-scoped — it admits its holder to ask about any username in any group — so who holds one is an instance-level decision.

- It is **generated, never typed**, and shown once. There is no way to read it back; an operator who loses it generates a new one.
- Deploy it to the portal host as `BILBYCAST_PORTAL_TOKEN`. **Rotating it takes the portal down until the new value is deployed** — and the symptom on the viewer's side is an empty feed list, which does not look like a token problem.
- The manager **fails closed**: with no token configured, or with the setting unreadable, every portal request is refused rather than answered.
- Clearing it is the switch that turns the portal off.

## Deleting a session

Deleting is Admin work, and the manager refuses it in two states rather than stranding disk on a relay:

| Refusal | Why, and what to do |
|---|---|
| `session_active` | Stop it first. The reconciler finds relays by looking at sessions, so with the row gone nothing would ever tell that relay to release the window — it would hold the disk until it was restarted |
| `release_pending` | The relay has not yet confirmed releasing this session's window, because it was unreachable when the session stopped. Retry once the relay is back. This does not apply once the relay row itself has been deleted, or the session would be permanently undeletable |

A delete that goes through also asks the relay to **drop the streams outright**, not merely to release the override. Releasing the override only drops the streams back to the node's default retention, which has nothing to do with the window this session asked for — an operator deleting a session to reclaim space should get the space, not a promise for later in the afternoon.

Grants and portal entitlements cascade away with the session. Deleting a **node** does not delete sessions pointing at it: the assignment is set to null, which is precisely what has happened, and the session says so instead of vanishing.

## Who may do what

Authority splits the way the [multiviewer](/manager/multiviewer/) does, and for the same reason: creating a session commits a node's disk, while starting one is show work, and the people who start and stop a recording are not administrators.

| Action | Group role | Also checked on the nodes |
|---|---|---|
| Create a session | **Admin** | **Manage** on the named edge and relay — this is where the hardware is committed |
| Delete a session | **Admin** | — |
| Start it, or arm a start time | **Operator** | **Operate** on both |
| Stop it, set a stop time alone, disarm | **Operator** | — |
| Issue and revoke viewing links | **Admin** | — |
| Add, remove portal logins; set entitlements | **Admin** | — |
| Mint or clear the portal service token | **SuperAdmin** | — |

The node check is separate from the group check, and both are re-checked at activation rather than only at create: a node can be moved between groups, or a caller's membership changed, while a session sits in draft. Every mutation is written to the Audit Log, group-scoped to the session's owner — the one exception being the portal service token, which belongs to no tenant, so its rows carry no group and only a SuperAdmin sees them. The scheduler's unattended starts and stops are recorded there too, marked as system-triggered.

## Events

All of these carry the category `dvr`, which the Events page shows in its Category column. That page's category filter has no `dvr` entry, so narrow to them with the search box instead — every one of these messages begins with *DVR*.

| Event | Severity | Raised against |
|---|---|---|
| `dvr_session_started` | Info | The edge — names the window and the encoder the proxy got |
| `dvr_session_stopped` | Info | The edge |
| `dvr_origin_gate_enabled` | Warning | The relay — the node-wide gate above |
| `dvr_retention_push_failed` | Warning | The relay — the window in force is not the one that was set |
| `dvr_retention_push_recovered` | Info | The relay — closes the one above |
| `dvr_schedule_start_failed` | Warning | The edge — a scheduled start that did not happen; still armed, retrying |
| `dvr_teardown_incomplete` | Warning | The edge — the session stopped but its renditions could not be removed, so it may still be encoding and uploading |
| `dvr_deprovision_incomplete` | Warning | The edge — names the outputs left behind, which will keep encoding until removed |

The last two exist because stopping is deliberately best-effort: a session must be stoppable while its edge is offline, or an unreachable node would pin it active forever and keep the relay window held. The cost of that choice is an edge that may still be producing for a session that reads as stopped everywhere — so it is said out loud rather than left in a log.

## REST surface

Everything above is an endpoint. Full descriptions are in the [manager API reference](/manager/api-reference/).

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/dvr/sessions` | List the sessions the caller can see, or create one |
| GET / DELETE | `/api/v1/dvr/sessions/{id}` | Read one, or delete it |
| POST | `/api/v1/dvr/sessions/{id}/activate` | Start it now |
| POST | `/api/v1/dvr/sessions/{id}/stop` | Stop it now |
| POST | `/api/v1/dvr/sessions/{id}/schedule` | Arm a start time, a stop time, or both; nulls disarm |
| GET / POST | `/api/v1/dvr/sessions/{id}/grants` | List the viewing links issued for a session, or issue one |
| DELETE | `/api/v1/dvr/grants/{grant_id}` | Revoke a viewing link |
| GET / POST | `/api/v1/dvr/portal-users` | Portal logins the caller can see, or add one |
| DELETE | `/api/v1/dvr/portal-users/{id}` | Remove a portal login |
| PUT | `/api/v1/dvr/portal-users/{id}/entitlements` | Replace the set of sessions that login may watch |
| GET / POST / DELETE | `/api/v1/dvr/portal-service-token` | Whether a portal token is configured, mint a replacement, or clear it (SuperAdmin) |

Three routes carry no session cookie by design — the viewer's entry point, and the two the portal service calls with its bearer token:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/watch/{stream_id}` | The viewer's entry point. Takes the grant key as `?k=`, mints a short-lived viewer token, and redirects to the relay's player |
| GET | `/api/v1/dvr/portal/streams` | What one portal username may watch — `active` sessions only |
| POST | `/api/v1/dvr/portal/token` | Mint a viewing token for one session on behalf of a username, re-checking the entitlement first |

The manager's `/watch/{stream_id}` is **not** the relay's `/watch/{stream_id}`: different server, different credential. The manager's exchanges a grant key for a redirect; the relay's is a WHEP player page on its distribution listener.

## Related

- [Viewer Distribution (WHEP + LL-HLS)](/relay/viewer-distribution/) — installing and configuring the relay half, the origin's storage and retention settings, and the browser DVR player's controls, picture modes and self-test.
- [The viewer portal](/relay/portal/) — the sign-in service that fronts a gated feed, and the trust boundary it depends on.
- [CMAF / LL-HLS output](/edge/cmaf/) — the edge output type a session provisions, and what `dvr_window_secs`, segment duration and the thumbnail track mean on the unit.
- [Multiviewer Walls](/manager/multiviewer/) — the other manager surface built on the same author-then-deploy split.
