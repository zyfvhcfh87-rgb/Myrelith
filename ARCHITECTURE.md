# Architecture Rules (read before editing)

This file is the single source of truth for module boundaries and the
non-negotiable rules. Re-read it at the start of every coding session.

## Dependency direction (one-way only)

```
  ui/  →  state/  →  domain/
  engine/, pipeline/, workers/  →  codecs/  →  domain/
  engine/, pipeline/, workers/  →  domain/   (never import React)
  domain/  →  nothing (pure TS, no browser APIs)
```

- `domain/` is pure TypeScript: no React, no DOM, no WebCodecs, no browser
  globals. It must run unchanged in Node (Vitest) and in a worker.
- `state/` may import `domain/`. It must NOT import `ui/`, `engine/`,
  `pipeline/`, or `workers/`.
- `ui/` may import `state/` (and `domain/` types). It must NOT import
  `pipeline/`, `workers/`, or `engine/` directly from a `.tsx` file.
- `engine/`, `pipeline/`, `workers/` may import `domain/`. They must never
  import React or anything from `ui/` or `state/`.
- `codecs/` is a browser/worker-safe runtime leaf for reviewed local codec
  registration and policy. It may import `domain/` types and external codec
  packages, but never `state/`, `ui/`, `app/`, `engine/`, `pipeline/`, or
  `workers/`.
- `app/` is the COMPOSITION ROOT: non-component `.ts` controllers there
  (e.g. `app/previewController.ts`) may import state/ AND engine/pipeline
  to wire them together. ui components may import those controllers as
  their facade — but still never engine/, pipeline/, or workers/ directly.
- Sanctioned exceptions between those three (and nothing more):
  - anyone may import `workers/decode-protocol.ts` and
    `workers/render-protocol.ts` (types only, no runtime),
  - `workers/` may import `engine/frame-cache.ts` (pure class, no deps),
  - `workers/render.worker.ts` may import `pipeline/render.ts` (the pure
    compositing core: imports domain/ only, no browser I/O — the worker is
    its runtime host, exactly like export.ts will be in Phase 5) and the
    STRUCTURAL TYPES exported by `workers/decode.worker.ts` via
    `import type` (erased at build time — a runtime import would register
    the decode worker's message listener inside the render worker),
  - `engine/worker-bridge.ts` references the worker FILE via
    `new Worker(new URL(...))` — a URL, not a module import; the pipeline
    chunk source reaches the bridge by injection, never by import.

## Non-negotiable rules

1. **Close every frame.** Every `VideoFrame` / `AudioData` / `ImageBitmap`
   MUST be `.close()`'d in a `finally` block or immediately after use. Never
   store one in React state or a closure that outlives the current draw call.
2. **Integer frames, not floats.** All timeline math uses integer frame
   counts + `RationalTime`, never raw floating-point seconds. Convert to
   seconds only at the boundary (encoder/decoder/audio-clock).
3. **Audio is the master clock.** Playback is driven by the audio clock
   (`AudioContext.currentTime`). Video always re-derives "which frame to
   show" from that clock — it never free-runs on its own timer.
4. **UI reads state only.** UI components import from `state/` only. A `.tsx`
   file never imports `pipeline/`, `workers/`, or `engine/` directly.

Changes may span multiple modules or layers when that is the smallest complete
solution. The dependency direction above and all ownership/timing rules remain
binding across the whole change.

## Scrubbing-vs-committed pattern

Drag/scrub interactions update only `transportStore` preview state during the
gesture (coalesced to one update per animation frame). The `documentStore`
mutation — which creates an undo-history entry — happens once, on `pointerup`.
Never write to `documentStore` on every `pointermove`.

## Browser-safe timeline geometry

- `zoom` is the one and only pixels-per-frame scale. The logical timeline
  runway is `max(docDurationFrames(doc), 12 hours at the document rate)` and
  keeps its exact logical endpoint at every zoom level; browser layout limits
  must never shorten it or impose a duration-dependent maximum zoom.
- The DOM exposes at most one 16,000,000px physical timeline surface at a
  time. `timelineOriginFrame` is an ephemeral non-negative integer translation:
  local x for a global frame is `(frame - timelineOriginFrame) * zoom`. It is
  NOT another scale, never changes `playheadFrame` or document geometry, and
  never enters persistence or undo/redo history.
- `ui/timeline/timelineViewport.ts` owns the pure bounded-window math. Its
  final legal origin is `totalFrames - surfaceFrames`, so the exact logical
  endpoint remains reachable. Near a native-scroll edge, `Timeline`
  rebases the origin and applies the opposite scroll displacement before
  paint; the logical viewport and every on-screen frame stay fixed while
  ordinary scrolling remains one logical pixel per CSS pixel.
- Ruler ticks, pointer-to-frame conversion, clips, transition seams, and the
  playhead all use the same `zoom` plus the shared origin translation. A clip
  is intersected with the current physical window before it emits DOM width.
  Filmstrip buckets retain their source-frame offset within that slice, and
  waveforms use a normalized source-time SVG viewBox rather than a gigantic
  duration-scaled background. Long clips therefore stay aligned without
  recreating the browser-width problem inside one visual element.

## Data model — `src/domain/schema.ts` (canonical, implemented)

`domain/schema.ts` defines the authoritative interfaces every phase
references: `FrameRate`, `RationalTime`, `TimeRange`, `MediaAsset`,
`TimelineDoc`, `Track`, `Clip`, `Transform`, `Effect`, `Transition`,
`TextProps`. Read that file for field-level docs. Key invariants:

- `TimeRange` is **half-open** `[startFrame, startFrame + durationFrames)`;
  ranges that merely touch do not overlap. All ranges are integer frames at
  the document rate.
- MVP: clips play at speed 1.0 and assets are conformed to the doc rate, so
  `sourceRange.durationFrames === timelineRange.durationFrames` always.
- Clips on one track are sorted by `timelineRange.startFrame` and pairwise
  non-overlapping; `operations.ts` rejects violations.
- `TimelineDoc.tracks[0]` composites first (bottom layer).
- Document duration is derived (selectors), never stored.
- `TimelineDoc` must survive `JSON.stringify`/`parse` losslessly (undo
  history depends on it); `MediaAsset.objectUrl` is session-scoped.
- A present `Clip.linkGroupId` identifies exactly one video clip plus one
  audio clip. `domain/linking.ts` owns the pure manual-link contract:
  `getLinkClipsEligibility` returns stable rejection reasons and `linkClips`
  links only two distinct, existing, unlocked, currently unlinked clips in
  video-then-audio order. It changes no asset, range, or clip metadata;
  manually linked partners may have different assets and ranges. Link-group
  ids are minted against the current document so a UUID collision cannot
  merge unrelated pairs. Re-linking requires an explicit unlink first.

## Store action contracts

- `DocumentState` — implemented in `src/state/documentStore.ts` (canonical):
  `setDoc`, `splitClipAtPlayhead(frame)`, `splitClipAt(clipId, frame)`,
  `insertClip(trackId, clip)`, `insertClips([{trackId, clip}...])` (atomic
  batch, one history entry — the A/V drop path), `trimClip(clipId, edge,
  delta)`,
  `rippleTrim(clipId, edge, delta)`, `slipClip(clipId, delta)`,
  `slideClip(clipId, delta)`, `moveClip(clipId, toTrackId, toFrame)`,
  `rippleDelete(clipId)`, `addEffect(clipId, effect)`,
  `addTrack(kind)`, `setTrackFlags(trackId, {hidden?, muted?, solo?,
  locked?})` (idempotent patches push no history entry; flags and
  renames WORK on locked tracks — metadata, not content),
  `renameTrack(trackId, name)`, `removeTrack(trackId)` (locked tracks
  reject), `addCrossfade(fromClipId, toClipId, durationFrames)`,
  `setCrossfadeDuration(trackId, transitionId, durationFrames)`,
  `removeTransition(trackId, transitionId)`,
  `setClipVolume(clipId, volume)` (clamped [0,2]),
  `linkClips(videoClipId, audioClipId)` (one history entry; delegates to the
  pure domain contract, so rejection preserves the entire state and redo
  branch by reference; undo/redo restore the exact generated group id),
  `unlinkClip(clipId)` (dissolves the clip's whole link group), `undo`,
  `redo`. The geometry actions (move/trim/rippleTrim/slip/slide/
  rippleDelete/splitClipAt/splitClipAtPlayhead) are LINK-AWARE: they
  delegate to domain/linking wrappers, so edits apply to every member of
  a `Clip.linkGroupId` group atomically (any member rejecting rolls the
  whole edit back); transform/volume edits deliberately do NOT follow
  links. History: `past`/`future` snapshot stacks capped at 100.
  Rejected domain ops return the SAME doc reference, so they push no
  history entry. Actions take the frame as a parameter — documentStore
  never reads transportStore (UI wiring passes the playhead in).
- `TransportState` — `src/state/transportStore.ts`: `playheadFrame` (int,
  setter rounds + clamps >= 0), `isPlaying`, `isScrubbing`, authoritative
  `zoom` (px/frame, > 0), `zoomMode` ('full'|'detail'|'custom'), and
  `customZoom` (remembered custom px/frame), plus `timelineOriginFrame` (the
  integer global frame represented by local x=0 in the bounded DOM surface).
  `setZoom` atomically updates rendered + remembered zoom and activates Custom;
  `setPresetZoom` updates rendered zoom + Full/Detail mode without overwriting
  `customZoom`; `setTimelineOriginFrame` changes translation only. All four
  fields are ephemeral/non-history and reset deterministically. Also `inOut`,
  `dragPreview` ({clipId, deltaFrames,
  targetTrackId?, trackOffsetY?, linkGroupId?} | null — the live half of
  the scrubbing-vs-committed pattern for select-tool moves; every participating
  ClipView renders its own committed `timelineRange.startFrame + deltaFrames`.
  The optional target fields ghost only the gesture owner over a same-kind lane
  while a linked partner stays on its own lane; pointerup commits ONE
  documentStore.moveClip and clears it), `tool`
  ('select'|'razor'|'trim'|'slip'|'slide'), `selectedClipIds` (ordered,
  unique, ephemeral, never in undo) plus `selectedClipId` (the primary member
  retained for single-clip surfaces such as Inspector), `editPreview`
  ({clipId, kind, deltaFrames,
  linkGroupId?} | null — same live-preview contract for trim/ripple/
  slip/slide gestures). The optional linkGroupId lets partner ClipViews
  ghost a linked gesture live. Normal selection replaces both selection
  fields; Ctrl/Cmd pointer or keyboard activation toggles membership and
  promotes the newly added clip to primary. The Inspector resolves the live
  selection against the current document, enables its native Link button only
  for one eligible video + audio pair, and shows the current rejection reason
  otherwise. Selection has no history, no persistence, and no side effects;
  transportStore never touches documentStore. The app-only
  `selectionReconciliationController` is the composition bridge: on each
  document-reference change it supplies the current clip-id set to
  `reconcileClipSelection`, which synchronously removes stale ids while
  preserving survivor order and the current primary (or promoting the latest
  survivor). Undo can restore document clips but never resurrects selection.
  `resetTransport()` restores every field to its initial value when a different
  project is activated.
- `MediaState` — `src/state/mediaStore.ts`: `descriptors: Map<AssetId,
  PortableAssetDescriptor>` is the durable project catalog, while
  `assets: Map<AssetId, MediaAsset>` is only the currently connected subset.
  `addAsset`/`connectAsset` install a fully analyzed source and take ownership
  of its URL; `disconnectAsset` keeps the descriptor but releases the source;
  `replaceAssets` atomically installs a project catalog plus its connected
  subset; and `removeAsset` deletes both. `visuals: Map<AssetId, AssetVisuals>`
  + `setAssetVisuals(id, v)` owns filmstrip/waveform URLs. Replacement,
  disconnection, removal, late visual results, and `clearAssets()` revoke each
  owned source/generated URL exactly once. Project persistence serializes the
  descriptors, never the session-only connected resources or URLs.
  `compatibility: Map<AssetId, MediaCompatibilityItem>` is also session-only:
  `startCompatibility` accepts only an uncommitted id with no active check,
  `setCompatibility` accepts only the request generation that still owns that
  row, and removal/project replacement invalidates late results. Reports are
  small serializable facts with no live resources. Files, handles, Inputs, and
  abort controllers stay app-layer; a Ready object URL transfers only to the
  existing asset/visual owners, never into compatibility state.
- `ProjectSessionState` — `src/state/projectSessionStore.ts`: serializable
  launch/editor screen, operation phase, active-project labels, resume and
  active-editor relink summaries (including ambiguity choices), and the
  serializable dirty/save/recovery-status projection. Parsed projects,
  selected Files, folder entries, MediaAssets, readable/writable file handles,
  recovery payloads, timers, and all object URLs stay in app-layer
  controllers/adapters; they never enter this store.
- `ProjectLibraryState` — `src/state/projectLibraryStore.ts`: serializable Home
  summaries for recent project files and recovery journals. Opaque handles and
  serialized recovery snapshots remain controller-local; this store may only
  expose labels, timestamps, permission state, and stable local record ids.
- Project persistence — `src/app/projectPersistenceController.ts`: builds a
  validated portable snapshot from `documentStore` + `mediaStore`, owns the
  current writable handle, debounces live saves, serializes overlapping edits
  by revision, and attaches `beforeunload` only while work is dirty. `Save`
  and `Save As` request an explicit user-gesture grant when no writable handle
  exists; that grant enables later in-place live saves. A browser without the
  writable-file picker may download a copy, but that unobservable fallback
  never marks dirty work as safely persisted. A separate recovery sink writes
  bounded, versioned local snapshots while work is dirty; recovery success
  never clears dirty state or updates saved-at truth. Project replacement first
  pauses this controller, cancels both timers, and drains any open file or
  recovery write before media or session state can be released.
- Local project library — `src/app/localProjectStorage.ts` stores recent
  `FileSystemFileHandle` capabilities and bounded recovery journals in
  origin-local IndexedDB. `src/app/projectLibraryController.ts` retains those
  opaque values outside Zustand and publishes Home summaries. Recovery keeps
  several complete generations, is offered explicitly, and never stores media
  bytes. Intentional project exit or a revision-current successful `.webcut`
  save removes the active journal before session resources are released.
- Local media reconnection — `src/app/localMediaHandles.ts` stores opaque
  `FileSystemFileHandle` capabilities in an origin-local IndexedDB sidecar,
  keyed by stable document + asset ids. Paths and handles never enter domain
  data or `.webcut` JSON. Resume may query permission silently; prompting must
  originate in a user click. Missing, denied, moved, changed, or unsupported
  sources remain offline and may be reconnected individually or through one
  recursively enumerated folder. Folder scans are deterministically bounded;
  conservative filename/size/modified-time/media-metadata matching accepts
  unique sources, while ambiguous candidates require an explicit user choice.
  Accepted sources keep the original asset id and are re-analyzed before
  transfer into `MediaState`; relative folder paths are display-only, and
  Files, handles, and object URLs remain controller-local.
- Worker messages — `src/workers/decode-protocol.ts` (canonical):
  `ToDecodeWorker` (`init`/`configure`/`seek`/`close`) and `FromDecodeWorker`
  (`configured`/`frameReady`/`error`). Types-only file; BOTH the worker and
  `engine/worker-bridge.ts` import it (that is the one sanctioned
  cross-import between those layers — it carries zero runtime code).
  Timestamps are integer microseconds; frame-number conversion happens on
  the bridge side. Seeks are latest-wins: only the newest seek is guaranteed
  a `frameReady`; superseded seeks are resolved by the bridge, and a
  worker `error` carrying a requestId also settles that request.

## Folder layout

```
src/
  domain/      time, schema, operations, selectors      (pure TS)
  state/       document, transport, media, project-session/library stores
  engine/      playback-engine, worker-bridge, frame-cache
  workers/     decode.worker, render.worker
  pipeline/    demux, decode, render, export
  codecs/      realm-local lazy decoder registration and resource policy
  ui/          ProjectLaunch, Toolbar, MediaPool, Preview, Inspector
  ui/timeline/ Timeline, Track, ClipView, Ruler, Playhead
  app/         App, project/persistence/controllers, layout.css
  dev/         temporary scratch harnesses — may import anything, never shipped
```
