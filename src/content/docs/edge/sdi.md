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

Skipping this produces a distinctive and confusing symptom: the node
**advertises SDI but enumerates zero cards**. The API probe succeeds because it
only needs `libDeckLinkAPI.so`, which loads fine — but every device open is
denied by the sandbox.

1. **See what your card exposes:**

   ```bash
   ls /dev/blackmagic/
   ```

2. **Check the shipped unit covers them.** It grants the `char-blackmagic`
   device class plus `/dev/blackmagic/io0` through `io7`. If your host shows
   nodes outside that set — different names, or more than eight — add matching
   lines to the unit:

   ```ini
   DeviceAllow=/dev/blackmagic/<node> rw
   ```

   Paths that don't exist are ignored with a log warning, so extra entries are
   harmless.

3. **Reload and restart:**

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl restart bilbycast-edge
   ```

4. **Confirm** the node's per-port SDI hardware status is now populated.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `DECKLINK_SDK_DIR is not set` at build | Feature enabled without the headers | Checklist A step 3 |
| `missing …/DeckLinkAPI.h — DECKLINK_SDK_DIR does not look like the SDK's Linux/include` | Pointing at the SDK root, not `Linux/include` | Point one level deeper |
| Compile errors about `IDeckLinkVideoBuffer` / `StartAccess` | SDK older than 16 | Download SDK 16 or newer |
| `sdi_no_media_codecs` at flow start | Built with `media-codecs` disabled | Rebuild with default features |
| Node advertises SDI but lists **zero** devices | systemd sandbox blocking device nodes | Checklist C |
| Node does not advertise SDI at all | Desktop Video missing, or binary built without the feature | Install Desktop Video; confirm the feature was enabled |
| Released binary has no SDI | A `*-rockchip` artefact (never carries it), or a `*-full` artefact from v0.102.0 or earlier. Confirm with `--print-capabilities \| grep '^feature sdi-decklink'` | Upgrade to v0.103.0+ for `*-full`; otherwise Checklist A, or Checklist B then re-release |
| CI logs *"SDI compile gate skipped"* | No SDK credential visible to that run | Expected on fork PRs; otherwise recheck the secret name |

## Related

- [Supported Protocols](/edge/supported-protocols/) — where SDI sits among the
  input and output types
- [Codec Matrix](/edge/codec-matrix/) — which encoders you can pair with SDI
  capture
- [Install as a Linux Service](/edge/install-ubuntu-service/) — the packaged
  systemd unit referenced in Checklist C
