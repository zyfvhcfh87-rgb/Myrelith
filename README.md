# Myrelith

> A private-by-design, browser-native video editor. Your media stays on your
> device.

[![MIT License](https://img.shields.io/badge/license-MIT-78a9e8.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/zyfvhcfh87-rgb/Myrelith?include_prereleases&label=release)](https://github.com/zyfvhcfh87-rgb/Myrelith/releases)
[![CI](https://github.com/zyfvhcfh87-rgb/Myrelith/actions/workflows/ci.yml/badge.svg)](https://github.com/zyfvhcfh87-rgb/Myrelith/actions/workflows/ci.yml)
[![Container](https://img.shields.io/badge/ghcr.io-myrelith-8a63d2)](https://github.com/zyfvhcfh87-rgb/Myrelith/pkgs/container/myrelith)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/lyn07)

**[Open Myrelith](https://myrelith.pages.dev)** ·
[Privacy](PRIVACY.md) ·
[Releases](https://github.com/zyfvhcfh87-rgb/Myrelith/releases) ·
[Report a bug](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/new/choose)

Current public preview: **v0.2.0-alpha.1**. The
[hosted app](https://myrelith.pages.dev) tracks current `master`.

Myrelith is an experimental non-linear editor built with React, TypeScript,
WebCodecs, Mediabunny, Web Audio, and worker-owned Canvas rendering. It can take
a project from local media to a capability-aware MP4 or WebM export without
sending the source files to an application server.

New saves use the `.myrelith` extension and `myrelith-project` format marker.
Projects created before the rename with a `.webcut` filename or
`webcut-project` marker remain supported and are normalized when opened.

## Why Myrelith?

- **Local-first:** media decoding, preview, editing, and export happen in your
  browser. There are no accounts, ads, cookies, or in-app analytics.
- **A real editing model:** multi-track editing, linked A/V, trim/ripple/slip/
  slide/razor tools, markers, snapping, captions, constant-speed retiming, and
  speed ramps.
- **Portable projects:** `.myrelith` files contain the edit, not bundled source
  media. Chrome can remember browser-managed file permissions and reconnect
  sources when allowed.
- **Honest compatibility:** Myrelith inspects media bytes and probes real decoder
  and encoder configurations. Unsupported explicit export choices stay blocked
  with a reason; the app never quietly swaps in another format.
- **Resilient work:** recent-project shortcuts, offline sources, relinking, and
  bounded local crash-recovery copies help without pretending they are saves.

## What works today

| Area | Highlights |
|---|---|
| Projects | Horizontal 16:9, vertical 9:16, square 1:1, and 4:5 canvases from 720p to 4K; exact common frame and audio rates; Save, Save As, live save, Resume, Recent, recovery, and workspace presets |
| Media | Video, audio, PNG, JPEG, WebP, and AVIF; byte-level container inspection; searchable virtualized pool; collections; thumbnails, filmstrips, and waveforms; offline relink; optional local editing proxies |
| Timeline | Four video and four audio tracks by default; select, razor, trim, ripple trim, slip, slide, linked editing, track controls, markers, snapping, caption tracks with SRT/VTT, and undo/redo |
| Effects | Text overlays, transforms, crop, blend modes, opacity, volume, color correction, masks and chroma key, keyframed animation, dynamic zoom presets, visual crossfades, and synchronized audio fades when valid handles exist |
| Motion | Constant-speed retiming and speed ramps; video stabilization; point and box tracking; manual lens correction when WebGL2 is available |
| Preview | Direct Program Monitor manipulation; Auto/Full/Half/Quarter quality; histogram, waveform, and vectorscope; playback audio meters; command palette |
| Export | Auto, Compatibility MP4/AVC/AAC, Web WebM/VP9/Opus, Modern WebM/AV1/Opus, and explicit HEVC; buffered download or direct-to-file save |
| Plugins | Signed local `.myrelith-plugin` packages only; review, enable, disable, and fail-closed preview/export. There is no plugin marketplace |

## Try it

Myrelith targets current desktop Chromium. Open the
[hosted preview](https://myrelith.pages.dev), create a project, and choose
local media. The browser may ask for file access; Myrelith receives only the files
or folders you explicitly choose.

Chrome is the primary development target. Chrome 150 and Edge 150 on Windows
have passed the current import, editing, playback, cancellation, and export
gates. Firefox and Safari are not yet verified. Exact codec support still
depends on the browser, operating system, and hardware, so Myrelith probes it each
time instead of relying on file extensions.

## Run locally

Requirements: Node.js `^20.19.0` or `>=22.12.0`, npm, and a current desktop
Chrome or Edge installation.

```bash
git clone https://github.com/zyfvhcfh87-rgb/Myrelith.git
cd Myrelith
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Run the container

Versioned images publish to GitHub Container Registry under the `myrelith`
package name for Linux AMD64 and ARM64. The server listens on port `8080` inside
the container.

```bash
docker run --rm -p 8080:8080 ghcr.io/zyfvhcfh87-rgb/myrelith:0.2.0-alpha.1
```

Then open [http://localhost:8080](http://localhost:8080). The container serves
the static app; editing remains in the visitor's browser.

## Privacy and local storage

Myrelith does not upload selected media or projects. It uses browser storage for
preferences, browser-managed file handles you authorize, and bounded recovery
snapshots that contain project structure and source metadata—but never the
source video, audio, or image bytes. Clearing the site's browser data removes
these conveniences.

Browser storage is bound to the exact site origin. Moving to the Myrelith
hostname cannot automatically transfer Recents, recovery copies, preferences,
or remembered permissions from the previous hostname; save a portable project
file there and open it in Myrelith when migration is needed.

Cloudflare Pages delivers the hosted app and processes ordinary request and
security metadata. Cloudflare Web Analytics is disabled. Read the full
[Privacy Notice](PRIVACY.md) or the
[public hosted copy](https://myrelith.pages.dev/privacy/).

## Known limitations

- Myrelith is an **alpha preview**, not a production-ready editor. Keep your
  source media and exported files backed up.
- Browser and OS codec support varies. Auto tries Modern, then Web, then
  Compatibility; HEVC is explicit-only. Unsupported selections are never
  silently substituted.
- Direct-to-file export and durable recent-file permissions require secure
  context and compatible File System Access APIs. Other browsers use downloads
  and manual reconnection.
- Recovery copies are origin-local browser conveniences, not user-owned
  `.myrelith` saves. Multi-tab recovery ownership is not coordinated.
- Local ProRes and AC-3/E-AC-3 extensions cover import only. There is no proxy
  converter or local export-encoder fallback. Editing proxies are optional
  preview helpers; export always uses the original source.
- Non-1× speed and speed ramps retime picture. Clip audio is muted outside
  exact 1×. Timeline text overlays and caption tracks are separate; text
  overlays do not yet have keyframe animation.
- Manual lens correction needs a capable WebGL2 path and can block motion
  tracking while it is active. Signed plugins are local packages only and can
  block export when they cannot be prepared.
- The bundled AC-3/E-AC-3 decoder includes FFmpeg-derived WebAssembly. Copyright
  and patent obligations are separate; this prerelease is not a
  patent-clearance certification. See [Third-party notices](THIRD_PARTY_NOTICES.md).

## Quality and architecture

```bash
npm test
npm run build
npm run lint
npm audit --omit=dev --audit-level=high
```

The app keeps a one-way dependency flow:

```text
ui/ → state/ → domain/
app/ → state/ + engine/ + pipeline/ + workers/
engine/ + pipeline/ + workers/ → domain/
```

The non-negotiable ownership, timing, and state rules live in
[ARCHITECTURE.md](ARCHITECTURE.md). Current implementation status and browser
evidence live in [docs/HANDOFF.md](docs/HANDOFF.md); the completed build record
is in [docs/PLAN.md](docs/PLAN.md).

## Contributing and support

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing code. Please use
synthetic fixtures rather than private media in reports, follow the
[Code of Conduct](CODE_OF_CONDUCT.md), and use [SECURITY.md](SECURITY.md) for
sensitive vulnerabilities. General support expectations are in
[SUPPORT.md](SUPPORT.md).

## License

Myrelith is copyright © 2026 Aryel and released under the [MIT License](LICENSE).
Bundled dependencies keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
