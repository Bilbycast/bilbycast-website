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
| That edge advertising **`clip-export`** | Every clip a viewer exports is cut on the edge, so **Start** is refused against an edge that does not advertise it — `409 edge_provision_failed`, *"this edge does not advertise `clip-export`, so a viewer's export would be recorded and never cut — upgrade the edge, or point the session at one that does"*. Such an edge takes every command and produces two perfectly watchable renditions, while every export a viewer asks for sits pending for the life of the session, which is why the refusal is up front. The picker filters on `video-encode` only, and arming a schedule checks no capability either: a session scheduled against such an edge fails at kick-off with `dvr_schedule_start_failed` and retries until the edge is upgraded. An edge that carries the exporter advertises the bit unconditionally, so an upgrade is the whole fix. `replay` is **not** required — without a recorder, clips are cut from whole segments rather than to the frame |
| A running **flow** on that edge carrying the signal | The picker reads the unit's live configuration, so flows authored on the unit itself are selectable, not just manager-pushed ones |
| **Admin** on the owner group to author, **Operator** to run it | See [Who may do what](#who-may-do-what) |

## A worked example

A one-hour review feed of a match, on `edge-truck-1`, held by `relay-syd`.

1. **DVR Sessions → New session.** Name it `Team A vs Team B`. As you type, the form shows what the feed will be called on the relay: `team-a-vs-team-b`, with `team-a-vs-team-b-proxy` for jog and shuttle. That name is derived from yours, is permanent, and appears in every viewing link — check it before you press Create.
2. Pick the **edge** (`edge-truck-1`), then the **source flow** on it, then the **relay** (`relay-syd`). Set the **seek-back window** to `1` hour for this one-hour feed — the field is in hours and opens on `4`, the manager's default; it stores your `1` as `window_secs: 3600`, which is what the numbers below assume.
3. **Create.** The session lands in **Draft**. Nothing is running and nothing has been sent to either node.
4. **Start.** The manager first checks the edge can cut clips (`clip-export`), then — if the edge has a Replay recorder — **arms it on the source flow** for [clip export](#clip-export): a merge onto whatever the operator already had, remembered so Stop can hand it back. Before arming it asks the edge's replay volume for room: the window at the flow's *measured* rate once it has written 30 or more recorder segments, 25 Mbit/s assumed otherwise, plus 25 % headroom. A session that will not fit is refused here, at the form, with the free and needed sizes and whether the rate was measured or assumed. It then creates two CMAF outputs on the edge and attaches them to the flow, marks the session **On air**, and pushes `relay-syd` a retention override for both stream names.
5. **Issue link.** Give it a label — *Match director* — and leave the expiry blank for access that runs until you revoke it. The key is displayed **once**: `https://manager.example.com/watch/team-a-vs-team-b?k=<64 hex characters>`. Copy it now; only its SHA-256 is stored.

What that put on the two nodes:

| Where | What |
|---|---|
| `edge-truck-1`, on the source flow | Output `dvr-<session id>-main`, named `Team A vs Team B — main`: CMAF, HLS manifest, 2 s segments, `dvr_window_secs: 3600`, PUT to `https://relay-syd.example.com/origin/team-a-vs-team-b`, plus a scrub-preview thumbnail track |
| `edge-truck-1`, on the same flow | Output `dvr-<session id>-proxy`, named `Team A vs Team B — proxy (jog / shuttle)`: the same, PUT to `…/origin/team-a-vs-team-b-proxy`, re-encoded at 640x360, 3000 kbit/s CBR, `gop_size: 1`, no B-frames |
| `relay-syd` | A retention override on both stream names — `retention_secs: 3660`, `max_bytes_per_stream` sized to it — and its node-wide origin token gate turned **on** |

Stop the session and all of that is taken back off: the outputs are unassigned and deleted from the edge; the flow's Replay recorder is handed back to whatever it held before the session armed it (or kept armed at the widest window another session still running on the same flow needs); the relay is pushed a policy set that no longer names either stream; and the relay is told to **retire** both streams — their segments, manifests and init files are removed at once (best-effort: a relay that was unreachable at that moment ages them out on its node default), and only the clips exported from the session are kept, for 24 hours after the stop, after which the manager's expiry sweep removes them and forgets the session. Removing the clips sooner is what [deleting the session](#deleting-a-session) does.

:::note[Arming a recorder on a flow that is already running restarts it]
The recorder binds when a flow starts, so switching it on for a flow that is on air means a restart — every input and output on that flow drops and re-establishes, not only this session's. A Warning `dvr_flow_restarted_for_recorder` says so against the flow. It fires only when something actually had to be pushed: a second session on the same flow at an equal or narrower window, or a retried activation, finds the recorder already covering it (a byte cap within 10 % of what it would ask for counts) and restarts nothing. Arm DVR before the flow goes on air to avoid the interruption.
:::

## Naming, and the feed name it derives

You name the session; the manager names the feed. The **stream id** is derived from the name — lower-cased, non-alphanumerics collapsed to `-`, trimmed, cut to 63 characters — and it is what the edge uploads to, what the relay stores under, and what appears in the viewer's URL. It cannot be changed afterwards, which is why the form shows it as you type.

- The proxy rendition's name is **derived, never stored**: `{stream_id}-proxy`. The player, the edge's second output and the relay's token widening each derive it independently, so a stored fourth answer would be one that could disagree with the other three.
- A stream id is **globally unique**, and that is load-bearing rather than tidy. The relay's origin store is keyed by name and never parses what it holds, so two sessions on one name do not conflict — they interleave, each overwriting the other's manifest, and the result plays as corruption. Two fixtures with the same name is an ordinary thing to want, so the form suffixes (`team-a-vs-team-b-2`) rather than refusing, and shows you the suffix.
- The indirect collision is caught at **Start**, not at Create: a session whose stream id is `show-proxy` alongside another whose id is `show` is accepted at Create and refused with `stream_collision` at the moment both would be active, because that is the only instant the collision exists. The form steers around it for sessions you can see — the suffixing above treats a derived `-proxy` name as taken too — so what reaches Start is an API caller, or a session in a group you cannot see.

## The seek-back window

`window_secs` is how far back a viewer can scrub, and one number drives both nodes: the edge trims its playlist to it and the relay is told to hold it. A playlist listing segments the relay has evicted 404s on seek; a relay holding segments the playlist no longer lists is wasted disk.

| | Value |
|---|---|
| Default | `14400` (4 hours) — long enough to cover a fixture and its build-up; the form asks for the window in hours, so it shows `4` |
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

## Clip export

A viewer marks a moment in the player and asks for so many seconds either side of it. The relay records the request; the edge polls for it, cuts the clip and PUTs it back where the portal lists and hands it out — the relay never parses media. A frame-exact clip is cut from the flow's **own Replay recording**, not from the viewer segments, which is why Start arms that recorder:

- **It is a merge, never a replacement.** The flow may already be recording for Replay. The operator's pre-buffer, filmstrip, storage directory and segment length are carried through; DVR imposes only `enabled`, a retention no shorter than the window, and a byte cap sized to it. What the flow held before any DVR session touched it is remembered, and the **last** session to stop on that flow hands exactly that back — a flow that had no recorder is disarmed, one that had the operator's gets it back. With no memory to restore from, the recorder is left running and a Warning `dvr_recorder_left_armed` says where to look.
- **Sessions sharing a flow share the recorder**, sized to the widest active window among them, so a second session cannot shorten the first's material.
- **The window has to fit.** Start reads the free space on the edge's replay volume and refuses a session that would not hold its window — at the flow's **measured** rate once it has written 30 recorder segments, otherwise at an assumed 25 Mbit/s — plus 25 % headroom. The refusal names the figures and whether the rate was measured or assumed, so an "assumed" refusal on a light feed can be answered by recording first. An edge that reports no free space is trusted, not refused.
- **Arming a running flow restarts it** — see the note under the worked example. The manager pushes only when the recorder is not already in shape, and when it does restart a flow it says so with `dvr_flow_restarted_for_recorder`.
- **An edge without `replay`** is not refused: it still answers every export, cut from whole segments rather than to the frame. Only `clip-export` is mandatory.

### How long clips stay

Clips outlive the game. Stopping a session starts a **24-hour** clock, measured from the stop rather than from each export, so everything from one fixture expires together. Until then the relay has retired the feed's media but keeps its clips, a portal login entitled to the session can still list and download them though the feed itself cannot be watched, and the session row survives, because it is what the entitlement check is made against.

When the clock passes, the expiry sweep — on the reconciler's 60-second tick — tells the relay to drop the streams first and, only once that lands, deletes the row with every grant, entitlement and viewing session on it, writing `dvr.session.clips_expired` to the Audit Log. A relay that will not take the drop leaves the row for the next pass and raises a Warning `dvr_clip_expiry_failed` once, on the transition. **Re-arming or restarting a stopped session clears the clock.** The relay keeps no retention of its own — only a seven-day backstop, for clips a manager never comes back for — so this 24-hour clock is the one that applies.

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

**A viewing link's token TTL is three hours, and that is its revocation latency.** Revoking a grant refuses new viewers at once, but a token already issued stays valid for up to that long, and nothing can recall it. The response to a revoke says so in those terms. (Portal tokens are different — 30 minutes, renewed by the player, so a withdrawn entitlement bites within about 20 minutes; see [One viewing session per login](#one-viewing-session-per-login).)
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
- Only sessions that are **on air** appear in the portal's feed list. A feed that is not running is absent rather than broken. The one exception is the **Exports** table beneath that list: clips cut from a session stay listed there — and can still be downloaded or deleted — for the 24 hours after the session stops, each row naming the feed it came from. A stopped session with no exported clips appears nowhere.

The portal **asks** the manager on every page load rather than being pushed to, so withdrawing access takes effect on the viewer's next click instead of on the next successful push to a box that might be unreachable. It holds no secret and signs nothing — it asks the manager to mint a token, and the manager re-checks the entitlement before it does.

#### One viewing session per login

A portal login is one viewer at a time. A fresh **Watch** takes the login for that device — the newest device wins — and the previous device is refused at its next renewal with `session_taken_over`, told in those words rather than "expired", so it keeps playing until then rather than being cut mid-sentence. Portal tokens live **30 minutes** and the player renews ten minutes before expiry, so a withdrawn entitlement, a stopped session or a takeover bites within about **20 minutes** for somebody already watching — unlike a viewing link, whose three-hour token nothing renews. Stopping a session releases its viewing sessions, so the next fixture is not refused on the strength of a finished one.

Holding a token and watching are different facts. The player sends a heartbeat every 60 seconds; a device counts as watching while it has beaten within 150 seconds on a live token, so a closed tab drops off the count within three minutes. **Viewers** on a session card (`GET /api/v1/dvr/sessions/{id}/viewers`) shows both — who holds the login and who is watching. When no player on the session has ever beaten (an older player, or a portal with no `player_origins` set), the count falls back to "holds a live token" and the response says so (`heartbeat: false`) rather than reporting silence. The viewer's IP address is shown to Admins only.

#### The portal service token

The portal authenticates to the manager with a shared bearer token, generated at **Portal logins → connection panel** and visible only to a **SuperAdmin**: the credential is not group-scoped — it admits its holder to ask about any username in any group — so who holds one is an instance-level decision.

- It is **generated, never typed**, and shown once. There is no way to read it back; an operator who loses it generates a new one.
- Deploy it to the portal host as `BILBYCAST_PORTAL_TOKEN`. **Rotating it takes the portal down until the new value is deployed** — and the symptom on the viewer's side is an empty feed list, which does not look like a token problem.
- The manager **fails closed**: with no token configured, or with the setting unreadable, every portal request is refused rather than answered.
- Clearing it is the switch that turns the portal off.

## Deleting a session

Deleting is Admin work, and the manager refuses it in three states rather than stranding disk on a relay:

| Refusal | Why, and what to do |
|---|---|
| `session_active` | Stop it first. The reconciler finds relays by looking at sessions, so with the row gone nothing would ever tell that relay to release the window — it would hold the disk until it was restarted |
| `release_pending` | The relay has not yet confirmed releasing this session's window, because it was unreachable when the session stopped. Retry once the relay is back. This does not apply once the relay row itself has been deleted, or the session would be permanently undeletable |
| `relay_unreachable` | The session stopped less than 24 hours ago — the window in which any clips it exported are still retained — and the relay could not be told to drop its streams. Deleting the row now would leave those clips on the relay with nothing able to reach them: the relay's own backstop would not reclaim them for seven days, and the manager's expiry sweep finds streams by looking at sessions. Retry once the relay is back, or wait for the 24 hours to pass, after which the session is deletable while the relay is down. The manager does not know whether a clip was actually cut, so a session that exported nothing is refused in the same way. As with `release_pending`, this does not apply once the relay row itself has been deleted |

A delete that goes through also asks the relay to **drop the streams outright**, not merely to retire them. Stopping already takes the media — segments, manifests and init files — off the relay but keeps the session's exported clips for a day; deleting takes the clips too, so an operator deleting a session to reclaim space gets all of it back. With no live clips the delete goes ahead whether or not the relay answered, since there is nothing left to strand. A stopped session nobody deletes does not linger either: when its clips' day is up the manager drops the streams and removes the session itself, grants and entitlements with it.

Grants and portal entitlements cascade away with the session. Deleting a **node** does not delete sessions pointing at it: the assignment is set to null, which is precisely what has happened, and the session says so instead of vanishing.

## Who may do what

Authority splits the way the [multiviewer](/manager/multiviewer/) does, and for the same reason: creating a session commits a node's disk, while starting one is show work, and the people who start and stop a recording are not administrators.

| Action | Group role | Also checked on the nodes |
|---|---|---|
| Create a session | **Admin** | **Manage** on the named edge and relay — this is where the hardware is committed |
| Delete a session | **Admin** | — |
| Start it, or arm a start time | **Operator** | **Operate** on both |
| Stop it | **Operator** | **Operate** on both — a stop writes to both nodes (it takes the renditions off the edge and retires the streams on the relay), so it is re-checked like a start |
| Set a stop time alone, disarm | **Operator** | — |
| Issue and revoke viewing links | **Admin** | — |
| Add, remove portal logins; set entitlements | **Admin** | — |
| Mint or clear the portal service token | **SuperAdmin** | — |

The node check is separate from the group check, and both are re-checked at activation rather than only at create: a node can be moved between groups, or a caller's membership changed, while a session sits in draft. Every mutation is written to the Audit Log, group-scoped to the session's owner — the one exception being the portal service token, which belongs to no tenant, so its rows carry no group and only a SuperAdmin sees them. The scheduler's unattended starts and stops are recorded there too, marked as system-triggered.

## Events

All of these carry the category `dvr`, which the Events page shows in its Category column. That page's category filter has no `dvr` entry, so narrow to them with the search box instead — the search is a full-text match on the message, and every one of these messages contains *DVR* (all but the clip-expiry warning, which opens *"This relay would not drop the clips…"*, begin with it), so that one word finds them all.

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
| `dvr_flow_restarted_for_recorder` | Warning | The edge, against the flow — arming the clip recorder restarted a running source flow, so every input and output on it dropped and re-established, not only this session's. Said only when a push was actually needed: a second session on the same flow at an equal or narrower window, or a retried activation, restarts nothing. Arm DVR before the flow goes on air to avoid it |
| `dvr_recorder_left_armed` | Warning | The edge, against the flow — the last session on a flow ended but the manager had no record of what that flow's recorder was before DVR armed it, so it was left running rather than cleared on a guess; check Flow → Recording on that flow and turn it off if it is not wanted |
| `dvr_clip_expiry_failed` | Warning | The relay — it would not drop the clips of expired sessions; their clips are already out of every viewer's reach and the disk is not reclaimed until the relay accepts the command. Said once on the transition, the sweep retries every pass, and there is no recovered counterpart — the sessions simply leave the list when the drop lands |

`dvr_teardown_incomplete` and `dvr_deprovision_incomplete` exist because stopping is deliberately best-effort: a session must be stoppable while its edge is offline, or an unreachable node would pin it active forever and keep the relay window held. The cost of that choice is an edge that may still be producing for a session that reads as stopped everywhere — so it is said out loud rather than left in a log.

## REST surface

Everything above is an endpoint. Full descriptions are in the [manager API reference](/manager/api-reference/).

| Method | Path | Description |
|--------|------|-------------|
| GET / POST | `/api/v1/dvr/sessions` | List the sessions the caller can see, or create one |
| GET / DELETE | `/api/v1/dvr/sessions/{id}` | Read one, or delete it |
| POST | `/api/v1/dvr/sessions/{id}/activate` | Start it now |
| POST | `/api/v1/dvr/sessions/{id}/stop` | Stop it now |
| POST | `/api/v1/dvr/sessions/{id}/schedule` | Arm a start time, a stop time, or both; nulls disarm |
| POST | `/api/v1/dvr/sessions/{id}/watch` | Watch the running feed as the caller: answers `{url}` for the relay's player, carrying the same three-hour viewer token a link gets. No grant is issued — an audit row (`dvr.session.watch`) names who opened it instead |
| GET | `/api/v1/dvr/sessions/{id}/viewers` | Which portal logins hold a viewing session on this feed, and which of them are watching — by the player's heartbeat, falling back to "holds an unexpired token" where the player never beats |
| GET / POST | `/api/v1/dvr/sessions/{id}/grants` | List the viewing links issued for a session, or issue one |
| DELETE | `/api/v1/dvr/grants/{grant_id}` | Revoke a viewing link |
| GET / POST | `/api/v1/dvr/portal-users` | Portal logins the caller can see, or add one |
| DELETE | `/api/v1/dvr/portal-users/{id}` | Remove a portal login |
| PUT | `/api/v1/dvr/portal-users/{id}/entitlements` | Replace the set of sessions that login may watch |
| GET / POST / DELETE | `/api/v1/dvr/portal-service-token` | Whether a portal token is configured, mint a replacement, or clear it (SuperAdmin) |

Four routes carry no session cookie by design — the viewer's entry point, and the three the portal service calls with its bearer token:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/watch/{stream_id}` | The viewer's entry point. Takes the grant key as `?k=`, mints a short-lived viewer token, and redirects to the relay's player |
| GET | `/api/v1/dvr/portal/streams` | What one portal username may watch — `active` sessions only. With `?for=clips` (what the portal's Exports table asks), also stopped sessions whose 24-hour clip-retention window, started at the stop, has not yet run out — listed whether or not any clip was actually cut |
| POST | `/api/v1/dvr/portal/token` | Mint a viewing token for one session on behalf of a username, re-checking the entitlement first |
| POST | `/api/v1/dvr/portal/heartbeat` | The player's presence beat, forwarded by the portal — what separates a login that is watching from one that merely holds a token |

The manager's `/watch/{stream_id}` is **not** the relay's `/watch/{stream_id}`: different server, different credential. The manager's exchanges a grant key for a redirect; the relay's is a WHEP player page on its distribution listener.

## Related

- [Viewer Distribution (WHEP + LL-HLS)](/relay/viewer-distribution/) — installing and configuring the relay half, the origin's storage and retention settings, and the browser DVR player's controls, picture modes and self-test.
- [The viewer portal](/relay/portal/) — the sign-in service that fronts a gated feed, and the trust boundary it depends on.
- [CMAF / LL-HLS output](/edge/cmaf/) — the edge output type a session provisions, and what `dvr_window_secs`, segment duration and the thumbnail track mean on the unit.
- [Multiviewer Walls](/manager/multiviewer/) — the other manager surface built on the same author-then-deploy split.
