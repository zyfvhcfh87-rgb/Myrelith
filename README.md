# WebCut

WebCut is an experimental, browser-native non-linear video editor built with
React, TypeScript, WebCodecs, Mediabunny, Web Audio, and an
OffscreenCanvas-based render worker. It runs locally in the browser and has a
complete MVP editing and MP4 export flow.

## Features

- Start from a project home, choose 720p through 4K, exact common frame rates,
  and 44.1/48/96 kHz audio, or validate and resume a portable `.webcut` file.
- Reconnect saved source media by metadata before a resumed project can enter
  the editor; invalid or incomplete candidates never replace the session.
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

Open [http://localhost:5173](http://localhost:5173). WebCut opens on the project
home, where you can create a project or choose a portable `.webcut` file.

## Browser support

Desktop Chrome is the verified development target. Playback and export require
WebCodecs, transferable `OffscreenCanvas`, Web Audio, workers, and browser
support for the source and output codecs. Other browsers are currently
unverified.

## Current limitations

- Export uses one fixed profile: MP4 with 8 Mbps H.264/AVC video and stereo AAC.
- Portable project validation, loading, and media relinking are available, but
  Save, Save As, recent projects, and crash-recovery/autosave are not yet in
  the UI. Work created in the editor still lives in memory for this slice.
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

The MVP gate is complete. Smooth preview, live audio, configurable project
creation, and safe portable-project resume are implemented. WebCut remains an
experimental development project rather than a production-ready editor.
