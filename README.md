# WebCut

WebCut is an experimental, browser-native non-linear video editor built with
React, TypeScript, WebCodecs, Mediabunny, Web Audio, and an
OffscreenCanvas-based render worker. It runs locally in the browser and has a
complete MVP editing and MP4 export flow.

## Features

- Import local video files and generate metadata, filmstrips, and waveforms.
- Edit on a multi-track timeline with select, razor, trim, ripple trim, slip,
  and slide tools.
- Keep imported audio/video pairs linked through edits, with manual unlinking
  and exact undo/redo history.
- Hide, mute, solo, lock, rename, add, and remove tracks.
- Adjust video transforms, opacity, and per-clip audio volume in the Inspector.
- Author visual crossfades directly at eligible timeline seams.
- Preview through worker-owned streaming video lanes with Web Audio as the
  shared audio/video clock.
- Export and download cancellable H.264/AAC MP4 files from the browser.

## Run locally

Requirements:

- Node.js `^20.19.0` or `>=22.12.0`
- npm
- A current desktop Chrome installation

```bash
git clone https://github.com/zyfvhcfh87-rgb/WebCut.git
cd WebCut
npm ci
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Imported media and project
state are session-scoped, so reloading the page starts a fresh project.

## Browser support

Desktop Chrome is the verified development target. Playback and export require
WebCodecs, transferable `OffscreenCanvas`, Web Audio, workers, and browser
support for the source and output codecs. Other browsers are currently
unverified.

## Current limitations

- The project profile is fixed at 1920×1080, 30 fps, and 48 kHz audio.
- Export uses one fixed profile: MP4 with 8 Mbps H.264/AVC video and stereo AAC.
- There is no project save/load UI; document and media state live in memory.
- Crossfades are visual-only, so audio still hard-cuts. Dissolves involving
  transformed or transparent footage are not yet mathematically exact.
- The import UI accepts video and audio files. Images are not previewable.
- Linked audio/video pairs can be unlinked, but arbitrary clips cannot be
  manually re-linked yet.
- Media compatibility ultimately depends on the codecs exposed by the browser
  and operating system.

## Quality checks

```bash
npm test
npm run build
npm run lint
```

Use `npm run test:watch` while developing. `npm run preview` serves a completed
production build locally.

## Architecture

The main dependency flow is intentionally one-way:

```text
ui/ → state/ → domain/
app/ → state/ + engine/ + pipeline/ + workers/
engine/ + pipeline/ + workers/ → domain/
```

`app/` is the composition root where browser-facing controllers connect state
to playback, rendering, and export. The binding rules—including frame
ownership, integer frame math, audio-master timing, and UI boundaries—live in
[ARCHITECTURE.md](ARCHITECTURE.md).

For deeper project context, see:

- [docs/HANDOFF.md](docs/HANDOFF.md) — current status, file map, verification,
  known browser lessons, and open items.
- [docs/PLAN.md](docs/PLAN.md) — completed Phase 3–5 roadmap and MVP gate
  record.

## Project status

The MVP gate is complete. The post-MVP smooth-preview and live-audio playback
fixes are also implemented and browser-verified. WebCut remains an experimental
development project rather than a production-ready editor.
