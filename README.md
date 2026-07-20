# WebCut

WebCut is an experimental, browser-native non-linear video editor built with
React, TypeScript, WebCodecs, Mediabunny, Web Audio, and an
OffscreenCanvas-based render worker. It runs locally in the browser and has a
complete MVP editing and MP4 export flow.

## Features

- Start from a project home, choose 720p through 4K, exact common frame rates,
  and 44.1/48/96 kHz audio, or validate and resume a portable `.webcut` file.
- Remember local source media in Chrome and reconnect it automatically on
  Resume. Projects can also open safely with missing sources kept **Offline**,
  then reconnect one file or scan a folder to restore preview, audio, and
  export without changing clip or asset identities.
- Reopen validated `.webcut` files from Recent and recover bounded local safety
  copies after a reload or crash; recovery is always offered explicitly and is
  never presented as a user-owned save.
- Import or reconnect local video/audio files through one content-based browser
  compatibility check, then generate metadata, filmstrips, and waveforms only
  for Ready sources.
- Edit on a multi-track timeline with select, razor, trim, ripple trim, slip,
  and slide tools, including dragging clips between same-kind tracks.
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
home, where you can create a project, choose a portable `.webcut` file, reopen
a recent file, or review an available recovery copy.

Inside the editor, the first **Save** asks where to store the portable
`.webcut`; **Save As** chooses a different project file. After that one
explicit browser permission, WebCut live-saves later timeline and media-pool
changes to the writable file. Browsers without the writable-file picker can
download a copy, but WebCut keeps the work marked unsaved because a download
cannot be verified. Unsaved work is protected before reload or a return to the
project Home.

Chrome imports store an opaque local file handle in browser storage—not a
Windows path and not inside `.webcut`. When that read grant persists, Resume
reconnects the original media automatically. If Chrome asks again, **Allow
media & open** restores it with one click. Moving the project to another
browser/computer, clearing site data, or moving/changing a source uses the
metadata-checked relink fallback. A project with missing media can still open:
its clips remain visible and bounded on the timeline, preview labels the
missing source, and export explains what must be reconnected. Use **Relink**
for one source or **Scan folder** once to search a moved media folder; WebCut
auto-connects unique matches and asks before using an ambiguous match.

While work is dirty, WebCut also maintains a bounded local recovery journal in
browser storage. Home offers that journal after a reload or crash, but never
opens it automatically. Recovery copies are not `.webcut` saves and do not
cache source videos; use **Save** or **Save As** for a user-owned project file.

## Browser support

Desktop Chrome is the verified development target. Playback and export require
WebCodecs, transferable `OffscreenCanvas`, Web Audio, workers, and browser
support for the source and output codecs. Other browsers are currently
unverified.

Imports, Resume, and Relink inspect the container from file bytes, build the
real decoder configuration for every video/audio track, and ask whether the
current browser supports each configuration. This is a metadata/config-support
check, not a sample decode of the whole stream. The Media Pool shows `Ready`,
`Limited`, `Unsupported`, or `Error` with container/track details. A rejected
new import remains available for explicit Retry or Remove. A project source
that is not Ready stays Offline and uses Relink.

| Direct-import source | Verified Windows Chromium result |
|---|---|
| MP4 with H.264/AVC video + AAC audio | Ready (verified) |
| QuickTime/MOV with ProRes 422 HQ video + AAC audio | Ready through the locally bundled ProRes fallback (verified) |
| H.264/AVC video + AC-3 or E-AC-3 audio | Ready through the locally bundled audio fallback (verified) |
| One fully decodable track kind plus one failed track kind | Limited; explicit review can import video-only or audio-only (verified) |
| Other containers/codecs | Probed at runtime; support depends on Chrome, the OS, and the real track configuration |

Issue #19's completed slices carry that report through import, Resume, Relink,
preview, filmstrip, waveform, live audio, and export. ProRes and AC-3/E-AC-3 can
lazy-load reviewed, version-pinned, locally bundled decoder extensions behind
resource limits. A safe whole-kind partial import requires an explicit dialog
and persists the user's choice across reconnection. Confirmed runtime failures
update only the exact connected source generation and expose Relink without an
implicit retry loop.
The measured browser-side proxy-conversion candidate is formally out of scope
for Issue #19's current release; see
[the decision record](docs/decisions/ISSUE_19_PROXY_CONVERSION.md).

## Current limitations

- Export uses one fixed profile: MP4 with 8 Mbps H.264/AVC video and stereo AAC.
- Portable Save, Save As, Resume, validation, and media relinking are
  available, including browser-local automatic source reconnection, offline
  editing, individual relink, and bounded folder matching. Existing projects
  imported before handle storage need one successful relink or folder match to
  seed their handles. A resumed `.webcut` still needs one **Save** or **Save
  As** grant before live save can update that project file in place. Recent-file
  shortcuts, remembered media, and recovery journals are origin-local browser
  conveniences: they disappear when site data is cleared, are not portable,
  and do not cache source media. Recovery ownership is not coordinated across
  multiple open WebCut tabs, so the same recovery copy should not be edited or
  discarded from two tabs at once.
- Crossfades are visual-only, so audio still hard-cuts. Dissolves involving
  transformed or transparent footage are not yet mathematically exact.
- The import UI accepts video and audio files. Images are not previewable.
- Linked audio/video pairs can be unlinked, but arbitrary clips cannot be
  manually re-linked yet.
- Native media compatibility depends on the codecs exposed by the browser and
  operating system. WebCut has bounded local decoder fallbacks for ProRes and
  AC-3/E-AC-3, plus explicit video-only/audio-only import when exactly one whole
  track kind is safe to keep. Other Limited and Unsupported imports remain
  non-draggable. There is no built-in proxy converter; convert externally and
  import the result as a new source when no direct or partial path applies.

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
creation, portable save/resume, recent files, and explicit crash recovery are
implemented. WebCut remains an experimental development project rather than a
production-ready editor.
