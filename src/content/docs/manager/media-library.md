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

The browser splits the chosen file into **1 MiB chunks** and POSTs them sequentially over the manager's WS proxy. The manager forwards each chunk to the edge as an `upload_media_chunk` WS command. On the final chunk the edge `fsync_all`s the staging file and atomically renames it onto the library directory — no half-written files in the live library.

The manager applies a **60 s ACK budget** to upload chunks (vs the default 10 s) because the final-chunk `fsync` can take a noticeable amount of time on slow storage. This is the only WS command path with the extended budget.

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

Click the trash icon next to any file. The manager checks first: if a `media_player` input on this node still references the file, the operator is warned about which inputs and flows are about to point at a missing file. If they confirm anyway the manager emits a `media_deleted_in_use` warning event with `referencing_input_ids[]` and `referencing_flow_ids[]` so the events feed reflects the operator decision.

The edge itself will fall through to the next playlist source on its next `media_player` start; if there's no fallback, the input emits its own event when it next attempts to open the missing file.

## Abort behaviour

Closing the upload modal mid-stream cancels the chunk loop and tells the manager to log the abort. If the operator had already uploaded **half or more** of the declared file size before cancelling, a `media_upload_aborted` info event is recorded so the events feed reflects the decision. Smaller cancels (e.g. "wrong file picked, cancel immediately") are silent — the events feed isn't a typo log.

Aborts are advisory; the edge cleans up its staging files via a 1-hour TTL reaper.

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
