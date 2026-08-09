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
- `codecs/` is a browser/worker-safe runtime leaf for reviewed local decoder
  registration and policy. It may import `domain/` types and external codec
  packages, but never `state/`, `ui/`, `app/`, `engine/`, `pipeline/`, or
  `workers/`.
- `app/` is the COMPOSITION ROOT: non-component `.ts` controllers there
  (e.g. `app/previewController.ts`) may import state/ AND engine/pipeline
  to wire them together. ui components may import those controllers as
  their facade — but still never engine/, pipeline/, or workers/ directly.
- The opt-in Issue #54 benchmark has one narrow, architecture-guarded dev
  exception. `dev/performance/runtime.ts` may compose existing `app/`
  controllers with `state/` and its bounded Mediabunny fixture generator;
  `dev/performance/framePlanningBenchmark.ts` may import only browser-free
  `domain/` planners to produce the Issue #59 legacy/indexed parity and timing
  evidence;
  `PerformanceBenchmarkApp.tsx` may reuse existing `ui/` surfaces. No other
  `dev/` module may reach those layers, and only the build-gated exact route in
  `main.tsx` may import the benchmark UI. Ordinary production builds remove
  that dynamic import and its complete closure.
- Sanctioned exceptions between those three (and nothing more):
  - anyone may import `workers/decode-types.ts`,
    `workers/decode-protocol.ts`, `workers/render-legacy-protocol.ts`, and
    `workers/render-protocol.ts` (types only, no runtime),
  - `workers/` may import `engine/frame-cache.ts` (pure class, no deps),
  - `workers/render.worker.ts` may import `pipeline/render.ts` (the pure
    compositing core: imports domain/ only, no browser I/O — the worker is
    its runtime host, as `export.ts` is the finite export host),
    `pipeline/static-image.ts` (the bounded browser/worker-safe still-image
    inspection + decode boundary),
  - `engine/worker-bridge.ts` references the worker FILE via
    `new Worker(new URL(...))` — a URL, not a module import; the pipeline
    chunk source reaches the bridge by injection, never by import.

## Non-negotiable rules

1. **Close every frame.** Every `VideoFrame` / `AudioData` / `ImageBitmap`
   MUST be `.close()`'d in a `finally` block or immediately after use. The
   only resource allowed to outlive one draw is a bounded source/cache entry
   with one explicit non-React owner and exact replacement/release/shutdown
   cleanup. Never store one in React state or an unowned closure.
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
  Timed filmstrip buckets retain their source-frame offset within that slice;
  still clips repeat their one generated tile across the visible timeline
  slice. Waveforms use a normalized source-time SVG viewBox rather than a
  gigantic duration-scaled background. Long clips therefore stay aligned
  without recreating the browser-width problem inside one visual element.

## Data model — `src/domain/schema.ts` (canonical, implemented)

`domain/schema.ts` defines the authoritative interfaces every phase
references: `FrameRate`, `RationalTime`, `TimeRange`, `MediaAsset`,
`TimelineDoc`, `Track`, `Clip`, `Transform`, `Effect`, `Transition`,
`TextProps`. Read that file for field-level docs. Key invariants:

- `TimeRange` is **half-open** `[startFrame, startFrame + durationFrames)`;
  ranges that merely touch do not overlap. All ranges are integer frames at
  the document rate.
- `Clip.sourceMode` makes source mapping explicit. Timed clips play at speed
  1.0 against conformed assets, so their source and timeline durations match.
  Still clips always use `sourceRange = { startFrame: 0, durationFrames: 1 }`;
  every timeline frame (including transition windows) resolves to source frame
  0, while `timelineRange.durationFrames` is independently editable. Trim,
  ripple, razor, and slide change timeline geometry without inventing source
  frames; Slip is an intentional no-op.
- Text overlays are procedural timed video clips. They use a reserved
  `__myrelith_text__:` asset id, carry their full supported appearance in
  `Clip.text`, and require no `MediaAsset`, durable descriptor, Blob, file
  handle, decoder, or relink state. Their source range is always
  `[0, timeline duration)`; trim, ripple, split, move, slide, and linked edits
  preserve that identity, while Slip is an intentional no-op. Unsupported
  font/color/geometry values fail validation instead of being substituted.
  Project-file migration accepts the legacy `__webcut_text__:` prefix only to
  normalize it to the current prefix before validation and editing.
- Visual media clips may carry `Clip.animation`, a canonical list of scalar
  tracks for position X/Y, scale X/Y, rotation, and opacity. Keyframe times are
  exact clip-local integer frames, sorted strictly with no duplicates; an edit
  at an existing time replaces it. Boundaries hold the nearest value. Each
  left keyframe owns the outgoing `hold`, `linear`, or bounded CSS-style cubic
  Bézier easing into the next keyframe. `domain/clipAnimation.ts` is the one
  pure, bounded validator/evaluator/editor authority. Static clip fields remain
  the fallback and are unchanged when a property animation is reset. Text,
  audio, crop, flips, effects, and text styling are intentionally outside this
  first property set. Timeline schema 6 adds the durable contract; schema-5
  migration installs an empty animation without changing appearance.
- `TimelineDoc.markers` holds sequence-level annotations as stable ids, exact
  non-negative integer frames, bounded labels/optional notes, and one color
  from the portable marker palette. `domain/timelineMarkers.ts` is the pure
  add/edit/move/duplicate/delete/navigation authority and keeps the array
  strictly sorted by `(frame, id)`, making equal-frame behavior deterministic.
  Markers are independent of tracks and never extend preview/export duration;
  `timelineDisplayDurationFrames()` is the UI-only extent used to reveal far
  markers. Timeline schema 7 adds the explicit array, and schema-6 migration
  installs an empty default. Selection/editor state stays ephemeral in
  `transportStore`; the ruler clusters only its visible pixel window.
- `TimelineDoc.captionTracks` holds semantic captions separately from video
  clips. Tracks own stable ids, a bounded name, BCP-47-compatible language,
  subtitle/caption role, style preset, visibility, and sorted cue arrays. Cues
  own globally stable ids, non-empty plain text, and half-open integer-frame
  ranges; overlap is legal up to the document-wide visible-active bound.
  `domain/captions.ts` is the pure validation/edit authority and
  `domain/captionFiles.ts` is the pure SRT/WebVTT authority. The compositor
  may reuse the procedural-text layout and paint path, but caption identity,
  timing, metadata, import/export, and editing must never be converted into
  synthetic clips. Caption cues extend derived preview/export duration.
  Timeline schema 8 adds the explicit array, and schema-7 migration installs
  an empty default.
- `Clip.blendMode` is explicit in timeline schema 9. The current serialized
  allow-list is `normal`, `multiply`, `screen`, and `overlay`; schema-8
  migration installs `normal`, which maps to source-over. Unknown bounded
  strings remain durable author intent but resolve to the normal compatibility
  path. `domain/blendModes.ts` is the browser-free vocabulary, transition-group
  resolver, and sRGB premultiplied-alpha reference authority. The complete
  layer/transition contract is normative in `docs/BLEND_MODES.md`.
- Clips on one track are sorted by `timelineRange.startFrame` and pairwise
  non-overlapping; `operations.ts` rejects violations.
- `TimelineDoc.tracks[0]` composites first (bottom layer).
- Document duration is derived (selectors), never stored.
- `TimelineDoc` must survive `JSON.stringify`/`parse` losslessly (undo
  history depends on it); `MediaAsset.objectUrl` is session-scoped.
- Each durable media descriptor carries independent video/audio source bounds.
  `exact` bounds use signed integer microsecond timestamps, `unknown` is the
  conservative migration state, and `null` means the stream is absent. Handle
  planning must use these facts; a renderer or mixer must never invent media
  by clamping a video endpoint, freezing audio, or padding an exact handle.
- A present `Clip.linkGroupId` identifies exactly one video clip plus one
  audio clip. `domain/linking.ts` owns the pure manual-link contract:
  `getLinkClipsEligibility` returns stable rejection reasons and `linkClips`
  links only two distinct, existing, unlocked, currently unlinked clips in
  video-then-audio order. It changes no asset, range, or clip metadata;
  manually linked partners may have different assets and ranges. Link-group
  ids are minted against the current document so a UUID collision cannot
  merge unrelated pairs. Re-linking requires an explicit unlink first.
  Track removal must never leave a one-clip link group: removing an unlocked
  track dissolves the group id on each lone unlocked survivor in the same
  document mutation; if a required survivor is on a locked track, the entire
  removal rejects by returning the original document reference.
- `domain/projectSettings.ts` is the pure creation-time authority for reviewed
  canvas sizes. It exposes Horizontal 16:9, Vertical 9:16, Square 1:1, and
  Social portrait 4:5 at the 720, 1080, 1440, and 2160 tiers. Every selectable
  pair is an exact allow-listed integer width/height within the current 4K
  pixel envelope; the default remains Horizontal 1920 × 1080.
- The same creation-time authority gives every fresh document exactly four
  empty video tracks (`V1`–`V4`) followed by four empty audio tracks
  (`A1`–`A4`). Each track and its clip/transition arrays are independently
  owned. Resume, recovery, migration, and file loading preserve the saved track
  count, order, and identities; the default is not a minimum-track invariant.
- Aspect-ratio identity is derived from exact `TimelineDoc.width` and
  `TimelineDoc.height` and is never persisted as another source of truth.
  Portable projects and export profiles retain their existing schemas; resume,
  preview, render, and export consume the document dimensions unchanged.
- `domain/presentationProfile.ts` is the browser-free authority for disposable
  Program Monitor presentation. It resolves Auto/Full/Half/Quarter into one
  uniform project-to-output scale plus an explainable reason and device-pixel
  policy. The app may combine session quality, transport state, and measured
  monitor size, but authored transforms/crops/text/keyframes remain in project
  coordinates. The render worker may resize and reuse only preview surfaces;
  export always requests an explicit full-resolution profile.

## Crossfade planning, composition, and audio

- `domain/crossfadePlan.ts` is the pure authority for one authored seam: exact
  centered integer-frame geometry, genuine per-stream handle capacity, visual
  source requests, unique aligned linked-audio partners, and typed fallback
  reasons. Preview, live playback, and export receive the same immutable
  document plus source-bounds facts and do not reconstruct seam geometry.
- `domain/videoCompositionPlan.ts` carries ordinary paint items and grouped
  crossfade items plus procedural text items through the preview bridge,
  worker protocol, and export. It resolves clip animation at the requested
  timeline frame before emitting every ordinary or crossfade leg, so scrub,
  playback, and export cannot choose different interpolation paths. Text layout
  is one bounded shared Canvas2D path
  for preview and export; it never emits a media request. The compositor
  renders each complete transformed/effected/opacity-adjusted leg
  to a reusable transparent surface, combines premultiplied weighted pixels in
  declared Canvas2D sRGB, then composites the isolated group over lower tracks
  exactly once. Scratch surfaces, cached text layouts, and borrowed frames
  retain explicit bounded owners.
- Every composition item carries resolved blend intent. Ordinary decoded media
  blends after transform/crop and opacity. Procedural text first renders as one
  isolated source-over layer, then blends once. A crossfade keeps source-over
  legs plus premultiplied `lighter` weighting and applies a non-normal mode to
  the isolated group only when both legs agree on the same supported name;
  mixed/unknown intent uses normal without rewriting either clip. The concrete
  Canvas operation is capability-probed and restored in `finally`; the adapter
  permits a future parity-verified WebGL backend but never selects an implicit
  shader fallback. Preview and export share this exact plan/compositor path.
- `domain/audioMixPlan.ts` is the shared live/export audible-contributor and
  envelope contract. Valid linked fades open real virtual handle ranges and
  apply clip volume with an absolute linear or equal-power envelope. Web Audio
  schedules that plan against the shared audio anchor; export evaluates it on
  the exact BigInt-derived sample grid before one final sum/clamp. Invalid or
  unavailable audio falls back to the ordinary hard cut without weakening a
  valid visual crossfade.

## Export profile and delivery contracts

- `domain/exportProfile.ts` is the sole browser-free authority for allowed
  concrete container, video/audio codec, channel-layout, bitrate, key-frame,
  MIME, extension, and destination shapes. `auto` is selection policy only and
  resolves Modern → Web → Compatibility; HEVC is explicit-only. Dimensions,
  exact rational FPS, and audio sample rate remain `TimelineDoc` facts.
- `pipeline/export-capabilities.ts` validates containment and native encoder
  support. Cached catalog checks are hints; `app/exportController.ts` reruns
  the exact disposable preflight before allocating an output writer or
  encoder. An explicit unavailable profile fails with its reason; no profile
  or codec substitution and no local encoder fallback are permitted.
- `pipeline/export-mediabunny.ts` is the stable composition facade for the
  real browser adapters. `export-mediabunny-visual-source.ts` exclusively owns
  timed-video/static-image decode sessions and frame leases;
  `export-mediabunny-audio-source.ts` exclusively owns sequential decoded PCM
  readers; and `export-mediabunny-sink.ts` exclusively owns encoder/muxer
  resources plus buffered/direct-file output transactions. Shared asset
  resolver/error types live in `export-mediabunny-common.ts`; resource
  lifecycles remain inside their owner module and never move into the facade.
- Buffered output owns a `BufferTarget` result. Direct-file output begins with
  a user-gesture picker in `app/`, passes only a one-shot opaque capability,
  and uses `StreamTarget` with at most 1 MiB of awaited positioned writes.
  Myrelith commits only after successful mux finalization; cancellation or
  failure aborts, and uncertain abort cleanup is a terminal integrity error.
- AAC and Opus must preserve the exact scheduled presentation length. The
  exact-version Mediabunny patch writes and reopens Opus `CodecDelay`, 80 ms
  `SeekPreRoll`, final `DiscardPadding`, source-rate metadata, and exact
  duration; malformed or unrepresentable timing fails closed.
- Only a validated export selection may persist in its dedicated local
  preference. Capability results, file handles, and output bytes never enter
  project or Zustand state. Project dimensions, FPS, and sample rate remain
  authoritative `TimelineDoc` facts and are not duplicated into that export
  preference.
- `ui/ExportDialog.tsx` exclusively owns export view state, lazy controller
  loading, capability generations, cancellation, focus scheduling, and result
  URL lifetime. `ui/ExportDialogSections.tsx` is stateless presentation;
  `ExportProfilePicker.tsx` owns only profile-editing drafts. Presentation must
  not acquire an export resource or bypass the app-layer facades.
- `app/App.tsx` is the eager launcher composition root. It must reach the
  editor only through `app/editorModuleLoader.ts`; project creation/open/recovery
  preloads that boundary before changing session truth. `app/EditorShell.tsx`
  owns editor-only panels, shortcuts, runtime lifecycles, and styles. Export,
  text-overlay, and animation surfaces remain first-use dynamic imports.
- `app/exportLifecycle.ts` is the lightweight project-replacement seam for the
  lazy export controller. It may call a disposer only after that controller has
  registered itself; project exit must never import export code just to learn
  that no export was started.
- `app/launcher.css` eagerly imports launcher and lazy-state rules;
  `app/layout.css` is the lazy editor stylesheet manifest. Together their
  `styles/` imports retain the original global cascade order. Changing either
  boundary or import order is a behavior change and requires production visual
  and network validation.

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
  `renameTrack(trackId, name)`, `removeTrack(trackId)` (a locked target
  rejects; surviving linked partners are unlinked atomically, while a locked
  survivor rejects the whole removal),
  `addCrossfadeWithSourceBounds(fromClipId, toClipId, settings, catalog)`,
  `setCrossfadeSettings(trackId, transitionId, settings, catalog)`,
  `removeTransition(trackId, transitionId)`,
  `setClipVolume(clipId, volume)` (clamped [0,2]),
  `updateClipVisualAtFrame(clipId, timelineFrame, patch)` (static properties
  update their base fields; properties with a curve replace/add one keyframe at
  that playhead), `setClipKeyframe`, `moveClipKeyframe`,
  `removeClipKeyframe`, `resetClipAnimationTrack` (each successful call is one
  history entry; rejected/idempotent calls are none),
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
  ghost a linked gesture live. `textOverlayPreview` and `clipVisualPreview`
  hold rAF-coalesced Program Monitor drafts for procedural text geometry and
  visual-media transform/settings respectively. `app/previewController.ts`
  projects those drafts into the immutable document snapshot sent to the
  shared preview renderer; neither enters document history until the gesture
  owner dispatches its single pointerup mutation.
  `ui/timeline/useClipGestureSession.ts` is the
  single owner of clip pointer/keyboard routing, pointer capture, cancellation,
  rAF-coalesced previews, and the one pointerup document dispatch. At
  pointerdown it delegates to pure `ui/timeline/gestureBounds.ts`, using one
  fresh document/media snapshot to intersect every participating linked
  member's legal signed-delta interval, so no owner can preview beyond a
  partner's timeline, source, duration, and headroom bounds. The gesture
  session retains that exact pointer-down document reference and group
  identity; if the committed document changes before pointerup, the preview is
  cleared and no stale commit is dispatched. Normal pointer or unmodified
  keyboard selection replaces both selection fields; Ctrl/Cmd pointer or
  keyboard activation toggles membership and promotes the newly added clip to
  primary. The
  Inspector resolves the live selection against the current document. Its
  native Link/Unlink commands remain keyboard-focusable and expose
  `aria-disabled` while unavailable; activation dispatches only for the exact
  rendered eligible pair after a latest-state preflight, and adjacent visible
  `aria-describedby` status explains unavailable states while a live status
  announces raced/rejected actions. Selection has no history, no persistence,
  and no side effects; transportStore never touches documentStore. The app-only
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
  subset; and `removeAsset` deletes both. `collections: MediaCollection[]` is
  the durable ordered Media Pool organization layer: each collection owns only
  a unique name plus stable descriptor ids, and one id may belong to multiple
  collections. Collection create/rename/reorder/delete/membership changes have
  a bounded collection-only undo/redo history. Deleting a collection never
  deletes a descriptor or connected source; deleting a descriptor prunes that
  id from current and historical collection snapshots so undo cannot resurrect
  a ghost membership. `visuals: Map<AssetId, AssetVisuals>`
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
  `src/app/mediaJobScheduler.ts` is the app-layer owner for disposable media
  analysis queue state. `mediaVisualsController` submits one generation-safe
  job per connected asset with a conservative two-job/two-decoder default
  budget; selected-clip media outranks exact on-screen timeline or Media Pool
  media, which outranks background media, while aging prevents starvation.
  Timeline and Media Pool UI may publish only their transient visible ranges
  through app facades; neither viewport is document or session truth.
  Removal, replacement, project teardown, or supersession aborts queued/active
  work; each pipeline owner must close its Input/decoder and revoke any URL
  that did not transfer to `mediaStore`. Scheduler snapshots are bounded,
  serializable diagnostics only—never document truth or live resources.
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
  validated portable snapshot from `documentStore` + `mediaStore`, including
  descriptors and ordered collection membership in project format v5, owns the
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
  bytes. Intentional project exit or a revision-current successful `.myrelith`
  save removes the active journal before session resources are released.
  New saves use `.myrelith` and `myrelith-project`; parsing also accepts the
  legacy `.webcut` filename and `webcut-project` marker, then returns only a
  current normalized project. The historical IndexedDB database names are
  durable compatibility identifiers and must not be renamed without an atomic
  record migration.
- Media import policy — `src/app/mediaImportDecisions.ts` is the store-free
  authority for FPS-prompt eligibility, partial-track choice reapplication,
  active-document/rate validation, and Keep/Match rate resolution. It accepts
  only serializable document, asset, report, and rate facts; it never owns a
  File, handle, object URL, abort signal, store, or browser capability.
  `src/app/mediaImportController.ts` remains the public composition facade and
  the sole import resource/mutation owner. It publishes guarded compatibility
  generations, retains retry Files/handles outside Zustand, revalidates the
  active document before commit, transfers a Ready URL only through the media
  store, and revokes every analyzed-but-uncommitted URL in its outer `finally`.
  Cancellation, a rejected decision, project replacement, and failed retry
  must not bypass that exact cleanup owner.
- Local media reconnection — `src/app/localMediaHandles.ts` stores opaque
  `FileSystemFileHandle` capabilities in an origin-local IndexedDB sidecar,
  keyed by stable document + asset ids. Paths and handles never enter domain
  data or `.myrelith` JSON. Resume may query permission silently; prompting must
  originate in a user click. Missing, denied, moved, changed, or unsupported
  sources remain offline and may be reconnected individually or through one
  recursively enumerated folder. Folder scans are deterministically bounded;
  conservative filename/size/modified-time/media-metadata matching accepts
  unique sources, while ambiguous candidates require an explicit user choice.
  Accepted sources keep the original asset id and are re-analyzed before
  transfer into `MediaState`; relative folder paths are display-only, and
  Files, handles, and object URLs remain controller-local.
  `src/app/projectMediaMatching.ts` is the store-free authority for descriptor
  comparison, saved partial-track reapplication, deterministic ambiguity
  narrowing, and stable asset reconstruction. Active individual Relink and
  accepted folder matches share the dependency-injected transaction in
  `src/app/activeMediaRelinkCoordinator.ts`; `projectController.ts` remains the
  public facade and owns project generations plus staged folder selections.
  The transaction must revalidate that exact controller-local selection before
  `MediaState` takes its object URL. Remembering its handle happens only after
  that transfer, so cancellation or project replacement must never revoke a
  store-owned source.
- Legacy worker messages — `src/workers/decode-protocol.ts` (compatibility):
  `ToDecodeWorker` (`init`/`configure`/`seek`/`close`) and `FromDecodeWorker`
  (`configured`/`frameReady`/`error`). Shared structural types live in
  `decode-types.ts`; both files carry zero runtime code. The retired worker and
  `engine/worker-bridge.ts` retain these contracts without being imported by
  the current render path.
  Timestamps are integer microseconds; frame-number conversion happens on
  the bridge side. Seeks are latest-wins: only the newest seek is guaranteed
  a `frameReady`; superseded seeks are resolved by the bridge, and a
  worker `error` carrying a requestId also settles that request.

## Folder layout

```
src/
  domain/      time, schema, operations, selectors      (pure TS)
  state/       document, transport, media, project-session/library stores
  engine/      playback-engine, render bridge, isolated legacy bridge, frame-cache
  workers/     protocols/types, current render worker, isolated legacy delegates
  pipeline/    demux, legacy chunk decode, render, export
  codecs/      realm-local lazy decoder registration and resource policy
  ui/          ProjectLaunch, Toolbar, MediaPool, Preview, Inspector,
               ExportDialog lifecycle owner + stateless export sections
  ui/timeline/ Timeline, Track, ClipView presentation root,
               useClipGestureSession pointer owner, presentation plan/layer,
               Ruler, Playhead
  app/         eager App launcher, lazy EditorShell, module/lifecycle seams,
               project/persistence/controllers, split CSS manifests
  app/styles/  launcher then editor feature styles in binding cascade order
  dev/         explicitly guarded, build-gated benchmark UI/runtime only
```
