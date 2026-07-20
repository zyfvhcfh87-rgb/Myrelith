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
- [x] Close the final ownership gaps: prompt abort for fallback checks without
  late publication, exact-once live-audio Input disposal when close overtakes
  open, and stale-bitmap closure after decoder-worker teardown.
- [x] Verification: 265/265 focused tests across 14 files; 1,094/1,094 total
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

## Test strategy per layer (unchanged from original)

domain/, state/: Vitest. pipeline/, workers/: injectable-core unit tests +
browser verification via preview tools. ui/: RTL + `<Profiler>` render-count
tests + manual QA. E2E: manual + browser-driven pointer synthesis.

## Cross-cutting reminders for new sessions

- Follow ARCHITECTURE.md dependency arrows; new store↔engine wiring goes
  through app/ composition-root controllers (previewController pattern).
- Keep dependency boundaries explicit, test logical steps as they land, and
  browser-verify anything touching pipeline/workers/gestures.
