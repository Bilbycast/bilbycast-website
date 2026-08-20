---
title: Multiviewer (Mosaic Wall)
description: Composite several of a node's inputs into one canvas and republish it as MPEG-TS, so a monitoring wall is an ordinary flow source you can restream, record and thumbnail.
sidebar:
  order: 9
---

A **multiviewer wall** composites several of a node's inputs into a single canvas and publishes that canvas as a fresh MPEG-TS feed. The wall is therefore an ordinary flow source: restream it over SRT, RTP, UDP, RIST, WebRTC or CMAF, record it with [Replay](/edge/replay/), let the flow thumbnail it, or feed it into another wall — none of that needs anything new, because as far as the rest of the edge is concerned a wall is just an input producing a transport stream.

That is the design in one sentence: **a wall is an input of `"type": "mosaic"`**, not an output. It is the only input type that consumes other inputs on the same node.

## When to use it

- **Gallery / control-room wall** — put 4, 9 or 16 contribution feeds on one screen and send that one stream to wherever the operators are, instead of decoding sixteen streams at the viewing end.
- **Remote monitoring over a thin link** — one 8 Mbps mosaic reaches a producer at home; sixteen individual feeds do not.
- **Confidence wall on the box** — pair the wall with a [display output](/edge/display/) and the on-site engineer sees every feed on the HDMI connector next to the node.
- **Cheap wall recording** — record the mosaic itself, so an as-run of what the gallery saw exists without recording every source.

It is **not** a director's surface: there is no tally, no UMD, no audio metering and no click-to-air in phase 1 (see [Limitations](#limitations)). For cutting a programme, use the [Live Switcher](/manager/switcher/).

## Will my node do this?

Two things must be true, and both are properties of the **binary**, not of the host:

1. The edge was built with the `multiviewer` feature (off by default).
2. The edge was built with at least one video encoder. The flow bus carries MPEG-TS, so a composite reaches an output only by being **encoded and muxed** — a build with the compositor and no encoder compiles fine and then refuses at flow start.

**All three published release artefacts carry both** — `x86_64-linux-full`, `aarch64-linux-full` and `aarch64-linux-rockchip`. The release workflow verifies it on every artefact before publishing, so a release binary that could not run a wall does not ship.

A node that can run a wall advertises the `mv-compositor` capability. A node without it advertises **no head at all**, so it never appears as somewhere a wall could be drawn; and a wall pointed at one anyway is refused at deploy with the reason named — built without the multiviewer feature, or without a video encoder. Check the capability from the node itself:

```bash
bilbycast-edge --print-capabilities | grep -E 'multiviewer|mv-compositor'
```

If you build from source, the compositor needs an encoder named alongside it:

```bash
# libx264 — GPL v2+, so the combined binary is AGPL-3.0-or-later
cargo build --release --features "multiviewer,video-encoder-x264"

# NVENC — LGPL-clean, needs an NVIDIA driver at runtime
cargo build --release --features "multiviewer,video-encoder-nvenc"
```

:::caution[The wall encodes on the CPU on every published release]
The compositor uses the **first encoder compiled into the binary**, and in all three published artefacts that is **libx264** — CPU encode, even on a host with NVENC, QSV, VAAPI or Rockchip RKMPP hardware available. Budget the wall as a software H.264 encode at its canvas size and frame rate. The node reports the backend it will actually use in its health payload under `mv_heads[].capabilities.encoder_backends`.
:::

## Authoring a wall

In phase 1 the manager's **Multiviewer Walls** page (`/mv/walls`) is a **read-only** view of your walls plus **Deploy**, **Redeploy** and **Undeploy**. Layouts, tile routing and head allocation are **REST calls** — there is no layout editor in the browser yet, and no live re-routing. See [Multiviewer walls (operator UI)](/manager/multiviewer/) for those endpoints and the deploy workflow. This page is the **edge** side: what the node accepts, what it draws, and what it reports.

Everything below is also reachable directly: a mosaic is just another entry in the node's `inputs` array, so it can be created through the edge REST API or written into `config.json` like any other input.

## Config

A 2×2 wall at 1080p25, with one tile deliberately left unrouted:

```json
{
  "id": "wall-1",
  "name": "Gallery wall",
  "type": "mosaic",
  "width": 1920,
  "height": 1080,
  "fps": 25,
  "video_bitrate_kbps": 8000,
  "codec": "h264_auto",
  "tiles": [
    { "id": "t1", "source_input_id": "cam-1", "x": 0,   "y": 0,   "width": 960, "height": 540, "label": "CAM 1" },
    { "id": "t2", "source_input_id": "cam-2", "x": 960, "y": 0,   "width": 960, "height": 540, "label": "CAM 2" },
    { "id": "t3", "source_input_id": "cam-3", "x": 0,   "y": 540, "width": 960, "height": 540, "label": "CAM 3" },
    { "id": "t4", "source_input_id": null,    "x": 960, "y": 540, "width": 960, "height": 540, "label": "SPARE" }
  ]
}
```

Then put `wall-1` in a flow's `input_ids` and give that flow whatever outputs you want the wall seen on. Nothing about the flow is special.

### Canvas fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `type` | string | — | Always `"mosaic"`. |
| `width` / `height` | u32 | `1920` / `1080` | Both must be **even** (every 4:2:0 encoder needs it). **Capped at 1920×1080** in phase 1 — written here, a larger canvas is refused when the config is validated, not at flow start. The manager-authored path refuses later, at deploy; see [Limitations](#limitations). |
| `fps` | u16 | `25` | 1–60, **whole frames per second only**. A fractional broadcast rate cannot be expressed here at all, and the manager refuses a 29.97 or 59.94 layout rather than rounding it. The **canvas's own** cadence, deliberately independent of any source's rate: a tile slower than the canvas repeats, a faster one is decimated, and neither is an error. |
| `video_bitrate_kbps` | u32 | `8000` | 100–200000. The canvas encodes with a 2-second GOP and no B-frames — a wall is judged on latency and on being readable, not on compression. |
| `codec` | string | `"h264_auto"` | Accepts the same names as an output's `video_encode.codec`. **Does not select the encoder in phase 1** — see the note below. Max 64 characters. |
| `tiles` | array | — | 1–64 tiles. Required. |

:::note[`codec` is accepted but does not choose the encoder]
In phase 1 the compositor always opens the first encoder compiled into the binary (libx264 on every published artefact) regardless of what `codec` says. The field is still read by the node's **resource-budget estimate**, so naming a hardware encoder here makes the manager's "Resource impact" preview count a hardware session the wall will never open. Leave it at `h264_auto` unless you have a reason not to.
:::

### Tile fields

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `id` | string | — | 1–64 characters, unique within the wall. **Stable identity** — routing keys on it, so renaming a tile cannot silently re-point a signal. |
| `source_input_id` | string \| null | `null` | A **node-local** input id. `null` renders the tile as UNASSIGNED rather than leaving a hole. An input running on a *different* node cannot be a tile source — see [Limitations](#limitations). |
| `x` / `y` | u32 | — | Top-left corner in canvas pixels. |
| `width` / `height` | u32 | — | Tile size in canvas pixels. Non-zero, and the whole rect must fit inside the canvas. |
| `z` | i32 | `0` | Paint order; higher is drawn later, therefore on top. **Overlap is legal** — it is how a picture-in-picture or a banner is built. |
| `label` | string | `""` | Max 64 characters. Carried with the layout for the manager's authoring surface; **nothing is burned into the canvas in phase 1** (no glyph rendering — see [Limitations](#limitations)). |

Sources are letterboxed into their tiles: the aspect ratio is preserved, the picture is centred, and the leftover becomes bars. Tiles decode H.264, H.265 and MPEG-2.

A wall is an ordinary input, so **another wall on the same node can take it as a tile source** (a wall-of-walls). Pointing a wall at its own input id is refused — it would feed the compositor its own output.

## What an operator sees

| State | On the canvas | Means |
|-------|---------------|-------|
| **Live** | The source, letterboxed into its tile. | Frames are arriving. |
| **NO SIGNAL** | An **amber** bar across the middle of the tile. | A source is routed here and has delivered nothing for 2 seconds. |
| **UNASSIGNED** | A neutral **grey** bar. | No source is routed to this tile at all. |

Two states, not one, because they send an operator to different places: "the feed died" and "nobody patched this" are different problems, and a wall that showed the same rectangle for both would make an operator check the wrong thing first. The colours are chosen to be told apart from ten feet away.

**A stale frame is never presented as live.** A source that stops keeps its last picture on the canvas — going black on a momentary hiccup would be worse — but once the 2-second timer expires the badge goes over the top of it. The two seconds are long enough to ride out a GOP boundary, a bonded-path reordering window or a decoder hiccup without a badge flickering across the wall, and short enough that a real failure is visible within a breath.

A tile with a higher `z` covers both the picture *and* the badge of everything beneath it, so a picture-in-picture is never painted over by a background tile's NO SIGNAL bar.

## A wall never disturbs the feeds it watches

This matters most on the node where a wall is most useful: a contribution node already carrying high-bitrate live feeds. The compositor is a *monitoring* surface and must never apply backpressure to the media paths it is looking at, so:

- **Each tile decodes independently and keeps only its newest frame.** The handoff overwrites rather than queues — it cannot block a decoder, cannot fill, and cannot grow. A tile decoding faster than the canvas ticks simply has its older frames discarded, which is exactly right: nobody wants a stale frame that was queued behind a fresher one.
- **The compositor never waits for a tile.** Each canvas tick takes whatever each tile has at that instant. A dead source cannot stall the wall.
- **A tile that falls behind its source is skipped, not awaited** — the shortfall is counted (`tile_input_lagged`) and the tile carries on.
- **A missing source is not fatal and not permanent.** Tiles subscribe in a retry loop, so a source that isn't running *yet* is picked up when it appears — a wall is usually started alongside the very feeds it watches — and a source stopped and restarted mid-show is picked up again.
- **The wall's own audio is absent by design.** The mosaic publishes video only, and its PMT announces no audio PID at all: announcing one that never carries a packet would make receivers and A/V checks wait for audio that is never coming.

## Telemetry

A wall feeds the flow's ordinary input packet and byte counters like any other input, so its throughput appears wherever those already do.

The five counters below are a different matter. In phase 1 they are **internal to the compositor**: they reach no stats message, no REST stats surface, no `/metrics` scrape and no manager screen. Four of them are printed once, to the node's own log, when the compositor stops — `tile_input_lagged` is counted but not printed at all. They are documented here because they name the failure modes exactly, but reading one today means reading the node's log, not a screen.

| Counter | What a rising number means |
|---------|----------------------------|
| `canvas_frames` | Canvas frames composited and published. This is the wall's real output rate — compare it against `fps`. |
| `canvas_over_budget` | Canvas ticks whose composite work took longer than one canvas period. **The wall is too expensive for this node** — reduce the tile count, the canvas size or `fps`. |
| `canvas_skipped` | Canvas periods that went by with no frame produced. The wall is being **starved** rather than being expensive. This is what an operator sees as a stuttering wall; without the counter it would run at a fraction of its configured rate with everything else reading healthy. |
| `tile_input_lagged` | Transport packets a tile missed because that tile's decode fell behind its source. That tile's picture will have artefacts or gaps. This is **not** the ordinary case of a decoded frame being superseded by a fresher one, which is healthy, happens constantly, and is not counted. |
| `tile_decode_errors` | Frames a tile could not decode. |

`canvas_over_budget` and `canvas_skipped` are deliberately separate: "too expensive" and "being starved" are different faults with different fixes, and one counter conflating them would tell an operator nothing.

## Events

| Event | Severity | Trigger |
|-------|----------|---------|
| `mosaic_failed` | Critical | The wall stopped. The commonest cause is a build with the compositor but no video encoder — the message names the rebuild. |
| `mosaic_tile_source_missing` | Warning | A tile's `source_input_id` is not running on this node **yet**. The tile keeps retrying and fills in when the input appears; this is expected when a wall starts alongside the feeds it watches. |
| `mosaic_tile_self_reference` | Warning | A tile named the wall's own input id. Refused — the tile is left unassigned and reads UNASSIGNED. |

All three carry the wall's `input_id`; the two tile events also carry `tile_id`, and `mosaic_tile_source_missing` names the `source_input_id` it is waiting for.

## Limitations

Phase 1 ships a stream head and nothing else. Stated plainly:

- **Canvas is capped at 1920×1080**, and how you meet that ceiling depends on which way in you took. A mosaic written into a node's `config.json` or posted to the edge REST API is refused when that config is validated — not at flow start. A wall authored in the manager is a different story: an oversized layout **saves, with a warning**, and it is the **deploy** that is refused, naming the ceiling the head actually advertises. The ceiling mirrors the display output's, which exists because a 4K software convert into a write-combining display buffer measured about 7 seconds per frame. A stream head composites into ordinary cached memory and is very probably not bound by that number — but nobody has measured the stream-head shape yet, and shipping an unmeasured UHD path is how the display output earned its own ceiling. Raising it is gated on that measurement.
- **No text is drawn.** Badges are coloured bars, and `label` is not burned into the canvas: rendering glyphs needs a font stack this binary does not carry. An operator reading a wall across a gallery reads position and colour long before letters, so this is the right thing to defer, but it does mean tile names live in the manager UI rather than on the picture.
- **Tile sources must be inputs on the same node.** A signal from another node cannot be a tile source today; the manager reports that case and emits the tile unrouted, so it reads UNASSIGNED rather than showing nothing silently. Cross-node walls need proxies, which are not built yet.
- **A tile shows the first video stream it finds in its source.** Program and PID selection are not honoured, so a tile pointed at one programme of an MPTS gets whichever video came first — and a wrong programme looks entirely plausible on the canvas. The manager says so when it compiles a wall; the node itself has no way to warn you.
- **Only H.264, HEVC and MPEG-2 tiles decode.** Everything else the demuxer emits — audio, data, and any other video codec — is dropped before a decoder is opened. A source carrying none of the three produces no frames at all, so its tile sits at **NO SIGNAL** with no event and no `tile_decode_errors` increment: nothing ever failed to decode.
- **Letterbox only.** There is no crop or stretch fit policy.
- **Video only.** No audio in the mosaic, and no audio metering rasterised into the canvas.
- **No tally or UMD**, no per-tile QC and no click-to-replay.
- **Stream head only.** Driving a wall straight out of an HDMI connector or an SDI port, rather than as a transport stream, is not built. To get a wall onto a local panel today, attach a [display output](/edge/display/) to the flow the mosaic feeds.
- **Routing changes require a redeploy.** Re-pointing a tile is a change to the wall's layout, so the wall is republished to the node; it is not a live crosspoint operation.

## Where to read next

- [Multiviewer walls (operator UI)](/manager/multiviewer/) — head allocation, the REST authoring surface, and deploying a wall to a node.
- [Configuration reference](/edge/configuration/) — the full input schema in context.
- [Display Output](/edge/display/) — put the wall on a locally-attached HDMI / DisplayPort connector.
- [Resources & Capacity](/edge/resources/) — how per-flow cost units work. The wall's canvas encode is charged like any other encoder session; its per-tile decodes are not modelled at all.
- [Events & Alarms](/edge/events-and-alarms/) — the full event catalogue.
