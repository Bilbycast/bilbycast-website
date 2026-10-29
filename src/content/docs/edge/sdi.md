---
title: SDI (Blackmagic DeckLink)
description: Build and run bilbycast-edge with native SDI capture and playout on Blackmagic DeckLink cards — local builds, GitHub Actions, and systemd device permissions.
sidebar:
  order: 13
---

bilbycast-edge can capture and play out **SDI** directly on Blackmagic
**DeckLink** cards — video plus embedded audio, with no external SDI→IP
converter in the path. It talks to the Blackmagic SDK through a first-party C++
shim rather than FFmpeg's `decklink` avdevice, because the avdevice hides
`bmdFrameHasNoInputSource`, which makes a pulled cable indistinguishable from a
live feed.

SDI lives behind the **`sdi-decklink`** build feature, which is **off** in a
plain `cargo build`. This page is about turning it on.

:::note[SDI ships in the two `*-linux-full` artefacts from v0.103.0 onward]
Every published binary up to and including **v0.102.0** had the `sdi-decklink`
feature silently dropped: the release pipeline continues (with a warning) when
no DeckLink SDK credential reaches CI, so the build stayed green while the
artefact shipped without SDI. The release notes for v0.100.0–v0.102.0 said
otherwise and have since been corrected.

Since **v0.103.0** the release run asserts the shim symbol is actually linked
into each artefact — `nm | grep dl_read_frame` — whenever SDI was requested
*and* a credential arrived, so an SDI-less `*-linux-full` artefact now fails
the release instead of shipping. Trust that assertion rather than a green
checkmark: the companion `ldd` check (which confirms `libDeckLinkAPI` is
`dlopen`-only) passes just as happily on a binary built without the feature at
all. A missing credential still only warns, so verify the binary you actually
downloaded:

```bash
./bilbycast-edge --print-capabilities | grep '^feature sdi-decklink'
```

The **`*-linux-rockchip`** artefact carries no SDI, by design — those boards
are the embedded deployment rather than a rack host with a PCIe DeckLink
fitted. Build from source (**Checklist A**) if you need SDI on Rockchip, or on
a release predating v0.103.0.
:::

## Why there is a build step at all

The Blackmagic SDK is EULA-gated: you have to accept Blackmagic's licence to
download it, and it cannot be redistributed inside this project. Only the SDK
**headers** are needed, and only while compiling.

| | Needed at **build** time | Needed at **run** time |
|---|---|---|
| SDK headers (`DeckLinkAPI.h`, `DeckLinkAPIDispatch.cpp`) | Yes | No |
| `libDeckLinkAPI.so` (part of Desktop Video) | No | Yes |
| A physical DeckLink card | No | Yes |

The SDK's `DeckLinkAPIDispatch.cpp` loads `libDeckLinkAPI.so` dynamically at
runtime, so you can compile an SDI-capable binary on a machine with no card and
no driver installed. Conversely, an SDI-capable binary runs perfectly well on a
host with no card: the boot probe finds nothing, the node never advertises the
`sdi-decklink` capability, and the manager UI hides the SDI input and output
types for it. There is no runtime cost to carrying SDI on a non-SDI host.

:::note[SDK 16 or newer]
The shim uses `IDeckLinkVideoBuffer` with `StartAccess`/`EndAccess`, introduced
in SDK 16. Older SDK versions will not compile.
:::

## Checklist A — build it yourself

For anyone building bilbycast-edge from source on their own machine. No GitHub
account, private repository, or credential is involved.

1. **Download the SDK.** Go to
   [blackmagicdesign.com/support](https://www.blackmagicdesign.com/support/),
   search for **"Desktop Video SDK"**, choose version **16 or newer**, and
   download it. You will need to complete Blackmagic's registration form and
   accept their EULA.

2. **Unzip it and locate `Linux/include`.** That single directory contains both
   `DeckLinkAPI.h` and `DeckLinkAPIDispatch.cpp`. Nothing else from the SDK is
   used by the build.

3. **Point `DECKLINK_SDK_DIR` at that directory** — the directory itself, not
   its parent:

   ```bash
   export DECKLINK_SDK_DIR=/path/to/Blackmagic_DeckLink_SDK_16.0/Linux/include

   # Both of these must list. If they don't, you are one level off.
   ls "$DECKLINK_SDK_DIR"/DeckLinkAPI.h "$DECKLINK_SDK_DIR"/DeckLinkAPIDispatch.cpp
   ```

4. **Build with the feature enabled**, alongside whatever else you already use:

   ```bash
   cargo build --release --features sdi-decklink,video-encoder-x264
   ```

   SDI also needs `media-codecs`, which is on by default. If you disable it,
   both the SDI input and output refuse to start with `sdi_no_media_codecs` —
   neither can encode or decode without it.

5. **Install Desktop Video** on the machine with the card, from the same
   support page. This provides the kernel driver and `libDeckLinkAPI.so`.

6. **Check the operating system sees the card** before suspecting the build:

   ```bash
   ls /dev/blackmagic/
   ```

7. **Check the edge sees it.** Start the edge, then confirm `sdi-decklink`
   appears in the node's advertised capabilities and that per-port hardware
   status is populated. In the manager UI, the SDI input and output types
   become selectable for that node.

:::caution[Running under systemd?]
If you run the edge from the packaged systemd service, you must also complete
**Checklist C**. Without it the card is invisible to the edge even though
everything else is correct.
:::

## Checklist B — build it in GitHub Actions

For project maintainers, and for anyone running their own fork's CI. The
release workflow already requests `sdi-decklink` for the two `*-linux-full`
artefacts (the `*-rockchip` row omits it deliberately) — it strips the feature
at build time when the SDK is unavailable, warns, and continues. So this is
entirely about making the headers reachable from CI. **No workflow edit is
required.** Once a credential does reach the run, the `Verify binary` step
asserts the shim symbol is linked in and fails the release if it is not, so the
feature cannot silently rot back out.

The SDK is not vendored into the public repository. It lives in a separate
**private** repository that CI checks out.

1. **Download the SDK** and locate `Linux/include`, exactly as in Checklist A
   steps 1–2.

2. **Create a private repository** for the headers — for this project,
   `Bilbycast/bilbycast-decklink-sdk`. Private is the point: nothing is
   redistributed.

3. **Commit only `Linux/include`.** Not `Samples/`, not the shared library, not
   the installer or PDFs:

   ```bash
   mkdir bilbycast-decklink-sdk && cd bilbycast-decklink-sdk
   git init
   cp -r /path/to/SDK/Linux/include .

   # Both must exist before you commit.
   ls include/DeckLinkAPI.h include/DeckLinkAPIDispatch.cpp

   git add -A && git commit -m "DeckLink SDK 16.0 headers"
   git tag sdk-16.0
   git remote add origin git@github.com:Bilbycast/bilbycast-decklink-sdk.git
   git push -u origin main --tags
   ```

   CI searches for `DeckLinkAPI.h` rather than assuming a fixed path, so you can
   keep the vendor's directory nesting or flatten it.

4. **Generate a deploy key** — an SSH keypair scoped to that one repository:

   ```bash
   ssh-keygen -t ed25519 -N "" -C "bilbycast-decklink-sdk deploy key" \
     -f ~/.ssh/decklink_sdk_deploy
   ```

   This produces `decklink_sdk_deploy` (private) and `decklink_sdk_deploy.pub`
   (public).

5. **Add the public half to the SDK repository:** Settings → Deploy keys → Add
   deploy key, and paste `decklink_sdk_deploy.pub`. Leave **Allow write access
   unchecked** — CI only needs to read.

6. **Add the private half to the edge repository:** Settings → Secrets and
   variables → Actions → New repository secret. Name it exactly
   **`DECKLINK_SDK_DEPLOY_KEY`** and paste the whole private key file,
   including the `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END …-----`
   lines.

7. **Verify before releasing.** Push a commit and open the CI run. The
   **`cargo check (sdi-decklink)`** step should run and pass. If you instead see
   *"SDI compile gate skipped"*, the secret is not visible to the run — check
   the name from step 6.

8. **Cut a release.** In the release run's build log the preflight prints
   `OK: DECKLINK_SDK_DEPLOY_KEY is set`, and the binary verification prints
   `OK: SDI compiled in (dl_read_frame present)`. The release notes switch to
   the SDI-present wording automatically.

:::tip[Use a deploy key, not a personal access token]
A fine-grained token with `Contents: Read` also works, as
`DECKLINK_SDK_TOKEN` — but a token **expires** and belongs to one person's
account. Because the preflight warns rather than blocks, an expired token
silently drops SDI from every later release. That is exactly how SDI went
missing for several releases. A deploy key is scoped to one repository, belongs
to no individual, and does not expire.
:::

To move to a newer SDK later, commit the new headers to the SDK repository.
Nothing in bilbycast-edge changes.

## Checklist C — allow the device nodes under systemd

Only applies if you run the edge from the packaged systemd service. That unit is
hardened with `DevicePolicy=closed`, so device access is deny-by-default.

Skipping this makes an SDI-capable node look exactly like a host with no card.
The API probe succeeds — it only needs `libDeckLinkAPI.so`, which loads fine —
but the sandbox denies the DeckLink device nodes, so enumeration returns zero
cards. The `sdi-decklink` capability is gated on that live device list, so the
node **never advertises SDI at all** and the manager hides the SDI input and
output types, exactly as it would for a card-less host. The boot log names each
denied node (see the table below).

The unit grants the node names confirmed on hardware:

| Nodes | Cards |
|-------|-------|
| `/dev/blackmagic/io0`…`io7` | Multi-channel cards: a DeckLink Quad 2 has one node per channel. |
| `/dev/blackmagic/dv0`…`dv7` | Single-channel DeckLink SDI cards, one node per card. |

These are `misc` character devices (major 10, minors assigned dynamically), so
the unit's `DeviceAllow=char-blackmagic` class rule cannot match them; the path
rules are what grant access. systemd does not glob device paths, so each node is
listed, and a listed path that does not exist when the unit starts is skipped
with a log line, so the extras are harmless.

1. **See what your card exposes:**

   ```bash
   ls /dev/blackmagic/
   ```

2. **Check your unit covers them.** The current unit grants `io0`…`io7` and
   `dv0`…`dv7`. **A manager-driven upgrade replaces only the binary, never the
   unit**, so a host installed with v0.116.0 or earlier still runs the older
   list — `io0`…`io7` only — and a single-channel card (`dvN`) enumerates
   nothing. For any name outside the list (an older unit on a `dvN` host, a
   second Quad 2's `io8`…, more than eight `dvN` nodes, another prefix), add the
   rules in a drop-in, one per line with no trailing comment (systemd reads a
   `#` after the value as part of it and drops the rule):

   ```bash
   sudo systemctl edit bilbycast-edge
   ```

   ```ini
   [Service]
   DeviceAllow=/dev/blackmagic/dv0 rw
   DeviceAllow=/dev/blackmagic/dv1 rw
   ```

   Alternatively refresh the unit itself with `install-edge.sh
   --upgrade-installer` (see [Manual upgrade](/edge/getting-started/#manual-upgrade)).
   That **also moves the node to the latest release**, so prefer the drop-in on
   a production node you are not ready to upgrade.

3. **Restart** (after a hand edit of the unit file, `daemon-reload` first):

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart bilbycast-edge
   ```

   Path rules resolve when the unit **starts**. A node the driver creates later
   (driver loaded after the edge, card hot-plugged) stays denied until the next
   restart, even when the unit lists it.

4. **Confirm** the node's per-port SDI hardware status is now populated and the
   boot log carries no `sdi.decklink` warning.

**Reading the boot log.** Whenever the DeckLink API enumerates zero devices, or
some device nodes are denied to the edge, the probe logs one warning under
target `sdi.decklink` (`journalctl -u bilbycast-edge | grep sdi.decklink`)
saying which of these it found:

| The warning says | Cause | Fix |
|---|---|---|
| `… are denied to this process by its device cgroup (EPERM): dv0, dv1 …` | The unit's `DeviceAllow=` list (in a container, the runtime's device rules) does not grant those nodes, or they appeared after the edge started. | Steps 2 and 3 above. |
| `… are denied by file permissions or an AppArmor/SELinux policy (EACCES): …` | File mode and the service user's groups, or an LSM policy. | `ls -l /dev/blackmagic/`, the service user's groups, the LSM's audit log. |
| `… although N device node(s) in /dev/blackmagic/ are present and accessible …` | The nodes are reachable, so look past them: most often card firmware older than the driver (`dmesg` shows a firmware version mismatch), or a Desktop Video driver/library mismatch. | `dmesg \| grep -i blackmagic`; `DesktopVideoUpdateTool --list`, update, reboot. |
| `… /dev/blackmagic/ holds no device nodes …` | No card fitted, the Desktop Video kernel driver is not loaded, or (in a container) the nodes were not passed through. | `lspci \| grep -i blackmagic`, `lsmod \| grep blackmagic` (after a kernel upgrade DKMS rebuilds it on the next boot). |
| `… could not be read (…)` | `/dev/blackmagic/` itself is unreadable: its permissions, or a container whose `/dev` is not the host's. | `ls -ld /dev/blackmagic/`. |

With some nodes denied but other cards enumerating, the warning says how many
devices did enumerate and that the ports behind the denied nodes are missing.

## Ad markers — SCTE-104 ↔ SCTE-35

Both directions are off by default and are a single boolean each. They are
the reason to take SDI natively rather than through a converter: an ad marker
that only lives in VANC is lost the moment a converter re-frames the signal.

**Capture** — set `scte35_extraction: true` on an `sdi` input. Generic VANC is
copied before the SDK frame is released, the packets carrying DID/SDID
`0x41/0x07` are picked out, and the message is decoded — both the
`single_operation_message` and the `multiple_operation_message` framing, the
latter being what real ad-splice inserters emit. Splice start, splice end and
cancel become a SCTE-35 `splice_insert()` section muxed straight into the
egress TS — PID `0x01FC`, advertised in the PMT as stream type `0x86`;
anything else is ignored.
Pre-roll, break duration and auto-return survive the translation; zero pre-roll
becomes an immediate splice. Each translated cue raises an Info
`sdi_scte35_emitted` event carrying the splice event ID and opcode, and bumps
`InputStats.sdi_stats.scte35_cues_emitted`.

**Playout** — set `scte35_injection: true` on an `sdi` output. The selected
program's SCTE-35 PID is section-reassembled, CRC-valid `splice_insert()` cues
are decoded back into SCTE-104 — a `multiple_operation_message` carrying one
splice operation — and the packet is attached as DID/SDID
`0x41/0x07` VANC to the next **three** successfully scheduled frames (receiver
reliability; line number `0` lets the SDK place it). Component splices,
encrypted sections and non-`splice_insert` commands are ignored.
`OutputStats.sdi_stats.scte35_cues_injected` counts once per cue, not once per
frame carrying it.

:::note[Verification status]
The binary codec, CRC validation, section demux and TS carriage are
round-trip unit-verified, and VANC attachment on playout is hardware-verified
at 1080i50. Capture plumbing still wants a live SCTE-104 inserter, and a full
TS cue → SDI → extraction loop remains the outstanding system-level test.
:::

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `DECKLINK_SDK_DIR is not set` at build | Feature enabled without the headers | Checklist A step 3 |
| `missing …/DeckLinkAPI.h — DECKLINK_SDK_DIR does not look like the SDK's Linux/include` | Pointing at the SDK root, not `Linux/include` | Point one level deeper |
| Compile errors about `IDeckLinkVideoBuffer` / `StartAccess` | SDK older than 16 | Download SDK 16 or newer |
| `sdi_no_media_codecs` at flow start | Built with `media-codecs` disabled | Rebuild with default features |
| Node does not advertise SDI; boot log `sdi.decklink` says *"… are denied to this process by its device cgroup (EPERM): dv0, …"* | The unit's `DeviceAllow=` list does not grant those nodes (a unit from v0.116.0 or earlier lacks `dvN`), or they were created after the service started — enumeration returns zero cards, so the capability is withheld | Checklist C steps 2 and 3 |
| Boot log `sdi.decklink` says *"… although N device node(s) in /dev/blackmagic/ are present and accessible …"* | Card firmware older than the driver, or a Desktop Video driver/library mismatch | `dmesg \| grep -i blackmagic`; `DesktopVideoUpdateTool --list`, update, reboot |
| Boot log `sdi.decklink` says *"… /dev/blackmagic/ holds no device nodes …"* | No card, kernel driver not loaded, or a container without the nodes passed through | `lspci \| grep -i blackmagic`, `lsmod \| grep blackmagic` |
| Boot log `sdi.decklink` says *"… denied by file permissions or an AppArmor/SELinux policy (EACCES)"* | File mode, the service user's groups, or an LSM policy | `ls -l /dev/blackmagic/`, the service user's groups, the LSM's audit log |
| Node does not advertise SDI; boot log `sdi.decklink` says *"the DeckLink API is unreachable"* | Desktop Video missing, or binary built without the feature | Install Desktop Video; confirm the feature was enabled |
| v0.116.0 or earlier: boot log `sdi.decklink` says *"no devices enumerated … is a card fitted?"* | Any of the causes above — that release's single message cannot tell them apart | `ls -l /dev/blackmagic/`: nodes listed → Checklist C or the firmware row; nothing listed → card or driver |
| Released binary has no SDI | A `*-rockchip` artefact (never carries it), or a `*-full` artefact from v0.102.0 or earlier. Confirm with `--print-capabilities \| grep '^feature sdi-decklink'` | Upgrade to v0.103.0+ for `*-full`; otherwise Checklist A, or Checklist B then re-release |
| CI logs *"SDI compile gate skipped"* | No SDK credential visible to that run | Expected on fork PRs; otherwise recheck the secret name |

## Related

- [Supported Protocols](/edge/supported-protocols/) — where SDI sits among the
  input and output types
- [Codec Matrix](/edge/codec-matrix/) — which encoders you can pair with SDI
  capture
- [Install as a Linux Service](/edge/install-ubuntu-service/) — the packaged
  systemd unit referenced in Checklist C
