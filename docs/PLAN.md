# WebCut — MVP Build Record (Phases 3-gate, 4, 5)

Adapted from the original implementation plan (source:
`C:\Users\Aryel\Pictures\nle-implementation-plan.md`) with corrections for
how the codebase actually evolved. This completed roadmap remains the MVP gate
record; new post-MVP work needs a new user-approved plan. Companion context:
[HANDOFF.md](HANDOFF.md).

## Phase 3 gate — ✅ CLOSED (2026-07-06)

- [x] Wire Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y) to documentStore undo/redo —
  `app/useUndoRedoShortcuts.ts` (window listener, no subscriptions;
  guards editable targets, AltGr, IME).
- [x] User ran the manual pass (Profiler render isolation, drag → doc JSON
  → undo reverts) — confirmed 2026-07-06.
- [x] `src/dev/DecodeSandbox.tsx` and the `?sandbox` branch in `main.tsx`
  DELETED.

## Phase 4 — Trim / Split / Multi-Track Edit Ops

Goal: full editing surface + correct multi-track compositing.

### 4.0 ✅ DONE (2026-07-06) Media → timeline flow
Shipped: pure ops `insertClip(doc, trackId, clip)` + `clipFromAsset(asset,
startFrame)`, documentStore.insertClip (one undo entry; rejects push none),
HTML5 drag from MediaPool rows onto Track lanes (`ui/dnd.ts` carries the
payload contract + asset-kind↔track-kind gating; drop = pointer frame via
the ruler's px→frame mapping). Browser-verified drop/undo/redo.

### 4.0.5 ✅ DONE (2026-07-06; user-requested, not in original plan) Transport bar
Play/pause + one-frame steps between Preview and Timeline. Shipped:
`engine/playback-engine.ts` (real now, no longer a stub — injected
AudioContext clock per rule 3, floor+epsilon frame math), app/
transportController (composition root; scrub preempts playback, end
parks+pauses, play-at-end restarts), ui/TransportBar (subscribes to
isPlaying only — invariant 6 kept). At this point playback was silent and
single-asset; Phase 4.1 and post-MVP issues #2/#5 later superseded both
limitations. Keyboard arrows still belonged to 4.2.

### 4.0.6 ✅ DONE (2026-07-06; user-requested) 12-hour virtualized ruler
The 60s minimum runway ended mid-screen on wide monitors. Now
MIN_RULER_SECONDS = 12h with tick VIRTUALIZATION (only the viewport ±1
screen of ticks exist in the DOM — a full 12h runway would be ~8.6k
nodes); scroll window read from the `[data-timeline-scroll]` ancestor,
rAF-coalesced. The runway's last frame always shows a right-anchored
label so scrolling right ends on a clean 12:00:00:00 mark. Native
scrollbar is twitchy at 1px/frame over 1.3M px. Post-MVP issue #9 now
supersedes that fixed-scale limitation with Full/Detail/Custom zoom while
retaining the virtualized ruler and the exact logical 12-hour runway. Its
bounded physical viewport removes the browser-width limitation without
shortening the runway.

### 4.1 Compositing — `pipeline/render.ts` + `workers/render.worker.ts`
Sliced into three module-turns:

- [x] **4.1a compositor core** — DONE 2026-07-06. `pipeline/render.ts`:
  `compositeFrame(doc, frame, ctx, source)` draws each visible video
  track's active clip bottom-to-top (tracks[0] first) with Transform
  (scale→rotate→translate around anchor) + clamped opacity; black
  background; text clips + opacity≤0 skipped. Canvas2D only. The 2D ctx
  (`Composite2D`) and pixels (`FrameSource.getFrame(assetId, sourceFrame)
  → Promise<ImageBitmap|null>`) are injected; all fetches for one
  composite issue CONCURRENTLY, drawing is synchronous afterwards
  (bitmap-validity window), per-clip try/finally so a dead bitmap can't
  poison the ctx stack; result reports `{drawn, missing}` clip ids so the
  caller knows to re-composite after decoders warm up. New domain
  selectors: `activeClipAt(track, frame)`, `clipSourceFrame(clip, frame)`.
  12 unit tests (order, transform math, failure isolation, concurrency).
- [x] **4.1b render worker** — DONE 2026-07-06. `workers/render-protocol.ts`
  (types only: init/setDoc/configureAsset/releaseAsset/composite ↔
  assetConfigured/compositeDone/error; the MAIN side is the single
  computer of µs targets — entries carry assetId+sourceFrame+targetUs+
  tolUs+chunks) + `workers/render.worker.ts` (`createRenderWorkerCore`,
  injected deps): one decoder + 12-slot bitmap cache PER ASSET (decode-
  worker semantics kept: reset-reconfigures, ≥8 backpressure, close every
  frame), FrameSource over the caches feeding compositeFrame, DOUBLE
  BUFFERING (compose on scratch, blit→visible only if still newest —
  superseded composites never touch the screen), per-asset batch chains
  (same-asset PiP entries serialize; assets parallel), LOAN ledger
  (in-use bitmaps leave the cache during a composite so a flooding batch
  can't evict-and-close them mid-draw; epoch-checked return). 13 unit
  tests incl. a loan mutation-test. DEVIATION from the sketch: the worker
  does NOT self-recomposite on late decodes — `missing` goes back to the
  bridge and the controller decides to reissue (retry policy = main side).
- [x] **4.1c render bridge + previewController swap** — DONE 2026-07-06.
  `engine/render-bridge.ts` (`RenderWorkerBridge`): owns the doc snapshot
  it last posted (protocol ordering), mirrors compositeFrame's skip rules
  via the domain selectors, dedupes (asset, sourceFrame) wants, does ALL
  µs math per asset, fetches chunk batches concurrently (a failing
  provider degrades to an empty batch), latest-wins request ids.
  `app/previewController.ts` rewired: demuxes EVERY video asset into a
  per-asset worker decoder (not just the newest), releases removed
  assets, forwards each doc snapshot, renders DOC frames rAF-coalesced;
  re-render on doc change + assetConfigured = the missing-clip retry
  policy. 23 unit tests. Browser-verified end-to-end: 2 generated clips,
  PiP placement numerically exact, scrub sync across decoders, hidden
  toggle, 50% opacity + scale + 15° rotation blend, 30fps playback
  through the compositor, clean console. NOTE: decode.worker +
  DecodeWorkerBridge are now runtime-dead (types/tests still use them) —
  remove or repurpose only as explicit post-MVP cleanup.

**4.1 COMPLETE** — preview is the real timeline compositor.

### 4.2 ✅ DONE (2026-07-06) — the full editing toolset
EXPANDED at user request from the original "S + edge trim + Delete" to
the Resolve-style fundamental tools, shipped in three commits
(domain → state → ui) + browser verification:
- **domain**: `slipClip` (source shift, position fixed), `slideClip`
  (touching neighbors absorb; gap sides just move; whole-track overlap
  recheck), `rippleTrim` (edge trim + same-track downstream shift,
  gap-preserving; 'start' keeps the head pinned). All with the standard
  reject-same-reference contract.
- **state**: transportStore `tool` (select/razor/trim/slip/slide),
  `selectedClipId`, `editPreview` {clipId, kind, deltaFrames};
  documentStore `splitClipAt`, `rippleTrim`, `slipClip`, `slideClip`.
- **ui**: Toolbar tool buttons; keys A/B/T/Y/U (tools), S (split all
  under playhead), Delete/Backspace (ripple-delete selection, kept when
  a locked track rejects); ClipView gesture routing — edge handles trim
  (select) or ripple (trim tool), razor click-splits at the pointer
  frame, slip/slide body drags with live delta badges; slip clamps live
  against the asset's source bounds; empty-lane click deselects.
  Every gesture = preview-then-commit, one undo entry.
- Browser-verified: trim→razor→ripple→slip→slide→S→Delete on real
  clips, then SEVEN Ctrl+Z restored the byte-exact original layout.
  Verification caught one real fix: pointer handlers now route by
  getState() tool, not the render-time closure.

### 4.3 ✅ DONE (2026-07-06) Inspector
(`selectedClipId` + click-to-select had already landed with 4.2.)
- domain `updateClipTransform(doc, clipId, {transform?, opacity?})`:
  merges partial Transform + opacity; rejects non-finite numbers and
  empty patches; clamps opacity to [0,1]. Plus selectors.findClip.
- documentStore.updateClipTransform — one entry per commit.
- ui/Inspector.tsx: Position X/Y, Scale X/Y, Rotation, Opacity; drafts
  while typing, commit on blur/Enter only, Escape reverts, junk/empty
  reverts, unchanged blur commits nothing; resyncs on undo/gestures;
  remounts per clip. Never reads playheadFrame (invariant 6).
- BONUS (gate prerequisite): ←/→ arrow keys step ±1 frame via
  transportController.stepFrame, clamped to [0, last content frame].
- Browser-verified: five field edits through the real inputs = five
  undo entries, transform/opacity rendered live by the compositor,
  5×Ctrl+Z exact restore, arrow clamps at both ends. (Live inputs show
  locale decimal commas — display-only; the doc holds proper floats.)

### 4.3.5 ✅ DONE (2026-07-08; user-requested) Timeline track headers
The lone in-lane V1/A1 chips were not enough to understand the timeline.
Shipped in three commits (domain → state → ui):
- **domain**: `addTrack(doc, kind)` (next free V#/A# counting ids AND
  names; video inserts after the last video = composites on top, audio
  appends), `setTrackFlags(doc, trackId, {hidden?, muted?, locked?})`
  (works on locked tracks — that's how unlocking works; idempotent
  patches return the same reference), selector `tracksInDisplayOrder`
  (videos reversed — top composite layer first — then audios).
- **state**: documentStore.addTrack / setTrackFlags via commit();
  one undo entry per real change, none for idempotent toggles.
- **ui**: sticky header gutter [headers | lanes] — TrackHeader rows
  (badge, kind, clip count, hide/mute/lock toggles) pixel-aligned with
  their lanes, "+ Video"/"+ Audio" buttons, lanes restyled by flags
  (dim hidden/muted, stripe locked). Lanes column keeps the frame-0
  x-origin, so ruler/drop/drag/playhead math is untouched.
- Browser-verified: add → order + undo exact, toggles → flags + one
  entry each, sticky gutter at 5000px scroll, rows aligned, clean
  console. 351 tests total.

### 4.3.6 ✅ DONE (2026-07-09; user-requested) Track rename / delete / solo
Follow-up to 4.3.5, same domain → state → ui slicing:
- **domain**: `Track.solo` (new REQUIRED schema field; every fixture
  updated, tsc-verified), `renameTrack` (display name only, id stable;
  allowed on locked tracks — metadata, not content), `removeTrack`
  (takes its clips with it, ONE op; locked rejects; deleting the last
  track of a kind is allowed), selector `audibleTracks` = THE solo/mute
  mix rule (any solo → only solo tracks; mute wins) for Phase 5 audio.
- **state**: documentStore.renameTrack / removeTrack; solo rides the
  existing setTrackFlags. Idempotent renames/toggles push no entry;
  one undo restores a deleted track with all its clips.
- **ui**: double-click header → inline rename input (Enter/blur
  commits, Escape cancels, empty cancels; shortcut keys already guard
  editable targets); × delete button (disabled while locked); S solo
  button on audio rows — Timeline derives anyAudioSolo and dims the
  non-solo audio lanes. Gutter 168→200px for the fourth button.
- Browser-verified: real dblclick+keydown rename → badge + 1 entry,
  solo dims exactly the other audio lanes, delete → undo restores the
  clip, locked × disabled, clean console. 376 tests total.

### 4.3.7 ✅ DONE (2026-07-09; user-requested) Clip visuals + clip volume
Waveforms on audio clips, filmstrip thumbnails on video clips, and a
per-clip volume editor. Sliced domain → state → pipeline → app → ui:
- **domain**: `setClipVolume` (clamp [0, MAX_CLIP_VOLUME=2], silent
  idempotent no-op), selector `trackOfClip` (lane-kind branching).
- **state**: documentStore.setClipVolume; mediaStore.visuals map — the
  generated images as object URLs OWNED by the store (revoked on asset
  removal, on replacement, and for late results after removal).
- **pipeline** `visuals.ts`: generateFilmstrip (CanvasSink, 1 tile/~2s,
  cap 48, JPEG) + generateWaveform (AudioBufferSink chunk streaming —
  full PCM never in memory; 100px/s cap 16k, true amplitude, PNG).
  KEY DESIGN: both images span the asset's FULL duration, so the UI
  maps them onto any clip with two CSS background values
  (size = assetDuration×zoom, position = −sourceStart×zoom) — trim,
  razor, slip and zoom all correct with zero redraws.
- **app** `mediaVisualsController.ts` (3rd composition root): one
  background generation per asset, failures logged not retried,
  images skipped, idempotent init from App.
- **ui**: ClipView `.clip-visual` layer (waveform on A lanes, strip on
  V lanes; slip/start-trim previews shift the material live);
  Inspector edits Volume for audio-lane clips (transform fields are
  video-only now). Audio mixing with `clip.volume` is now complete in both
  Phase 5 export and post-MVP issue #5 live playback.
- Browser-verified with an in-page generated 8s A/V MP4 (beat audio):
  strips + waveform render, continuous across razor splits, volume
  commit = one entry, clean console. 414 tests total.

### 4.3.8 ✅ DONE (2026-07-10; user-requested) Linked A/V clips + unlink
A/V drops land LINKED by default; edits follow the link; the Inspector
unlinks manually. Built by Sonnet subagents (one per module) under
orchestrator review, sliced domain → state → ui:
- **domain**: `Clip.linkGroupId?` (shared id = linked; optional, no
  schemaVersion bump) + `linking.ts` — `createLinkGroupId`,
  `linkedPartners`, `unlinkClip` (dissolves the whole group; rejects
  if any member's track is locked) and linked wrappers around the
  proven ops (move/trim/rippleTrim/slip/slide/rippleDelete/split).
  Same delta to every member, sequentially, ATOMIC (any member
  rejecting rolls the whole edit back — a pair can never half-edit).
  Split re-groups the right halves under ONE fresh id via exact
  id-diffing; a lone right half is unlinked; left halves keep the
  original group.
- **state**: documentStore's geometry actions delegate to the linked
  variants (signatures unchanged — UI gesture code untouched); new
  `unlinkClip` action; splitClipAtPlayhead is group-aware (each group
  split once per gesture); transportStore Drag/EditPreview carry an
  optional linkGroupId. Transform/volume edits stay deliberately
  link-blind (video-half / audio-half properties).
- **ui**: the A/V drop stamps ONE fresh group id on both halves;
  ClipView's narrow preview slices also match the gesture owner's
  linkGroupId so the PARTNER ghosts moves/trims/slips live (absolute
  startFrame valid for both — identical ranges by construction); tiny
  🔗 badge on linked clips; Inspector "🔗 Unlink audio/video" button
  on both lane kinds.
- Bonus fix caught in the browser pass: scheduleMovePreview now has
  the same session guard as scheduleEditPreview — a rAF flush landing
  after pointerup could re-post a stale dragPreview that nothing
  clears (pre-existing race, window ~1 frame; huge under a
  throttled-rAF pane, which is how it surfaced).
- Browser-verified end-to-end with an in-page generated A/V MP4:
  linked drop (one entry, badges), partner ghosts the drag live
  (both translateX(150px) mid-gesture), one commit moves both halves,
  razor → 4 clips / left pair keeps group / right pair shares a new
  one, unlink dissolves exactly its own group and the button removes
  itself, post-unlink halves move independently, 5-undo chain back to
  empty + redo exact, clean console. 463 tests total.

### Phase 4 gate — ✅ CLOSED (2026-07-11)
Machine-verified already (browser E2E, see 4.1c/4.2d/4.3 notes):
- every edit op = exactly one undo entry (7-op and 5-op undo chains
  restored byte-exact layouts);
- arrow keys step exactly one frame, clamped both ends;
- 2 video tracks with the top clip at 50% opacity blend correctly.
User's confirmation pass (completed manually 2026-07-11):
- [x] Split a clip, trim both halves, drag one to another track —
  compositing order stays correct (cross-track moveClip already works).
- [x] General feel: tools/inspector/undo behave as expected end to end.

## Phase 5 — Export Pipeline

### 5.1 `pipeline/export.ts`
`exportTimeline(doc, settings): AsyncGenerator<number>` (progress 0..1):
Mediabunny `Output` + `Mp4OutputFormat` + `BufferTarget`; for each output
frame call `compositeFrame` on an offscreen canvas, add via
`CanvasSource.add(timestampSec, durationSec)` AWAITING the promise
(encoder backpressure). Audio: decode+mix active audio clips per timestamp,
encode via AudioEncoder. CFR output; audio sample count must equal
`docDurationFrames(doc) / fps * sampleRate` (NOTE: duration comes from the
SELECTOR `docDurationFrames(doc)` — `doc.durationFrames` does not exist,
deliberate deviation from the original plan). Pad/trim tail by a sample or
two rather than letting rounding accumulate.
The in-browser encode pattern is already proven — see HANDOFF.md toolbox
(we generated test MP4s with Output/CanvasSource in Phase 2.5/3.4).

The completed export work began with the video-only CFR orchestration and
ownership foundation described in
[`docs/superpowers/specs/2026-07-11-phase-5-1-cfr-video-export-foundation-design.md`](superpowers/specs/2026-07-11-phase-5-1-cfr-video-export-foundation-design.md).

- [x] **5.1a CFR orchestration foundation** — DONE 2026-07-11.
  `pipeline/export.ts` now defines the injected media-lease/video-sink
  contracts and schedules every derived document frame with independent
  rational timestamps, awaited backpressure, fatal missing-media handling,
  monotonic progress, returned buffer contract, and exact-once cleanup.
  Cancellation returns `undefined` rather than fabricating an
  `ExportResult` (caught by independent code review). 21 focused tests;
  488 total tests, build, and lint green.
- [x] **5.1b real Mediabunny video adapters + browser export verification**
  — DONE 2026-07-11. `pipeline/export-mediabunny.ts` supplies the production
  Blob→CanvasSink media source and OffscreenCanvas→CanvasSource MP4 sink.
  Each asset uses ONE long-lived `canvasesAtTimestamps` iterator (not
  per-frame `getCanvas`, which would create a decoder per frame); pooled
  canvases are copied into lease-owned ImageBitmaps and closed after each
  composite. AVC support is probed before allocation; writes await
  backpressure; setup/add/finalize/cancel paths terminate exactly once.
  Browser-verified against locked Mediabunny 1.50.3: a 10-frame red→green
  source was decoded, composited, re-exported, reopened by native `<video>`
  at 64×48 / 1.000s, and sampled correctly at 0.2s and 0.7s. 13 focused
  adapter tests; 501 total tests, build, and lint green.
- [x] **5.1c bounded audio decode/mix/encode with exact integer sample count**
  — DONE 2026-07-11. `pipeline/export-audio.ts` derives every absolute
  frame→sample boundary with BigInt rational math, preserves a signed
  source-minus-timeline phase across razor/start-trim edits, mixes only
  `audibleTracks`, honors trims/source offsets + clip volume, performs
  streaming resampling and mono/stereo/surround→stereo conversion, and emits
  awaited blocks capped at 1024 samples. `pipeline/export-mediabunny.ts`
  keeps one sequential AudioSampleSink cursor per active clip, closes every
  decoded/encoded AudioSample, muxes fixed 192 kbps AAC beside AVC, and trims
  the final AAC packet's container duration to the exact scheduled sample
  count. Browser-verified against locked Mediabunny 1.50.3 at 30000/1001:
  48,048 scheduled samples, stereo 48 kHz AAC, audio+video both 1.001s,
  trimmed 0.5-gain tone + silent tail correct, clean console. 16 audio-core
  tests + 20 combined adapter tests; 524 total tests, build, and lint green.

### 5.1d Transition parity
- [x] **Crossfade selection/rendering + preview/export request parity** — DONE
  2026-07-11. `visibleVideoLayersAtFrame` is now the one domain-owned,
  paint-ordered visual plan consumed by `compositeFrame`, the preview render
  bridge, and the export scheduler. Crossfades use a centered half-open
  window around a touching edit, freeze endpoint frames where source handles
  do not exist, and fail closed to a hard cut for stale, invalid, duplicate,
  or overlapping transition definitions. The Canvas2D opacity compensation
  removes the dark midpoint for ordinary opaque full-frame footage. Export
  validates every frame-local request against that same plan while retaining
  one long-lived timestamp iterator per asset.
  Browser-verified against locked Mediabunny 1.50.3 with one source asset
  whose transition schedule forces a real decoder seek forward → backward →
  forward: 12/12 frames reopened, 1.200s exact duration, preview/export probe
  pixels within 2 channel values, bright midpoint, clean console. 16 new
  regression tests; 540 total tests, build, and lint green.

### 5.1e Transition authoring (required before the MVP gate)
- [x] **5.1e-1 domain lifecycle** — DONE 2026-07-11.
  `addCrossfade`, `setCrossfadeDuration`, and `removeTransition` now author
  track-scoped, stable transition metadata for touching adjacent video clips.
  Authoring and rendering share `resolveCrossfade` for the exact centered
  window/fit rule; duplicate seams, unsafe durations, and overlapping windows
  reject with the original document reference. Successful geometry edits
  retain only transitions valid both before and after, so stale definitions
  never spring alive. Split preserves outer-edge intent by rebinding an
  outgoing transition to the new right half; move/trim/ripple/slide/delete
  keep or discard seams deterministically; slip stays safe-integer bounded.
  Linked A/V rollback restores transition metadata atomically. 24 new domain
  regressions; 564 total tests, build, and lint green.
- [x] **5.1e-2 state wiring** — DONE 2026-07-11. `documentStore` now exposes
  track-scoped add/duration/remove transition actions as thin domain-op →
  `commit` adapters. Every successful edit creates exactly one snapshot;
  rejected and idempotent edits preserve the document and both history stacks
  (including an existing redo branch). Undo/redo restore the exact authored
  snapshot and generated transition id; cross-track id reuse remains scoped
  to its requested owner. 5 new store regressions; 569 total tests, build,
  and lint green.
- [x] **5.1e-3 timeline UI** — DONE 2026-07-11. Touching adjacent non-text
  video clips now expose a compact cut marker; its accessible popover authors,
  resizes, or removes a centered crossfade through the undoable store actions.
  Duration is explicit before creation, neighboring-window rejection stays in
  the editor with a useful retry message, locked tracks are inert, and the
  popover does not steal clip gestures or global edit shortcuts. 5 focused RTL
  regressions cover eligibility, locking, shorter-duration retry, one-entry
  add/update/remove, dirty-draft removal, and exact-id undo/redo.
  Browser-verified with a generated 60-frame red→green AVC source: UI-authored
  D15 changed frame 27 from hard red `(255,1,0)` to blend `(175,81,0)`;
  applying D2 restored hard red there while frame 30 blended `(85,170,1)`;
  removal restored hard green `(0,255,1)`. Three keyboard undos/redos restored
  none→D15→D2→none with the exact generated id; console stayed at 0 errors and
  0 warnings. 574 total tests, build, and lint green.

### 5.2 Export flow
- [x] **5.2a app export controller** — DONE 2026-07-12.
  `app/exportController.ts` captures one immutable document/settings/media
  snapshot per run, starts retaining every referenced Blob before its object
  URL can be revoked, and shares one cached asset resolver between the video
  decoder and A/V sink factories. It manually pumps `exportTimeline` through
  the result-bearing final `next()` (never `for await`), forwards exact
  progress, and makes cancellation a single serialized `return(undefined)`
  after any in-flight frame boundary. A run owns the singleton slot through
  setup/cancel cleanup; errors remain primary; success returns the buffer and
  cancellation returns `undefined`. 11 focused lifecycle/ownership tests;
  585 total tests, build, and lint green. No browser pass: this controller has
  no rendered surface until 5.2b.
- [x] **5.2b Export UI** — DONE 2026-07-12. The Toolbar now opens a native,
  focus-managed modal with one honest MVP profile: current timeline resolution
  (fixed), MP4/H.264 AVC (fixed), and 8 Mbps. The heavy export controller stays
  behind a Start-time dynamic import. Progress callbacks are rAF-coalesced;
  synchronous double starts are rejected; active and pre-controller
  cancellation are race-safe; cleanup finishes before the cancelled state.
  Success creates one owned Blob URL and an explicit download link, revoking it
  only on reset/close/unmount. Empty timelines, exact runtime errors/retry,
  Windows-safe filenames, terminal focus, backdrop/keyboard behavior, and URL
  lifetime have 9 focused RTL regressions. Browser-verified with a generated
  320×180 A/V source and a two-video-clip crossfade plus one audio clip: the
  downloaded `Browser - Export.mp4` probed as 4.000s, H.264 High/yuv420p at
  exact 30/1 CFR, plus 48 kHz stereo AAC-LC. Progress was monotonic; active
  cancellation at nonzero progress showed Cancelling, created no download,
  and retry succeeded; console stayed at 0 errors and 0 warnings. 594 total
  tests, build, and lint green.

### Phase 5 / MVP gate — CLOSED 2026-07-12

User's confirmation pass (completed manually 2026-07-12):

- [x] Export a 30s, 3-clip, 2-track timeline w/ one crossfade + one trim.
- [x] VLC + QuickTime playback, no perceptible A/V desync.
- [x] Spot-check exported frame at t=10s vs preview.
- [x] `ffprobe -show_streams`: `avg_frame_rate == r_frame_rate == 30/1` on the
  5.2b browser-exported A/V MP4 (2026-07-12).
- [x] No memory growth exporting a 2-min timeline (Chrome Task Manager).

Phase 5 and the MVP are complete. Further work is post-MVP and needs a new
user-approved plan or an explicitly selected item from HANDOFF.md's open list.

## Post-MVP issue #9 — ✅ DONE (2026-07-17) Timeline zoom

- [x] Keep transport `zoom` as the sole rendered pixels-per-frame value; add
  ephemeral `zoomMode` and remembered `customZoom` without document writes or
  undo/redo entries.
- [x] Add right-docked Full Extent, 11-second Detail, remembered Custom,
  multiplicative −/+, and an exponential range slider while playback remains
  centered and timeline tools remain left-docked.
- [x] Measure the live lane width from the scroller minus the actual sticky
  header; anchor Detail/Custom around the playhead after layout commit, clamp
  at frame zero, and force Full Extent to scroll zero with 3%/32px trailing
  room.
- [x] Recompute Full/Detail from ResizeObserver and document-duration changes;
  preserve Custom pixels-per-frame and keep all ruler/clip/seam/visual geometry
  on the existing zoom path.
- [x] Preserve the exact logical runway through
  `max(docDurationFrames(doc), 12 hours at the document rate)` at every zoom;
  do not shorten it or derive maximum zoom from a browser layout ceiling.
- [x] Project that runway through a whole-frame DOM surface capped at
  16,000,000px. Keep `timelineOriginFrame` as ephemeral translation-only state,
  rebase it near native-scroll edges with the opposite scroll displacement,
  and make the true logical endpoint reachable in the last window.
- [x] Slice long clips to the active physical window while preserving source
  offsets for filmstrip buckets and mapping waveforms through a normalized SVG
  viewBox, so no individual visual recreates an oversized browser surface.
- [x] Verification: 127 focused timeline/transport tests, 930 total tests,
  production build, lint, and diff checks green. Real Chrome passed all three
  modes, exact recall, geometric mapping, 1.25x steps, endpoint disabling,
  centering/frame-zero clamping, 720px responsive layout, ruler virtualization,
  filmstrip/waveform rendering, and linked A/V alignment with a clean
  secure-origin warning/error console.

## Post-MVP issue #19 — Slice 1 ✅ DONE (2026-07-18) Native compatibility probe

At this slice boundary, Issue #19 remained open; this approved slice establishes
the conservative native boundary before any fallback or partial-track policy
is selected.

- [x] Detect containers from file bytes with Mediabunny rather than trusting
  extension or declared MIME; inspect every video/audio track with its real
  decoder configuration and the current browser's `canDecode()` result.
- [x] Preserve unknown-codec, unsupported-codec, malformed-media,
  resource-limit, and unexpected probe failures as serializable facts.
  Bound file bytes, total tracks, decoder descriptions, coded dimensions/pixels,
  duration, frame rate, audio sample rate, channels, and probe concurrency.
- [x] Dispose the probe Input exactly once on success, failure, and abort. Create
  an object URL only after the complete report is Ready.
- [x] Keep File/handle resources in the app controller; publish generation-safe
  request-id session reports through mediaStore. Explicit Retry starts a fresh
  generation; Remove aborts checking and late results cannot resurrect rows.
- [x] Render checking/ready/limited/unsupported/error rows in Media Pool with
  accessible live status, container and every-track facts, specific wrapped
  reasons without CSS clipping, and named Retry/Remove controls. Only Ready
  imports are draggable;
  dragstart and timeline drop both recheck live compatibility.
- [x] Preserve positive sub-frame media as one frame through probe, commit,
  reconformance, project validation, relink construction, and UI duration math.
- [x] Verification: 184 focused domain/probe/state/controller/UI/drop tests and
  979 total tests green; production build, lint, and diff checks green. Windows
  Chrome for Testing passed H.264/AAC MP4 Ready → linked A/V drop, ProRes MOV
  Unsupported/non-draggable → fresh explicit Retry → keyboard Remove, 720px
  wrapped diagnostics, and a 0-warning/0-error console.
- [x] Follow-ups: Slices 2–5 implement lifecycle feedback, bounded local
  fallback, explicit partial-track import, and session capability caching;
  Slice 6 records the measured proxy-conversion no-go below.
- [x] Final browser/codec fixture matrix and distribution/security review
  completed in the closeout section below.

## Post-MVP issue #19 — Slice 2 ✅ DONE (2026-07-18) Lifecycle + runtime feedback

At this slice boundary, Issue #19 remained open; this slice makes the native
compatibility result one guarded session truth across project reconnection and
downstream consumers.

- [x] Thread the typed native probe through remembered Resume, manual Resume,
  individual Relink, accepted folder matches, and active-project recovery.
  Activation installs connected assets and their Ready reports atomically;
  settled non-Ready reports stay attached to durable Offline descriptors.
- [x] Preserve a prior settled descriptor report while a new check owns the
  row, then restore it on cancellation, wrong-file selection, or failed commit.
  Descriptor-backed store transitions enforce exact identity, report/status
  consistency, and Ready/connected parity; provisional imports remain exempt.
- [x] Feed confirmed preview, filmstrip, waveform, live-audio, and export
  source failures into compatibility state through typed asset errors. Resource
  setup failures are file-level; track open/decode failures mark only the
  implicated primary track. Global output/pump/cleanup failures stay global.
- [x] Capture the exact object URL plus compatibility generation before async
  work. Stale preview requests, render replies, release cleanup, visuals,
  audio, and export failures cannot disconnect a relinked replacement. A
  failure disconnects once and does not create a hidden decode retry loop.
- [x] Keep runtime diagnostics accessible and non-duplicated. Descriptor-backed
  failures expose Relink rather than the direct-import Retry action; successful
  Relink publishes a fresh Ready report and restores the source.
- [x] Verification: 303 focused tests across 14 lifecycle/runtime files and
  1,021 total tests green; production build, lint, and diff checks green.
  In-app Chromium at 1280×720 passed Offline H.264/AAC → Ready, ProRes →
  Unsupported, wrong-file rollback to the prior report, and a real corrupted
  AAC Ready-at-probe → one Waveform Error/Offline → valid Relink → Ready. The
  normal paths had a clean warning/error console; the forced decoder failure
  emitted one expected warning and did not retry.
- [x] Follow-ups: Slices 3–5 implement bounded local fallback, explicit
  partial-track consent, and capability caching; Slice 6 records the measured
  proxy-conversion no-go below.
- [x] Final browser/codec fixture matrix and distribution/security review
  completed in the closeout section below.

## Post-MVP issue #19 — Slice 3 ✅ DONE (2026-07-19) Shared local decoder fallback

At this slice boundary, Issue #19 remained open; this slice implements the
approved direct-decoder fallback and its automatic resource boundary without
adding partial-track consent or proxy conversion.

- [x] Add one realm-local codec-registration seam used by import probing,
  filmstrip/waveform generation, render-worker sources, live audio, and export.
  Native `canDecode()` runs first; only normalized ProRes or AC-3/E-AC-3 can
  load a fallback, and the same track is checked again after registration.
- [x] Pin `mediabunny`, `@mediabunny/prores`, and `@mediabunny/ac3` together at
  exact version 1.50.9 and bundle them locally behind literal dynamic imports.
  Vite dedupes the core package, emits ES workers, and leaves independent lazy
  chunks for the main and render-worker realms.
- [x] Make registration idempotent and concurrency-safe per realm. Successful
  registrations retain their decoder path, failed loads clear the pending slot
  for an explicit retry, and abort checks surround the non-abortable import and
  decoder-support calls so a cancelled probe cannot publish Ready.
- [x] Bound automatic fallback at 8 GiB, 2 hours, DCI 4K30 ProRes pixel
  throughput, and 8-channel/48 kHz AC-3/E-AC-3. Exceeding a budget returns an
  exact `resource-limit` diagnostic; WebCut neither silently omits a track nor
  converts the source.
- [x] Keep diagnostics honest and state-only in Media Pool: every supported
  track names `Native browser decoder`, `Local fallback (ProRes)`, or `Local
  fallback (AC-3/E-AC-3)`. Unknown codecs never trigger a fallback load.
- [x] Evaluate cross-origin isolation before treating it as a requirement.
  ProRes is correct without isolation through TurboRes's message-passing worker
  mode; a shared-memory optimization remains future measured work. All decoder
  code is locally bundled and no executable decoder is downloaded at runtime.
- [x] Verification: 1,042 tests across 63 files, production build, lint, and
  diff checks green. In-app Chromium imported generated native H.264/AAC,
  ProRes/AAC, H.264/AC-3, and H.264/E-AC-3 fixtures with exact Ready paths and
  generated thumbnails; ProRes rendered in Preview; playback crossed into the
  AC-3 clip; a mixed timeline exported a downloaded 4.000s 1920×1080 H.264 +
  48 kHz stereo AAC MP4; warning/error console stayed clean.
- [x] Slice 4 follow-up: explicit informed partial-track import (see below).
- [x] Slice 5 follow-up: session capability caching with exact boundary
  revalidation (see below).
- [x] Slice 6 follow-up: measured optional proxy-conversion decision (see
  below); the stock browser/WASM candidate is formally out of scope.
- [x] Final fixture and shipping-boundary review completed below. The AC-3
  extension embeds FFmpeg, so public-distribution compliance remains separate
  and is not claimed complete.

## Post-MVP issue #19 — Slice 4 ✅ DONE (2026-07-20) Explicit partial-track import

At this slice boundary, Issue #19 remained open; this slice adds explicit
whole-kind omission only when the other track kind is fully decodable. It does
not add automatic omission or proxy conversion.

- [x] Preserve a bounded Limited candidate only when every track of exactly one
  kind is decodable and the other present kind has a specific failure. Keep the
  provisional File/handle and object URL controller-owned; unsafe Limited
  results remain URL-free and cannot offer partial import.
- [x] Require an explicit native consent dialog before committing anything.
  The dialog names the kept and omitted kinds, codecs, exact failure, unchanged
  source file, and timeline/export consequence; cancel keeps the Limited row
  and returns focus to its review action.
- [x] Project an accepted choice into an effective `video-only` or `audio-only`
  asset. Timeline drops, visuals, preview/audio lookup, and export all use that
  projection; stale invalid clips fail export before source acquisition rather
  than silently reviving the omitted track.
- [x] Persist the choice in portable project format v2 with strict descriptor
  validation and v1 migration. Remembered/manual Resume, individual Relink,
  folder matching, and accepted staged re-probes reapply the saved projection,
  including when another browser could decode both original tracks.
- [x] Keep the accepted omission visible in Ready Media Pool diagnostics while
  excluding it from active failures. Relink and runtime errors preserve the
  choice, selected-track duration, effective kind, audio presence, and decoder
  configuration invariants.
- [x] Verification: 1,072 tests across 63 files, production build, lint, and
  diff checks green. In-app Chromium at 1280×720 imported generated H.264/DTS
  and MPEG-2/AAC MKVs, exercised safe cancellation/focus restoration, then
  confirmed exact video-only and audio-only Ready paths with the omission facts
  still visible. No error overlay appeared and the Vite runtime log stayed
  clean. The known 1.144 MB lazy AC-3 and main-chunk advisories remain.
- [x] Slice 5 follow-up: session capability caching with exact boundary
  revalidation (see below).
- [x] Slice 6 follow-up: measured optional proxy-conversion no-go (see below).
- [x] Final browser/codec fixture matrix and distribution/security review
  completed in the closeout section below.

## Post-MVP issue #19 — Slice 5 ✅ DONE (2026-07-20) Capability caching and boundary revalidation

At this slice boundary, Issue #19 remained open; this slice caches only settled
decoder capability facts for the current JavaScript realm. It does not persist
source bytes, decoder objects, or capability results in `.webcut` projects.

- [x] Add one shared, bounded cache keyed by decode boundary, track kind,
  normalized codec, and a SHA-256 hash of the canonical decoder configuration,
  including exact description bytes. Store settled facts only — never a Blob,
  Mediabunny Input, decoder, track, or mutable configuration object.
- [x] Bound the cache to 256 LRU facts, 1,024 active sources, 1 MiB of copied
  configuration material, and 16,384 canonical JSON characters. Unsafe,
  oversized, or unhashable configurations bypass caching instead of weakening
  the answer.
- [x] Reuse probe results within the browser session, but force exact
  native/fallback revalidation and cache refresh at render, filmstrip, waveform, live
  audio, video-export, and audio-export decode boundaries.
- [x] Register a fresh generation on source add; invalidate on source
  removal/replacement, provisional or Offline transitions, confirmed runtime
  failures, worker configure/release/open
  failure/close, visible-page and BFCache restoration, and newly registered
  fallback codecs. Source generations, runtime revisions, and latest-write
  sequencing prevent stale and remove/re-add (ABA) writes from resurfacing.
- [x] Keep the cache outside Zustand and the domain/project schema. Serialization
  tests reject cache-like fields, so Save/Resume always recomputes support in the
  destination runtime.
- [x] Reapply current resource budgets before accepting a cached local-fallback
  fact, and verify native-only provenance through WebCodecs rather than trusting
  an earlier fallback answer.
- [x] Verification: 1,092 tests across 64 files, production build, lint, and
  diff checks green. In-app Chromium at 1280×720 opened and reconnected a
  generated H.264/AAC project, reported both tracks Ready, generated a real
  filmstrip and preview frame, completed render/live-audio playback, and reached
  Export ready through video + audio decode. No error overlay, warning/error
  console entry, or page-level overflow appeared. The known 1.144 MB lazy AC-3
  and main-chunk advisories remain.
- [x] Slice 6 follow-up: measured optional proxy-conversion no-go (see below).
- [x] Final browser/codec fixture matrix and distribution/security review
  completed in the closeout section below.

## Post-MVP issue #19 — Slice 6 ✅ DECIDED (2026-07-20) Optional proxy conversion

At this slice boundary, Issue #19 remained open. This optional slice ran the
worker/WASM spike and makes a firm no-go decision for built-in browser-side
proxy conversion in the current issue. This is a completed decision, not a
shipped proxy feature; the detailed record is in
[the Slice 6 proxy-conversion decision](decisions/ISSUE_19_PROXY_CONVERSION.md).

- [x] Run a temporary, locally hosted `ffmpeg.wasm` 0.12.15 / core 0.12.10
  single-thread worker spike against both an 8.008 s VP9/Opus mechanics fixture
  and a Limited 8.021 s MPEG-2/AAC Matroska whose MPEG-2 video returned `false`
  from `canDecode`. The direct-decoder-gap 9,009,804-byte source converted in
  4,197.4 ms to a 10,393,232-byte H.264/AAC MP4 whose two output configurations
  returned `true` from `canDecode`; the warning/error console stayed clean.
- [x] Exercise cancellation while conversion is active. Hard worker
  termination returned in 0.2 ms, prevented late completion, invalidated the
  worker, and required a full core reload; it did not prove immediate memory
  reclamation or cleanup. The experimental progress callback also emitted an
  invalid 1.15-trillion intermediate value on the rerun.
- [x] Reject the stock candidate on bounded-I/O, progress, licensing, and
  source/proxy-identity gates; low-memory performance and exact cleanup remain
  unproven and therefore fail closed. Its raw core is 32.2 MB, its documented
  input ceiling is 2 GB, and `readFile()` returns one whole WASM-FS buffer
  rather than an atomic streaming OPFS sink.
- [x] Keep proxy consent, storage, and lifecycle UI out of production. No
  converter dependency, proxy bytes, Zustand state, or `.webcut` field is
  added; the original file remains the sole source/relink identity.
- [x] Record strict reopen conditions: reviewed redistributable encoder,
  streaming OPFS I/O, first-class original/proxy provenance, representative
  low-memory benchmarks, monotonic progress, bounded clean cancellation, and
  an explicit cross-origin-isolation decision.
- [x] Browser evidence: Mediabunny reopened the derived MP4 and both decoder
  configurations returned `canDecode: true`; in-app Chromium also verified the
  hard-cancel/reload state with no console warning or error. Full tests, build,
  lint, and diff checks remained green after the documentation-only decision.
- [x] Final browser/codec fixture matrix and distribution/security review
  completed below, including an explicit boundary around the AC-3 fallback's
  FFmpeg obligations.

## Post-MVP issue #19 — Final closeout ✅ DONE (2026-07-20)

Issue #19 is implementation-complete and closes at 46/49 checklist items. The
three proxy implementation children remain intentionally unchecked because the
measured Slice 6 decision rejected that feature; no converter is implied.
Detailed evidence lives in
[the codec closeout record](decisions/ISSUE_19_CODEC_CLOSEOUT.md).

- [x] Add a reproducible 13-file real-media generator covering native AVC/AAC,
  VP9/Opus, local AC-3/E-AC-3, HEVC, AV1, spoofed extension/MIME, unknown
  codec, malformed configuration, two truncation shapes, empty input, and
  random bytes. The ignored manifest records byte sizes, hashes, and ffprobe
  output, and generation fails closed on a container/codec/shape mismatch.
- [x] Verify exact Chrome diagnostics: native VP9/Opus, native HEVC/AV1 on the
  tested host, one shared AC-3/E-AC-3 fallback family, byte-detected WebM under
  a `.mp4` name, safe audio-only choices for unknown/malformed video, and
  honest Unsupported/Error states for damaged or non-media inputs.
- [x] Close the final ownership and runtime-safety gaps: prompt abort for
  fallback checks without late publication, exact-once live-audio Input
  disposal when close overtakes open, stale-bitmap closure after decoder-worker
  teardown, non-blocking post-commit handle persistence, bounded filmstrip
  canvases, and fail-closed fallback budgets at preview, visual, live-audio,
  and export decode boundaries.
- [x] Verification: 346/346 focused tests across 16 files; 1,127/1,127 total
  tests across 64 files; production build, lint, audit, and diff checks green.
  The known three chunks over 500 kB remain a warning, not a hidden pass.
- [x] Chrome 150 and Edge 150 each passed real VP9/Opus import → thumbnail +
  waveform → linked A/V drop → exact ruler seek → preview/live-audio playback
  → active cancel → retry/download. Both outputs probed as 1280×720 H.264 at
  30 fps plus 48 kHz stereo AAC; both browser runs had zero console/page
  errors. Edge is Chromium-based, so Firefox/WebKit diversity remains untested.
- [x] Complete the distribution/security review. Exact package pins, local
  lazy bundles, zero production advisories, and no runtime decoder downloads
  are established. Public release still requires a WebCut license,
  third-party/source notices, FFmpeg/LGPL and Dolby review, and representative
  low-memory testing; Issue #19 closure does not certify those gates.

## Post-MVP issue #12 — Slice 1 ✅ DONE (2026-07-21) Pure manual-link contract

At this slice boundary, Issue #12 remains open. This slice establishes the
domain contract and collision-safe identity needed by every later manual-link
surface; it does not expose a new store action or user interaction yet.

- [x] Add pure `getLinkClipsEligibility` with stable, position-specific
  rejection reasons shared by the eventual UI and `linkClips` operation.
- [x] Accept only two distinct, existing clips in video-then-audio order when
  both owning tracks are unlocked and both clips are currently unlinked.
  Rejections warn and return the exact input document reference.
- [x] Link by adding one shared `linkGroupId` only. Different assets, source
  starts, timeline starts, durations, relative offsets, transitions, and all
  other clip/document metadata remain unchanged and JSON-safe.
- [x] Mint group ids against every id already in the current document, with a
  deterministic numeric suffix on UUID collision. Reuse that same contract in
  manual linking, linked split, and imported A/V-pair creation so unrelated
  pairs cannot merge accidentally.
- [x] Verification: 57/57 focused tests across the domain and A/V-drop
  integration; 1,138/1,138 total tests across 64 files; production build,
  lint, and diff checks green. No browser gate applies because Slice 1 changes
  no rendered behavior.

Remaining Issue #12 slices own the history-backed store action, pair-selection
interaction, relative-offset preview, accessible Link UI, and real-browser
behavior gate. Manual linking is therefore not user-invokable at this boundary.

## Post-MVP issue #12 — Slice 2 ✅ DONE (2026-07-22) Store and history

At this slice boundary, Issue #12 remains open. The pure Slice 1 operation is
now available as a canonical document-store mutation, but no selection or
rendered UI invokes it yet.

- [x] Add `documentStore.linkClips(videoClipId, audioClipId)` as a thin adapter
  over the pure domain operation. It uses the shared `commit` path instead of
  duplicating validation or identity generation in state.
- [x] Commit a valid link as exactly one history entry and clear any abandoned
  redo branch. Every invalid, stale, locked, wrong-kind, or already-linked
  call preserves `doc`, `past`, and an existing `future` array by reference.
- [x] Undo restores the exact pre-link snapshot. Redo restores the exact
  authored snapshot and original generated `linkGroupId` without invoking
  `crypto.randomUUID()` again.
- [x] Verify unequal assets/ranges remain metadata-only, unrelated tracks keep
  structural identity, and all nine stable Slice 1 rejection reasons retain
  the same no-history behavior through the store.
- [x] Verification: 90/90 focused domain + state tests; 1,142/1,142 total tests
  across 64 files; production build, lint, and diff checks green. No browser
  gate applies because Slice 2 changes no rendered behavior.

Remaining Issue #12 slices own pair selection, relative-offset feedback, the
accessible Link command, and real-browser interaction/accessibility gates.
Manual linking is still not user-invokable at this boundary.

### Issue #12 slice-numbering correction (2026-07-25)

The original researched implementation plan has seven slices and remains the
authoritative delivery boundary. The 2026-07-22 local notes accidentally
compressed later work into two headings called “Slice 3” and “Slice 4”.
Those historical headings are retained below only to match the commits they
described:

- original Slice 3 — global link-group integrity and unequal-edit matrix;
- original Slice 4 — owner-relative live previews plus group-wide intersection
  of every linked member’s timeline floor and source headroom;
- original Slice 5 — ephemeral multi-selection, including document-to-
  transport reconciliation for stale/deleted ids;
- original Slice 6 — accessible Link/Unlink control acceptance;
- original Slice 7 — complete gate and GitHub closeout.

The first historical bundle established much of original Slices 5 and 6; the
second established the unequal-edit matrix and original Slice 4’s signed-delta
core. Neither historical label supersedes the seven-slice checklist.

## Post-MVP issue #12 — Historical local Slice 3 bundle ✅ DONE (2026-07-22) Multi-selection and controls

At this historical commit boundary, Issue #12 remains open, but manual linking
is now a user-visible action. This bundle established the selection/control
foundation later assigned to original Slices 5 and 6; stale-id lifecycle
reconciliation, offset-safe previews, and final acceptance remained deferred.

- [x] Replace the single timeline selection with ordered, unique, ephemeral
  `selectedClipIds` plus one primary `selectedClipId` retained for Inspector
  compatibility. Both reset with transport state and never enter history or
  project persistence.
- [x] Make a normal clip click replace the selection and Ctrl/Cmd-click toggle
  membership without accidentally starting a drag. Newly added clips become
  primary; removing the primary promotes the most recent remaining member.
- [x] Give each clip pressed-button semantics, an exact accessible name,
  visible keyboard focus, and Enter/Space activation. Ctrl/Cmd+Enter provides
  the additive keyboard path without claiming a browser-reserved shortcut.
- [x] Add a native Inspector Link button that is enabled only for exactly one
  eligible video clip plus one eligible audio clip, in either selection order.
  It resolves fresh document/selection state before dispatching the canonical
  one-entry store action and preserves both selections plus their primary.
- [x] Keep Link visible while unavailable and connect it to actionable status
  copy for zero/one/oversized, stale/deleted, same-kind, locked, and
  already-linked selections. Existing Unlink, badges, partner highlighting,
  different assets/ranges, hidden/muted tracks, and transition metadata remain
  intact.
- [x] Verification: 54/54 focused transport/timeline/Inspector tests;
  1,152/1,152 total tests across 64 files; production build, lint, and diff
  checks green. In-app Chromium at 1280×720 passed normal click, Ctrl-click,
  Ctrl+Enter selection, primary Inspector state, Link/Unlink, linked badges,
  unequal source/timeline offsets, status copy, and a zero-warning/error
  console gate.

The next historical bundle owns owner-relative `deltaFrames` drag previews for
manually linked clips with unequal starts and expands the unequal-edit matrix.
It is not the final boundary of the original seven-slice plan.

## Post-MVP issue #12 — Historical local Slice 4 bundle ✅ DONE (2026-07-22) Offset-safe linked previews

This historical bundle completed original Slice 4’s signed-delta rendering
core and most of original Slice 3’s unequal-edit matrix. At this historical
boundary, original Slice 4 remained partial because preview bounds still came
from the gesture owner rather than intersecting every linked member’s timeline
and source constraints. Original Slice 7 later closed that gap.

- [x] Replace the move preview's owner-absolute `startFrame` with a signed,
  integer `deltaFrames`. Pointer movement remains rAF-coalesced transport state
  only; pointerup still dispatches one history-backed `moveClip` action.
- [x] Render every linked participant at its own committed
  `timelineRange.startFrame + deltaFrames`. Cross-track target metadata remains
  owner-only, so linked partners preserve their lane and unequal authored
  offset throughout the live gesture.
- [x] Cover unequal manual-link move, trim, ripple trim, slip, slide, split,
  and ripple-delete paths with distinct source ranges, durations, timeline
  starts, and neighboring geometry. Verify exact atomic rollback for collision,
  timeline-floor, and locked-partner rejection.
- [x] Verify linked move preview leaves the document untouched, commits exactly
  one undo entry, preserves each clip's source/duration and pair offset, and
  restores exact documents through undo and redo. An illegal linked drop snaps
  both ghosts back and creates no history.
- [x] Verification: 129/129 focused linking/transport/timeline/store tests;
  1,159/1,159 total tests across 64 files; production build, lint, and diff
  checks green.
- [x] Historical real Chrome movement/playback gate with a generated 320×180
  H.264/AAC source: unlink, trim the audio half from timeline frame 30 to
  45/source frame 15, relink, and move the video by +20. The live document
  stayed at 30/45 while ghosts rendered at 50/65; pointerup added one entry,
  undo/redo restored exact linked states, final unlink preserved 50/65, and
  playback at timeline frame 94 resolved both halves to source frame 44.
  Preview rendered the real video and warning/error logs stayed empty. This was
  not original Slice 7’s final keyboard/accessibility gate.

## Post-MVP issue #12 — Slice 5 ✅ DONE (2026-07-25) Ephemeral selection reconciliation

Original Slice 5 is complete at this boundary. Selection is still transport-
only, but it now remains structurally consistent with every committed document
snapshot instead of relying on individual edit callers to clear it.

- [x] Add an atomic, document-agnostic `reconcileClipSelection(existingIds)`
  transport action. It filters stale ids without reordering survivors, retains
  a still-valid primary, promotes the latest survivor when the primary
  disappears, clears deterministically when none survive, and returns the exact
  store reference for a valid no-op.
- [x] Add `app/selectionReconciliationController` as the only composition seam
  importing both stores. It reconciles once at initialization and synchronously
  after every document-reference change; neither store imports the other.
- [x] Remove the Delete shortcut’s bespoke “clear all selection” branch.
  Successful delete now prunes only clips that actually disappeared; rejected
  locked edits preserve the exact selection and history references.
- [x] Cover stale initialization, primary and linked-pair deletion, undo/redo,
  split undo, track removal and undo, whole-project replacement, root lifecycle
  ownership/disposal, reset, primary Inspector compatibility, Ctrl/Cmd
  interaction, and empty-lane clearing. Undo may restore a clip in the document
  but never resurrects its prior selection.
- [x] Prove selection-only changes retain `doc`, `past`, and `future` by
  reference and produce byte-identical portable project serialization with no
  `selectedClip*` field.
- [x] Verification: 82/82 focused tests across six files; 1,173/1,173 total
  tests across 65 files; production build, lint, and diff checks green.
- [x] In-app Chromium gate: selected Delta → Ctrl-selected Alpha → Ctrl-selected
  Bravo (primary); Delete removed only Bravo and promoted Alpha; undo restored
  Bravo unselected. Deleting Alpha’s track promoted Delta; undo restored the
  track with Alpha/Bravo still unselected. Inspector followed every primary,
  the editor had no blocking overlay, and warning/error logs stayed empty.

## Post-MVP issue #12 — Slice 6 ✅ DONE (2026-07-25) Accessible Link/Unlink acceptance

Original Slice 6 is complete at this boundary. Manual linking is now
keyboard-discoverable without moving document validation, selection, or
history ownership into React.

- [x] Keep every clip root focusable with a stable accessible name,
  `aria-pressed`, Enter/Space activation, and focus styling visually distinct
  from selected and primary-selected state. Forced-colors mode receives a
  system-color outline fallback instead of relying on box shadow alone.
- [x] Keep one shared Inspector command group in every primary/empty branch.
  Unavailable Link/Unlink remains in the tab order with `aria-disabled` and an
  adjacent visible reason connected by `aria-describedby`; activation
  revalidates the exact rendered clip ids/link group against fresh state, so a
  stale, changed, locked, or rejected target dispatches no unintended action
  and announces an actionable reason.
- [x] Link exactly one eligible video + audio pair in either order through the
  canonical one-entry store action while retaining selection order and
  primary. Preserve keyboard-operable Unlink, both linked badges, live partner
  highlighting, and move focus to the stable Link command after Unlink removes
  its own button.
- [x] Verification: 100/100 focused tests across five files; 1,184/1,184 total
  tests across 65 files; production build, lint, and diff checks green.
  Targeted in-app Chromium passed pointer + Ctrl+Enter pair selection, two
  pressed clips with one primary and distinct focus/selection rings, Link,
  both badges, retained selection, Unlink focus handoff, a locked-partner
  described reason, suppressed unavailable activation, and a zero
  warning/error console gate. RTL `user-event` covers native Enter/Space Link
  and Unlink activation end-to-end.

## Post-MVP issue #12 — Slice 7 ✅ DONE (2026-07-25) Final integrity and closeout

Original Slice 7 completes the cross-slice integrity, regression, and real-
browser gate. All seven slices in the authoritative Issue #12 blueprint now
have concrete code, test, and browser evidence.

- [x] Repair track-removal integrity in the pure domain operation. Removing an
  unlocked track now dissolves the group id on each lone unlocked survivor in
  the same document/history mutation. If a required survivor is on a locked
  track, the whole removal rejects with the original document reference, so no
  orphan or partial history state can be created. Exact undo/redo is covered.
- [x] Add pure `ui/timeline/gestureBounds.ts` interval intersection for move,
  trim, ripple trim, slip, and slide. Every gesture derives its legal signed
  delta from the owner and linked partner using one fresh pointerdown document
  and media snapshot, including connected asset bounds and durable offline
  descriptor bounds. Timeline, source, duration, and headroom limits are
  group-wide; collision rejection and snap-back remain canonical at commit.
- [x] Retain the exact pointerdown document reference and link-group identity
  for the whole gesture. If committed document state changes before pointerup,
  clear the transport preview and dispatch no stale geometry action. This
  preserves the UI-reads-state-only boundary while keeping one successful
  release equal to one history entry.
- [x] Verification: 359/359 focused Issue #12 tests across 12 files and
  1,209/1,209 total tests across 66 files. Production build passed with only
  the known three chunks above 500 kB; lint passed;
  `npm audit --omit=dev` reported 0 vulnerabilities; diff checking was clean
  apart from informational line-ending notices.
- [x] Real Chrome 150 at 1600×1000 passed through the supported file-input
  fallback with an actual 2.0 s 320×180 30 fps H.264 + mono 48 kHz AAC
  fixture. Import reached Ready and dropped the linked pair. Deleting V1
  dissolved A1’s lone link; Ctrl+Z restored V1 and the exact pair. After
  Unlink, an audio head trim changed the timeline/source/duration tuple from
  20/0/60 to 30/10/50 while V1 stayed 20/0/60, then keyboard pair selection
  and Link restored the unequal-offset pair.
- [x] During a live +15 move, the ghosts rendered at 35/45 while the document
  remained 20/30 and history remained at 4. Release added exactly one entry at
  35/45 while retaining offset 10; Ctrl+Z restored 20/30 and Ctrl+Y restored
  35/45. Keyboard activation performed the final Unlink. Playback at timeline
  frame 62 mapped both clips to source frame 27, rendered the real video, and
  reported 35 live audio nodes with RMS 0.0898. Chrome recorded 0 warnings and
  0 errors.

All 30 GitHub #12 implementation-checklist items now have matching code, test,
and browser evidence for the normal-merge closeout.

## Post-MVP issue #18 — Original nine-slice roadmap (authoritative correction, 2026-07-31)

The original researched nine-slice roadmap is authoritative. The five dated
sections below are historical local delivery bundles; their shorter labels did
not renumber or remove the original Slices 7–9. Issue #18 was reopened after a
premature closeout and remains open.

| Original slice | Status | Delivery mapping |
|---|---|---|
| 1 — image source foundation | ✅ complete | Historical local Slice 1 bundle. |
| 2 — still schema and migration | ✅ complete | Historical local Slice 3 bundle plus the correction that makes `Clip.sourceMode` required and migrates nested timeline schema 1→2 while the outer project format remains v3. |
| 3 — editing semantics | ✅ complete | Historical local Slice 3 bundle. |
| 4 — import, persisted default duration, and reconnect | ✅ complete | Historical local Slice 2 bundle plus the correction that persists **Default still-image duration** and restores each saved image duration during reconnect. |
| 5 — Media Pool and timeline visuals | ✅ complete | Historical local Slices 2–3. |
| 6 — worker preview | ✅ complete | Historical local Slice 4 bundle plus referenced-only image opening, discriminated video/image entries, one resident still per asset, exact loan/setup identities, a 256 MiB aggregate reserved-and-retained worker-realm budget, bounded close-ack timeout, and repeated seek/play/reopen coverage. |
| 7 — correct transition compositor | ✅ complete | The selector exposes intrinsic opacity and transition weights separately. The shared preview/export renderer builds each transformed leg normally, adds the finished premultiplied legs with `(1-p)` / `p` inside one isolated group, and source-overs that group onto lower tracks exactly once. |
| 8 — export | ✅ complete | Historical local Slice 5 supplies the implementation; original Slice 8 adds typed-error preservation, complete still/video adapter and lifecycle coverage, and real Chromium encode → reopen gates against both the exact pre-encode canvas and the production worker-rendered Preview. |
| 9 — acceptance and closeout | ⏳ open | Run the complete Issue #18 workflow/input matrix and update final evidence only after it passes. |

The corrective source suite passes 1,385/1,385 tests across 74 files. The
deterministic 15-file fixture replay, production build, lint,
`npm audit --omit=dev`,
and diff checks pass. Original Slice 8 additionally passed a real 60-frame AVC
encode → exact-buffer reopen → full decode, with 30 pre-encode/output patches
and a second 30-patch comparison between the production worker-rendered Preview
and reopened output across ordinary and crossfade frames. This is not the original
Slice 9 acceptance/closeout gate; Issue #18 remains open.

## Post-MVP issue #18 — Historical local Slice 1 bundle ✅ DONE (2026-07-26) Static-image source foundation

At this slice boundary, Issue #18 remains open. This pipeline-only slice
establishes content-based inspection and first-frame decode ownership for
raster-image sources; it does not make images importable or user-visible yet.

- [x] Detect PNG, JPEG, WebP, and AVIF from a bounded source prefix instead of
  trusting filenames or declared MIME types. Reject GIF, SVG, generic ISO BMFF,
  unknown, malformed, and truncated input with stable typed failures; supported
  bytes remain supported when their extension or declared MIME is spoofed.
- [x] Publish frozen source-size, candidate-dimension, decoded-allocation, and
  animation facts. Enforce immutable 256 MiB encoded, 4 MiB header-scan,
  16,384 px edge, 67,108,864-pixel, and 256 MiB decoded-allocation ceilings
  before browser decode. Validate PNG/APNG and WebP outer/first-frame geometry
  so a small canvas cannot conceal a hostile nested frame.
- [x] Keep inspection and decode atomic for the exact immutable Blob. Relabel
  the Blob with the sniffed MIME, use orientation-aware `createImageBitmap` as
  the primary path, and transfer frame zero directly from `ImageDecoder` when
  the Blob path is unavailable. The fallback retains WebCodecs rotation/flip,
  validates coded, visible, display, and native allocation bounds, and never
  holds a second full-size bitmap beside the frame.
- [x] Treat every AVIF `ispe` as a conservative predecode budget candidate,
  not proof of the browser-selected primary item. Safe browser-decoded geometry
  is authoritative after independent bounds checks, so valid clean-aperture,
  rotation, auxiliary, derived-item, and selected-track behavior is not falsely
  rejected.
  Residual boundary: `ispe` cannot absolutely cap native AV1 decoder work;
  sequence-header maximum frame dimensions and intermediate images may exceed
  item extents before the browser returns a source we can inspect. The 256 MiB
  ceiling therefore bounds WebCut's estimates and accepted returned allocation,
  not every transient browser-decoder allocation. Future hardening should parse
  sequence-header limits where practical and stress hostile inputs in an
  isolated decoder context.
- [x] Preserve first-frame-only animation disclosure without conflating encoded
  PNG/WebP loop fields with WebCodecs repetition semantics. Abort wins promptly;
  late bitmap/frame completions, decoder completion rejection, failures, and
  successful caller ownership all have exact cleanup coverage.
- [x] Add `npm run qa:issue18:fixtures` for a deterministic 15-file matrix
  covering ordinary PNG/JPEG/WebP/AVIF, alpha, EXIF orientation, APNG/animated
  WebP/AVIF sequence headers, spoofed MIME/extension, corrupt/truncated input,
  oversized metadata, and explicitly unsupported SVG/GIF.
- [x] Verification: 60/60 focused tests across two files; 1,269/1,269 total
  tests across 68 files; fixture generation and validate-only replay,
  production build, lint, audit, and diff checks green.
- [x] Real Chrome 150 through local Vite passed 41 browser facts across all four
  formats, alpha, actual EXIF-oriented pixels, APNG/WebP first-frame labels,
  canonical MIME, typed hostile failures, both browser decode paths, and caller
  close behavior. The console recorded 0 warnings and 0 errors.

At the Slice 1 boundary, later slices still owned the Media Pool/import
controller, durable domain/state representation, timeline duration and editing
semantics, preview/compositor integration, export behavior, and user-visible
error/retry/accessibility surfaces. Images were therefore not importable,
previewable, placeable, or exportable at that boundary.

## Post-MVP issue #18 — Historical local Slice 2 bundle ✅ DONE (2026-07-28) Still-image import and durable source records

Issue #18 remains open. This slice makes verified PNG, JPEG, WebP, and AVIF
sources importable, durable, reconnectable, and visible in the Media Pool. It
deliberately stops before timeline authoring: a still needs explicit clip/source
semantics rather than inheriting the existing timed-video range contract.

- [x] Route imports, Resume, manual Relink, and folder Relink through one shared
  inspection boundary. It byte-inspects before the timed-media probe, never
  lets recognized malformed/unsupported images fall through as video, and
  performs a real browser decode before creating an object URL or durable
  `MediaAsset`.
- [x] Represent every accepted still as an image asset with orientation-aware
  dimensions, no audio/native frame rate/decoder config, and an exact canonical
  then-current five-second default expressed as integer microseconds and
  project-rate frame math. The later original Slice 4 correction makes that
  default configurable and persisted, and makes reconnection restore the exact
  saved dimensions and duration.
- [x] Accept PNG, JPEG, WebP, and AVIF in native pickers, fallback inputs, and
  bounded folder scans. Import up to 100 selected files through one sequential
  queue so only one decode owns peak memory at a time; cancellation stops the
  remaining queue and competing import/retry actions cannot interleave.
- [x] Generate exactly one bounded Media Pool tile per image: at most 320×180,
  encoded as PNG at most 1 MiB, rendered with contained aspect ratio, and owned by
  the existing media-store URL lifecycle. Source, bitmap/frame, canvas, abort,
  late completion, replacement, and removal paths retain exact cleanup.
- [x] Show dimensions, the imported duration, content-derived format, decode
  path, and an explicit “First frame only” label for animated inputs. Surface
  actionable Unsupported/Error/Retry states for SVG, GIF, corrupt, oversized,
  and browser-undecodable sources. Keep image rows non-draggable in both the
  rendered affordance and the live drag-start guard until Slice 3 establishes
  correct still-clip semantics.
- [x] Verification: 212/212 focused tests across 12 files; 1,291/1,291 total
  tests across 71 files; deterministic 15-file fixture replay, production
  build, lint, audit, and diff checks green.
- [x] In-app Chrome 150 imported PNG, EXIF-oriented JPEG, animated WebP, and
  AVIF in one real multi-file selection. All four reached Ready with correct
  dimensions, the then-default five-second metadata, bounded ready thumbnails, and
  `draggable=false`; the animated WebP disclosed first-frame-only behavior.
  Corrupt PNG stayed Error through Retry, while SVG and GIF stayed Unsupported
  with actionable explanations. The Media Pool remained usable and the console
  recorded 0 warnings and 0 errors.

## Post-MVP issue #18 — Historical local Slice 3 bundle ✅ DONE (2026-07-28) Still-clip timeline semantics

Issue #18 remains open. This slice makes verified image sources placeable and
fully editable on video lanes with one explicit still-source contract. Preview
and export decoding remain later slices, so timeline authoring is complete
without claiming that the viewer or exported file can render a still yet.

- [x] Add explicit `timed` versus `still` clip source modes. Every still keeps
  the canonical half-open source range `[0, 1)` while its timeline range owns
  the independent visible duration. New image clips start at the existing exact
  configured import default; timed video/audio/text behavior remains unchanged.
- [x] Keep the outer portable project format at version 3 and advance the
  nested timeline schema from 1 to 2. Current snapshots require an explicit
  valid source mode and reject inconsistent image/timed/source-range
  combinations. Bounded nested-schema migration resolves image-media clips to
  `still` plus `[0, 1)` and preserves timed media/text clips as `timed`.
- [x] Map every active still frame, including both sides of a crossfade, to
  source frame 0. Move, start/end trim, ripple trim, Razor, and Slide may change
  timeline geometry but preserve the canonical still source range. Slip is an
  intentional same-reference no-op for a still and for any linked group that
  contains one; no preview, warning, history entry, or redo loss is produced.
- [x] Enable Ready image rows at both drag guards and create image drops through
  the normal one-entry `clipFromAsset`/`insertClip` path. Still-aware gesture
  bounds expose unlimited trim headroom and zero Slip range while retaining
  locked-track and fresh-document protections.
- [x] Render one contained image tile repeatedly across the complete still
  timeline interval, including split and extended clips. Expose “still image
  clip” in the accessible name and explain directly that Slip is unavailable.
- [x] Verification: 352/352 focused tests across 10 domain/state/UI files;
  1,311/1,311 total tests across 71 files; deterministic 15-file fixture replay,
  production build, lint, audit, and diff checks green.
- [x] In-app Chrome 150 imported a real 2×2 PNG, exposed a draggable Ready row,
  and rendered a five-second `data-source-mode="still"` clip with one repeated
  tile. Razor produced exact adjacent 75/75-frame still halves; a 15-frame
  crossfade attached between them; Slip preserved identical rendered clip
  markup; and keyboard undo/redo restored both Razor and crossfade states
  exactly. The console recorded 0 warnings and 0 errors. Browser automation
  used removed QA-only chooser/insertion adapters because its native File
  System Access and HTML drag bridges could not carry the local fixture; the
  real import, clip factory, store action, edit, transition, and render paths
  were exercised, while the actual data-transfer boundary is covered by the
  focused UI component tests.

## Post-MVP issue #18 — Historical local Slice 4 bundle ✅ DONE (2026-07-28) Worker-owned still preview

Issue #18 remains open. This slice makes verified image sources render through
the existing shared preview/compositor path while preserving one explicit
live-resource owner. Export integration remains a later slice and is not
claimed here.

- [x] Add an `openImage` render-worker message that carries one Blob per asset.
  The bridge records a static source kind, maps every still entry to source
  frame/timestamp zero, and waits for a `closed` cleanup acknowledgment before
  terminating the worker.
- [x] Decode and retain exactly one worker-owned `ImageBitmap` or `VideoFrame`
  for each open image asset. Share that same decoded source across ordinary
  clips, stacked layers, scrub/play requests, and both sides of a transition
  without copying it into React/Zustand state.
- [x] Give each retained source an explicit in-flight loan count. Replacement
  and release remove the source from future requests immediately, then close it
  exactly once after the final active composite settles.
- [x] Guard concurrent opens with per-asset revisions and abort signals.
  Superseded opens, release-during-decode, close-during-decode, late success,
  decode/resource-limit failure, replacement, and worker shutdown cannot
  install stale state or leak/double-close a decoded source.
- [x] Extend the shared compositor's frame source to accept either
  `ImageBitmap` or Canvas-drawable `VideoFrame`, using presentation dimensions
  for the latter. Generalize Preview/controller offline language from video to
  visual sources while preserving typed runtime-failure identity.
- [x] Verification: 128/128 focused tests across the render worker, bridge,
  preview controller/UI, and compositor files; 1,327/1,327 total tests across
  71 files; deterministic 15-file fixture replay, production build, lint,
  audit, and diff checks green.
- [x] In-app Chromium imported and previewed a real 280×175 JPEG, retained it
  through a complete five-second playback, and applied live position, scale,
  rotation, and opacity. Razor produced two still clips; a 15-frame same-asset
  crossfade played with transformed pixels intact. The console recorded 0
  warnings and 0 errors. Browser automation used removed QA-only
  chooser/insertion adapters because its native File System Access and HTML
  drag bridges could not carry the local fixture; the production import, clip
  factory, worker decode, preview, transform, transition, and playback paths
  ran unchanged.

## Post-MVP issue #18 — Historical local Slice 5 bundle ✅ DONE (2026-07-31) Static-image export

This bundle provides the original Slice 8 export implementation. Original
Slice 7 later replaced the transition compositor and passed its pixel matrix;
the original Slice 8 section below records the completed decode-once/frame-zero,
cleanup, exact-output reopen, and sampled pre-encode/output acceptance gate.

- [x] Extend each immutable export asset resolution with its captured media
  kind. The visual export adapter branches only after resolving that exact
  Blob/kind snapshot: timed video keeps its existing Mediabunny
  Input/CanvasSink path, images use the bounded content-inspecting
  `decodeStaticImage` boundary, and non-visual audio fails closed if it reaches
  the visual path.
- [x] Decode each image asset exactly once for the whole export. Every
  frame-local lease borrows the same retained frame-zero `ImageBitmap` or
  `VideoFrame`; lease cleanup never closes it. The export media source is the
  sole owner and closes it exactly once on success, failure, cancellation, or
  repeated shutdown.
- [x] Abort in-flight still decoding when export ownership closes. A successful
  decode that races shutdown closes before it can publish, while
  resource-limit failures retain typed `surface: export`, `trackKind: null`
  identity for compatibility reporting.
- [x] Keep transforms, alpha, opacity, stacking, and image↔video transition
  selection on the existing shared `compositeFrame` /
  `visibleVideoLayersAtFrame` path. Export adds no parallel visual math.
- [x] Verification: 54/54 focused export adapter/controller tests and
  1,331/1,331 total tests across 71 files; deterministic 15-file fixture replay,
  production build, lint, audit, and diff checks green.
- [x] In-app Chromium imported a real alpha PNG plus a generated H.264 MP4,
  placed both on one video lane, exercised a still end-trim gesture, applied
  position/scale/rotation/opacity, scrubbed and played a 15-frame image→video
  crossfade, then exported and downloaded the result. `ffprobe` reported H.264,
  1280×720, 30/1 fps, exactly 210 frames and 7.000 seconds. Extracted start,
  transition, and video frames preserved the expected transform, opacity,
  layering, and blend; re-importing that exact download reported Ready at
  1280×720 / 00:00:07:00. There were no export, decoder, render-worker, or
  browser errors; the sole warning was the expected domain rejection from an
  intentionally attempted overlapping clip move. Removed QA-only
  chooser/insertion adapters were needed because browser automation cannot
  carry local files through the File System Access or HTML drag bridges.

## Post-MVP issue #18 — Original Slice 6 ✅ DONE (2026-07-31) Worker-preview correction

The earlier publication section was incorrectly labeled “Slice 6” and closed
Issue #18 before the original nine-slice roadmap was complete. The issue was
reopened, the remote checklist was corrected, and this section now records the
actual original Slice 6 boundary.

- [x] Open still-image worker sources only while the active document references
  them, while retaining the existing video warm-open behavior.
- [x] Use discriminated video/image protocol entries. Still entries always
  request source frame and timestamp zero, and one resident decoded still is
  shared per asset through an exact in-flight loan ledger.
- [x] Enforce one aggregate 256 MiB reserved-and-retained still budget for the
  render-worker realm. Pending decodes reserve before browser allocation,
  fallback decoding reserves a conservative 8 bytes/pixel before reconciling
  to the exact returned lease, and retired sources remain charged until their
  final loan closes. Over-budget opens fail with typed resource-limit identity.
- [x] Wait for the worker's `closed` acknowledgement, with a bounded timeout
  fallback that terminates exactly once. Replacement, release, cancellation,
  active-loan, and shutdown races retain exact close ownership.
- [x] Give every configure/video-open/image-open operation a monotonic
  `setupId`. ACKs and setup errors settle only the exact `(assetId, setupId)`
  waiter, so a delayed reply from a released source is inert after cross-kind
  reopen. Decoded still loans likewise carry exact lease identity, including
  late browser completions after cancellation.
- [x] Cover repeated still seeks/playback and the ownership/budget races in the
  corrective suite. The source suite passes 1,369/1,369 tests across 73 files;
  deterministic 15-file fixture replay, production build, lint, dependency
  audit, and diff checks pass.
- [x] In-app Chromium imported a real 720×602 PNG using the persisted 2.5-second
  default, placed the resulting 75-frame still, rendered frame zero through
  repeated stepping and full playback, released it on clip deletion, and
  reopened/rendered it through undo. Browser diagnostics recorded 0 warnings
  and 0 errors; all QA-only chooser/insertion adapters were removed afterward.

## Post-MVP issue #18 — Original Slice 7 ✅ DONE (2026-07-31) Correct transition compositor

Issue #18 remains open. This slice corrects the one shared visual compositor;
the encoded-output and final acceptance gates remain original Slices 8–9.

- [x] Remove the selector's opaque/full-frame source-over compensation. Every
  ordinary/crossfade layer now carries intrinsic clip opacity, while transition
  legs carry a separate track/transition identity and exact complementary
  weight.
- [x] Render each complete transformed leg with ordinary source-over semantics
  into a reusable transparent leg surface. Add the finished leg to a reusable
  isolated group with Canvas `lighter` and weight `(1-p)` / `p`, then source-over
  that group onto lower tracks exactly once. A missing leg keeps its absent
  weight and therefore fades through transparency instead of being
  renormalized.
- [x] Keep preview and export on the same `compositeFrame` implementation.
  Their hosts own separate lazy surface pairs, allocate nothing for ordinary
  frames, reuse the pair across transition frames, and resize it only when the
  document canvas changes.
- [x] Add exact premultiplied-RGBA goldens for opaque, transparent, intrinsic
  opacity/lower-layer, transformed overlap/uncovered, still→video,
  video→still, still→still, missing-leg, and ordinary-video cases. Worker and
  export tests cover lazy allocation, clearing, reuse, resize, and provider
  identity; the production streaming `renderFrame` adapter also crossfades a
  retained image loan with a video loan and settles both ownership paths.
- [x] Verification: 164/164 focused tests across 6 files and 1,380/1,380 total
  tests across 74 files; production build, lint, and diff checks green.
- [x] In-app Chromium ran the production `compositeFrame` through real
  `OffscreenCanvas` contexts. Opaque midpoint was `[128,0,128,255]`, transparent
  midpoint over green was `[64,127,64,255]`, transformed overlap/uncovered
  samples matched within Canvas RGBA8 rounding, and ordinary video allocated no
  transition surfaces. The editor loaded and timeline selection updated the
  Inspector; browser diagnostics recorded 0 warnings and 0 errors. The
  temporary QA exposure was removed before final verification.

## Post-MVP issue #18 — Original Slice 8 ✅ DONE (2026-07-31) Export acceptance

Issue #18 remains open. This slice closes the encoded-output boundary; original
Slice 9 still owns the complete workflow/input matrix and final closeout.

- [x] Preserve the exact visual-source rejection through export. Preview's
  shared compositor intentionally turns a failed source request into `missing`
  so a later repaint can recover; the finite export run now observes that
  failure and rethrows the original typed `MediaAssetRuntimeError` before the
  generic missing-media fallback. Lease, sink, and media-source cleanup retain
  their existing primary-error ordering.
- [x] Exercise the production visual adapter through image→video,
  video→image, and same-asset image→image transitions. Each unique still is
  decoded once, every still request remains frame zero, timed requests retain
  their canonical order, frame-local video copies close, and the retained still
  closes exactly once with the whole export source.
- [x] Join that real retained-image source to early generator return and
  encoder failure. Both paths cancel the sink, abort any late still decode, and
  close the retained source once while preserving the operational failure.
- [x] Verification: 89/89 focused tests across the export orchestrator,
  Mediabunny adapter, controller, and pixel-golden files; 1,385/1,385 total
  tests across 74 files; deterministic 15-file fixture replay, production
  build, lint, `npm audit --omit=dev`, and diff checks green.
- [x] In-app Chromium 150 exported a deterministic 320×180, 30 fps, 60-frame
  timeline through the production controller, media source, shared compositor,
  and AVC sink. The timeline combined an opaque lower still, a scaled/rotated
  semi-transparent RGBA still, a transformed video, and a seven-frame
  still→video crossfade. Mediabunny 1.50.9 reopened the exact 12,304-byte MP4,
  reported AVC, 320×180, timestamp zero, 2.000 seconds, and decoded all 60
  frames. Six 7×7 regions on each of frames 10, 27, 30, 33, and 45 compared the exact
  pre-encode production canvas with reopened output: maximum patch-mean channel delta
  1.510 (limit 12), maximum patch RGB MAE 1.000 (limit 10), and selected-region
  RMSE 0.680 (limit 15). Decoded alpha stayed `[255,255]`; transformed still,
  lower-layer, opacity, outgoing/overlap/incoming transition, and ordinary
  video probes were all non-degenerate. Browser diagnostics recorded 0
  warnings and 0 errors.
- [x] A stricter direct parity pass mounted the normal editor and waited for the
  production Preview worker to report each requested frame drawn with no missing
  clips. Same-screen captures compared that transferred Preview canvas with the
  reopened-output canvas at the same six 7×7 regions on frames 10, 27, 30, 33,
  and 45: maximum patch-mean channel delta 3.143 (limit 12), maximum patch RGB
  MAE 2.347 (limit 10), and selected-region RMSE 1.693 (limit 15). Across all
  five complete 320×180 frame pairs, RGB MAE was 1.781 and RMSE 2.934. Browser
  diagnostics again recorded 0 warnings and 0 errors; the temporary seed,
  observation hook, captures, and server logs were removed.

**Next: original Slice 9 — acceptance and closeout.** Run the complete Issue
#18 Chrome workflow and input matrix, then update the remote checklist and
close the issue only if the full gate passes.

## Test strategy per layer (unchanged from original)

domain/, state/: Vitest. pipeline/, workers/: injectable-core unit tests +
browser verification via preview tools. ui/: RTL + `<Profiler>` render-count
tests + manual QA. E2E: manual + browser-driven pointer synthesis.

## Cross-cutting reminders for new sessions

- Follow ARCHITECTURE.md dependency arrows; new store↔engine wiring goes
  through app/ composition-root controllers (previewController pattern).
- Keep dependency boundaries explicit, test logical steps as they land, and
  browser-verify anything touching pipeline/workers/gestures.
