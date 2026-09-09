---
title: CMAF & CMAF-LL Output
description: Push fragmented-MP4 segments to an HTTP ingest with parallel HLS and DASH manifests, chunked-transfer low latency, time-based DVR windows, scrub-preview thumbnails and ClearKey CENC.
sidebar:
  order: 9
---

A **CMAF output** segments a flow into fragmented MP4 (ISO/IEC 23000-19) and PUTs the pieces to an operator-supplied HTTP ingest — a CDN push endpoint, an object store, or a [bilbycast-relay origin](/relay/viewer-distribution/). One output publishes an HLS media playlist and an MPEG-DASH MPD off the **same** segment set, so Apple and DASH players are reached from a single push without segmenting twice.

It is the fragmented-MP4 sibling of the HLS output: same HTTP-push shape, `.mp4` / `.m4s` objects instead of `.ts`. The output is compiled into every build — there is no Cargo feature and no capability bit to check. Two optional parts of it are build-gated: the scrub-preview thumbnail track needs `replay` (see [Scrub-preview thumbnails](#scrub-preview-thumbnails)), and the re-encode paths need `media-codecs` — plus a `video-encoder-*` backend for `video_encode`. All of those are present in the published release artefacts.

The per-field schema lives in [Configuration — CMAF Output](/edge/configuration/#cmaf-output). This page is the operational reference: what the edge actually publishes, which rules are enforced at config load, and which combinations do not exist.

## When to use it

- **CDN distribution** — a live channel pushed to Fastly / Akamai / MediaStore / an S3-style origin, reaching browsers and mobile without a packager in between.
- **Sub-3 s web latency** — `low_latency: true` streams each segment as it is written, so the first chunk is on the CDN roughly `chunk_duration_ms` after the first frame instead of a whole segment later.
- **Browser DVR** — `dvr_window_secs` turns the rolling playlist into a *duration*, which is what makes `video.seekable` cover hours instead of the ten seconds a five-segment live window gives you.
- **Encrypted distribution** — ClearKey CENC on the edge, with verbatim passthrough of Widevine / PlayReady / FairPlay `pssh` boxes minted by your DRM provider.

It is **output only**. The edge does not ingest its own CMAF; the playback side is any compliant HLS or DASH player.

## What gets published

Every artefact is a `PUT` to `{ingest_url}/{filename}`, so keep a trailing path component (`…/live/channel1`) if your ingest expects one. `auth_token`, when set, rides as `Authorization: Bearer {token}` on **every** PUT — segments, manifests, thumbnails alike.

| Object | Content-Type | Notes |
|-------|--------------|-------|
| `init.mp4` | `video/mp4` | `ftyp` + `moov`. Re-PUT every 30 s for the life of the flow, so an origin that lost it self-heals without a flow restart. |
| `seg-NNNNN.m4s` | `video/mp4` | The media segment, 5-digit zero-padded sequence number. Carries video, and audio too when the path allows it. |
| `seg-NNNNN.m4s?part=K` | `video/mp4` | LL-CMAF part URI. The query string distinguishes parts inside the one chunked PUT; there is no separate object. |
| `manifest.m3u8` | `application/vnd.apple.mpegurl` | HLS **media** playlist (`#EXT-X-VERSION:7`, or `9` in low-latency mode). There is no multivariant playlist — one output is one rendition. |
| `manifest.mpd` | `application/dash+xml` | Dynamic MPD. `profiles` is `urn:mpeg:dash:profile:cmaf:2019,urn:mpeg:dash:profile:isoff-live:2011`. |
| `thumbs-NNNNN.jpg` | `image/jpeg` | Scrub-preview sprite sheet. Only when `thumbnails` is configured. |
| `thumbs.vtt` | `text/vtt` | WebVTT index over the sheets still inside the playlist window. |

Names are fixed. If you need a different layout, rewrite the URLs in a reverse proxy in front of the ingest.

The manifests are published only after `init.mp4` exists, because every playlist names it in `#EXT-X-MAP` — a manifest published first is one a player can fetch, parse and then fail on.

## Whole-segment PUT vs low-latency chunked PUT

`low_latency` picks between two delivery models. It is the single most consequential field on the output.

| | `low_latency: false` (default) | `low_latency: true` |
|---|---|---|
| Upload | One `PUT` per finished segment, whole body. | One long-lived `PUT` per segment with `Transfer-Encoding: chunked`; `moof + mdat` chunks are pushed as they are built. |
| Cadence knob | `segment_duration_secs` | `chunk_duration_ms` (100–2000, default 500) inside `segment_duration_secs` |
| HLS | Ordinary media playlist. | Adds `#EXT-X-PART` rows, `#EXT-X-PART-INF`, `#EXT-X-SERVER-CONTROL` with `CAN-BLOCK-RELOAD=YES`. |
| DASH | Plain `SegmentTemplate`. | Adds `availabilityTimeOffset` = `segment_duration_secs − chunk_duration_ms/1000`, plus `availabilityTimeComplete="false"`. |
| Audio | Muxed in when the source has it. | **Video only** — see [Which paths carry audio](#which-paths-carry-audio). |
| `encryption` | Supported. | **Refused at config load.** |

`chunk_duration_ms` is only range-checked when `low_latency` is true, and is ignored entirely otherwise.

Back-pressure never reaches the flow. The chunked PUT is fed through a bounded channel with `try_send`; if the ingest cannot keep up the queue fills, the in-flight PUT is aborted, a Warning event is raised and the segment is discarded. The broadcast subscriber is never blocked — that is the project-wide invariant, and CMAF is no exception.

## Segment boundaries and target duration

CMAF segments must start on an IDR, so the segmenter cuts on the **first keyframe at or past** `segment_duration_secs` (1.0–10.0, default 2.0). The configured value is therefore a target, not a guarantee: on a passthrough source whose GoP does not divide it, real segments run long — up to one GoP longer.

`#EXT-X-TARGETDURATION` is derived from the rows rather than from the config, and held as a high-water mark. RFC 8216 §4.3.3.1 puts the constraint on the `EXTINF` values (rounded to the *nearest* integer), so a 5 s row against a 2 s configured target would make the playlist contradict its own tag. The configured value stays a floor, and `HOLD-BACK` in low-latency mode is computed from the advertised target — three times it — not from the config, so a player is never asked to start inside a segment that does not exist yet.

If you re-encode, the GoP is **not** derived from `segment_duration_secs`. `video_encode.gop_size` defaults to **60 frames** on a CMAF output when you do not set it. Set both fields if you want them to line up.

## Parallel HLS + DASH manifests

`manifests` is a non-empty subset of `["hls", "dash"]`, defaulting to both. Duplicates and unknown entries are rejected at config load. Publishing both costs one extra small PUT per segment cycle — the media objects are shared.

The MPD is dynamic and carries `availabilityStartTime` (the Unix second of the first emitted segment), `minimumUpdatePeriod` of one segment duration, `timeShiftBufferDepth` over the available segments, and a `SegmentTemplate` with `$Number%05d$` matching the HLS media filenames. `@codecs` is derived from the real parameter sets: `avc1.{profile}{constraints}{level}` for H.264, `hvc1.{profile}.{compat}.{L|H}{level}` for HEVC, `mp4a.40.{aot}` for AAC. Init segments emit `hvc1` sample entries, never `hev1` — parameter sets live only in the init, which is what iOS Safari requires.

:::caution[DASH addresses the live edge, not the DVR window]
`@startNumber` is rewritten to the newest segment on every publish, so the MPD points at the live edge even while `timeShiftBufferDepth` advertises a longer window. Browser DVR is served over HLS today.

The MPD also has one `Period` and no discontinuity signal. A media-timeline re-anchor is written to the HLS playlist as `#EXT-X-DISCONTINUITY` and is invisible to DASH players of the same output.
:::

:::caution[The DASH audio AdaptationSet points at objects the edge never writes]
When the source has AAC, the MPD gains an audio `AdaptationSet` whose `SegmentTemplate` media pattern is `aud-$Number%05d$.m4s`. No such object is ever PUT — audio is muxed into `seg-NNNNN.m4s` alongside the video. Treat HLS as the audio-carrying manifest until this is fixed, and prefer `manifests: ["hls"]` where audio matters.
:::

Neither manifest signals encryption. There is no `#EXT-X-KEY` tag in the playlist and no `<ContentProtection>` element in the MPD — CENC is signalled entirely inside `init.mp4` (`tenc` plus the `pssh` boxes), which is what an EME client reads.

## Absolute time on the playlist

Every closed segment row carries `#EXT-X-PROGRAM-DATE-TIME`, not just the first one. One row is spec-legal, but then the whole window rests on the single value belonging to whichever segment happens to be first, and the derived timeline shifts each time the window slides. The tag costs about 50 bytes against a segment of a couple of megabytes.

The one row that can go undated is low-latency's *in-progress* segment, which is read off the clock rather than allowed to steer it: until the flow's first segment closes there is no epoch to read, so an LL output's opening playlist carries no date on that row for about one segment, and it loses the date again if the row's own sample falls outside the epoch's plausibility band. A date wrong by most of a segment would be worse than an absent one — the tag is optional per RFC 8216 §4.3.2.6.

**The date is derived from the media timeline, not from the wall clock at publish time.** Each flow holds one shared epoch; a segment's date is that epoch plus the segment's own DTS. Sampling `now()` at publish put scheduling and upload latency straight into the tag, and made two outputs of the same flow disagree by the difference in their origins' response times.

The epoch is steered rather than pinned, because a media timeline is not a wall clock — a source running 450 ppm slow drifts a pinned epoch by seconds across a long session. Each closed segment moves the epoch toward a low-passed estimate of what the samples imply, by at most **5 ms**, which tracks a source up to about 2500 ppm out while no single date moves by more than an eighth of a frame. Two CMAF outputs of the same flow share one epoch, so they slew together and publish identical dates for the same segment.

A jump larger than **10 s** is not jitter — it is a source restart, a PTS discontinuity, or a flow reconfigured under the same id. The epoch snaps, and the snap is *declared*: the affected row is preceded by `#EXT-X-DISCONTINUITY`, and `#EXT-X-DISCONTINUITY-SEQUENCE` counts the ones already trimmed off the front of the window. An isolated re-anchor logs at INFO. Inside a run of them less than a minute apart nothing is logged until the third, which escalates to a WARN naming the condition — and again on every hundredth after that. Neither raises a manager event.

The playlist deliberately carries **no** `#EXT-X-PLAYLIST-TYPE`. `EVENT` promises a playlist that only ever grows (RFC 8216 §4.3.3.5), and a trimmed rolling window is not one — hls.js trusted it and computed a seekable range covering segments the origin had already dropped.

## The DVR window (`dvr_window_secs`)

By default the playlist lists the last `max_segments` segments (1–30, default 5). `dvr_window_secs` replaces that with a **duration**, and supersedes `max_segments` entirely when set:

```
playlist entries = ceil(dvr_window_secs / segment_duration_secs)
```

Expressing the window in time is what makes it survive a change to segment length. It is also what gives a browser a seek bar: `video.seekable` is derived from what the playlist lists, so a five-segment live window offers ten seconds of history no matter how much the origin still holds.

Validation:

| Rule | Bound |
|---|---|
| `dvr_window_secs` | Finite and `>= 1.0`. |
| Derived entry count | `<= 21600`. A 21 600-entry playlist is roughly 650 KB, refetched by every viewer on every segment — the cap guards manifest traffic, not disk. |

The error names the fix rather than the limit: lengthen `segment_duration_secs` or shorten the window. Twelve hours of 2 s segments sits exactly on the cap; twelve hours of 4 s segments is half of it.

:::caution[Origin retention must be sized to match]
The playlist is a *sliding* window. It advertises what the edge believes is available, and a seek into a segment the origin has already evicted 404s mid-playback. Size origin retention to the advertised window **plus headroom** — a viewer parked mid-window must not have the segment under them deleted while they are watching it. On a bilbycast relay origin that setting is `origin_retention_secs`; see [Viewer distribution](/relay/viewer-distribution/).
:::

## Which paths carry audio

`init.mp4` declares the track list, and a browser builds its decoders from that file **once**. So the answer has to be decided before the first publish and then never change: declaring an audio track that no fragment fills stalls MSE silently — the decoder initialises, waits forever, buffers nothing and reports no error, while the manifest, the segments and the origin all look healthy.

The edge therefore latches one answer per output:

| Configuration | Audio |
|---|---|
| Whole-segment, unencrypted | **Muxed into the same fragment as the video** — one `moof` addressing both tracks, so a browser needs a single MSE SourceBuffer and there is no second timeline to keep aligned. |
| `low_latency: true` | **Video only.** A low-latency chunk is one `traf` for the video track; there is no audio run in it at all. |
| `encryption` set | **Video only.** CENC covers video; the audio encryptor exists but is unwired, and shipping audio in the clear under an init that declares the output encrypted would be worse than omitting it. |

Both video-only cases say so in the log at startup rather than presenting as a stream that simply has no sound.

On the muxed path the decision waits up to **3 s** after the video track materialises for an audio track to appear. Audio that starts later than that is **not** adopted — the `moov` cannot widen under a player already running — and the output stays video-only for the life of the flow. A single warning names the remedy: for the ordinary path, restart the flow; for the two structural cases above, there is no remedy short of changing the configuration.

Source-codec rules:

- **AAC** (LC / HE-AACv1 / HE-AACv2) rides through untouched.
- **MP2 / AC-3 / E-AC-3** reach CMAF only via `audio_encode` — the edge decodes them and re-encodes to AAC. Without an `audio_encode` block the frames are discarded.
- **Opus** is dropped; there is no CMAF path for it.
- **MPEG-2 video** is dropped. CMAF video must be H.264 or HEVC.

`audio_encode.codec` on a CMAF output accepts `aac_lc`, `he_aac_v1` or `he_aac_v2` only. A `transcode` block (channel shuffle / sample-rate / bit-depth) sits between the decoder and the encoder and is **rejected without `audio_encode`**, because on its own it would do nothing. See [Audio gateway](/edge/audio-gateway/).

## Re-encoding: an explicit backend, always

`video_encode` on a CMAF output must name a real encoder. The `*_auto` aliases every other output accepts are **rejected at config load**:

```
CMAF output 'x': video_encode.codec 'h264_auto' is not resolvable here — a CMAF
output needs an explicit backend (x264, x265, h264_nvenc, hevc_nvenc, h264_qsv,
hevc_qsv, h264_vaapi, hevc_vaapi, h264_rkmpp, hevc_rkmpp), because the CMAF
re-encoder does not resolve the `*_auto` aliases
```

This is checked before the generic encoder validation, because the reason holds on every build: it is about what the CMAF re-encoder can resolve, not about which backends were compiled in. Accepting an alias used to load cleanly and then fail at flow start — leaving the re-encoder unset and **publishing the source encoding under a config that says it is being re-encoded**.

Which of the ten backends a given binary carries is a build question; see the [Codec matrix](/edge/codec-matrix/).

HEVC is best paired with `manifests: ["dash"]` — HLS fMP4 HEVC playback varies by client — but nothing enforces that.

## Scrub-preview thumbnails

A drag on a scrub bar issues roughly twenty seeks a second. Every position outside the player's back buffer costs a media-segment fetch, so a drag presents 0–1 frames out of forty — measured at LAN speed, at 25 Mbit/s and at 8 Mbit/s alike. One sprite sheet is about the size of one media segment and covers `frames_per_sheet` positions. That is the whole idea.

The track is a sibling subscriber on the flow's broadcast channel, drop-on-lag, decoding and JPEG-encoding under `spawn_blocking`. A failure here never tears down the CMAF output.

| Field | Default | Range | Notes |
|---|---|---|---|
| `interval_secs` | `2` | 1–30 | Seconds between preview frames. The default matches a typical segment duration, so there is one frame per segment and no gap a drag can fall into. |
| `frames_per_sheet` | `20` | 1–200 | Frames packed into a sheet before it is published. This is the **lag of the newest preview**, not a size knob — a sheet only exists once it is full. Two full rows of the ten-wide grid. |
| `width` | `160` | 64–640 | Preview frame width in pixels. |
| `height` | `90` | 36–360 | Preview frame height in pixels. |

Three cross-checks run at config load on top of those ranges:

- `interval_secs × frames_per_sheet` must be **strictly less** than the playlist window (`dvr_window_secs`, or `max_segments × segment_duration_secs` when it is unset). Otherwise no sheet would ever describe a segment the playlist still lists — a scrub bar showing a preview nowhere, which is the symptom the track exists to remove.
- `width × 10` must be `<= 4096`, so ≤ 409 px in practice. The sheet is laid out ten frames wide, and many mobile GPUs refuse a wider image outright — with no error anywhere.
- `ceil(frames_per_sheet / 10) × height` must be `<= 4096`. The tall axis is the easier one to hit by accident, because it grows with a field that is not named in pixels.

Sheets are `thumbs-NNNNN.jpg`; `thumbs.vtt` is rewritten after each one and lists only the sheets whose frames still fall inside the playlist window — pruned by age against that window (`dvr_window_secs`, or `max_segments × segment_duration_secs`), not against anything the origin reports. Under-size origin retention and the index will still name a sheet the origin has already evicted. Cue times are offsets from a UTC epoch the file declares in its own `X-BILBYCAST-EPOCH` header — the player converts a scrub position to wall clock through `#EXT-X-PROGRAM-DATE-TIME` on the media playlist, then to an offset from that epoch. The epoch moves with the window, exactly as the playlist's dates do.

:::note[The index is not referenced from either manifest]
`thumbs.vtt` and the sheets are published beside the media, but neither the HLS playlist nor the MPD points at them, and `X-BILBYCAST-EPOCH` is a bilbycast extension rather than a standard WebVTT header. Wiring the preview into a player is an integration step on the playback side.
:::

:::caution[Needs a build with the `replay` feature]
The track reuses the [replay](/edge/replay/) filmstrip's frame capture, and its JPEG encode comes from `media-codecs`. Both are on by default and present in all three published release artefacts. On a build without them the config still validates and the output still runs, but no preview is ever published and a Warning `config` event says exactly that — otherwise it would be indistinguishable from a source the capture could not decode.
:::

## ClearKey CENC and commercial DRM

`encryption` turns on Common Encryption (ISO/IEC 23001-7) with an operator-supplied key.

| Field | Required | Notes |
|---|---|---|
| `key_id` | Yes | Exactly 32 hex characters (16 bytes). Lands in `tenc.default_KID` and the ClearKey `pssh`. |
| `key` | Yes | AES-128 content key, exactly 32 hex characters. **A secret held in the node config** — clients get it only through your license flow. |
| `scheme` | Yes | `"cenc"` (AES-128 CTR, per-sample 16-byte IV) or `"cbcs"` (AES-128 CBC, 1:9 block pattern, all-zero constant IV — FairPlay). Anything else is refused by name. |
| `pssh_boxes` | No | Hex-encoded complete `pssh` boxes from your DRM provider, one per system. Each must be even-length hex decoding to 32–4096 bytes with the fourcc `pssh` at bytes 4–7. Copied into `moov` verbatim. |

What the edge does with it: the sample entry becomes `encv` wrapping `avc1` / `hvc1` in a `sinf / frma / schm / schi / tenc` chain; each video sample is subsample-split so the NAL length prefix, NAL header and a conservative 32-byte slice-header allowance stay clear while the rest of the VCL NAL is encrypted; parameter-set NALs stay fully clear; `senc` / `saio` / `saiz` are written into every `traf`; and a version-1 ClearKey `pssh` carrying the KID goes into `moov` ahead of any operator boxes. For `cbcs` the encrypted span is rounded down to a multiple of 16 bytes and `tenc` carries `crypt_byte_block=1`, `skip_byte_block=9`, `Per_Sample_IV_Size=0` and a 16-byte zero constant IV.

The edge does **not** run a license server, and does not talk to Widevine / PlayReady / FairPlay license services. Register the content key with your provider, take the `pssh` box each one returns, and paste the hex into `pssh_boxes`; players pick the system matching their CDM. For ClearKey, return `{"keys":[{"kty":"oct","kid":…,"k":…}]}` from your own license URL.

:::caution[`encryption` and `low_latency` are refused together]
The pair fails at config load with:

```
CMAF output 'x': encryption is not applied on the low-latency path — its chunks
are written unencrypted. Use low_latency = false for an encrypted output, or
drop `encryption` if low latency matters more.
```

Refused rather than warned. The low-latency chunk writer emits no `senc` / `saiz` / `saio` and applies no CENC transform, so the media would go out in the clear while the init declared the output encrypted, "CENC active" appeared in the log, and every manager surface agreed. A configuration whose security property silently does not hold is worse than one that will not start.
:::

Remember that an encrypted output is video-only. Do not pair `encryption` with `audio_encode` expecting sound.

## Worked examples

An output is a top-level entity in `config.json`; a flow references it by id in `output_ids`.

**Standard CMAF with a two-hour DVR window and scrub previews.** Both manifests, AAC passthrough, 4 s segments. The playlist derives `7200 / 4 = 1800` entries, well inside the 21 600 cap, and the sheet lag is `4 × 20 = 80 s` against a 7200 s window.

```json
{
  "type": "cmaf",
  "id": "cdn-primary",
  "name": "CDN primary push",
  "ingest_url": "https://ingest.cdn.example.com/live/channel1",
  "auth_token": "s3cr3t-ingest-token",
  "segment_duration_secs": 4.0,
  "dvr_window_secs": 7200.0,
  "manifests": ["hls", "dash"],
  "thumbnails": {
    "interval_secs": 4,
    "frames_per_sheet": 20,
    "width": 160,
    "height": 90
  }
}
```

**LL-CMAF, HLS only.** 500 ms parts inside 2 s segments; a six-segment live window. No `encryption` — the pair would be refused. This output is video-only whatever the source carries.

```json
{
  "type": "cmaf",
  "id": "ll-web",
  "name": "Low-latency web edge",
  "ingest_url": "https://ll.cdn.example.com/live/web",
  "low_latency": true,
  "chunk_duration_ms": 500,
  "segment_duration_secs": 2.0,
  "max_segments": 6,
  "manifests": ["hls"]
}
```

**Encrypted, re-encoded, MPTS source.** `cbcs` for FairPlay, an explicit `x264` backend (no `h264_auto`), a `gop_size` set to line up with the 4 s target at 25 fps, and program 3 filtered out of the MPTS before segmenting.

```json
{
  "type": "cmaf",
  "id": "drm-egress",
  "name": "DRM egress",
  "ingest_url": "https://ingest.cdn.example.com/live/drm",
  "program_number": 3,
  "segment_duration_secs": 4.0,
  "max_segments": 8,
  "manifests": ["hls", "dash"],
  "video_encode": {
    "codec": "x264",
    "bitrate_kbps": 6000,
    "gop_size": 100,
    "preset": "medium",
    "profile": "high"
  },
  "encryption": {
    "scheme": "cbcs",
    "key_id": "0123456789abcdef0123456789abcdef",
    "key": "fedcba9876543210fedcba9876543210",
    "pssh_boxes": []
  }
}
```

## Monitoring

The output reports on the standard per-output stats surface with `output_type: "cmaf"` and `mode` set to `"cmaf"` or `"cmaf-ll"`, plus the `ingest_url` it is pushing to. There is no `wire_pacing_tier` — CMAF owns no UDP socket and paces inside HTTP.

Lifecycle and upload failures arrive as `cmaf`-category events; the full catalogue is in [Events & alarms](/edge/events-and-alarms/). Two shapes are worth planning for. Only the init-segment upload and the thumbnail capture are latched at all — the init one re-arms after a success, so it is one Warning per *failure episode* rather than one per attempt, while the thumbnail-capture one fires once for the life of the output. Segment and manifest uploads are not latched, so an origin that stays down produces one Warning **per segment** and **per manifest cycle**. Rate-limit those at the alarm rule, not at the edge.

## Limitations

- **One rendition per output.** Multi-bitrate ABR is produced by running several CMAF outputs and merging the manifests at the origin or CDN — the standard workflow, and why no multivariant playlist is written.
- **No live-to-VOD archival.** The playlist is a rolling window; nothing is promoted to a static asset.
- **`EXT-X-PART` rows land after their own segment's `#EXTINF`.** RFC 8216bis §4.4.4.9 places them before it. A strictly conforming player attributes them to the next media sequence number, which breaks `_HLS_msn` / `_HLS_part` blocking-reload addressing.
- **`EXT-X-PART:DURATION` is the nominal chunk target**, not the chunk's real span — a chunk takes samples spanning *at least* the target, so the advertised figure under-claims and the parts do not sum to the segment's `#EXTINF`.
- **The CENC clear prefix is conservative.** A fixed 32-byte slice-header allowance is safe but leaves roughly 32 more bytes in the clear than a bit-accurate slice-header parser would.
