# WebCut

> A private-by-design, browser-native video editor. Your media stays on your
> device.

[![MIT License](https://img.shields.io/badge/license-MIT-78a9e8.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/zyfvhcfh87-rgb/WebCut?include_prereleases&label=release)](https://github.com/zyfvhcfh87-rgb/WebCut/releases)
[![CI](https://github.com/zyfvhcfh87-rgb/WebCut/actions/workflows/ci.yml/badge.svg)](https://github.com/zyfvhcfh87-rgb/WebCut/actions/workflows/ci.yml)
[![Container](https://img.shields.io/badge/ghcr.io-webcut-8a63d2)](https://github.com/zyfvhcfh87-rgb/WebCut/pkgs/container/webcut)

**[Open WebCut](https://webcut-d27.pages.dev)** ·
[Privacy](PRIVACY.md) ·
[Releases](https://github.com/zyfvhcfh87-rgb/WebCut/releases) ·
[Report a bug](https://github.com/zyfvhcfh87-rgb/WebCut/issues/new/choose)

WebCut is an experimental non-linear editor built with React, TypeScript,
WebCodecs, Mediabunny, Web Audio, and worker-owned Canvas rendering. It can take
a project from local media to a capability-aware MP4 or WebM export without
sending the source files to an application server.

## Why WebCut?

- **Local-first:** media decoding, preview, editing, and export happen in your
  browser. There are no accounts, ads, cookies, or in-app analytics.
- **A real editing model:** multi-track editing, linked A/V, trim/ripple/slip/
  slide/razor tools, transitions, transforms, opacity, and clip volume.
- **Portable projects:** `.webcut` files contain the edit, not bundled source
  media. Chrome can remember browser-managed file permissions and reconnect
  sources when allowed.
- **Honest compatibility:** WebCut inspects media bytes and probes real decoder
  and encoder configurations. Unsupported explicit export choices stay blocked
  with a reason; the app never quietly swaps in another format.
- **Resilient work:** recent-project shortcuts, offline sources, relinking, and
  bounded local crash-recovery copies help without pretending they are saves.

## What works today

| Area | Highlights |
|---|---|
| Projects | 16:9, 9:16, 1:1, and 4:5 canvases from 720p to 4K; exact common frame and audio rates; Save, Save As, Resume, Recent, and recovery |
| Media | Video, audio, PNG, JPEG, WebP, and AVIF; byte-level container inspection; thumbnails, filmstrips, and waveforms |
| Timeline | Four video and four audio tracks by default; select, razor, trim, ripple trim, slip, slide, linked editing, track controls, and undo/redo |
| Effects | Position, scale, rotation, opacity, volume, visual crossfades, and synchronized audio fades when valid handles exist |
| Export | Auto, Compatibility MP4/AVC/AAC, Web WebM/VP9/Opus, Modern WebM/AV1/Opus, and explicit HEVC; buffered download or direct-to-file save |

## Try it

WebCut targets current desktop Chromium. Open the
[hosted preview](https://webcut-d27.pages.dev), create a project, and choose
local media. The browser may ask for file access; WebCut receives only the files
or folders you explicitly choose.

Chrome is the primary development target. Chrome 150 and Edge 150 on Windows
have passed the current import, editing, playback, cancellation, and export
gates. Firefox and Safari are not yet verified. Exact codec support still
depends on the browser, operating system, and hardware, so WebCut probes it each
time instead of relying on file extensions.

## Run locally

Requirements: Node.js `^20.19.0` or `>=22.12.0`, npm, and a current desktop
Chrome or Edge installation.

```bash
git clone https://github.com/zyfvhcfh87-rgb/WebCut.git
cd WebCut
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Run the container

Versioned images are published to GitHub Container Registry. The server listens
on port `8080` inside the container.

```bash
docker run --rm -p 8080:8080 ghcr.io/zyfvhcfh87-rgb/webcut:0.1.0-alpha.1
```

Then open [http://localhost:8080](http://localhost:8080). The container serves
the static app; editing remains in the visitor's browser.

## Privacy and local storage

WebCut does not upload selected media or projects. It uses browser storage for
preferences, browser-managed file handles you authorize, and bounded recovery
snapshots that contain project structure and source metadata—but never the
source video, audio, or image bytes. Clearing the site's browser data removes
these conveniences.

Cloudflare Pages delivers the hosted app and processes ordinary request and
security metadata. Cloudflare Web Analytics is disabled. Read the full
[Privacy Notice](PRIVACY.md) or the
[public hosted copy](https://webcut-d27.pages.dev/privacy/).

## Known limitations

- WebCut is an **alpha preview**, not a production-ready editor. Keep your
  source media and exported files backed up.
- Browser and OS codec support varies. Auto tries Modern, then Web, then
  Compatibility; HEVC is explicit-only. Unsupported selections are never
  silently substituted.
- Direct-to-file export and durable recent-file permissions require secure
  context and compatible File System Access APIs. Other browsers use downloads
  and manual reconnection.
- Recovery copies are origin-local browser conveniences, not user-owned
  `.webcut` saves. Multi-tab recovery ownership is not coordinated.
- Local ProRes and AC-3/E-AC-3 extensions cover import only. There is no proxy
  converter or local export-encoder fallback.
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

WebCut is copyright © 2026 Aryel and released under the [MIT License](LICENSE).
Bundled dependencies keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
