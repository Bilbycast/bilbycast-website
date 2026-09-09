---
title: Media Library
description: On-edge file playout for bilbycast — slates, loops, emergency-fallback content, image stills with browser upload, quota enforcement, and reference-aware delete.
sidebar:
  order: 5
---

Each edge node has a small on-disk **media library**. The edge's `media_player` input replays files from this library as a paced MPEG-TS feed on the flow's broadcast channel. Typical content:

- A station ID slate or "we'll be right back" loop.
- An emergency-fallback feed pinned as a Hitless leg behind a live primary, so a primary loss flips to local content automatically without an operator touch.
- A SMPTE bars / Mire test pattern for plant alignment.
- A still image (PNG / JPG) rendered at a configurable fps for graphics overlays.

The manager exposes the library on the same input modal as the rest of the `media_player` config — a quota meter at the top, a file picker, an Upload button. Operators never need to SSH into an edge to manage its content.

## Why it matters

Broadcasters need on-edge playout for two scenarios:

- **Resilience.** When a contribution feed dies, viewers shouldn't see a black hole — they should see a slate, a station ID, or a held graphic. Pinning a `media_player` input as a Hitless leg behind a live primary turns "primary down" into a clean cut to local content.
- **Programming flexibility.** Promo loops, sponsor reels, scheduled identifiers, and "off-air" graphics are easier to manage as files on each edge than as live contribution feeds from the studio.

The Media Library makes both flows browser-managed.

## Upload model

The browser splits the chosen file into **1 MiB chunks** and POSTs them sequentially to the manager (one `application/octet-stream` HTTP POST per chunk). The manager forwards each chunk to the edge as a native binary WebSocket frame (it falls back to the legacy base64 `upload_media_chunk` text command only when the edge is owned by another manager instance). On the final chunk the edge `fsync_all`s the staging file and atomically renames it onto the library directory — no half-written files in the live library.

The manager applies a **60 s ACK budget** to upload chunks (vs the default 10 s) because the final-chunk `fsync` can take a noticeable amount of time on slow storage. (The bond-leg capacity probe uses a similar extended budget for its own multi-second ramp.)

## Quota model

Two caps, both per-edge:

- **4 GiB** per file.
- **16 GiB** total library size.

Quota is preflighted on the first chunk: if the upload would exceed either cap, the manager refuses with HTTP 413, emits a `media_quota_exhausted` warning event, and the upload modal shows the rejection. The edge re-checks at chunk-write time as the authoritative gate.

The browser shows a live quota meter at the top of the file picker:

- **Amber at 75 %** of the 16 GiB cap.
- **Red at 90 %** of the 16 GiB cap.

Operators see the cap approaching before they're blocked.

## Reference-aware delete

Click the Delete button next to any file (a confirmation prompt guards the click). After the edge confirms the delete, the manager checks the node's cached config: if a `media_player` input still referenced the file, it emits a `media_deleted_in_use` warning event with `referencing_input_ids[]` and `referencing_flow_ids[]` so the events feed records which inputs and flows now point at a missing file.

The edge itself will fall through to the next playlist source on its next `media_player` start; if there's no fallback, the input emits its own event when it next attempts to open the missing file.

## Abort behaviour

Closing the upload modal mid-stream cancels the chunk loop and tells the manager to log the abort. If the operator had already uploaded **half or more** of the declared file size before cancelling, a `media_upload_aborted` info event is recorded so the events feed reflects the decision. Smaller cancels (e.g. "wrong file picked, cancel immediately") are silent — the events feed isn't a typo log.

Aborts are advisory; the edge cleans up its staging files via a 1-hour TTL reaper.

## Playlist compatibility planning

The same input modal builds the playlist: an ordered list of sources, **Loop playback** (on by default — the shape fallback duty wants), **Shuffle** (a fresh random order at start and again on every loop wrap), an optional paced-bitrate override for TS files that carry no PCR, and the output datagram size.

Before anything is saved, the manager asks the edge to classify **every adjacent boundary** of the proposed playlist — including the loop wrap from the last item back to the first — and renders the answer as a chip between the rows:

| Chip | Meaning |
|---|---|
| **Seamless** | PSI stable, timestamps continue, no decoder reset. |
| **Signalled cut** | Playable natively, but the player signals a discontinuity across the join. |
| **Needs transcode** | The join can only be played after normalising the assets. |
| **Incompatible** | The join cannot be played as configured. |

Each chip's tooltip names the reason in operator language — resolution changes, frame rate changes, audio codec changes, video disappears, decoder needs a reset. A playlist the edge marks unplayable — an *Incompatible* or *Needs transcode* boundary, or an item that isn't ready on that node — blocks **Save** and names the offending item number, so an incompatible splice surfaces at edit time instead of as an on-air glitch. A *Signalled cut* is a legitimate playlist and stays saveable.

## Transport control (the Next button)

On a node's detail page, a flow whose active input is a `media_player` grows a transport strip inside its flow card: the current item with its elapsed / total clock, the playout state, a **Next:** line naming the upcoming item, and a **Next** button that skips to it.

- The button renders only when the node advertises the `media-player-control-v1` capability, and only for operators with Operate permission on that node.
- The **Next:** line turns red with *⚠ not ready* when the upcoming item can't be opened. Pressing Next there would cut to dead air, so the edge refuses.
- The click carries the transport's generation counter, so a press that races the playlist advancing on its own is answered with a generation conflict and retried once against the current generation rather than skipping an extra item.
- An accepted skip is written to the audit log as `media_player.next`. A press that changed nothing — playlist exhausted, not playing yet, a skip already pending — is not: the audit trail records on-air skips, not refused clicks.
- An input pinned to the legacy loop (below) advertises the node-wide capability anyway, so the first press there is answered `media_player_control_unavailable` and the button removes itself.

## Rollback levers

Two knobs exist so a single misbehaving node can be put back on the previous behaviour without rolling back a release. Both default **on** and should stay there.

- **Operator transport control** — runs playout through the transition state machine that the **Next** button drives. Node-wide at **Configure → Tuning → Media Player** (the section is gated on the edge's `media_player_tuning` capability); turning it off there withdraws `media-player-control-v1`, so Next disappears from every media-player flow on the node rather than being offered and refused. To pin one player to the legacy loop instead, set that input's **Transport control** to *Legacy loop — no Next button*.
- **PCR-anchored playout pacing** — paces TS playout on deadlines taken from the asset's own PCR rather than an estimated byte rate, which drifts without bound on variable-bitrate assets. Node-wide on the same Tuning section; per input it is the `pcr_deadlines` config field, which has no modal control.

A per-input setting always wins over the node-wide one. Both layers are re-read when a media-player input next starts, so restarting the flow applies a change — no node restart.

## Worked example

A regional broadcaster keeps the same content on every edge:

- `station-id.ts` (15 s loop with their logo and a 1 kHz tone — emergency identifier).
- `please-stand-by.ts` (30 s held graphic with rotating sponsor cards).
- `bars-mire.ts` (SMPTE bars + tone for plant alignment).
- `weather-fallback.png` (still image with a "see weather.gov" overlay, used when the weather contribution feed dies).

Their primary newsroom flow has a `media_player` input pinned as a Hitless leg behind the live SRT contribution feed. When the contribution feed drops a packet for >200 ms, the edge cuts to `please-stand-by.ts` automatically; the moment SRT recovers, it cuts back. Viewers see a clean held graphic instead of black, the operator gets a `flow` warning event, and the engineering team has time to investigate without an on-air emergency.

## Reference

- Operator walk-through: [`USER_GUIDE.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/USER_GUIDE.md) ("Media Library (on-edge file playout)").
- Architecture, upload protocol, quota events: [`media-library.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/media-library.md).
- API reference: [`API.md`](https://github.com/Bilbycast/bilbycast-manager/blob/main/docs/API.md) ("Media library (on-edge file playout)").
- Edge-side `media_player` input: [Edge Configuration](/edge/configuration/).
