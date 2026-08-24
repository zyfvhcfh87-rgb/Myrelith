# Myrelith — MVP Build Record (Phases 3-gate, 4, 5)

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
  exact `resource-limit` diagnostic; Myrelith neither silently omits a track nor
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
source bytes, decoder objects, or capability results in `.myrelith` projects.

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
  converter dependency, proxy bytes, Zustand state, or `.myrelith` field is
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
  are established. Public release still requires a Myrelith license,
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
premature closeout; the corrected nine-slice gate is now complete.

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
| 9 — acceptance and closeout | ✅ complete | Complete automated and Chrome workflow/input matrices passed; the mirrored-EXIF fixture gap was closed and Issue #18 has matching closeout evidence. |

The corrective source suite passes 1,385/1,385 tests across 74 files. The
deterministic 18-file fixture replay, production build, lint,
`npm audit --omit=dev`,
and diff checks pass. Original Slice 8 passed a real 60-frame AVC
encode → exact-buffer reopen → full decode, with 30 pre-encode/output patches
and a second 30-patch comparison between the production worker-rendered Preview
and reopened output across ordinary and crossfade frames. Original Slice 9 then
passed the complete acceptance matrix recorded below.

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
  ceiling therefore bounds Myrelith's estimates and accepted returned allocation,
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

## Post-MVP issue #18 — Original Slice 9 ✅ DONE (2026-07-31) Acceptance and closeout

The final gate combines the complete automated matrix with direct Chrome
workflow evidence. Timed animated-image playback remains deliberately out of
scope: accepted animated PNG/WebP/AVIF sources use their default first frame and
say **First frame only**; clock-driven animation belongs in a separate issue.

- [x] Replayed 693/693 focused tests across 25 source/import, project,
  timeline, preview, compositor, and export files. The complete suite passes
  1,385/1,385 tests across 74 files; production build, lint,
  `npm audit --omit=dev`, and both branch/current diff checks are green.
- [x] Expanded the deterministic input matrix from 15 to 18 files with
  asymmetric JPEG EXIF orientations 2, 5, and 7. Validate-only replay confirms
  all 18 exact bytes, hashes, structural facts, and expected outcomes.
- [x] In-app Chrome 150 multi-imported alpha PNG, rotated JPEG, three mirrored
  JPEG cases, animated WebP, and AVIF. Reported display sizes were 2×2, 2×4,
  4×2, 2×4, 2×4, 2×2, and 2×2 respectively; animated WebP explicitly stayed
  first-frame-only. A `.jpg` containing PNG bytes was accepted as canonical
  PNG, while corrupt PNG, a 100000×100000 header, GIF, and malformed AVIF
  remained actionable Error/Unsupported rows.
- [x] Chrome reopened a validated portable project, kept its sources offline,
  rejected a mismatched relink without mutating the asset, and accepted the
  exact original PNG on retry. The previously recorded disk-backed
  Save/Resume/Relink gate plus focused persistence/controller tests cover the
  native writable-handle path; the final run also recovered an eight-source
  project and reconnected the matching source exactly.
- [x] Chrome exercised transformed still clips, Razor, exact keyboard undo,
  play-to-end, and a 15-frame still→still crossfade. A second validated project
  reopened three still clips across two video layers with scale, rotation,
  opacity, and a crossfade; after exact relink, the production export dialog
  delivered a 320×180 H.264/AVC MP4. Original Slice 8's exact-buffer reopen and
  sampled Preview/output pixel gates remain the encoded-pixel proof for this
  same production renderer.
- [x] Browser diagnostics recorded only Vite/React development messages: zero
  warnings and zero errors. The temporary fallback-picker shim and generated
  portable QA project were removed before the final automated gates.
- [x] Late import removal, cancellation/error cleanup, frame-zero reuse,
  output reopen, sampled pixels, and drag/trim geometry remain covered at their
  deterministic controller/pipeline/UI boundaries; the final Chrome run adds
  the integrated user-visible workflow without duplicating those hooks.

All original Issue #18 implementation-checklist items now have matching code,
test, and browser evidence for the normal-merge closeout.

## Post-MVP issue #17 — Authoritative eight-slice roadmap (2026-07-31)

Issue #17 is open at baseline commit `bce210f`; `origin/master` is merge
`e311d24`. The worktree was clean after `git fetch --prune origin`. Baseline
verification passed 1,385/1,385 tests across 74 files, production build, and
lint. Issue #18 already completed the isolated transformed/transparent visual
compositor, reusable surfaces, preview/export pixel parity, exact ownership,
and Chrome acceptance. Issue #17 must preserve that implementation rather than
create a second visual path.

### Frozen design decisions

- Source availability is immutable media truth, not a derived handle count.
  Project format v4 stores separate primary-video and primary-audio timestamp
  bounds on `MediaAsset` / `PortableAssetDescriptor`. Each stream is absent,
  exact `{ firstTimestampUs, endTimestampUs }`, or explicitly `unknown`.
  First timestamps may be negative; the shared adapter excludes negative
  presentation time rather than silently assuming every track begins at zero.
- Project-v3 migration retains historical `durationMicroseconds` but marks the
  new per-stream facts unknown: one container/effective duration cannot prove
  distinct A/V extents. Ordinary clips remain playable. Extra transition
  handles fail closed until exact relink/reprobe replaces the unknown facts.
  No migration fabricates media.
- Nested timeline schema 3 adds required transition audio intent:
  `{ enabled, curve: 'linear' | 'equal-power' }`. Existing transitions migrate
  disabled/equal-power to preserve their historical audio hard cut; newly
  authored transitions default enabled/equal-power.
- One pure `SourceBoundsCatalog` projection feeds one crossfade resolver. The
  resolver owns structural validity, typed availability, maximum duration,
  the centered half-open window, exact visual source requests, unique linked
  audio partners, and the audio mix plan. Domain remains browser-free; app
  composition roots create the catalog from durable descriptors.
- For duration `D` and cut `C`, start is `C - floor(D / 2)` and end is
  `start + D`. Incoming timed media needs `floor(D / 2)` genuine pre-handle
  frames and outgoing timed media needs `ceil(D / 2)` genuine post-handle
  frames. Stills may repeat frame zero by definition. Visual availability and
  audio availability stay independent.
- Structural stale/duplicate/overlapping transitions retain the existing
  deterministic hard-cut fallback. Authoring rejects an unavailable requested
  duration against a fresh catalog and reports the maximum. A later media or
  geometry change may retain the authored record while making it unavailable;
  the shared typed status prevents accidental rendering and keeps Remove/undo
  reachable instead of silently deleting user intent.
- The video composition contract becomes an explicit union of ordinary items
  and grouped `CrossfadePlan` items. Preview and export call the same pure
  planner. Worker messages carry the exact planned items/source requests so a
  worker never reconstructs a group by adjacency convention.
- The Issue #18 compositor remains unchanged in meaning: complete legs render
  into a bounded reusable transparent surface, weighted premultiplied pixels
  add in one isolated group, and that group source-overs lower tracks once.
  Canvas contexts explicitly request sRGB. Preview may soften a transient
  missing decode to weighted transparency and retry; finite export preserves
  the exact source error and fails.
- Audio uses the existing absolute BigInt frame-to-sample boundary. For sample
  `s` in `[S0, S1)`, `p = (s - S0) / (S1 - S0)`. Linear gains are
  `(1-p, p)`; equal-power gains are `(cos(pi*p/2), sin(pi*p/2))`. Gain is then
  multiplied by clip volume and track audibility, contributors are summed, and
  the result is clamped once. Block-local phase and frozen/zero-filled handles
  are forbidden.
- Live linear fades use exact AudioParam ramps. Equal-power uses a bounded,
  deterministic value curve generated by the shared evaluator and verified
  with an error tolerance. Transition/link/curve/bounds/volume/mute/solo facts
  enter the playback fingerprint; existing generation-safe teardown remains
  authoritative.
- Effects are schema-only today. Issue #17 keeps both legs on the ordinary
  complete-leg rendering seam so future effects are inherited, but does not
  claim or implement a general effects engine.

### Ordered implementation and gates

1. **Persistence** — add per-stream bounds throughout probing, runtime assets,
   portable descriptors, save/resume/relink, project-v4 migration, timeline
   schema 3, and transition defaults. Gate: exact round trips; v1/v2/v3
   migrations; hostile fields; unknown/offline/relink; non-zero/negative starts;
   different A/V ends; focused tests, build, and lint.
2. **Pure planner** — add grouped plans, exact handle math, maximum duration,
   typed diagnostics, deterministic malformed fallback, and unique linked-audio
   resolution. Gate: one-frame/odd/even, trims/splits/slips, stills, same and
   different assets/ranges, insufficient bounds, ambiguous/misaligned partners,
   unsafe integers, same-reference authoring rejection, tests/build/lint.
3. **Visual integration** — pass explicit planned groups through bridge,
   protocol, worker, preview, and export; remove timed endpoint clamping;
   explicitly request/test sRGB while retaining Issue #18 surfaces. Gate: the
   complete existing pixel/ownership matrix plus genuine requests, same-asset
   lanes, preview/export parity, build, and lint.
4. **State and UI** — add one atomic transition patch for duration/audio intent
   and one history entry. Expose “Crossfade duration in frames”, “Crossfade
   linked audio”, “Audio crossfade curve”, and an accessible live availability/
   maximum-duration explanation. Gate: Add/Apply/Remove, locking, keyboard,
   stale popovers, exact undo/redo, RTL, build/lint, and Chromium.
5. **Shared audio plan and playback** — create virtual overlapping audio legs,
   pure envelopes, fingerprinting, GainNode automation, late-buffer phase, and
   generation-safe edit/link/pause/seek cleanup. Gate: curve/volume/mute/solo,
   NTSC, unavailable fallback, bounded curves, no stale nodes/cursors, focused
   tests, build/lint, and real Chrome tones.
6. **Export parity** — mix both virtual legs, crop decoded ranges exactly,
   apply absolute per-sample envelopes before final sum/clamp, and retain exact
   output duration and cleanup. Gate: one-frame/odd/even/NTSC, signed phase,
   multiple 1024-sample blocks, same-asset seeks, short-source failure,
   reopened output, focused/full tests, build, and lint.
7. **Acceptance and closeout** — run transformed transparent footage over a
   visible lower track with distinct linked tones; cover availability, both
   curves, edits, seek/pause, export/reopen, cleanup, and console diagnostics.
   Update README, ARCHITECTURE, PLAN, and HANDOFF; run tests/build/lint/audit/
   diff checks; review, normally merge, retain `codex/feature`, and close only
   Issue #17 after every claimed item has concrete evidence.

Each slice is documented with exact evidence before the next slice begins and
is committed through a message file with Aryel as the sole author. A failing
gate stops progression; later checkboxes are never completed early.

### Slice 1 evidence — persistence and exact stream bounds (2026-07-31)

- [x] Project format 4 now requires separate video/audio `sourceBounds` on
  runtime assets and portable descriptors. Exact bounds retain signed integer
  microsecond starts and end timestamps; `null` means absent and `unknown`
  means a legacy file proves presence without proving handles.
- [x] Mediabunny probing records `getFirstTimestamp()` and `computeDuration()`
  independently for the primary video and audio streams. Still images carry no
  timed bounds; partial-track projection removes the omitted stream's bounds.
- [x] Timeline schema 3 requires transition audio intent. Existing schema-2
  transitions migrate disabled/equal-power; new crossfades default to
  enabled/equal-power. Project-v1/v2/v3 assets migrate to conservative unknown
  bounds and acquire exact facts only after a compatible analyzed relink.
- [x] Save/load validation rejects unknown fields, contradictory stream
  presence, empty/reversed timestamp extents, and end timestamps beyond the
  durable asset endpoint. Snapshot cloning isolates nested bounds and audio
  settings. Exact descriptor facts must match; legacy unknown facts may be
  upgraded atomically without weakening later relinks.
- [x] Focused gate: 249/249 tests across project files, media probing,
  compatibility projection, media state/relink, project resume, and transition
  authoring. Added direct coverage for negative/non-zero starts, unequal A/V
  ends, conservative migration, hostile bounds, and unknown-to-exact relink.
- [x] Full gate: 1,389/1,389 tests across 74 files; production build passed
  with only the pre-existing chunk-size advisory; oxlint passed. This slice has
  no user-visible interaction surface, so browser acceptance remains assigned
  to the later visual/UI/audio slices.

### Slice 2 evidence — pure grouped crossfade planner (2026-07-31)

- [x] `crossfadePlan.ts` is the browser-free authority for seam validity,
  centered odd/even windows, exact real-handle capacity, maximum duration,
  per-frame grouped requests, and typed invalid/unavailable diagnostics. The
  existing selector now delegates geometry to this authority instead of
  maintaining a second implementation.
- [x] Timed legs derive availability from persisted per-stream timestamp
  bounds using exact BigInt ceiling conversion at document rate. Requests may
  extend beyond the edited source range only when genuine decoded source
  frames exist; still legs alone repeat source frame zero. Rejected authoring
  and duration proposals retain the identical document reference.
- [x] Linked audio resolution requires exactly one distinct audio partner per
  visual leg at the same cut. Missing, ambiguous, misaligned, absent, unknown,
  unsafe, or insufficient audio handles produce an independent typed audio
  fallback while leaving a valid visual plan available.
- [x] Focused gate: 185/185 tests across planner, selector, operation, and time
  suites. Coverage includes one-frame and odd/even groups, negative and NTSC
  timestamp bounds, slips/trims, stills, same-asset ranges, insufficient
  handles, malformed/overlapping seams, linked-audio ambiguity/alignment, and
  visual-versus-audio capacity independence.
- [x] Full gate: 1,410/1,410 tests across 75 files; production build passed
  with only the pre-existing chunk-size advisory; oxlint passed. This pure
  domain slice changes no rendered behavior, so its browser gate is not
  applicable. Slice 3 owns worker/preview/export visual consumption and removal
  of the legacy timed-frame clamping path.

### Slice 3 evidence — exact visual integration (2026-07-31)

- [x] `videoCompositionPlan.ts` now emits an explicit paint-ordered union of
  ordinary clip requests and grouped crossfade requests. Preview and export
  build from the same immutable document/source-bounds facts; unavailable or
  malformed transitions fall back deterministically to the ordinary hard cut.
- [x] The grouped plan crosses the render bridge and worker protocol unchanged.
  The worker queues the plan's exact clip-keyed requests and never reconstructs
  transition groups from adjacency. Same-asset legs stay distinct while the
  compositor still fetches each requested `(assetId, sourceFrame)` only once.
- [x] Preview, worker, and export now use genuine handle frames from the shared
  planner. The legacy timed endpoint-clamping selector path was removed. Still
  legs alone repeat frame zero; invisible legs require no decode and cannot
  turn an otherwise valid group into a missing-source failure.
- [x] Issue #18's complete-leg isolation remains intact: transforms and clip
  opacity render into each leg surface, premultiplied weighted legs combine
  with `lighter`, and the group is composited over lower tracks once. Visible,
  scratch, orientation, transition, and export 2D contexts explicitly request
  sRGB and have direct assertions.
- [x] Focused gate: 289/289 tests across planner, selectors, compositor pixels,
  bridge/protocol, worker, preview, export source, and export controller. Added
  coverage proves explicit carried groups, real handles, transformed and
  transparent legs over lower layers, same-asset clip lanes, zero-weight legs,
  exact preview/export request parity, and sRGB context options.
- [x] Full gate: 1,417/1,417 tests across 76 files; production build passed
  with only the pre-existing chunk-size advisory; oxlint and `git diff --check`
  passed. Chromium smoke acceptance created a project, reached the editor,
  rendered one preview canvas, exercised transport controls, found no blocking
  dialog/overlay, and recorded no browser console warnings or errors.

### Slice 4 evidence — atomic state and accessible authoring UI (2026-07-31)

- [x] Crossfade creation and editing now accept one typed settings payload for
  duration plus linked-audio intent. Exact source-bound evaluation happens
  before one immutable document-store commit, so Apply creates one history
  entry and rejected or unchanged proposals preserve the identical document
  reference and history.
- [x] The seam popover exposes the exact accessible controls “Crossfade
  duration in frames”, “Crossfade linked audio”, and “Audio crossfade curve”.
  Its live status reports the exact visual maximum separately from linked-audio
  availability, allowing a valid visual crossfade and durable audio intent to
  survive an unavailable linked-audio fallback.
- [x] Add, Apply, Remove, lock, Escape, outside-click, stale-transition, and
  focus-restoration behavior remain explicit. The editor reads durable media
  descriptors for real handle limits, closes when its transition identity
  disappears or the track locks, and disables the curve selector while linked
  audio is off.
- [x] Focused gate: 252/252 tests across planner, operations, document store,
  timeline transitions, timeline, clip drag, and edit tools. Coverage proves
  real-handle maxima, linked-pair availability, one-entry atomic Apply,
  exact undo/redo, no-op history stability, locking, stale popovers, keyboard
  closure, removal, and adjacent-seam behavior.
- [x] Full gate: 1,422/1,422 tests across 76 files; production build passed
  with only the pre-existing chunk-size advisory; oxlint and `git diff --check`
  passed. In-app Chromium exercised the production Timeline and stores with
  touching real-handle stills: authored and reopened 21-frame settings, applied
  31-frame equal-power settings, closed with Escape, verified lock-disable and
  removal flows, found no clipping or blocking overlay, and recorded zero
  console warnings or errors.

### Slice 5 evidence — shared audio planning and live playback (2026-07-31)

- [x] `audioMixPlan.ts` now builds the browser-free audible contributor set
  shared with the next export slice. Valid linked crossfades extend each
  existing audio clip into genuine pre/post source handles without mutating the
  document; disabled, invalid, unavailable, or conflicting audio plans retain
  the historical ordinary hard cut.
- [x] Envelopes carry absolute transition windows and use one pure bounded gain
  evaluator. Linear legs schedule exact `AudioParam` start/end ramps;
  equal-power legs schedule deterministic 129-point curves whose interpolation
  error is directly bounded in tests. Clip volume and canonical mute/solo
  selection are applied once.
- [x] Rolling playback splits decoded buffers only at envelope boundaries and
  keeps phase relative to the complete crossfade window. A late buffer advances
  timeline phase with its trimmed source offset instead of restarting the fade.
  Virtual legs retain independent cursors even for shared assets and preserve
  the existing bounded lookahead and cleanup ownership.
- [x] Playback fingerprints now include transition, link, curve, source-bound,
  volume, mute, and solo facts. Durable descriptor changes and document edits
  generation-safely abort/stop and re-prime from the current frame; pause,
  scrub, step, media replacement, and project disposal keep the prior teardown
  contract.
- [x] Focused gate: 92/92 tests across the audio plan, crossfade planner,
  playback scheduler/output, Mediabunny source, and transport controller.
  Coverage includes odd/even virtual ranges, unavailable fallback, both curves,
  volume/mute/solo, NTSC time mapping, late-buffer phase, fingerprint changes,
  output-node cleanup, source reuse, and stale-generation suppression.
- [x] Full gate: 1,432/1,432 tests across 77 files; production build passed
  with only the pre-existing chunk-size advisory; oxlint and `git diff --check`
  passed. In-app Chromium decoded distinct 440 Hz left and 880 Hz right WAV
  tones through the production Mediabunny/Web Audio path from frame 45. Linear
  and equal-power runs both reported non-zero analyser RMS and live nodes during
  the exact crossfade; Stop reached zero RMS and zero nodes. Console warnings
  and errors were both empty, and the temporary tone harness was removed.

### Slice 6 evidence — exact export audio parity (2026-07-31)

- [x] Export now consumes the same immutable `audioMixPlan.ts` contributor and
  envelope facts as live playback. Virtual audio legs open their exact source
  handle ranges, overlap independently even when they share an asset, retain
  signed NTSC sample phase, and apply clip volume plus the absolute linear or
  equal-power envelope before one final channel clamp.
- [x] The controller passes one probed source-bounds catalog to both video and
  audio export paths. Crossfade handle readers are marked exact and fail with a
  typed media error on early EOF, PCM gaps/discontinuities, or an unavailable
  interpolation sample instead of freezing or zero-filling missing material.
- [x] Focused gate: 109/109 tests across shared audio planning, the block mixer,
  Mediabunny adapters, export controller, and export scheduler. Coverage spans
  one-frame and odd/even windows, multi-block absolute gains, both curves,
  per-leg volume, NTSC signed phase, same-asset readers, short-source failure,
  exact catalog identity, and a complete mocked sink encode path.
- [x] Full gate: 1,441/1,441 tests across 77 files; production build passed
  with only the pre-existing chunk-size advisory; oxlint and `git diff --check`
  passed. In-app Chromium decoded distinct 440 Hz left and 880 Hz right WAV
  tones, exported AVC/AAC MP4, reopened it, and decoded 48 kHz audio. Measured
  right/left ratios at 25/50/75% were 0.333/1.001/2.996 for linear and
  0.415/0.999/2.413 for equal power, matching the expected envelopes through
  encoding. Both outputs were exactly 2 seconds; console warnings and errors
  were empty, and the temporary export harness was removed.

### Slice 7 evidence — acceptance and closeout (2026-07-31)

- [x] README now describes exact isolated visual fades, optional linear or
  equal-power linked audio, real-handle requirements, and deterministic audio
  fallback. ARCHITECTURE records the canonical visual/audio plan boundaries,
  sRGB isolation, exact sample envelope, and ownership rules. HANDOFF carries
  the implementation map, browser numbers, and replaces the obsolete
  visual-only/frozen-endpoint guidance.
- [x] Final in-app Chromium acceptance used offset, rotated, semi-transparent
  PNG legs with intrinsic holes over a visible checkerboard plus separately
  linked 440 Hz left and 880 Hz right WAV sources. The production Preview
  showed both weighted complete transforms while the lower layer remained
  visible. The seam UI reported 60-frame visual and audio maxima; changing to
  linear and back to equal power produced exactly one history entry each.
- [x] Live linear and equal-power runs both exposed non-zero analyser RMS and
  21–22 active Web Audio nodes. A seek stopped the previous generation, an
  explicit Pause changed playing to false and cleared the audio session, and
  terminal playback also cleaned up. No stale cursor or node remained.
- [x] The normal Export dialog produced a 178,424-byte 320×180 AVC/AAC MP4.
  Mediabunny reopened it at exactly 2.000 seconds and 48 kHz; volume-weighted
  equal-power right/left ratios at 25/50/75% were 0.312/0.751/1.791 versus
  expected 0.311/0.750/1.811, within AAC/window tolerance. Browser warnings
  and errors were both zero; the temporary full-app fixture and logs were
  removed.
- [x] Final gate: 1,441/1,441 tests across 77 files, production build passed
  with only the pre-existing chunk-size advisory, oxlint passed,
  `npm audit --omit=dev` reported zero vulnerabilities, and diff checking was
  clean. GitHub publication remains a normal merge of `codex/feature`, with
  the branch retained and only Issue #17 eligible for closeout.

## Post-MVP issue #16 — capability-aware export profiles

**COMPLETE (2026-08-01); PR #29 normally merged and Issue #16 closed.**

Issue #16 started from baseline commit `fd1d50e` and owns container, codecs,
audio-off/mono/stereo layout, bitrate behavior, key-frame interval, MIME/file
metadata, and buffered-versus-direct-file output. Issue #31 owns the reviewed
creation-time dimension catalog; Issue #15 remains the authority for exact
rational FPS and audio sample rate. Those values are read from one captured
`TimelineDoc`, never duplicated in an export profile or dialog control.
Compatibility remains the safe default and
preserves the original MP4/AVC/AAC, stereo, 8 Mbps/192 kbps buffered-download
behavior.

### Frozen research and implementation boundaries

- `domain/exportProfile.ts` is the browser-free allow-list and validation
  boundary. `auto` is a selection policy, never a pipeline codec; it resolves
  visibly to one concrete validated profile. Explicit selections are rejected
  when unavailable and are never silently replaced.
- Auto's documented order is Modern (WebM/AV1/Opus), Web
  (WebM/VP9/Opus), then Compatibility (MP4/AVC/AAC). HEVC remains
  explicit-only because both MP4 containment and the exact native encoder must
  report support.
- Mediabunny output formats provide containment through
  `getSupportedVideoCodecs()` and `getSupportedAudioCodecs()`. Its
  `canEncodeVideo()` and `canEncodeAudio()` helpers are useful UI hints, but
  version 1.50.9 memoizes each exact configuration indefinitely. The
  immediately-before-start authority will therefore be a disposable real
  encode to `NullTarget` with the selected format, real dimensions/FPS, exact
  channel count/sample rate/bitrates/modes, and real source classes. It fails
  before decoder/encoder setup and never falls back to another profile. The
  captured object-URL Blob lease is acquired before the first await so editor
  changes cannot revoke the source snapshot while that probe is pending.
- The buffered path retains `BufferTarget`. Direct-file output owns its picker
  and writable stream in `app/`, acquires the handle first in the user click,
  and adapts positional `StreamTarget` writes. Mediabunny may close its wrapper;
  Myrelith alone commits the underlying file on success or aborts it on cancel or
  failure so a partial file is never reported as a successful export.
- AAC tail trimming remains isolated. Mediabunny 1.50.9 is patched locally and
  reproducibly for WebM/Opus: the encoder source records the exact post-
  transform PCM end, the Matroska muxer writes the required `CodecDelay`,
  80 ms `SeekPreRoll`, final-block `DiscardPadding`, version-4 header, and exact
  presentation duration, and the demuxer applies the same timing metadata on
  reopen. The patch is exact-version pinned, reapplied by `postinstall`, keeps
  the package's reviewed TypeScript/MPL source beside the shipped ESM edits,
  and fails closed on malformed or unrepresentable timing.

### Ordered implementation gates

1. [x] Freeze the allow-listed pure profile catalog, current safe default,
   Auto order, exact-key validation, numeric bounds, audio-off shape,
   container/codec pairing, container metadata, and destination contract.
2. [x] Add cached capability hints plus the app-controller facade and fresh
   disposable pre-start encode, including generation-safe cancellation and
   changed-support/no-silent-fallback tests.
3. [x] Generalize buffered video output across the selected container/codec,
   then add explicit audio off/mono/stereo. Keep AAC and Opus tail policy
   separate and do not enable WebM audio before its exact-duration gate passes.
4. [x] Add recommended presets, visible Auto resolution, collapsible advanced
   controls, unavailable reasons, a clearly labelled size estimate, dynamic
   extension/MIME, and browser-local validation of the last selection.
5. [x] Add transactional direct-file streaming with picker-first activation,
   positional-write backpressure, success commit, cancel/failure abort, and
   honest partial-file reporting tests.
6. [x] Evaluate optional pinned local encoder fallbacks only for a selected
   otherwise-unavailable codec. Keep them lazy, offline, and out of the initial
   editor bundle; a documented no-go is valid evidence.
7. [x] Reopen every enabled profile, verify container/codecs/dimensions/FPS/
   channels/sample rate/duration/MIME/extension, exercise native Chrome
   playback plus cancellation/write failure/retry/memory gates, then update
   README/ARCHITECTURE/HANDOFF.
8. [x] Publish by normal merge, then close only Issue #16.

### Slice 1 evidence — authoritative profile model (2026-07-31)

- [x] Four concrete recommended profiles now carry every #16-owned field while
  excluding all project-owned settings. The immutable Compatibility
  profile exactly preserves today's MP4/AVC/AAC, stereo, 8 Mbps/192 kbps,
  variable-bitrate, two-second-key-frame, buffered-download behavior.
- [x] Auto is represented separately from concrete pipeline profiles and has a
  deterministic Modern → Web → Compatibility order. HEVC cannot be selected
  by Auto. MIME type and file extension are canonical container metadata, not
  independently trusted strings.
- [x] The pure validator rejects unknown/missing fields, unsupported enum
  values, invalid container/video/audio triples, partial audio-off shapes,
  mismatched MIME/extensions, fractional or unbounded bitrates, and key-frame
  intervals outside zero through ten seconds or fractional microseconds. It
  returns a detached frozen profile; the TypeScript contract also discriminates
  audio-off from enabled mono/stereo shapes, and advanced changes pass through
  the same runtime boundary.
- [x] Focused gate: 42/42 profile tests passed. Production TypeScript/Vite
  build passed with only the pre-existing chunk-size advisory; oxlint passed.
  Full gate: 1,483/1,483 tests across 78 files passed. Production
  TypeScript/Vite build passed with only the pre-existing chunk-size advisory;
  oxlint and `git diff --check` passed. This slice is browser-free and changes
  no rendered/export behavior, so its browser gate is not applicable.

### Slice 2 evidence — capability discovery and fresh preflight (2026-07-31)

- [x] The pipeline capability core now validates the concrete profile and
  captured project settings, checks the selected Mediabunny format's exact
  container metadata and codec containment, and forwards dimensions,
  bitrates, bitrate modes, channel count, and sample rate to responsive
  `canEncode*` hints. Audio-off and projects with no audio clips do not probe
  or allocate an audio encoder.
- [x] The app facade probes only the documented catalog, exposes Auto's exact
  resolved preset, preserves explicit unsupported selections without fallback,
  and performs an authoritative fresh check immediately before export. The
  fresh adapter creates the selected output format, an actual-size sRGB canvas,
  real encoder sources, exact rational track FPS, and bounded whole document
  frames with the mixer's exact audio-block schedule through `NullTarget`,
  bypassing Mediabunny's memoized helpers.
- [x] The export controller reserves its singleton slot synchronously while
  preflight is pending. It starts one cached Blob lease before the first await,
  so removing media during the probe cannot revoke the captured source URL;
  decoders, media sources, encoder output, and the export generator remain
  delayed until support is confirmed. Cancellation aborts or safely outlives
  an abort-ignoring probe. Setup re-entry and competing write ownership close
  borrowed media exactly once while preserving the primary error.
- [x] Capability truth is additionally bounded by one shared production-sink
  matrix. A successful native HEVC, mono, or WebM probe cannot be advertised
  until that same exact path is wired into the real export sink; Slice 3 will
  widen this matrix together with the implementation and its adapter tests.
- [x] At this slice, the exact-duration policy kept Opus audio profiles visibly
  unavailable while the installed WebM muxer lacked end-padding metadata, but
  still permitted capability probing for WebM video when the concrete export
  had no audio. Slice 6 later lifted this gate after the pinned mux/demux
  contract passed.
  Disabling audio also excludes audio-only sources from offline/partial-source
  gates and Blob retention without changing the historical default path.
- [x] Focused gate: 206/206 tests across profile/selectors, capability core,
  real Mediabunny adapter, app facade, pipeline, sink, export controller, and
  dialog passed. Full gate: 1,527/1,527 tests across 81 files passed.
  Production TypeScript/Vite build passed with only the pre-existing
  chunk-size advisory; oxlint and `git diff --check` passed. Browser acceptance
  is deferred to the first rendered profile UI and enabled alternate output;
  this slice changes no visible controls and preserves the current export.

### Slice 3 evidence — generalized buffered writer (2026-07-31)

- [x] One shared output-format factory now selects Mediabunny's real
  `Mp4OutputFormat` or `WebMOutputFormat`, and both capability discovery and
  the writer consume it. The pinned-package contract is tested directly:
  Mediabunny extensions include their leading dot while Myrelith's canonical
  profile/result extensions do not, so `.mp4`/`.webm` comparisons can no
  longer make every real profile appear unavailable.
- [x] The buffered writer passes the validated AVC, HEVC, VP9, or AV1 codec,
  video/audio bitrates and modes, key-frame interval, exact rational track
  rate, and selected container without substitution. MP4/AVC and MP4/HEVC,
  plus video-only WebM/VP9 and WebM/AV1, share the existing bounded frame,
  backpressure, cancellation, and cleanup ownership.
- [x] The reviewed mixer remains one bounded stereo bus. Stereo output keeps
  exact L/R interleaving; mono output averages `(L + R) / 2` only at the
  encoder boundary, preserving duplicated mono level without clipping. AAC
  packet-duration trimming is attached only to AAC; Opus audio remained behind
  its exact end-padding policy until Slice 6. Audio-off still allocates no mixer
  or encoder.
- [x] Buffered results are now a frozen `destination: 'download'` branch with
  the exact buffer, MIME type, extension, and detached concrete profile. The
  writer derives all metadata from the validated profile. Direct-file
  selections are explicitly unavailable until their transactional writer
  lands, rather than being falsely approved and written to memory.
- [x] Focused gate: 140/140 tests across the generic pipeline, capability
  layers, pinned-format contract, real writer adapter, app controller, and
  current dialog consumer passed. Full gate: 1,540/1,540 tests across 82 files
  passed. Production TypeScript/Vite build passed with only the pre-existing
  chunk-size advisory; oxlint and `git diff --check` passed.
- [x] In-app Chromium ran the fresh probe, encoded, finalized, and reopened
  actual 64×48 one-frame outputs. Compatibility reopened as MP4/AVC at exactly
  1/30 second (718 bytes); Web reopened as WebM/VP9 at 0.033 seconds (421
  bytes); Modern reopened as WebM/AV1 at 0.033 seconds (360 bytes). MIME,
  extension, codec, and dimensions matched each selected profile. HEVC was
  rejected at its native capability hint without fallback. The gate also
  passed representative stereo and mono AAC probes. A second real 48 kHz,
  60-fps, one-frame gate proved the duration-aware preflight and actual writer
  both reject the exact 800-sample AAC tail with Chromium's same `Flushing
  error`, so the failure is caught before writer allocation instead of being a
  false positive. At that slice, Opus returned its explicit muxer reason;
  browser warnings/errors were zero, and both temporary harnesses were removed.

### Slice 4 evidence â€” persisted capability-aware export UI (2026-07-31)

- [x] The dialog now presents Auto plus the four documented profiles as native
  radio cards, resolves Auto visibly, disables unsupported choices with their
  exact capability reason, and keeps Start disabled instead of substituting a
  codec. The selected concrete container, video/audio codecs, channel layout,
  MIME type, and extension remain visible before any encoder work begins.
- [x] Collapsible advanced controls update only valid allow-listed profiles and
  keep container metadata/audio coupling atomic. Video/audio bitrates and
  modes, mono/stereo/off, key-frame interval, codec pair, and destination all
  feed the same profile validator. Numeric draft errors are labelled with
  units, bounds, `aria-invalid`, and a live Start-blocking explanation.
- [x] The bitrate estimate uses exact integer/BigInt frame-rate math and adds
  audio bitrate only when the selected profile and timeline actually write an
  audio track. It is explicitly labelled approximate because variable-rate
  encoding and container overhead can change the result. Audio-off also stops
  offline audio-only media from blocking an otherwise complete video export.
- [x] A separate versioned `myrelith.export-selection:v1` preference remembers
  only the last profile proven valid on this browser: a preset/Auto id or one
  validated custom profile. Capability results, reasons, Auto's resolution,
  and project-owned dimensions/FPS/sample rate are never persisted. Malformed
  saved data falls back safely without disturbing the still-image preference.
  A saved choice that becomes unavailable remains selected and blocks Start
  with its exact reason; it is never silently substituted.
- [x] Capability and custom-profile responses are generation-safe across edits
  and document changes. Dialog lifecycle, focus, cancellation, progress,
  dynamic MP4/WebM Blob metadata, URL revocation, retry, invalid drafts, stale
  checks, exact-profile handoff, and offline-audio exclusion are covered.
- [x] Focused gate: 111/111 tests across dialog, preferences, profile, and pure
  UI helpers passed. Full gate: 1,590/1,590 tests across 83 files passed.
  Production TypeScript/Vite build passed with only the pre-existing chunk-size
  advisory; oxlint and `git diff --check` passed.
- [x] In-app Chromium exercised the real capability facade. Compatibility was
  the first-run default; Auto resolved visibly to Modern; selecting Web changed
  the live summary to WebM/VP9/Opus with `video/webm` and `.webm`, survived a
  close/reopen through the versioned preference, and was restored to
  Compatibility. Advanced controls expanded without overflow, an out-of-range
  0.05 Mbps draft exposed the exact accessible error and disabled Start, and
  browser warning/error logs remained empty.

### Slice 5 evidence — bounded direct-to-file export (2026-07-31)

- [x] A dedicated app facade validates the selected concrete profile before
  touching the host picker, requests the exact MIME/extension filter inside
  the initiating click's transient activation, and returns an opaque one-shot
  handle capability. User cancellation, insecure/unavailable hosts, and picker
  security failures remain distinct readable outcomes; file output never
  silently changes into a browser download.
- [x] The Mediabunny direct sink uses `StreamTarget` with one MiB bounded
  chunks, awaited positional writes, and exact maximum-end byte accounting.
  Proxy stream closure does not commit the native file: successful export
  closes all media, finalizes the muxer, then commits exactly once, while
  cancellation or any setup/write/finalize failure aborts exactly once. An
  abort failure becomes the terminal integrity error so the UI never promises
  that no partial file survived when cleanup is uncertain.
- [x] The controller snapshots callbacks and the picker capability before its
  first await, requires an exact profile/destination pair, reruns the fresh
  capability gate, and treats an already-committed generator result as success
  even if cancellation races the terminal return. Direct results carry only
  frozen filename/byte-count/profile metadata and never retain a complete
  output buffer or native handle.
- [x] The dialog retains an explicitly saved file destination when the current
  host cannot provide it, shows the exact unavailable reason, and requires the
  user to switch destinations. A separate picker phase disables edits and
  prevents double invocation; success names the committed file without making
  a Blob URL, while cancellation and failed-abort copy preserve the empty-file
  versus possibly-incomplete-file distinction.
- [x] Focused gate: 146/146 tests across the generic export lifecycle, direct
  file adapter, Mediabunny writer, controller, picker facade, and dialog
  passed. Coverage includes synchronous picker invocation, bounded positional
  writes and backpressure, exact-once commit/abort, setup/write/finalize
  failures, cleanup precedence, terminal cancellation races, unsupported saved
  choices, retry, focus, and zero-Blob direct success.
- [x] Full gate: 1,620/1,620 tests across 85 files passed. Production
  TypeScript/Vite build passed with only the pre-existing chunk-size advisory;
  oxlint passed.
- [x] In-app Chromium used the production dialog and writer with a real
  transient user activation and an OPFS-backed native file handle. It streamed
  a 1,098-byte MP4, then Mediabunny reopened it as AVC at exactly 1280×720 and
  0.100 seconds with no audio track; the native video element loaded and played
  it successfully. The picker observed active user activation, browser warning
  and error logs were both zero, and the temporary QA module was removed.

### Slice 6 evidence - exact WebM/Opus timing and fallback decision (2026-07-31)

- [x] A pinned `mediabunny@1.50.9` patch now carries the exact post-transform
  PCM end from each encoding audio source and holds only the final open Opus
  packet. It writes the OpusHead pre-skip as `CodecDelay`, keeps
  `SeekPreRoll` at 80 ms, emits positive nanosecond `DiscardPadding` only on
  the final `BlockGroup`, advertises Matroska/WebM version 4 with read version
  2, and replaces coded tail time with exact presentation time. Packet duration
  comes from the Opus TOC and impossible padding fails closed.
- [x] The matching demux patch subtracts `CodecDelay` from packet timestamps,
  applies signed `DiscardPadding`, derives otherwise-implicit final Opus packet
  duration from its TOC, and preserves nanosecond timing on reopen. OpusHead is
  cloned before repair; its original-input sample rate and Matroska
  `SamplingFrequency` stay equal for 44.1, 48, and 96 kHz inputs even when
  Chromium reports its internal 48 kHz encode clock. The caller's header is
  never mutated.
- [x] Independent EBML contract tests cover 1, 648, 649, and 960 submitted
  samples, zero versus near-full final padding, exact `CodecDelay` and
  `SeekPreRoll`, final-block placement, sub-millisecond serialized timestamps,
  audio/video maximum duration, round-trip computed and metadata duration to
  the format's 0.5 ns bound, and 44.1/96 kHz metadata repair.
- [x] Optional local encoder fallbacks are a documented no-go for this issue.
  The closest AAC extension does not preserve the selected bitrate-mode
  semantics and adds FFmpeg LGPL/source/relink plus patent review. Opus, VP9,
  AV1, AVC, and HEVC candidates are immature, stale, multi-megabyte,
  whole-file-shaped, or carry disproportionate worker, licensing, cancellation,
  and packet-adapter work. Runtime-native support remains honestly capability-
  gated with no codec substitution.
- [x] `patch-package@8.0.1` is exact-pinned; a clean `npm ci` reapplied the
  patch successfully and npm reported zero vulnerabilities. Focused profile,
  preflight, writer, and Opus contract gates passed 75/75 tests. Production
  TypeScript/Vite build passed with only the existing chunk-size advisory, and
  oxlint passed. Real Chromium A/V playback and the final cross-profile matrix
  are recorded in Slice 7 below.

### Slice 7 evidence — final profile/browser acceptance (2026-08-01)

- [x] The production dialog reported Compatibility, Web, Modern, and HEVC as
  Available on this Windows Chrome 150 host, and Auto resolved visibly to
  Modern. Each exact configuration still passed the immediately-before-start
  native preflight; this measured host result does not weaken runtime probing
  or permit substitution on another browser or machine.
- [x] All four profiles passed both buffered-download and direct-file export,
  then reopened with their selected MP4/WebM container and AVC/VP9/AV1/HEVC
  video plus AAC/Opus audio. Every base output was exactly 320×180 at
  30000/1001 fps with 30 frames over 1.001 seconds, 48 kHz stereo, and 48,048
  presented samples. Native video elements loaded and played every result.
- [x] Advanced reopen gates passed AAC mono, audio-off, constant bitrate with a
  500 ms key-frame interval, and video-only Web and Modern outputs. Together
  with the base matrix, the browser run completed 17 gates and reopened 14
  outputs without warnings or errors.
- [x] Picker cancellation remained reusable without starting an export. Direct
  cancellation after five staged writes aborted without success; retry worked.
  Injected positioned-write failure plus abort-integrity failure surfaced the
  explicit possibly-incomplete-file warning and preserved the sentinel file
  content instead of reporting a false success.
- [x] The high-entropy 1280×720 memory gate produced a 10,436,306-byte direct
  file beside a 10,436,298-byte buffered result. Direct output kept chunks at or
  below 1 MiB with one write maximum in flight, and its terminal result retained
  no output buffer.
- [x] Final automation passed 1,632/1,632 tests across 86 files.
  `npm audit --omit=dev --audit-level=high` reported 0 vulnerabilities. The
  optional local encoder fallback decision remains a no-go; runtime-native
  support stays capability-gated with no codec substitution. Local
  implementation completed at reviewed head `ea5ccfb`; PR #29 was normally
  merged as `edb02d0`, and Issue #16 was closed as completed after its checklist
  and fallback no-go were reconciled.

## Post-MVP issue #31 — project aspect ratios

**IMPLEMENTATION AND ACCEPTANCE COMPLETE (2026-08-01).**

Issue #31 extends project creation without creating a second persisted source
of truth. `TimelineDoc.width` and `TimelineDoc.height` remain authoritative
through preview, render, save/resume, and export; aspect-ratio labels are derived
from those exact integers. Active-project resizing, custom ratios, media
fit/fill policy, and per-export resizing remain outside this issue.

### Frozen creation matrix

| Family | 720 tier | 1080 tier | 1440 tier | 2160 tier |
|---|---:|---:|---:|---:|
| Horizontal 16:9 | 1280 × 720 | 1920 × 1080 | 2560 × 1440 | 3840 × 2160 |
| Vertical 9:16 | 720 × 1280 | 1080 × 1920 | 1440 × 2560 | 2160 × 3840 |
| Square 1:1 | 720 × 720 | 1080 × 1080 | 1440 × 1440 | 2160 × 2160 |
| Social portrait 4:5 | 720 × 900 | 1080 × 1350 | 1440 × 1800 | 2160 × 2700 |

The default remains Horizontal 1920 × 1080. Changing the family preserves the
selected size tier and recomputes the exact paired resolution.

### Completed gates

- [x] Added one immutable pure-domain catalog and helpers for all 16 exact
  pairs, deterministic family lookup, exact-ratio derivation, display labels,
  uniqueness/even-integer checks, and the current 3840 × 2160 pixel envelope.
- [x] Kept project schema/format unchanged. Every vertical, square, and social
  creation size round-trips through `.myrelith`, and invalid/custom dimensions
  still fail the existing project-settings boundary.
- [x] Added accessible Aspect ratio and dependent Resolution controls. Resume
  cards and Export identify the derived family plus exact fixed dimensions.
- [x] Covered portrait/square/social worker scratch surfaces and the maximum
  portrait allocation, plus capability hints and fresh Mediabunny preflight
  using actual-size canvases and exact dimensions.
- [x] Focused gate passed 183/183 tests across six files. Full automation passed
  1,659/1,659 tests across 86 files; production build and oxlint passed, npm
  reported zero high-severity production vulnerabilities, and diff checking was
  clean. The build retained only the existing Vite chunk-size advisory.
- [x] In-app Chromium preserved the 1440 tier across all four families; created
  exact 1920 × 1080, 2160 × 3840, 1080 × 1080, and 1080 × 1350 monitor canvases;
  displayed `Vertical 9:16 · 2160 × 3840` as the fixed Export resolution; fit
  the 720px launcher without horizontal overflow; and logged zero warnings or
  errors.

## Post-MVP issue #32 — four default video and audio tracks

**COMPLETE AND CLOSED (2026-08-01).**

Issue #32 changes only the fresh-document factory. New projects begin with four
video tracks and four audio tracks; opening, recovering, or migrating an
existing project preserves its saved track count, order, and identities. The
project and timeline schemas are unchanged.

### Completed gates

- [x] The pure creation authority emits independently owned empty tracks in
  persisted order `V1`, `V2`, `V3`, `V4`, `A1`, `A2`, `A3`, `A4`, with no
  shared clip or transition arrays across tracks or factory calls.
- [x] New-project activation consumes that exact document. Existing persistence
  and import tests now derive their expectations from the factory shape instead
  of assuming two initial tracks; saved documents are not padded or rewritten.
- [x] The timeline renders the video stack as `V4` through `V1`, followed by
  `A1` through `A4`. Its existing add-track contract continues naturally at
  `V5` and `A5`.
- [x] Focused automation passed 157/157 tests across six files. Full automation
  passed 1,661/1,661 tests across 86 files; production build and oxlint passed,
  npm reported zero high-severity production vulnerabilities, and diff checking
  was clean. The build retained only the existing Vite chunk-size advisory.
- [x] At 1280 × 720, in-app Chromium rendered all eight exact header/lane pairs
  with matching 56px geometry inside the timeline's vertical scroller, exposed
  28 named and enabled per-track controls, avoided page-level horizontal
  overflow, reached `A4` and both add controls, added `V5`/`A5`, and logged zero
  warnings or errors.
- [x] Reviewed head `b131436` was normally merged through PR #37 as `daf3a6e`;
  GitHub closed only Issue #32 as completed.

## Post-MVP issue #33 — editable text overlays

**COMPLETE AND CLOSED (2026-08-03).**

Text overlays are procedural timed video clips: they own no imported media or
decoder, keep source semantics fixed to `[0, duration)`, and persist strictly
validated content, geometry, and supported presentation in timeline schema 4.
Preview and export consume the same composition item, bounded wrapping logic,
and Canvas2D painting path so supported appearance and timing stay aligned.

### Completed gates

- [x] Creators can add, select, edit, move, resize, link/unlink, and delete text
  overlays. The inspector covers content, portable font family, size,
  weight/style, text and background colors, alignment, opacity, and outline;
  direct Program Monitor controls work by pointer, touch, and keyboard.
- [x] Move, trim, ripple, split, slide, and linked edits preserve text timing;
  Slip is an explicit no-op because procedural text has no hidden source range.
  Live geometry drafts remain ephemeral and commit one document mutation on
  release.
- [x] `.myrelith` save/load advances the nested timeline schema to 4, migrates
  older documents conservatively, reserves procedural asset ids, and rejects
  unsupported or malformed text settings instead of substituting them.
- [x] The shared composition planner requests no media for text-only projects;
  preview, seeking, and export render the same wrapping, box, outline,
  alignment, opacity, and geometry rules with bounded surfaces and cleanup.
- [x] Focused automation passed 304/304 tests across 13 files. Full automation
  passed 1,747/1,747 tests across 99 files; production build and oxlint passed,
  npm reported zero high-severity production vulnerabilities, and diff checking
  was clean. The build retained only the existing Vite chunk-size advisory.
- [x] In-app Chromium created and edited multiline text with no upload, moved
  and resized it through keyboard-accessible Program Monitor controls, clearly
  rejected an overlapping insertion, completed an actual text-only MP4 export,
  and remained usable at 1280×720 and 720×800. No unexpected console errors or
  framework overlays appeared.
- [x] Reviewed head `05731fb` passed GitHub CI and was normally merged through
  PR #47 as `eba39b6`; the feature branch was retained and GitHub closed only
  Issue #33 as completed.

## Post-MVP issue #34 — full clip Inspector

**COMPLETE AND PUBLISHED (2026-08-03).**

The Inspector becomes the single contextual authoring surface for static clip
video and audio properties. Existing transform, opacity, and gain fields stay
document-owned; schema 5 adds explicit crop, flip, scale-lock, audio-enable,
stereo-balance, and integer-frame fade state. Preview and export must consume
the same pure visual and audio plans. Keyframes and the advanced effects listed
in child issues #43–#46 remain separate work.

### Frozen semantics

- Crop edges are normalized source fractions. Opposing edges may total at most
  `0.99`; the remaining source rectangle keeps its natural scale and position
  instead of stretching back to the uncropped size.
- Scale is non-negative and bounded. New UI-authored values stay above zero;
  schema-4 zero-scale clips remain invisible, while negative legacy scale is
  migrated to its absolute value plus an explicit horizontal/vertical flip.
- Enabling the aspect lock makes X authoritative for unequal scales. While
  locked, editing either scale writes the same value to both axes.
- Stereo balance is `[-1, 1]` with deterministic channel attenuation: center is
  `[1, 1]`, full left is `[1, 0]`, and full right is `[0, 1]`. It does not
  synthesize stereo for sources that do not provide it.
- Fade durations are safe integer project frames, may overlap, and multiply
  with clip gain and transition envelopes. Geometry edits clamp a fade that is
  longer than the resulting clip rather than leaving an invalid document.
- Program Monitor pointer movement may use ephemeral preview state, but release
  commits exactly one document/history mutation. Unsupported render or audio
  behavior fails explicitly; no Inspector choice is silently substituted.

### Authoritative implementation slices

- [x] **1 — document contract.** Advanced only the nested timeline schema from
  4 to 5; keep outer project format 4. Add defaults, strict validation,
  conservative migration, durable round-trip coverage, geometry-safe fades,
  and atomic undoable visual/audio patch actions. The focused foundation gate
  passes 218/218 tests; the complete suite passes 1,761/1,761 tests across 100
  files, and build, oxlint, production audit, and diff checks are clean.
- [x] **2 — shared visual rendering.** Teach the shared Canvas2D compositor to
  apply normalized source crop and explicit flips with the existing transform,
  anchor, rotation, opacity, z-order, transition, still, text, preview, and
  export contracts. Source-rectangle and pixel-golden tests pin crop position,
  natural scale, explicit flips, and procedural text clipping.
- [x] **3 — shared audio rendering.** Extend the canonical audio mix plan with
  enable, balance, and frame fades; apply the exact same gain evaluation in
  live Web Audio playback and offline export, including transition overlap.
  Disabled clips are silent, stereo balance attenuates channels without
  synthesizing stereo, and overlapping fades multiply deterministically.
- [x] **4 — contextual Inspector UI.** Replace the minimal panel with grouped,
  resettable Video and Audio sections, immediate selected-clip updates, and
  both halves for a linked A/V selection. Numeric inputs and sliders must have
  accessible names, visible focus, bounded keyboard behavior, and honest
  disabled states. Native sliders also have explicit Arrow, Home/End, and Page
  key semantics; connected mono sources expose balance as unavailable.
- [x] **5 — direct manipulation.** Generalize the Program Monitor overlay for
  video move/scale/rotate/crop/anchor/flip workflows while retaining text
  controls, fresh pointer-down bounds, touch behavior, keyboard alternatives,
  and one commit per completed gesture.
- [x] **6 — acceptance and closeout.** Cover domain mutations, migration,
  selection switching, UI reset/keyboard behavior, shared preview/export
  pixels and audio samples, save/reopen, linked A/V display, responsive layout,
  real playback, and reopened export output. Run focused and full automation,
  build, oxlint, production audit, diff checks, and in-app Chromium QA before
  publication or issue closure.

The matching live GitHub issue contains the same dependency-aware checklist so
implementation and review can be evaluated against one contract.

Slices 2–3 pass 117 focused tests. The complete suite passes 1,768/1,768 tests
across 100 files; production build, oxlint, production audit, and diff checks
are clean. The build retains only the existing Vite chunk-size advisory.

Slice 4 passes 212 focused tests and the complete suite passes 1,771/1,771 tests
across 100 files; production build, oxlint, production audit, and diff checks
are clean. In-app Chromium confirmed immediate preview/reset behavior, visible
focus, a contained Inspector scroller, no page overflow at 1280×720 or 720×800,
and zero console warnings or errors. The build retains only the existing Vite
chunk-size advisory.

Slice 5 passes 87 focused tests and the complete suite passes 1,782/1,782 tests
across 101 files; production build, oxlint, production audit, and diff checks
are clean. In-app Chromium confirmed move, scale, rotate, crop, anchor, and flip
controls for an offline durable visual descriptor; synchronized Inspector
drafts; fixed-size targets at 100× scale; one exact pointer-up history entry;
keyboard alternatives; and no page overflow or console errors at 1280×720 or
720×800. The build retains only the existing Vite chunk-size advisory.

Slice 6 adds explicit reusable-handle and ordinary-input choices for project
open, media import, and offline relink. Remembered access remains an explicit
user choice; Quick open/import/relink does not silently persist a handle or
copy source bytes. Offline mono Inspector state now reads the durable asset
descriptor so Balance remains honestly unavailable across recovery.

The final focused gate passes 117/117 tests and the complete suite passes
1,784/1,784 tests across 101 files. Production build, oxlint, production audit,
and diff checks are clean; the build retains only the existing Vite chunk-size
advisory. In-app Chromium quick-opened a validated portable project with linked
video/audio clips, opened it offline, failed closed on a descriptor mismatch,
then quick-relinked the real 2-second AVC/AAC fixture with one connected and
zero skipped. It committed transform, locked scale, rotation, anchor, flip,
opacity, crop, mono volume, and fade edits; played real decoded media; recovered
all values in a fresh tab; rendered the exact MP4/H.264/AAC Browser-download
selection and captured its completed MP4; kept both dual picker surfaces usable
without horizontal overflow at 720 px; and emitted no console warnings or
errors.

PR #49 passed GitHub CI at reviewed head `2746016`, was normally merged as
`571fff6`, and retained `codex/feature`. The final documentation reconciliation
completed before GitHub closed only Issue #34 as completed.

## Post-MVP issue #35 — preview direct manipulation completion

**COMPLETE AND PUBLISHED (2026-08-03).**

Issue #34 delivered the direct Program Monitor manipulation system and satisfied
Issue #35's selection, move, rotate, crop, anchor, flip, Inspector-sync,
keyboard, history, persistence, and preview/export requirements. Issue #35's
remaining acceptance gap was the resize control: only one automatically chosen
farthest-corner handle was rendered.

### Completed gates

- [x] Replace the one farthest-corner target with four explicit top-left,
  top-right, bottom-left, and bottom-right scale handles. Each has a distinct
  accessible name, matching diagonal cursor, fixed-size focus target, and the
  existing keyboard scale alternative.
- [x] Resolve the selected corner's crop- and anchor-relative vector from the
  fresh pointer-down document snapshot. Rotation and flips continue through the
  existing inverse local-delta math; locked scale remains proportional, while a
  freeform axis whose handle coincides with the anchor remains finite and
  unchanged.
- [x] Preserve the established gesture contract: pointer movement publishes an
  ephemeral Inspector/preview draft, document/history stay unchanged until
  release, and pointer-up commits one atomic visual edit. No overlay control is
  part of the shared preview/export composition plan.
- [x] The focused Inspector/preview gate passes 82/82 tests and the complete
  suite passes 1,785/1,785 tests across 101 files. Production build, oxlint,
  high-severity production audit, and diff checks are clean; the build retains
  only the existing Vite chunk-size advisory.
- [x] Real Chrome physically dragged all four handles on a rotated, cropped,
  off-center-anchor, horizontally flipped 320×180 clip. Each handle was the top
  hit target, updated Inspector live, and committed one history entry. At
  720×800 all four targets remained at least 28 px, visible, independently
  clickable, and inside a zero-overflow page with no warnings or errors.
- [x] Reviewed head `13ae345` passed GitHub CI and was normally merged through
  PR #51 as `4f9eaaa`; the feature branch was retained. The matching completion
  scope is limited to Issue #35.

## Post-MVP issue #43 — keyframing and animation curves

**COMPLETE (2026-08-05).**

The first deliberately small property set is visual-media Position X/Y, Scale
X/Y, Rotation, and Opacity. Crop, flips, audio, text styling, effects,
tracking, procedural animation, and blanket animation of every Inspector field
remain out of scope.

- [x] Add a strict serializable track/keyframe/easing model under nested
  timeline schema 6. Schema-5 migration installs empty curves without changing
  a static project; outer project format remains 4. Validation caps project and
  per-track keyframe counts, finite values, frame magnitudes, and easing control
  points.
- [x] Freeze deterministic semantics in one pure evaluator: clip-local integer
  frames, nearest-value boundary holds, exact-time selection, left-key outgoing
  hold/linear/CSS-style cubic-Bézier interpolation, duplicate-time replacement,
  and static fallback for invalid in-memory data.
- [x] Add immutable add/replace, move, copy, remove, and reset operations with
  one history entry per successful edit. A moved source replaces an existing
  target-time key. Split and head-trim shift local keyframe origins so the
  global curve is visually unchanged.
- [x] Route Inspector and Program Monitor changes through the playhead: static
  properties retain their existing base-field behavior, while an already
  animated property adds/replaces the exact playhead keyframe. Gesture previews
  stay ephemeral and release still commits once.
- [x] Resolve the same pure curve in the canonical video composition planner
  before ordinary and crossfade requests, giving scrubbing, playback, and export
  one path with no per-frame document/store mutation.
- [x] Add accessible Inspector property selection, keyframe list/navigation,
  frame/value inputs, copy/remove/reset commands, named curve presets, custom
  cubic-Bézier controls, live announcements, and bounded timeline diamonds.
- [x] Unit/integration coverage pins evaluator boundaries/easing, invalid and
  duplicate data, operations, split/trim geometry, store undo/redo, schema-5
  migration and save/load, composition parity, accessible UI workflows, and
  marker placement. The complete suite passes 1,805/1,805 tests across 105
  files.
- [x] Production build, oxlint, and diff checks pass; the build retains only
  the known Vite chunk-size advisory. In-app Chromium reopened and quick-
  relinked real 320×180 H.264 media, proved exact keyed monitor/Inspector sync,
  custom easing, copy/move/remove/reset with undo, interpolated playback, three
  timeline diamonds, and a completed 120-frame MP4 export. The 720×800 layout
  had zero horizontal overflow and the final console had zero warnings/errors.

## Soft Studio product experience overhaul

**IMPLEMENTATION COMPLETE (2026-08-06).**

- [x] Replace the sparse launcher with a warmer local-first hierarchy while
  retaining real create/open/recovery controllers and dynamic project data.
- [x] Present the reviewed Horizontal, Vertical, Square, and Social portrait
  creation presets as accessible visual radio choices without duplicating the
  project-settings authority.
- [x] Restyle the editor shell, Media Pool, Program Monitor, contextual
  Inspector, transport, and timeline around the selected calm navy direction
  while keeping every control connected to existing behavior.
- [x] Keep Transform, Crop, and Animation as keyboard-navigable Inspector tabs;
  move Add Text into the timeline tool group as a compact accessible T control
  with the existing dialog and focus restoration.
- [x] Ship five generated photographic assets as optimized WebP files and keep
  concept-only media/timeline content out of the real editor.
- [x] Pass 1,806/1,806 tests across 105 files, production build, oxlint,
  high-severity production audit, and diff checks. In-app Chromium verified
  the primary launcher/setup/editor interactions, exact comparison viewports,
  responsive no-overflow layouts, Inspector keyboard behavior, Add Text focus
  restoration, and zero console warnings/errors.

## Post-MVP issue #54 - performance benchmark harness

**COMPLETE AND PUBLISHED (2026-08-07; PR #81).**

- [x] Add a deterministic portable stress fixture with exactly 100 mixed-media
  assets, eight tracks, a 30-minute 4K timeline, 320 clips, 39 transitions,
  20 text clips, and bounded connected 4K video/still plus audio sources.
- [x] Measure launcher/editor readiness, scrub input-to-present, worker frame
  rendering, dropped frames, audio underruns, import readiness, complete
  CDP-scoped Chromium process-memory plateau/growth, and export real-time ratio
  with raw samples, provenance, and distribution summaries. Renderer/GPU/host
  process coverage failures record the memory metric as unavailable.
  Input-to-present ends at a browser presentation boundary after the matching
  worker draw, exposed through a testable dependency seam.
- [x] Emit schema-defined JSON, a human-readable Markdown summary, and a
  Chromium screenshot. Bind every result to exact branch/commit/dirty and
  fixture SHA-256 fingerprints plus runtime/browser/device metadata, including
  CDP GPU renderer/vendor/driver and acceleration identity. Fixture
  identity includes the portable project, connected source/scrub plan, and
  stable generation settings/sample plan while excluding browser-dependent
  output bytes; canonical-state verification recomputes it.
- [x] Keep every threshold advisory, document the exact production-browser
  workflow and proposals, and fail the command only for harness, console,
  mutation/restoration, or cleanup integrity failures.
- [x] Exclude the route and its chunks from ordinary production builds; include
  it only for the exact path in development or an explicitly flagged production
  build. Architecture tests enforce the one benchmark runtime composition
  exception and the one benchmark UI reuse exception.
- [x] Build and preview the enabled bundle from the same unique OS-temporary
  output directory, then recursively remove it on success/failure so the
  benchmark cannot replace or serve an existing ordinary `dist/`.
- [x] Refuse active project state, avoid persistence controllers, dispose every
  preview/audio/export owner, revoke generated/import URLs, and restore exact
  document/history, media, transport, and project-session state.
- [x] Reject playback beyond 2,000 ms and export beyond 31 frames before
  measurement so fixed generated video is never advertised as continuous after
  it enters the held tail.
- [x] Pass focused Vitest coverage plus all 16 Node runner cases, canonical
  `npm test` with 1,847/1,847 Vitest cases across 110 files plus those runner
  cases, production build/typecheck, oxlint, a 0-vulnerability production
  audit, and fresh smoke/full Chromium measurements. Both runs restored every
  isolated store and URL owner with no browser console problem. Smoke/full
  captured 2/7 complete Windows private-memory process-table samples and both
  artifacts validated against schema 2.
- [x] Reviewed head `f873818` was normally merged through PR #81 as `9920491`;
  Issue #54 closed automatically.

## Post-MVP issue #55 - launcher and editor bundle split

**IMPLEMENTATION COMPLETE (2026-08-07); DELIVERY TRACKED BY PR #83.**

- [x] Move the editor composition, lifecycles, shortcuts, and CSS behind one
  shared `EditorShell` dynamic import while keeping ProjectLaunch eager.
- [x] Preload the editor before Create/Open/Recover activates project truth;
  show accessible loading and honest reload recovery without an incomplete
  editor flash.
- [x] Preload remembered-project recovery before its final action becomes
  available, then invoke permission activation synchronously within the user's
  click so the transient File System Access activation window is preserved;
  clear pending preload busy state when leaving Resume for another flow.
- [x] Lazy-load Export, Add Text, and Animation on first use, preserve dialog
  focus restoration and mounted animation state, make loading/error dialog
  fallbacks own focus and contain editor shortcuts, and keep project exit able
  to dispose an already-loaded export without pulling export code forward.
- [x] Add error-boundary behavior tests and a static-import-closure architecture
  guard for the launcher, editor, and three secondary features.
- [x] Reduce ordinary initial gzip JS+CSS from 307.43 kB to 246.92 kB (-19.7%)
  and three-sample cold-launch median/p95 from 163.5/238.4 ms to
  146.1/211.5 ms (-10.6%/-11.3%) on the same source-bound harness host.
- [x] Verify production Chromium request timing, Create, first-use Export/Text,
  focus restoration, forced-503 reload recovery with unchanged project truth,
  720x800 overflow, and a clean ordinary success-path console.
- [x] Integrate published PRs #82 and #84, then pass 1,877/1,877 Vitest cases
  across 116 files plus all 16 Node runner cases, build/typecheck, oxlint,
  zero-vulnerability production audit, and diff checks.

## Post-MVP issue #56 - bounded media-analysis scheduling

**COMPLETE AND PUBLISHED (2026-08-07; PR #84).**

- [x] Add one app-layer `MediaJobScheduler` with explicit two-job/two-decoder
  resource budgets, FIFO-stable priority, aging, cooperative yield, generation,
  progress, cancellation, typed failure, and bounded diagnostics.
- [x] Route filmstrip, still-thumbnail, and waveform creation through the
  scheduler. Abort removal/replacement/supersession/disposal, dispose every
  Mediabunny Input exactly once, revoke late/stale URLs, and keep stores free of
  live resources or queue state.
- [x] Prioritize the primary selected clip's asset, then assets intersecting the
  exact on-screen Timeline range, then background media; update queued jobs as
  selection, document, viewport, or connection state changes, with aging to
  prevent starvation.
- [x] Extend the Issue #54 artifact to schema 4 with a deterministic 100-asset
  scheduler scenario. Record modeled legacy demand, queue/wait/active-resource
  facts, cancellation/completion/failure, progress, priority order,
  cooperative-yield strategy, and event-loop delay.
- [x] Pass 1,867/1,867 Vitest tests across 113 files plus all 16 Node runner
  cases, production build/typecheck, oxlint, zero-vulnerability production
  audit, diff checks, smoke/full production Chromium benchmarks, and real
  in-app Browser bulk-import/responsiveness/clean-console QA.
- [x] Resolve all review feedback, pass exact-head CI and a final Codex review
  with no major issues at `902078f`, and normally merge PR #84 as `b431623`;
  Issue #56 closed automatically.

## Post-MVP issue #57 - runtime and document-memory telemetry

**COMPLETE AND PUBLISHED (2026-08-07; PR #82).**

- [x] Add an explainable browser-free estimator that separates the authored
  document, undo/redo history, and structural sharing without claiming to
  measure JavaScript heap or decoded media.
- [x] Seed deterministic real history in the isolated stress fixture and keep
  current-document fingerprinting, reset, export, and cleanup exact.
- [x] Add opt-in render-worker snapshots for active decoders/sources, queue
  depth, cache hits/misses, classified retained bytes, and resource closes;
  add active cursor/pending-buffer facts to audio diagnostics.
- [x] Extend every process-memory batch into a bounded playback/scrub/drain
  health cycle and record live/drained snapshots plus an explicit cache-drain
  result.
- [x] Measure telemetry overhead against paired disabled controls, keep the
  proposal advisory, bound long-animation-frame capture, and capability-check
  `measureUserAgentSpecificMemory()` as optional lab evidence.
- [x] Advance the artifact to strict schema 3 / `issue-57-v1`, document all
  cost classifications and exclusions, and introduce no absolute byte cap.
- [x] Pass 190 focused tests, all 1,852 Vitest cases across 111 files plus 16
  Node runner cases, build/typecheck, oxlint, production audit, diff checks,
  schema validation, and a fresh production Chromium smoke run with two clean
  cache drains, exact restoration/URL cleanup, and no console problems.
- [x] Reviewed head `a857455` passed CI and was normally merged through PR #82
  as `f7eedab`; Issue #57 closed automatically.

## Post-MVP issue #60 - virtualize and search the Media Pool

**IMPLEMENTATION COMPLETE AND MERGED (2026-08-07).**

- [x] Add a browser-free stable index with deterministic token search and exact
  type/status facets; preserve insertion order and never mutate project state.
- [x] Virtualize the mixed-height Media Pool grid over its existing scroll owner
  with measured rows, bounded overscan, responsive one/two/three-column packing,
  stable asset keys, spacer geometry, and no offscreen visual subscriptions.
- [x] Add listbox keyboard navigation, retained selection/focus, exact ARIA set
  position/size, and boundary-safe drag, remove, compatibility, import, and
  individual relink controls.
- [x] Publish only visible Media Pool asset ids through the existing app facade;
  selected timeline work remains highest priority and visible pool/timeline work
  shares the scheduler's existing `visible` class ahead of background jobs.
- [x] Prove the 500-item bound, deterministic filters, End navigation, cross-row
  drag/relink payloads, measured expanded rows, scheduler priority, and no
  offscreen visual rerender in focused tests.
- [x] Pass all 1,885 Vitest tests across 117 files plus 16 Node runner cases,
  build/typecheck, oxlint, zero-vulnerability production audit, and diff checks.
  No separate accessibility-audit command exists in this repository.
- [x] In real Chromium, import 500 PNGs in five supported 100-file batches;
  verify 12–15 mounted cards on desktop, 8 at 1,180px, 3 after the 800px
  one-column layout settles, exact 136 ms search, End at positions 500/501,
  deterministic empty/type/status states, 500-source offline recovery with the
  relink control present at the far boundary, and no console warning/error.
  Single-file relink handoff is component-tested because the in-app browser's
  chooser hook did not attach to that virtualized input during manual QA.
- [x] PR #85 passed review and was normally merged as `809474f`; Issue #60
  closed automatically.

## Post-MVP issue #65 - Media Pool bins and collections

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-09).**

- [x] Add pure bounded collection operations over stable asset ids: normalized
  unique names, ordered create/rename/reorder/delete, and non-owning
  multi-collection membership with no duplicated media descriptors or bytes.
- [x] Advance the portable project format from v4 to v5, migrate older projects
  to an empty collection catalog, validate ids/names/membership budgets and
  references, and carry collections through Save, live save, recovery, Resume,
  and portable snapshot cloning.
- [x] Add bounded collection-only undo/redo. Collection deletion never removes
  media; asset deletion prunes current and historical membership so undo cannot
  restore a dangling id; offline/relink paths retain organization.
- [x] Integrate collection selection before the existing search/type/status and
  virtualization pipeline. Keep selected collection transient, publish only
  rendered rows to media scheduling, and preserve the 500-item DOM bound.
- [x] Add accessible collection tabs, create/rename/reorder/delete/history
  controls, checkbox multi-membership for connected and offline cards, and
  virtualized card-to-tab drag organization with stable keyboard focus.
- [x] Final gates: 7 focused files / 196 tests; `npm test` 132 files / 1,975
  Vitest tests plus 16 benchmark-runner tests; production build/typecheck;
  oxlint; `npm audit --omit=dev` with zero vulnerabilities; and clean diff
  checks. The expected existing Vite large-chunk advisory remains non-fatal.
- [x] Real Chromium on the task-exclusive `http://localhost:5175` imported 500
  supported PNGs, kept 18 or fewer cards mounted at the sampled boundaries,
  searched the final item in 57 ms, reached position 500 by keyboard, exercised
  create/rename/reorder/delete/undo and multi-collection membership, and stayed
  usable without page overflow at 800×720. A fresh launcher recovery reopened
  all 500 one-time sources offline while preserving the three collection names,
  counts, selected-collection filter, and two checked memberships; the console
  had no warnings or errors. The in-app browser did not synthesize an HTML5
  `DataTransfer`, so exact virtualized final-card drop is covered by the passing
  component test rather than claimed as a Chromium action.
- [x] Reproducible source identity started at clean `7036e23` /
  `sha256:d3c715957a67cc796e3b3ace716712b8f55ef1e5a83c93c8759fe4fd5ec26360`
  and reached implementation checkpoint
  `sha256:5b708007c1d877db8fbb95f3660a4bb091e37a294498fe9759f55af34f9a7faf`.
  The checkpoint intentionally predates this evidence block; the final commit
  id is the authoritative delivered source identity.
- [x] Local implementation is complete and this delivery publishes a draft PR.
  Review, merge, and Issue #65 closure remain separate and are not implied.

## Post-MVP issue #59 - indexed frame planning

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-07).**

- [x] Add an immutable browser-free point index for half-open clip and
  transition ranges, with binary search for canonical disjoint input and the
  historical first-match fallback for malformed overlaps.
- [x] Build one clip and transition index per visible track when the retained
  video composition planner is created, then reuse it across frame requests.
- [x] Preserve exact ordinary, procedural-text, animation-curve, crossfade,
  paint-order, and boundary semantics against an embedded legacy planner.
- [x] Advance performance evidence to schema 5 / `issue-59-v1` with dense and
  sparse distributions, exact 256-frame parity per scenario, and 36 explicit
  transition-boundary frames.
- [x] Measure production Chromium p95 improvement: 94.26% dense and 94.81%
  sparse on validation snapshot `69b7bad`, with exact cleanup and no console
  problems.
- [x] Pass all 1,884 Vitest cases across 118 files, all 16 Node runner cases,
  build/typecheck, oxlint, production audit, diff checks, and in-app Chromium
  creation/text-preview/step/play/pause QA.

## Post-MVP issue #58 - adaptive preview resolution

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-07).**

- [x] Add a browser-free `PresentationProfile` contract with output size,
  uniform scale, device-pixel policy, and explainable resolution reason.
- [x] Resolve session-only Auto/Full/Half/Quarter intent in the app layer from
  project dimensions, measured monitor CSS pixels/DPR, and transport state.
- [x] Pass profiles through the render bridge and supersede stale in-flight
  work when the document, transport mode, viewport, or quality changes.
- [x] Resize and reuse visible, scratch, transition-leg, and transition-group
  worker surfaces while preserving project-space transforms, crop, text,
  still-image, transition, and keyframe geometry.
- [x] Keep paused Auto and export explicitly Full; export remains fixed to the
  project dimensions regardless of the Program Monitor selection.
- [x] Add the compact accessible quality selector and preserve the monitor's
  CSS geometry while its disposable backing resolution changes.
- [x] Cover domain/store/controller/bridge/worker/compositor/export behavior
  with focused tests and verify 4K Auto playback plus the 720 × 800 control in
  real Chromium with a clean console.
- [x] Compare matched clean full-harness snapshots: retain zero dropped frames
  and audio underruns; lower Chromium process-memory plateau by 6.4% median and
  7.5% p95; record the small 3.6% frame-render p95 improvement and explain that
  full-resolution source decode still dominates latency. Keep export
  effectively unchanged and make no claim from the noisy growth-rate p95.

## Public preview foundation — v0.1.0-alpha.1

**COMPLETE AND RELEASED (2026-08-01).**

This slice makes the existing hosted app understandable and responsibly
releasable as an experimental preview without overstating legal or product
maturity.

- [x] License Myrelith's own source under MIT and record exact runtime dependency
  licenses/source links, including the FFmpeg-derived AC-3/E-AC-3 boundary.
- [x] Publish an implementation-matched privacy notice: app media stays local;
  preferences, opaque file handles, and bounded recovery snapshots remain in
  the browser; Cloudflare processes ordinary delivery/security request data;
  cookies and Cloudflare Web Analytics are not used.
- [x] Add public in-app Privacy and Licenses links plus standalone static pages
  that remain reachable even when the source repository is private.
- [x] Add a clearer README, changelog, citation metadata, contribution/support/
  security/conduct files, and structured issue and pull-request templates.
- [x] Add read-only CI and a version-tagged, multi-platform, SBOM/provenance
  GHCR workflow for a non-root static Myrelith container.
- [x] Focused launcher coverage passed 13/13 and the complete suite passed
  1,661/1,661 across 86 files. Production build, oxlint, the high-severity
  production audit, and diff checking passed; only the known large lazy codec
  chunk advisory remains. Playwright verified the built launcher at 1440×900
  and 390×844 plus both legal routes: exact headings/links, keyboard focus,
  zero horizontal overflow, zero cookies, and no console warning/page error.
- [x] PR #39 passed Linux CI at reviewed head `a0f385a` and was normally merged
  as `256887b` while retaining `codex/feature`. `v0.1.0-alpha.1` targets that
  merge and contains the 1,124,158-byte verified web archive plus SHA-256 file.
  The tag workflow published private AMD64/ARM64 GHCR tag
  `0.1.0-alpha.1` at digest
  `sha256:837cc8ea8d2b5b206283580b5806053cf861886c26d03668abab27f58646ec8b`
  with SBOM/provenance, and merged-master CI passed independently. GitHub
  detects MIT and exposes the new About text, live homepage, seven topics,
  community resources, release, and package. Cloudflare production deployment
  `c85ceeb0-0913-44ec-8ea4-db79c815dd31` serves exact commit `256887b`; its live
  launcher and `/privacy/` and `/licenses/` routes were re-read successfully.

The alpha label is binding. This work is not a production-readiness,
representative low-memory, GDPR, FFmpeg/LGPL, or codec-patent certification.
Downstream distributors must review their own obligations.

## Test strategy per layer (unchanged from original)

domain/, state/: Vitest. pipeline/, workers/: injectable-core unit tests +
browser verification via preview tools. ui/: RTL + `<Profiler>` render-count
tests + manual QA. E2E: manual + browser-driven pointer synthesis.

## Cross-cutting reminders for new sessions

- Follow ARCHITECTURE.md dependency arrows; new store↔engine wiring goes
  through app/ composition-root controllers (previewController pattern).
- Keep dependency boundaries explicit, test logical steps as they land, and
  browser-verify anything touching pipeline/workers/gestures.

## Myrelith rebrand

**IMPLEMENTED (2026-08-09).**

- [x] Rename the current product, package, repository references, UI copy,
  documentation, benchmark surfaces, future container target, and anticipated
  public hostname from WebCut to Myrelith.
- [x] Make `.myrelith`, `myrelith-project`, and `__myrelith_text__:` the only
  values emitted by new saves and current app behavior.
- [x] Preserve old-project access by accepting and normalizing legacy
  `.webcut`, `webcut-project`, and `__webcut_text__:` values.
- [x] Read the former localStorage keys as fallbacks and keep the historical
  IndexedDB names as durable identifiers for same-origin in-place upgrades.
- [x] Document that browser-origin storage cannot move automatically when the
  public hostname changes; portable project files are the migration path.

## Post-MVP issue #64 - timeline markers

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-09).**

- [x] Add schema-7 sequence markers with stable ids, integer frames, bounded
  labels/notes, portable colors, strict validation, and schema-6 empty-default
  migration across save/load/recovery project paths.
- [x] Add pure immutable create/edit/move/duplicate/delete operations plus
  deterministic next/previous navigation in canonical `(frame, id)` order.
- [x] Add thin one-gesture document-store actions, undo/redo, ephemeral marker
  selection/editor state, stale-id reconciliation, and clip-exclusive
  selection.
- [x] Render markers on the ruler with selected/offscreen feedback, accessible
  names/focus, explicit editing, Delete/Duplicate/Previous/Next keyboard paths,
  global add/navigation shortcuts, and command-palette discovery.
- [x] Keep clip-derived preview/export duration unchanged while using a
  marker-aware timeline-only extent for scrolling and Full Zoom.
- [x] Binary-search and pixel-cluster the visible ruler slice so 10k+ marker
  projects retain bounded DOM work, including deterministic equal-frame piles.
- [x] Record the final complete suite/build/lint/audit and source fingerprints;
  verify observable behavior in real Chromium exclusively on port 5174; then
  publish the exact committed head as a draft PR without merging it.

## Post-MVP issue #68 - caption tracks with SRT/VTT round trips

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-09).**

- [x] Add schema-8 semantic caption tracks/cues with stable portable ids,
  half-open integer-frame ranges, non-empty plain text, language/role-ready
  metadata, style presets, visibility, strict bounded validation, and schema-7
  empty-default migration across save/load/recovery/Resume.
- [x] Add browser-free immutable track/cue operations for add/edit/delete,
  navigation, split, touching merge, and suffix/all timing shifts; wire each
  gesture and full-file import through ordinary undoable document history.
- [x] Implement strict atomic SRT/WebVTT parsing and serialization with exact
  rational-rate conversions: import floors starts/ceils ends; export ceils
  starts/floors ends. Preserve safe VTT cue ids, generate ids where the format
  cannot, and return typed line-specific errors for malformed timing, empty
  text, markup, bounds, limits, and unsupported VTT features.
- [x] Keep caption semantics explicit in the composition plan while reusing
  the shared procedural-text layout/paint path. Make captions media-free,
  topmost, half-open at seek boundaries, duration-bearing, and identical in
  preview/playback/export planning.
- [x] Add a lazy, focus-contained accessible Caption editor with bounded cue
  DOM, keyboard list navigation/seek, track metadata, add/edit/delete,
  split/merge, batch timing, SRT/VTT import/download, live status, Escape, and
  toolbar focus return.
- [x] Cover canonical integer and NTSC frame rates, overlapping/touching cues,
  bounds/limits/markup, atomic failures, explicit plan/render semantics,
  selector duration, history, migration, save/load/recovery, controller races,
  UI accessibility, and architecture boundaries.
- [x] Pass 144 test files / 2,046 tests plus 16 benchmark-runner tests,
  production build/typecheck, oxlint, and the production high-severity audit
  with 0 vulnerabilities. Retain only the existing Vite chunk-size advisory.
- [x] Verify the real app only on port 41868: semantic edit, accessible dialog,
  caption-only preview, exclusive-end seek behavior, recovery, valid multiline
  SRT import, atomic line-specific malformed rejection, SRT/VTT downloads,
  import undo, a 30-frame 1080p H.264 caption-only export with native Chromium
  reopen/playback, and a console with 0 warnings/errors.
- [x] Record source identity from clean
  `c8bb2757833fa69da2360a56460bea6fd03274c0` /
  `sha256:1be12fbeed146910d5339d4f10696f719c9e0d247290d6bb8b0eeb378faedd1d`
  to implementation checkpoint
  `sha256:4fdd045a9fbdcda1938124f51cd9fd49b53dc114e1a2acd7e8767a9aaecc1473`.
  Publish the exact committed head as a ready PR, without merging it; final
  commit id is the authoritative delivered identity.

## Post-MVP issue #46 - minimal blend modes and compositing foundation

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-09).**

- [x] Persist exact `normal`, `multiply`, `screen`, and `overlay` clip intent in
  schema 9, migrate schema-8 caption documents without losing caption tracks,
  default blends to Normal, and retain bounded unsupported stored intent while
  rendering it through the source-over compatibility path.
- [x] Add one browser-free blend contract plus exact sRGB reference pixels for
  layer order, clip opacity, straight/premultiplied alpha, clipping, isolation,
  and transition-group semantics.
- [x] Carry explicit clip/group resolutions through the shared preview/export
  composition plan and use probed Canvas2D operations with restored state,
  safe fallback, and an explicit WebGL parity-registration seam.
- [x] Isolate complete text layers and transition groups, apply opacity/blend
  once at the correct boundary, and clear/release reusable intermediates on
  success and every failure path.
- [x] Add an accessible Inspector selector/reset with locked and unsupported
  states; connect it through canonical one-step undo/redo and all persistence
  paths.
- [x] After rebasing onto caption head
  `78d0d0756a9b9248d8c08f485bf4892407279347`, pass 280 reconciliation-focused
  tests across 10 files, all 2,077 Vitest cases across 146 files, all 16
  benchmark cases, build/typecheck, lint, diff check, and the zero-vulnerability
  production high-severity audit. Record the separate all-dependency audit's
  two inherited development-only highs against manifests unchanged from
  `origin/master`.
- [x] Verify two overlapping text layers, selection, undo/redo, reset, locked
  controls, Overlay preview, MP4 export-ready output, and recovery reload in
  real Chromium exclusively on port 41846. Re-run the conflict path after the
  caption merge with a persisted semantic cue above both layers; retain exact
  Overlay and caption intent through reload with zero warnings/errors, no error
  overlay, an inspected screenshot artifact, and the test port released.
- [x] Publish the exact committed branch as a ready-for-review PR targeting
  `master` with `Closes #46`; leave merge, deployment, and closure to the
  coordinating task.

## Post-MVP issue #67 - snapping and alignment guides

**IMPLEMENTATION COMPLETE (2026-08-09).**

- [x] Add one browser-free pure resolver for playhead, clip-edge,
  transition-edge, and sequence-marker candidates with integer-frame results,
  gesture-bound clamping, and deterministic distance/kind/frame/track/id ties.
- [x] Keep the default 8px tolerance visually stable by deriving its integer
  frame radius from the authoritative zoom; never persist presentation scale
  or fractional authored geometry.
- [x] Exclude the moving clip/link group, locked and hidden tracks, wrong-kind
  track candidates, and attached transitions while retaining global marker and
  playhead anchors.
- [x] Share the resolver across applicable pointer previews/commits,
  Ctrl/Cmd+Arrow moves, and ruler playhead scrubbing. Alt temporarily bypasses
  snapping without mutating the preference.
- [x] Persist an accessible snapping toggle with safe legacy-v1 defaults and
  render the active guide through transport-only state plus live status text.
- [x] Preserve the established transaction contract: previews and guides never
  touch document history, one completed gesture creates exactly one entry, and
  an already-aligned keyboard snap dispatches no no-op action.
- [x] Pass 136 focused tests, all 2,023 Vitest tests, all 16 benchmark-runner
  tests, TypeScript + production build, oxlint, and the production high-level
  dependency audit with 0 vulnerabilities.
- [x] Verify headed Chromium exclusively on port 41867 at 1px/frame and
  2px/frame, across eligible/ineligible anchors, pointer and keyboard paths,
  preference persistence, Alt bypass, history isolation, guide cleanup,
  1280×720 and 800×720 layouts, and a zero-warning/zero-error console.
- [x] Record clean-base fingerprint
  `sha256:89ee303aad205fd8ef1736e2ea63cc2cc454660442d4543d554de4d91088be87`
  at `c8bb275` and completed-implementation checkpoint
  `sha256:8cc9e64ea4f5b3f21d20dda536fca647fc8945f568cfe31f698c166855942bc0`;
  publish the final commit as a ready PR targeting `master` without merging it.
- [x] Rebase after Issue #68 onto `78d0d075`, retaining both completion records
  and caption schema 8/migration/implementation unchanged. Advance only the
  snapping unit fixture to schema 8 with empty captions; pass 233 targeted,
  2,062 full, 16 benchmark-runner, build, lint, and diff checks. Record the
  unchanged `master` dev-audit baseline of two high transitive findings while
  keeping the production audit at 0 vulnerabilities; skip repeat browser QA
  because the rebase resolution changed only docs and test compatibility.
- [x] Complete the final Issue #46 integration rebase onto `1a09f782`, retain
  caption schema 8 plus 7→8 migration and blend schema 9 plus 8→9 Normal
  migration/compositor behavior unchanged, and order the delivered records as
  captions → blends → snapping. Advance the snapping fixture to schema 9 with
  empty captions and explicit Normal blend intent; pass 385 targeted, 2,093
  full, 16 benchmark-runner, build, lint, both audits with the inherited
  dev-only baseline documented, production audit at 0, and clean diff checks.
  Carry forward browser evidence because only docs/test compatibility changed.

## Post-MVP issue #45 - versioned visual-effect stack foundation

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-10).**

- [x] Advance to timeline schema 10 with ordered, versioned effect descriptors;
  migrate schema-9 owned effects through registry hooks and preserve unknown
  type/version/order/payload through save, load, migration, and recovery.
- [x] Add the browser-free registry contract for typed parameter validation,
  defaults, migrations, capability declarations, deterministic status reports,
  and ordered evaluation. Preserve and bypass invalid/unsupported entries.
- [x] Add pure add, enable/bypass, parameter, reorder, reset, and remove edits
  plus one-snapshot store actions, exact undo/redo, locked/missing rejection,
  global effect-id uniqueness, and forward-compatible reset behavior.
- [x] Execute exposure, contrast, and saturation through the one shared
  preview/seek/export Canvas2D compositor before opacity/blending. Retain the
  exact no-effect path and use no new per-frame intermediate resources.
- [x] Add a four-tab accessible Inspector with native controls, roving keyboard
  focus, ordered status/action labels, and usable unknown/invalid fallbacks.
- [x] Pass 306 focused tests, all 148 Vitest files / 2,108 tests, all 16
  benchmark-runner tests, TypeScript plus production build, oxlint, production
  high-severity audit, and clean diff checks.
- [x] Record clean-base fingerprint
  `sha256:5acd7a8b1c89f0eafeef6ca504d183c18f415835da1fb994a65a97427ad84745`
  at `718c0d28e3611e2bad3b511d45ce1e3adcba0270` and completed dirty checkpoint
  `sha256:f791a282c72b571bdaff260e32a0232eb8ee0caf80cf40b1c66a9688d66e7a41`.
- [x] Verify real Chromium exclusively on port 41845: visible filtered output,
  all stack operations, undo/redo, keyboard tab focus, recovery reload, two
  ordered persisted effects, and a 150-frame 1920×1080 effected MP4 reaching
  Export ready. Record the in-app browser's missing Blob download event as a
  harness caveat, confirm 0 warnings/errors, and release the port.
- [x] Prepare a ready PR targeting `master` with `Closes #45`; leave merge and
  ordered #69/#70 rebases to the coordinating task.
- [x] Review remediation: centralize portable/live descriptor and aggregate
  budgets, reject over-limit adds/patches without history, and disable Add with
  an accessible reason at the selected clip/document limit.
- [x] Review remediation: replace Inspector's assumed Canvas capability with
  the actual worker preview-context report projected by the app into session
  state; document that export probes its separately owned context.
- [x] Review remediation: paint procedural text primitives unfiltered into the
  existing leg surface and apply the ordered stack exactly once to the
  completed layer draw before opacity/blending, with no additional surface.
- [x] Re-run post-review gates: 466 focused tests, all 149 files / 2,124 tests,
  16 benchmark-runner tests, build, lint, production audit at 0, clean diff,
  and real Chrome exclusively on strict port 41845. The worker reported both
  ordered text effects ready, effect bypass/application produced distinct
  Program Monitor screenshot hashes, browser diagnostics were empty, and the
  port was released.

## Post-MVP issue #69 - constant-speed clip retiming

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-10).**

- [x] Add schema-11 `SourceTimeMap` with exact integer source ticks, a reduced
  rational rate in whole 25-percentage-point steps bounded to 25%–400%, an
  exact preserved source span, strict validation, and a behavior-identical
  schema-10→11 migration after the existing schema-9→10 effect migration.
- [x] Make one browser-free mapping contract authoritative for selection,
  seeking, preview, playback, export, ordinary composition, crossfades,
  thumbnails, waveforms, trim, split, slip, slide, move, transition handles,
  and source-capacity checks.
- [x] Add pure constant-speed retiming for timed decoded media. Keep timeline
  start fixed; derive the greatest valid whole-frame duration without losing a
  fractional source tail; reject locked/still/text/overlap edits atomically;
  reconcile transitions and fades; remap animation keys by exact source-time
  intent with deterministic collision handling.
- [x] Route linked A/V retiming through the existing all-or-nothing linking
  contract and expose one document-store history entry per accepted edit, with
  rejected and idempotent edits preserving redo by reference. Mixed-rate
  groups accept already-at-target members without weakening atomic rollback.
- [x] Define the audio policy explicitly: exact 1× with integer source origin
  keeps existing audio; every other constant-speed map is muted consistently
  in live playback and export until pitch-safe time stretching is implemented.
  Exclude muted audio-only contributors from output/offline/Blob/fetch
  requirements while preserving any visual contributor using the same asset.
- [x] Add accessible Inspector Speed choices in 25% increments, Reset, exact
  timeline/source frame feedback, linked/locked eligibility feedback, and a
  visible explanation when audio is muted.
- [x] Cover rational no-drift/tail preservation, migration/round trips,
  operations and linking, transitions, animation remapping, selectors,
  filmstrips/waveforms, audio mixing/export silence, store history, Inspector,
  and shared composition planning with focused and complete automated gates.
- [x] Review remediation: reject unsafe retime ends; preserve exact keyframe
  source intent across repeated round trips; reject destructive key collisions;
  make split/trim mapping associative by accepting only fixed-tick-exact 25%
  steps; and cover mixed-rate linked groups plus muted-output resource policy.
- [x] Pass 375 focused tests across the eight review-contract files, all 2,159
  Vitest cases across 150 files, all 16 benchmark-runner tests, production
  build/typecheck, oxlint, the production high-severity audit with 0
  vulnerabilities, and clean diff/source-identity checks. Retain only the
  existing non-fatal Vite large-chunk advisory.
- [x] Rebase onto clean effect-stack base
  `c33ffa35aad0d8c2c993b6ccb6c9fbed4065c34c` /
  `sha256:77119aeef265c5fed69dbd0b7aaeea4d36dbb7da01dd52f2469e2027e81e8b04`
  and record completed dirty checkpoint
  `sha256:4034ac7db9317fcd78e9444b21e124b96ffd94e742ea6e94af2bfd2d0facfa3d`;
  use the final commit id as the authoritative delivered identity.
- [x] Verify observable UI behavior in real Chromium only on port 41869: open
  and validate a schema-10 effect-era fixture through schema 11, exercise
  100%→150%→Reset with 120→80→120 frame and audio-policy feedback, and prove a
  frame-1 key quantizes to frame 0 at 150% then returns to frame 1 at 100%.
  Finish with zero warning/error logs and release the test port. The portable
  media stayed offline, so decoded-frame behavior is attributed only to
  automated composition/runtime coverage.
- [x] Publish the exact committed branch as a ready PR targeting `master` with
  `Closes #69`; rebase it after Issue #45 so effects remain schema 10 and
  retiming becomes schema 11, then leave merge and closure to the coordinator.

## Post-MVP issue #72 - speed ramps on top of retiming

**IMPLEMENTATION COMPLETE (2026-08-10).**

- [x] Add schema-12 serializable piecewise speed curves over the preserved
  schema-11 constant fallback: bounded integer origin/points, canonical 0% or
  25%–400% rational speeds, strictly ordered persisted times, deterministic
  duplicate replacement in the editor, and explicit hold/linear/smooth easing.
- [x] Integrate every segment through one BigInt-backed integer primitive so
  direct mapping, split, trim, duration inversion, keyframe remapping, and
  repeated edits retain exact phase without floating accumulation.
- [x] Permit only bounded freezes with a later positive point; reject terminal
  freezes, unsafe bounds, excessive point counts, duplicates, malformed easing,
  and non-canonical speeds. Preserve the constant visual fallback for invalid
  in-memory curves, fail audio closed, and reject malformed portable intent.
- [x] Route duration, thumbnails, waveforms, seek/scrub, trim and transition
  handles, ordinary/crossfade composition, preview, and export through the same
  map. Preserve the established audio policy: exact integer-origin 1× and
  all-1× curves keep audio; variable ramps/freezes are explicit shared silence
  until pitch-safe time stretching exists.
- [x] Add accessible Inspector ramp editing with add/select-at-playhead, ordered
  point navigation, speed/easing controls, removal, clear, live duration/audio
  feedback, linked atomicity, locked/bounds rejection, and byte-exact undo/redo.
- [x] Cover migration/round trips, hostile curve validation, every easing and
  freeze boundary, split/trim phase, extreme duration inversion, operations,
  linking/history, transitions, composition, filmstrip/waveform mapping, gesture
  capacity, audio policy, and the accessible Inspector in focused tests.
- [x] Pass the complete test/build/lint/production-audit gates and clean diff/
  source-identity checks; record exact counts and any retained advisories.
- [x] Verify representative long scrub/play/export behavior and accessible ramp
  editing in real Chromium only on strict port 41872, retain truthful artifacts,
  finish with clean diagnostics, and release the port.
- [x] Publish the exact committed branch as a ready PR targeting `master` with
  `Closes #72`; do not merge, close manually, or rebase after publication.

Validation: 2,226 complete Vitest cases across 159 files plus all 16
benchmark-runner cases; production build/typecheck; oxlint; zero-vulnerability
production high audit; clean diff checks. Real Chromium on strict port 41872
imported/relinked a 90-second H.264/AAC source, authored a linked
100%-smooth -> 0%-hold -> 200%-smooth curve, scrubbed and played across its
bounded freeze, proved undo/redo and recovery reload, and completed a 27.5-second
1280x720 MP4 export. Decoded export frames 325 and 425 were identical while
frame 700 differed; the deliberate silent AAC track measured -91.0 dB
mean/max. Browser warnings/errors were zero and port 41872 was released.

## Post-MVP issue #70 - OPFS editing proxies

**IMPLEMENTATION COMPLETE (2026-08-10).**

- [x] Publish the exact browser-native input/output codec matrix and keep the
  Generate action disabled until the current source decoder plus exact AVC MP4
  output configuration, including actual rational frame rate, passes a fresh
  disposable runtime probe.
- [x] Add a strict versioned origin-local OPFS manifest with stable asset
  identity, sampled source fingerprint, full profile/generator provenance,
  bytes, creation/last-use timestamps, manifest-first replacement, and bounded
  LRU eviction against honest browser origin estimates.
- [x] Keep proxy facts out of `TimelineDoc`, portable project/recovery formats,
  remembered media, and export preferences. Share one pure representation
  policy: Preview prefers only a fresh proxy; final export always revalidates
  and requires the original.
- [x] Add Media Pool quota/usage/persistence facts, per-video generation
  progress, cancel/retry/regenerate/remove, and explicit clear-all UX. Offline,
  stale, unsupported, quota, source replacement/removal, worker/decode, and OPFS
  failures remain recoverable and never silently become project truth.
- [x] Bound conversion to one scheduler job and one active decoder with
  sequential canvases, awaited encoder/OPFS backpressure, and explicit cleanup
  of Input, output, staged file, and decoder telemetry on every exit.
- [x] Close independent-review races: two-phase cache commit rollback after the
  final source/lifecycle guard, scheduler-idle remove/clear serialization,
  ref-counted async React lifecycle cleanup, exact-video-span/zero-time output,
  hostile-manifest rejection, and CSS/planner-aligned full-row video cards.
- [x] Record focused/full tests, build, lint, audit, diff/fingerprint, real
  Chromium generation/cancel/regeneration/offline/export gates, useful stress
  benefit, clean diagnostics, and exclusive port 41870 release.
- [x] Publish the exact commit as a ready PR targeting `master` with
  `Closes #70`; leave ordered integration to the milestone coordinator.

Validation: 170 focused post-rebase tests; 2,186 complete Vitest cases across
155 files plus 16 benchmark-runner cases; build/typecheck; oxlint; clean
production high audit and diff
checks. Real Chromium converted a 50,948,082-byte 3840x2160 12-second H.264
long-GOP source to a reported 3.0 MiB 1280x720 proxy in 2.9 seconds, preserved
the committed proxy through regeneration cancellation, rendered it offline,
blocked final export until original relink, then completed original-backed
1920x1080 MP4 export in 4.413 seconds. Console warnings/errors and Vite overlays
were zero; only strict port 41870 was used and released.

Independent review reran the exact timeline-selected source in real Chromium.
Original worker-complete seeks measured 456.6 ms median / 1176.7 ms p95 and
456.2 / 1176.2 ms worker render; proxy seeks measured 15.9 / 21.5 ms and
15.8 / 21.3 ms (about 96.5% lower median worker cost). A serialized, unpaced
live-bridge capacity trial capped at 119 frames/four seconds rendered 35/119
original frames in 4081.3 ms (8.576 fps, 84 budget misses) and all 119 proxy
frames in 2631.5 ms (45.221 fps, no misses). Paint-boundary samples were kept
separate and excluded from the benefit claim because background Chromium
animation-frame throttling dominated them; the result is local-fixture evidence,
not a universal codec or GPU promise.

The cumulative schema-11 rebase onto `532a728` kept the proxy as a disposable
sidecar and final export original-only. A fresh strict-41870 Chromium smoke
showed both Timing and Effect-stack contracts, reopened the 3.0 MiB proxy as
ready, and repeated the proxy measurement at 15.5 / 22.3 ms completion,
15.2 / 21.8 ms worker render, and 119/119 frames in 2634.3 ms (45.173 fps,
zero misses). Browser diagnostics were clean and the port was released. The
full production benchmark completed with clean console/resource restoration;
its repository-wide proposed thresholds remain advisory rather than Issue #70
acceptance claims.

## Post-MVP issue #71 - basic color correction and video scopes

**IMPLEMENTATION COMPLETE (2026-08-10).**

- [x] Extend the stable version-1 built-in color descriptor compatibly with
  bounded temperature and tint while retaining exposure, contrast, saturation,
  old-descriptor defaults, unknown preservation, persistence, recovery, and one-
  entry history operations.
- [x] Specify and test the exact pixel contract: display-referred unpremultiplied
  8-bit sRGB, byte-identical alpha, transparent-RGB transformation, float64
  intermediates, per-descriptor clamp, final nearest-byte rounding, and authored
  stack order.
- [x] Apply the same correction implementation in shared preview/export
  composition for media, stills, crossfade legs, and procedural text before
  opacity/blending, with an explicit pixel-readback capability fallback.
- [x] Add fixed-resource histogram, waveform, and vectorscope analysis in a
  dedicated worker behind a one-pending/four-Hz render-worker sampler with
  generation guards and disable/replacement/close cleanup.
- [x] Add accessible Inspector enable/bypass/order/reset/remove plus labeled five-
  parameter controls, and a session-only Program Monitor scope toggle with ARIA
  tabs, Arrow-key navigation, status copy, and unsupported-capability feedback.
- [x] Cover neutral identity, SDR fixture values, full/partial transparency,
  still/text/crossfade composition, preview/export agreement, legacy version-1
  omission, save/recovery/history, scope math, cadence, stale work, and resource
  cleanup.
- [x] Pass the full gate: 2,224 Vitest cases across 162 files plus 16 benchmark-
  runner cases, production build/typecheck, oxlint, production high audit with 0
  vulnerabilities, and clean diff/source evidence.
- [x] Verify real Chromium only at
  `http://127.0.0.1:41871/` using `--host 127.0.0.1 --port 41871 --strictPort`:
  two ready color descriptors, all five values, order/bypass/reset/recovery,
  keyboard-selected histogram/waveform/vectorscope, 14,400-sample analysis
  advancing from frame 2 to frame 41 during playback, disable/restart cleanup,
  zero browser warnings/errors, screenshot evidence, and released port.
- [x] Publish the exact commit as a ready PR targeting `master` with
  `Closes #71`; do not merge, close the issue manually, or touch Issue #72's
  isolated worktree/branch.

## Security hardening - six audit findings

**COMPLETE LOCALLY (2026-08-10).**

- [x] Bind remembered local media handles to opaque origin-local project
  identity, preserve exact-handle and legacy-record migration, and prevent a
  copied portable document id from inheriting the original's grants.
- [x] Owner-scope OPFS proxy manifests, runtime tokens, mutation, and offline
  selection; quarantine schema-1 entries until a connected source proves the
  fingerprint required for adoption.
- [x] Replace unbounded remembered-handle fan-out with an ordered,
  cancellation-aware pool of at most eight IndexedDB reads.
- [x] Enforce shared dimension, pixel, and aggregate compositor-memory limits
  before portable-project use, worker canvas resizing, and export allocation.
- [x] Reject excessive export frame counts, durations, and bitrate-derived
  output estimates before creating an encoder, sink, or frame lease.
- [x] Replace Docker's denylist context with an exact production-input
  allowlist. Keep Cloudflare Pages unchanged: it continues to deploy only the
  Vite `dist` artifact and does not use Docker.
- [x] Pass 2,205 Vitest cases across 159 files, all 16 benchmark-runner cases,
  build/typecheck, oxlint, the production audit at 0 vulnerabilities, and a
  strict-port real-Chromium editor smoke with zero warnings/errors or
  non-static requests. Preserve the independently reproduced `master` browser
  baseline failure for the undersized audio-overload reset target as separate
  work; Docker image execution remains unverified because the local Linux
  daemon was not running.

## Milestone 4 issue #73 - masks and chroma key

**COMPLETE LOCALLY (2026-08-11).**

- [x] Add bounded rectangle, ellipse, and normalized cubic-Bezier mask
  descriptors with project-space clipping, alpha, feather, invert, enable, and
  exact authored ordering after crop/transform and before opacity/compositing.
- [x] Add a safe-default chroma-key descriptor with explicit key color,
  tolerance, softness, and spill suppression in the same executable pixel chain
  as color and mask effects.
- [x] Introduce schema-13 `ClipAnimation.effectTracks`, stable effect-id
  addressing, evaluator/budget rules, and source-time/retime/split/trim/remint/
  duplicate behavior; prune tracks atomically on remove/reset and preserve
  unknown authoring intent deterministically.
- [x] Migrate schema 12 by identity, including clips whose animation was omitted;
  require canonical current `effectTracks` and keep intentional legacy fixtures.
  Mechanically update only 66 current-document schema literals across 48 tests.
- [x] Preserve byte behavior for no-effect and eligible filter-only paths while
  sharing exact pixel execution, opacity order, and fallback semantics across
  Program Monitor, transitions, text, and export.
- [x] Add accessible ordered Inspector editing and effect-key controls, including
  synchronized rejected Bezier drafts and static text-effect editing. Deliberately
  leave direct mask gestures and text effect animation outside this slice rather
  than add an unbounded or misleading interaction.
- [x] Pass 293 final-tree focused tests, the explicit 81-test budget/migration
  subset, all 2,260 Vitest cases across 163 files plus 16 benchmark checks,
  build/typecheck,
  oxlint, and the production dependency audit at 0 vulnerabilities.
- [x] Verify real Chrome at `http://localhost:5181/` using only strict port 5181:
  local fixture import/drop, three ready effects, frame-0/frame-35 mask geometry,
  transformed/cropped project-space behavior, reorder undo/redo, bypass, rejected
  Bezier draft recovery, reload/recovery/offline restore/relink persistence, and
  no console errors; save exact screenshot hashes and release the port. Keep
  noncommuting stack order, colored-destination transparency, and encoded-export
  parity claims grounded in deterministic tests rather than browser observation.
- [x] Publish the exact commit as a draft PR targeting `master` with `Closes
  #73`; do not merge or manually close the issue, and leave Issue #74's isolated
  worktree/branch untouched.

## Milestone 4 issue #73 - review hardening follow-up

**COMPLETE LOCALLY (2026-08-11).**

- [x] Make Program Monitor readiness playhead-aware through the shared pure
  effect-track evaluator, while indexing effect owners on document changes and
  resolving only animated owners during animation-frame refreshes.
- [x] Give every budget-disabled effect Add button an accurate stable accessible
  description, including mixed per-type aggregate-limit cases.
- [x] Enforce the shared 100,000-key aggregate limit before all key-growing
  direct edits, at-frame multi-edits, animated inserts, and splits; keep
  non-growth edits legal at the cap and rejected store actions history-neutral.
- [x] Preflight Reset through descriptor and replacement-budget checks before
  changing defaults or clearing tracks.
- [x] Preflight cloned effect descriptors on insert and split against the shared
  aggregate effect, parameter, and string budgets; reject exact-cap growth
  without history while keeping effectless zero-growth operations legal.
- [x] Replace Bezier per-pixel double edge scans with scanline coverage and
  clipped edge-neighborhood feather distances using grow-only `Uint8Array` and
  `Float32Array` scratch. Cover zero feather and representative 5% feather at
  1080p under a generous CI-safe threshold; document that maximum feather can
  still approach edges times clipped-region pixels.
- [x] Use a bounded 32-step nearest-boundary solve for project-space Euclidean
  ellipse distance; verify equal inward axis coverage plus wide-ellipse center
  and adjacent-pixel continuity. Skip exact work at zero feather, outside the
  ellipse, and in the provably full-coverage interior; gate zero, 5%, and
  maximum feather at 1920x1080 under 2 seconds each.
- [x] Pass the earlier 67-test focus and 415-test broad subset, a final 291-test
  ellipse/budget focus, all 2,281 Vitest cases across 163 files plus 16
  benchmark-runner checks, standalone TypeScript, production build/typecheck,
  oxlint, and the production audit with
  0 vulnerabilities. Publish the Aryel-only follow-up commit and verify its exact
  remote SHA and fresh CI on draft PR #107 before handoff.

## Milestone 4 Part 9b / issue #74 - dynamic zoom and reframe presets

**COMPLETE (2026-08-10).**

- [x] Add four bounded, editable framing presets that compile into normal
  Position X/Y and Scale X/Y keyframes only, with no procedural durable state,
  second evaluator, or schema bump.
- [x] Accept editable start/end horizontal and vertical focus, safe zoom,
  integer-frame duration, and existing easing; support reverse by swapping
  endpoints and reversing cubic-bezier timing.
- [x] Use portable descriptor dimensions first, with a connected-asset fallback,
  and solve full-canvas coverage from project aspect, source size, crop, anchor,
  and static rotation in compositor transform order.
- [x] Clamp requested duration to clips of at least two frames; support stills,
  reject one-frame clips and text with an accessible reason, support static crop
  and rotation, reject animated Rotation, and leave transition evaluation on the
  shared ordinary clip resolver.
- [x] Make Apply, Reverse, and Reset deliberate one-entry history operations.
  Replace/remove only all four framing properties, preserve static and unrelated
  curves/container fields, avoid pointer-move document writes, and state Reset's
  no-hidden-provenance boundary in the UI.
- [x] Keep the Inspector, monitor, scrub, recovery, and export on
  `resolveClipAnimationAtFrame`; expose labeled native controls, fieldsets,
  keyboard tab navigation, a live status, and direct disabled-reason descriptions.
- [x] Cover safety math, eased interior frames, resolver parity, source-time ticks,
  persistence, still/text/short/locked/rotation behavior, transitions through the
  existing composition tests, history/idempotence, descriptor priority, reset,
  and accessible keyboard/screen-reader UI.
- [x] Pass the final gate: 2,261 Vitest cases across 166 files plus 16 benchmark-
  runner cases, build/typecheck, oxlint, clean diff checks, and production audit
  with 0 vulnerabilities.
- [x] Verify real headed Chromium only at `http://localhost:5182/` using
  `npm run dev -- --port 5182 --strictPort`: real still import, keyboard access,
  200-to-150-frame clamp, exact local frames 0/75/149, Reverse, Reset, undo,
  720x800 overflow, recovery while offline, relink, and a downloaded 1080x1920
  H.264 export with 180 frames at 30 fps. Record local artifacts/hashes, confirm
  zero console warnings/errors, and release port 5182.
- [x] Publish a draft PR targeting `master` with `Closes #74`; do not merge or
  manually close the issue. Rebase after #73 only when the milestone coordinator
  integrates the schema-13 effect-track work.

## Milestone 4 Part 9b / issue #74 - schema-13 integration follow-up

**COMPLETE LOCALLY (2026-08-11).**

- [x] Rebase the exact old issue-74 head `e9fdbbd` onto the merged issue-73 head
  `e0778ab`; resolve only `domain/operations.ts` and `docs/PLAN.md` semantically,
  retaining schema-13 `effectTracks`, effect APIs, compositor ordering, budget
  authorities, and both issue records.
- [x] Keep dynamic zoom as four ordinary transform tracks, preserve the complete
  animation container on Apply/Reset, and preflight its net key growth against
  the shared 100,000-key document budget without rejected history entries.
- [x] Add schema-13 focused coverage proving Apply and Reset retain effect tracks
  and exact-cap rejection is a no-op; confirm the old/new range-diff contains
  only the expected integration changes.
- [x] Pass 17 narrow issue-74 tests, the 177-test dynamic/schema/effects/
  compositor focus, all 2,299 Vitest cases across 167 files plus 16 benchmark
  checks, production build/typecheck, oxlint, clean diff checks, and the
  production audit with 0 vulnerabilities.
- [x] Verify real headed Chromium only at `http://localhost:5182/` using the
  required strict-port command: real still import/drop, a rectangle-mask effect
  key, Apply, exact interior scrub, Reverse, Reset, Ctrl+Z restoration, and
  effect-track survival. Record five ignored screenshot hashes, confirm zero
  console warnings/errors, and release port 5182.
- [x] Force-push only with the exact old-head lease, update draft PR #106 with
  the rebased evidence, and wait for exact-head CI. Do not merge or manually
  close issue #74.

## Milestone 4 Part 9b / issue #74 - signed-flip and accessible-status follow-up

**COMPLETE LOCALLY (2026-08-11).**

- [x] Match compositor signed-scale geometry for horizontal, vertical, and
  combined flips around arbitrary anchors while retaining crop, rotation,
  centered-anchor, endpoint, and eased-interior safety.
- [x] Share exact net-key growth between readiness and Apply; expose explicit
  changed/unchanged/rejected domain/store outcomes so budget rejection cannot
  be mistaken for idempotence and history remains untouched.
- [x] Make current invalid draft, missing dimensions, track lock, animated
  rotation, and budget reasons outrank stale feedback; clear feedback on draft
  edits and give disabled Reset its own directly associated lock/no-track reason.
- [x] Pass 22 focused tests, all 2,304 Vitest cases across 167 files plus 16
  benchmark checks, production build/typecheck, oxlint, clean diff checks, and
  the production audit with 0 vulnerabilities.
- [x] Verify real Chrome at strict port 5182 with a 1672x941 still on a square
  canvas, Anchor X 20%, horizontal flip, disabled-reason transitions, Apply,
  eased interior scrub with full coverage, Reverse, Reset, Ctrl+Z, lock/unlock,
  two hashed screenshots, and 0 console warnings/errors; release the port.

## Milestone 4 Part 10b / issue #75 - optional WebGPU acceleration evaluation

**COMPLETE LOCALLY (2026-08-12): NO-GO FOR PRODUCTION SELECTION.**

- [x] Select the existing fixed 160x90, four-Hz completed-frame video-scope
  analysis as the bounded Part 8a workload. Keep Canvas2D sampling plus the
  dedicated CPU analysis worker as the supported/default path.
- [x] Define one exact integer/fixed-point CPU/WGSL contract, preserve shipped
  Float64 direction at exact luma, waveform, Cb, and Cr half bins through four
  upload correction bits, and gate WebGPU initialization with a complete
  deterministic parity self-test containing both midpoint directions.
- [x] Add an internal-build-only dynamic adapter with explicit API/adapter/
  initialization probing, one device/pipeline owner, 353,304-byte maximum
  request buffer budget, `finally` destruction, device-loss observation,
  CPU fallback, idempotent release, and child-worker release acknowledgment.
- [x] Keep ordinary production output free of the WebGPU adapter/shader chunk;
  an explicitly enabled build emits one separate 11.27 kB experiment chunk.
- [x] Add a repeatable strict-port Chrome runner with source/fixture fingerprint,
  exact correctness, latency, startup, explicit buffer memory, adapter/CDP GPU,
  device-loss, console, cleanup, and port-release evidence.
- [x] Capture the historical headed decision run on Chrome 151 / Windows 11 /
  Radeon RX 6600: 71 exact parity comparisons; CPU 1.000 ms median / 1.400 ms
  p95 versus WebGPU 4.400 / 5.100 ms; 418.400 ms WebGPU startup; 30,720 versus
  353,304 explicit bytes; exact CPU recovery after real device destruction;
  zero remaining buffers, browser warnings/errors, or occupied port. This run
  predates the final self-test release-race fix and is not exact-head evidence.
- [x] Include in that historical decision evidence a flagged real-app pass on
  the same strict port: create a text clip, load the opt-in module through the
  actual analysis worker, publish 14,400 visible samples at frame 0, move scope
  tabs by keyboard, disable/release, save screenshot hash evidence, keep 0
  warnings/errors, and release the port.
- [x] Record the no-go recommendation and unmeasured support-matrix boundaries
  in `docs/WEBGPU_EXPERIMENT.md`. Reconsider only if a future design removes
  the CPU readback/upload round trip or materially increases useful compute,
  followed by exact multi-browser/device evidence before any default change.
- [x] Before the later shutdown follow-ups, pass 118 focused lifecycle/
  integration tests, all 2,321 Vitest cases across 169 files plus 16 benchmark-
  runner checks, normal and opt-in production build/typecheck, oxlint, diff
  checks, and the production high audit with 0 vulnerabilities.

## Milestone 4 Part 10b / issue #75 - shutdown-handshake review follow-up

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-12); THE FINAL EXACT-HEAD BENCHMARK IS A PR-RECORDED MERGE GATE.**

- [x] Make the child scope-worker release operation expose a completion promise
  covering both the active child and every earlier retirement, with exact-once
  acknowledgment/error/post-failure/timeout settlement.
- [x] Await that completion during render-worker close before publishing
  `closed`; retain the 250 ms child fallback and independent 1,000 ms bridge
  fallback, while ordinary scope disable remains non-blocking.
- [x] Prevent a delayed opt-in module import from creating a WebGPU analyzer
  after the child has already acknowledged release.
- [x] Keep release terminal after every awaited session/self-test boundary.
  A candidate self-test rejection after release must release that candidate,
  preserve `released`, abort the in-flight request, and prevent every later
  analysis from returning CPU fallback; cover the race deterministically.
- [x] Cover idle close, disable-then-close, repeated release, acknowledgment,
  exact timeout, late acknowledgment, and delayed-import races. Before the
  final self-test race case was added, pass 118 focused tests, all 2,321 Vitest
  cases across 169 files, and all 16 benchmark checks.
- [x] Pass normal and opt-in production build/typecheck, preserve the ordinary
  WebGPU-free graph and flagged 11.27 kB experiment chunk, pass oxlint and the
  production high audit at 0 vulnerabilities. The headed Chrome run with exact
  parity, device-loss fallback, zero live buffers, clean diagnostics, strict-
  port release, and source fingerprint
  `sha256:b37ec7c43331995499dc2396b298e069c69686718bac94283b2838360e6813dc`
  predates the final race fix and is historical decision context only. Keep the
  production no-go.
- **External merge gate:** From the final clean committed head, rerun
  `npm run benchmark:webgpu-scopes -- --warmup 10 --iterations 60`, preserve
  the ignored `.tmp/issue-75-webgpu/` JSON/Markdown artifact, and publish its
  source/fixture fingerprints plus parity, device-loss, cleanup, diagnostics,
  and strict-port results in PR evidence. Make no tracked-doc edit afterward.
## Part 10c / issue #76 - sandboxed plugin capability and security design

**DESIGN AND NON-EXECUTING PROTOTYPE COMPLETE LOCALLY (2026-08-11).**

- [x] Publish the complete review boundary in `docs/PLUGINS.md`: strict versioned
  manifest and compatibility negotiation; deterministic offline package shape;
  complete-entry integrity; Ed25519 signer continuity; local trust, permission,
  update, rollback, downgrade, revocation, and safe-mode behavior.
- [x] Constrain the first implementation to signed WebAssembly behind a
  host-authored opaque-origin iframe broker and dedicated worker. Supply one
  bounded imported memory and no callable imports; reject package JavaScript,
  remote URLs, network, files/handles, storage, DOM/custom UI, audio, codecs,
  project mutation, export sinks, threads, shared memory, and background work.
- [x] Define only one first contribution/capability: a host-rendered ordered
  video effect that receives one isolated RGBA8 layer plus exact integer-frame/
  rational-rate facts and bounded primitive parameters. Preserve shared authored
  preview/export stack order and fail export rather than silently omit effects.
- [x] Threat-model hostile archives/manifests/projects/modules, supply-chain and
  signer compromise, file/media overreach, network/storage exfiltration, Wasm
  escape/import smuggling, denial of service, stale messages, output integrity,
  permission fatigue, migration/data loss, revocation, and residual browser/
  side-channel risk in `docs/PLUGIN_THREAT_MODEL.md` with severity calibration.
- [x] Add pure `domain/pluginManifest.ts` validation/negotiation only: exact
  keys, bounded identities/ranges/paths/memory/contributions/parameters, Wasm-
  only runtime, required frame permission, exact version selection, and stable
  namespaced descriptor types. It performs no I/O, trust mutation, registration,
  package loading, or execution; byte-level ZIP/JSON/signature work stays gated
  on Issue #77.
- [x] Prove unknown plugin descriptors round-trip disabled through the existing
  portable project/effect contract without URLs, Wasm paths, installation, or
  execution. Missing, incompatible, denied, revoked, crashed, and safe-mode
  plugins preserve authored data and remain bypass/reorder/remove/save capable.
- [x] Pass 99 focused manifest/project/effect/architecture tests, all 2,317
  Vitest cases across 168 files, all 16 benchmark-runner checks, production
  build/typecheck, warning-free oxlint, `git diff --check`, and
  `npm audit --omit=dev --audit-level=high` with 0 vulnerabilities.
- [x] Record browser verification as not applicable to this design-only slice:
  the prototype has no production import, registry, UI, worker, sandbox, package
  parser, or execution path, and its identifying strings are absent from the
  production bundle. Real hostile-sandbox Chromium gates are explicit Issue #77
  prerequisites rather than fabricated Issue #76 runtime evidence.
- [x] Bind evidence to clean base
  `00daac79cd26b2e0a503477d629635f0d15da853` /
  `sha256:058d3e740f1c760a7349e78299f3e3cb6d97649f4e18a5192ec9ad0fe89d89ee`
  and initial pre-evidence checkpoint
  `sha256:994caa4e793d1e57d2f45e97fbc86107866e3a1dba72a3311b3bf1dd112d4f4b`.
  Final review then added independently versioned contribution negotiation;
  the final commit SHA is the authoritative delivered identity.

## Part 10c / issue #76 - PR #112 review hardening

**COMPLETE LOCALLY (2026-08-11).**

- [x] Keep every accepted numeric parameter range inside the shared durable
  effect magnitude and reject the same reserved record keys as portable/live
  effect validation.
- [x] Raise the bounded imported-memory ceiling to 1,025 pages so the maximum
  legal 64 MiB RGBA frame retains one non-overlapping 64 KiB canonical-parameter
  page; keep smaller declarations explicitly unavailable when a call will not
  fit.
- [x] Add exact bounded migration declarations to the version-1 contribution
  schema, validate deterministic forward chains, require distinct render and
  migration exports, and publish the typed migration call/cleanup contract.
- [x] Keep migration explicit, sandboxed, cloned, and history-atomic. Descriptor
  migration ABI version 1 rejects an instance targeted by any effect-animation
  track before plugin code runs and preserves the original descriptor plus
  complete animation; animated migration requires a future versioned contract.
- [x] Pass 109 focused manifest/project/effect/architecture tests, all 2,323
  Vitest cases across 168 files, all 16 benchmark-runner checks, production
  build/typecheck, warning-free oxlint, clean diff checks, and the production
  high-severity audit with 0 vulnerabilities.
- [x] Retain the original browser-verification decision: this remains a pure
  design/non-executing prototype with no production plugin runtime or observable
  browser behavior. Issue #77 still owns hostile-sandbox Chromium gates.

## Part 10c / issue #76 - PR #112 aggregate table-budget follow-up

**COMPLETE LOCALLY (2026-08-12).**

- [x] Bound the WebAssembly module to at most 16 defined tables, require every
  table to declare a maximum no greater than 4,096 entries, and cap both aggregate
  initial entries and aggregate declared maxima at 4,096.
- [x] Enforce all three module-wide table limits during Issue #77 binary-policy
  parsing before compilation or instantiation, and add exact count/initial/max
  boundary fixtures to that implementation gate.
- [x] Mirror the same numbers in package budgets and the threat model while
  retaining the existing prohibition on table imports and all other ambient
  imports except the one host-supplied bounded memory.
- [x] Pass 103 focused manifest/project/effect/architecture tests, all 2,323
  Vitest cases across 168 files, all 16 benchmark-runner checks, production
  build/typecheck, warning-free oxlint, clean diff checks, and the production
  high-severity audit with 0 vulnerabilities. Exclude the first full-suite launch
  from evidence because an accidentally short command timeout stopped it after
  five seconds; the immediate full rerun passed.
- [x] Keep browser verification explicitly not applicable to this non-executing
  design slice. Issue #77 retains the hostile-module browser gates.

## Part 10c / issue #76 - PR #112 contribution-dispatch follow-up

**COMPLETE LOCALLY (2026-08-12).**

- [x] Require every contribution to name a package-unique render entrypoint and
  keep the complete render-name set disjoint from differently typed migration
  exports regardless of contribution declaration order.
- [x] Use the selected render export itself as the WebAssembly-call contribution
  discriminator, retaining the ten-integer ABI without copying a contribution-id
  string or another selector into untrusted memory.
- [x] Align the normative plugin contract, threat model, architecture boundary,
  and focused validator coverage so Issue #77 has one explicit dispatch rule.
- [x] Pass 111 focused manifest/project/effect/architecture tests, all 2,325
  Vitest cases across 168 files, all 16 benchmark-runner checks, production
  build/typecheck, warning-free oxlint, clean diff checks, and the production
  high-severity audit with 0 vulnerabilities.
- [x] Keep browser verification not applicable to this pure non-executing
  validator/design follow-up; Issue #77 owns hostile-module dispatch fixtures.

## Part 10c / issue #76 - PR #112 intermediate-migration follow-up

**COMPLETE LOCALLY (2026-08-12).**

- [x] Make multi-step migration verification implementable without adding
  undeclared historical schemas: validate every non-final result as canonical
  bounded primitive parameter data, then validate only the final result against
  the current contribution parameter schema.
- [x] Bound every intermediate to one strict UTF-8 canonical JSON object of at
  most 65,536 bytes and 64 entries. Reuse the 1-to-64-character ASCII local-
  identifier grammar for keys and string values, exclude the three reserved
  record keys, bound finite numbers to +/-1,000,000,000, and reject nulls,
  arrays, nested objects, duplicate keys, and noncanonical bytes before another
  step.
- [x] Apply shared durable descriptor and whole-document replacement budgets only
  to the final candidate, with no intermediate document or history mutation.
- [x] Close the latest exact-head Codex P2 by making descriptor migration ABI
  version 1 static-instance-only. Before any migration export runs, reject the
  entire chain if an owning `ClipAnimation.effectTracks` entry targets that
  effect instance id, preserving the original descriptor and complete animation.
  Do not use key-range-only validation; animated schema or unit migration needs
  a future, separately versioned contract.
- [x] Keep all parser, package, sandbox, and migration execution work gated on
  Issue #77; this follow-up adds no production plugin runtime or browser surface.
- [x] Pass all 20 focused plugin-manifest tests, the test wrapper's 16 benchmark-
  runner checks, and `git diff --check`.

## Part 10c / issue #76 - PR #112 activation and declaration-budget follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Close the exact-head Codex start-function P2 by rejecting every WebAssembly
  start section during host-authored byte-policy parsing, before validation,
  compilation, or instantiation can execute package code. The later candidate-
  worker parser follow-up below corrects the parser's realm/ordering.
- [x] Run engine validation, asynchronous compilation, and instantiation in a
  fresh, disposable activation-candidate worker under one parent wall-clock
  deadline that never resets and expires after five seconds. Promote it to the
  dedicated runtime worker only after an instance-ready acknowledgement;
  otherwise terminate it and the sandbox.
- [x] Close the exact-head Codex declaration-bomb P2 with explicit pre-engine
  ceilings: 1,024 types; 8,192 imported-plus-defined functions; 16 tables/4,096
  aggregate entries; one imported memory/1,025 pages; 2,048 globals; 8,192
  exports; 1,024 element segments/4,096 elements; 1,024 data segments/8 MiB;
  exactly one import; zero tags; and 16,384 aggregate declaration entries.
- [x] Keep this follow-up design-only and non-executing. Issue #77 retains the
  byte parser, activation worker, browser deadlines, and hostile-module boundary
  fixtures.
- [x] Pass 111 focused manifest/project/effect/architecture tests across five
  files, the test wrapper's 16 benchmark-runner checks, and `git diff --check`;
  keep browser verification intentionally not applicable.

## Part 10c / issue #76 - PR #112 RGBA color-encoding follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Close the exact-head Codex color-interpretation P2 by defining capability
  version 1 input and successful output as display-referred IEC sRGB: nonlinear
  sRGB OETF code values, sRGB/Rec.709 primaries, D65 white point, and explicitly
  not linear-light or Display-P3.
- [x] Define each pixel as four `R, G, B, A` bytes with independent, linearly
  quantized straight/unassociated alpha; RGB is never premultiplied by alpha,
  including when alpha is zero.
- [x] Make the host responsible for exact conversion before plugin copy-in and
  identical interpretation/conversion after copy-out. Share that boundary across
  preview/export and pass no ICC/profile or other gamut metadata to the plugin.
- [x] Keep the clarification non-executing; Issue #77 retains implementation and
  cross-browser ABI byte fixtures.
- [x] Pass 111 focused manifest/project/effect/architecture tests across five
  files, the test wrapper's 16 benchmark-runner checks, and `git diff --check`;
  keep browser verification intentionally not applicable.

## Part 10c / issue #76 - PR #112 export-instance and numeric-step follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Give each export attempt fresh export-owned mutable runtime state: worker,
  Wasm instance, imported memory, private port, queue, and generation. The later
  exact-head correction permits only a fresh copy of exact-key verified raw Wasm
  bytes and requires every activation gate to repeat; compiled/engine artifacts
  never cross lifecycles.
- [x] Bound that session-only raw-byte cache to eight private entries and 64 MiB
  actual retained bytes with checked accounting, fresh-copy ownership,
  deterministic access/key LRU, and lifecycle/trust/revocation/update
  invalidation; remove compiled-code leasing entirely.
- [x] Serialize planned plugin calls by ascending requested frame and authored
  plan order, isolate them from preview/scrub messages, destroy export state on
  every terminal outcome, and restart a retry from its first requested frame.
- [x] Reserve all required package sandboxes during preflight under the hard
  eight-resident ceiling, failing before sink/encoder acquisition rather than
  evicting and reinstantiating stateful modules during export.
- [x] Reject positive finite numeric steps that cannot make representable
  IEEE-754 progress from either declared endpoint; cover asymmetric magnitudes,
  the reported huge-endpoint/subnormal case, and ordinary accepted steps.
- [x] Keep the change design-only except for pure manifest validation/tests;
  Issue #77 retains runtime implementation and hostile stateful-module browser
  fixtures, so browser verification remains intentionally not applicable.

## Part 10c / issue #76 - PR #112 memory-layout and expanded-declaration follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Replace the infeasible pixel-plus-parameter-only calculation with one
  fixed 258-to-1,025-page v1 layout: 8 MiB passive data, 8 MiB stack/heap,
  64 KiB host parameters/migration input, and all remaining pages for host
  pixels/migration output. Require imported and host initial/maximum limits to
  equal the manifest request so memory cannot grow.
- [x] Expose and test the pure manifest arithmetic: page 257 pixel offset,
  `(P - 257) * 16,384` RGBA-pixel capacity, 48 MiB/12,582,912 pixels at 1,025
  pages, exact 258-page acceptance, 257-page rejection, and max-plus-one bytes.
- [x] Reject active data segments before engine work. Require exact data-count
  consistency and permit only passive lazy `memory.init`/`data.drop` into the
  module's first 8 MiB during a watchdog-bounded call; retain a separate 8 MiB
  allocator workspace and refresh/validate host-owned I/O every call.
- [x] Expand compressed function signatures and code-local group multiplicities
  before allocation. Enforce 128 parameters/16 results per type, 16,384
  aggregate signature fields, 2,048 locals per function/16,384 per module,
  2,048 parameters-plus-locals per function/16,384 after repeated type reuse,
  and a checked 32,768 raw-entry/signature/runtime-slot combined charge.
- [x] Keep larger ordinary compositor surfaces valid while making an
  insufficient plugin explicitly preview-unavailable and export-blocking under
  the reviewed bypass flow. Keep implementation of the parser/runtime and all
  hostile binary/browser fixtures gated on Issue #77.
- [x] Pass 119 focused manifest/project/effect/architecture tests across five
  files, all 2,351 Vitest cases across 170 files, all 16 benchmark-runner checks,
  production build/typecheck, warning-free oxlint, clean diff checks, and the
  production high-severity audit with 0 vulnerabilities. Keep browser
  verification intentionally not applicable to this non-executing follow-up.

## Part 10c / issue #76 - PR #112 migration-lifecycle and executable-budget follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Give every explicitly requested descriptor chain a fresh migration-owned
  worker, Wasm instance, fixed imported memory, private port, queue, request
  sequence, and generation after current trust/revocation/static-target preflight.
  Allow only canonical migration traffic and same-chain sequential steps; share
  no pixels, editor/export messages, or mutable state between descriptor chains.
- [x] Make a multi-descriptor action reserve one global sandbox slot, process
  fresh chain owners serially in immutable document order, stage every bounded
  result, and commit once only after all chains and final whole-document budgets
  pass against unchanged starting values and generation. Destroy the current
  owner on every terminal path, discard all staging on non-success, preserve all
  originals/animations, and make retry fresh. The later exact-head cache
  correction permits only a parent-owned verified raw-byte entry to remain;
  retry uses a fresh copy and repeats parse/validate/compile/instantiate.
- [x] Add independent pre-engine executable ceilings: 256 KiB per defined-
  function payload and 16 MiB aggregate; 65,536 decoded instructions per body and
  1,048,576 per module; 256 simultaneously open explicit control constructs;
  `br_table` vector labels capped at 1,024 per instruction, 16,384 per body, and
  65,536 per module; initializer expressions capped at 64 opcodes each and 16,384
  per module.
- [x] Require a closed binary-policy-versioned opcode/immediate grammar,
  canonical complete decoding, bounded typed-`select`/branch-table and every
  other immediate vector before allocation, checked sums, valid control/branch
  depth, and one exact final `end` with no trailing byte. Gate Issue #77 on
  exact/+1 and malformed/truncated/noncanonical/unsupported hostile fixtures.
- [x] Keep this follow-up design-only. No production package parser, migration
  runtime, worker, sandbox, or browser surface is added; Issue #77 owns runtime
  implementation and hostile cross-browser fixtures.
- [x] Pass 119 focused manifest/project/effect/architecture tests across five
  files, all 2,351 Vitest cases across 170 files, all 16 benchmark-runner checks,
  production build/typecheck, warning-free oxlint, clean diff/source-marker
  checks, and the production high-severity audit with 0 vulnerabilities. Record
  the first full-suite attempt's one known five-second Inspector timing flake,
  its isolated 1/1 pass, and the immediate authoritative full rerun's clean pass;
  retain only the existing >500 kB build advisory.

## Part 10c / issue #76 - PR #112 candidate-worker parser follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Close exact-head Codex review `4922271431`: the trusted parent must never
  synchronously iterate attacker-driven WebAssembly sections, bodies,
  instructions, immediates, or initializer expressions. It owns bounded package
  framing/preflight, the activation deadline, and candidate termination only.
- [x] Start one non-resetting five-second parent wall-clock deadline before fresh
  candidate-worker creation. Run the complete host-authored byte-policy parser
  inside that disposable candidate under all static resource ceilings, and only
  after parse success let the same worker validate, compile, and instantiate.
- [x] Require parse rejection to invoke no engine API, keep the deadline running
  continuously across create/parse/validate/compile/instantiate, promote the
  ready candidate without changing worker identity, and terminate it on every
  parse/engine failure or timeout.
- [x] Gate Issue #77 on near-limit parser responsiveness/termination, exact
  deadline ordering, no-engine-on-rejection, and same-worker promotion fixtures.
  Retain the design-only boundary: no production parser/runtime or browser-
  observable change is added, so browser QA remains not applicable.
- [x] Pass 119 focused manifest/project/effect/architecture tests across five
  files plus all 16 benchmark-runner checks, production build/typecheck,
  warning-free oxlint, and clean diff checks. Confirm the ordinary bundle has
  zero plugin capability/manifest/candidate/instance/validation/CSP canaries;
  its four generic `WebAssembly.instantiate` references are confined to the
  existing Mediabunny AC-3/ProRes codec chunks. Retain only the existing >500 kB
  build advisory.

## Part 10c / issue #76 - PR #112 render-parameter ABI follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Close exact-head Codex review `4922439329` by defining one versioned render-
  parameter wire record instead of an ambiguous “UTF-8 canonical” buffer.
- [x] Encode exactly every declared contribution key and no metadata/extra key.
  Use a valid authored value, ephemerally complete an absent key from its manifest
  default without document mutation, mark a present invalid declared value
  invalid/fail+bypassed, and preserve an undeclared durable key as unsupported/
  bypassed before calling plugin code.
- [x] Resolve only declared animatable numbers through the shared pure effect-
  track authority at the exact requested global integer timeline frame before
  encoding. Use the materialized base number (valid authored value, otherwise
  manifest default) as static fallback, never apply `step`
  quantization, and require identical bytes for the same immutable preview/export
  snapshot and frame.
- [x] Pin the byte grammar to RFC 8785 JCS plus UTF-8 without BOM, whitespace,
  terminator, or trailing bytes; pin JCS/ASCII key order, canonical primitive
  serialization, the exact `0x01000000` half-open slice, 2..65,536-byte length,
  and full-page pre/post-call clearing. Keep migration on its separate static
  record ABI.
- [x] Gate Issue #77 on exact and hostile object/JCS/default/validation/buffer,
  requested-frame animation, preview/export parity, maximum-valid 8,577-byte
  records, synthetic 64 KiB raw-buffer boundaries, and migration-separation
  fixtures. Retain the design-only boundary and browser-QA N/A status.
- [x] Pass 119 focused manifest/project/effect/architecture tests across five
  files plus all 16 benchmark-runner checks, production build/typecheck,
  warning-free oxlint, the production audit with 0 vulnerabilities, and clean
  diff/contradiction checks. Confirm zero plugin capability/manifest/candidate/
  instance/validate/compile/CSP bundle canaries; the six generic
  `WebAssembly.instantiate` references remain confined to four existing
  Mediabunny AC-3/ProRes codec chunks. Retain only the existing >500 kB chunk
  advisory.

## Part 10c / issue #76 - PR #112 signature-envelope and raw-byte-cache follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Close exact-head Codex review `4922582697` with one closed version-1
  signature envelope: exact `format`/version/algorithm literals, exact nested
  member sets and types, RFC 8785 JCS source-byte equality, canonical raw-key/
  signature base64url, lowercase-hex hashes, normalized paths, expanded integer
  lengths, exactly two strict path-sorted entries, and duplicate/extra rejection.
- [x] Define the Ed25519 message as the exact JCS envelope excluding only
  `signature`. Define the package digest as SHA-256 of an ASCII+NUL v1 domain and
  big-endian-`u32`-length-framed message plus decoded 64-byte signature, with
  `sha256:` lowercase-hex text everywhere.
- [x] Pin a self-consistent complete golden package: exact 496-byte manifest,
  valid 91-byte Wasm, 469-byte signed message, fixed RFC 8032-seed-derived public
  key/signature, 570-byte canonical envelope, every component hash, exact domain/
  framed length, and final package digest. Require independent crypto and hostile
  exact/+1 fixture verification before Issue #77 execution.
- [x] Retain no `WebAssembly.Module`, compiled/JIT/native/engine artifact, or
  engine reference across lifecycles. If enabled, cache only private write-once
  verified raw `Uint8Array` copies: at most eight entries/64 MiB actual retained
  `byteLength`, exact identity, fresh activation copy, deterministic access/key
  LRU, pressure bypass, and complete invalidation. A hit skips no parse,
  validation, compilation, or instantiation phase.
- [x] Keep the correction design-only; no package verifier/cache/runtime or
  browser-observable behavior exists yet, so browser QA remains not applicable.
- [x] Independently reproduce the fixed-seed public key/signature and every
  documented length/hash/canonical byte string/framed digest with Node classic
  crypto, Web Crypto, and Python `cryptography`; validate and instantiate the
  exact Wasm fixture with the fixed 258-page memory import.
- [x] Pass the final frozen 119 focused tests across five files plus all 16
  runner checks, build/typecheck, warning-free lint, production audit with 0
  vulnerabilities, clean diff/contradiction/alignment checks, and production
  canary scan. Confirm zero plugin-runtime canaries and six generic instantiate
  calls only in four existing AC-3/ProRes codec chunks. Retain only the existing
  >500 kB advisory; do not repeat the full suite for a docs-only correction that
  follows an already-green exact-head suite.

## Part 10c / issue #76 - PR #112 deterministic migration-profile follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Close exact-head Codex review `4922748950`: do not permit implementation-
  selected scalar-float/SIMD NaN behavior to influence durable descriptor
  migration output.
- [x] Select `myrelith-wasm-render-general-v1` only when every contribution has
  an empty migration chain; select `myrelith-wasm-migration-integer-v1` for the
  entire signed module as soon as any contribution declares a migration.
- [x] Reject `f32`, `f64`, and `v128` in every type position and reject every
  scalar-float operation/conversion/reinterpretation, float-related prefixed
  conversion, complete `0xfd` SIMD family, future/unlisted feature, and
  resource-dependent `table.grow` under migration-integer before any engine API.
  Future/unlisted features remain rejected by render-general too.
  Retain only the closed deterministic integer/control/fixed-memory/bulk-memory/
  bounded-`funcref` table subset without callable or nondeterministic imports.
- [x] Scan the whole module rather than attempting reachable-function analysis;
  cover unreachable helpers, element targets, `ref.func`, mutable-table dispatch,
  and `call_indirect`. Accept that migration-bearing render exports are integer-
  only in version 1.
- [x] Keep scalar float/fixed SIMD in render-general for toolchain compatibility
  and performance while explicitly declining cross-engine/hardware bit-identical
  third-party pixel guarantees. Preserve exact host input bytes, color/parameter
  interpretation, call ordering, and lifecycle separation.
- [x] Bind the selected profile id and its normative opcode/immediate-table digest
  into raw-cache identity, so a general parse/cache hit cannot authorize a
  migration-integer activation and neither path skips candidate-worker parsing.
- [x] Preserve canonical JCS/schema validation and atomic migration lifecycle;
  require identical accepted JCS bytes for identical successful cross-engine
  input/step sequences, with traps/timeouts remaining transactional failures.
- [x] Gate Issue #77 on exact and hostile type/opcode/profile/cache/indirect-table/
  NaN/`table.grow` cases plus cross-engine canonical migration goldens. Keep the
  change design-only with browser QA not applicable.
- [x] Pass the final frozen 119 focused tests across five files plus all 16 runner
  checks, build/typecheck, warning-free lint, production audit with 0
  vulnerabilities, and clean diff/contradiction/alignment checks. Confirm zero
  ordinary-bundle plugin capability/profile/signature/candidate/manifest/
  validate/compile/module/CSP canaries and only six generic instantiate calls in
  four existing Mediabunny AC-3/ProRes chunks. Retain only the existing >500 kB
  advisory. Do not repeat the full suite for this docs-only correction after an
  already-green exact-head suite; browser QA remains not applicable.
## Milestone 5 Part 10a / issue #44 - motion-analysis research

**RESEARCH COMPLETE LOCALLY (2026-08-11).**

- [x] Establish a browser-local, build-unreferenced analysis boundary with one
  admitted job, one reserved decoder slot, disposable workers, exact capability
  probes, abort settlement, and diagnostic proof that all child resources close.
- [x] Specify a strict bounded derived-cache schema keyed by project binding,
  asset, sampled source fingerprint, stream geometry/rate, source range and
  sampling, clip mapping/projection, algorithm/version, and parameters. Reject
  stale entries; do not make analysis output portable project truth.
- [x] Prototype deterministic bounded feature detection, patch tracking,
  similarity RANSAC/refinement, stabilization smoothing/crop estimation, point
  tracking, and similarity-box tracking with explicit scene-cut/occlusion loss.
- [x] Map accepted tracker samples to existing Position X/Y and optional Scale
  X/Y curves only after an explicit future Apply action; keep running analysis
  outside React, Zustand, document mutation, history, preview, and export.
- [x] Validate a versioned normalized manual Brown-Conrady lens model and fixed-
  grid invertibility guard. Record production rendering as no-go pending #111's
  bounded remap and exact preview/export parity proof; reject profile catalogs.
- [x] Split delivery into #108 analysis/cache, #109 stabilization, #110 point/
  box tracking, and #111 lens-renderer feasibility, each with its own limits,
  cleanup, negative cases, parity obligations, and acceptance gates.
- [x] Pass 18 focused tests and real source-bound Playwright Chromium at strict
  port 41844 with exact primitive probes, cancellation, successful execution,
  resource parity, zero active counters, zero console problems, and released
  port. The full gate passed all 2,322 Vitest cases across 172 files, all 16
  benchmark-runner checks, production build/typecheck, oxlint, clean diff
  checks, and `npm audit --omit=dev` with 0 vulnerabilities; the build retained
  only its established large-chunk advisory.

## Milestone 5 Part 10a / issue #44 - review hardening

**COMPLETE LOCALLY (2026-08-11).**

- [x] Replace the flat scene-cut shortcut with independently seeded textured
  scenes and a versioned 50% feature-match-coverage discontinuity gate before
  similarity fitting.
- [x] Acquire one controller-scoped admission slot before support probing or
  scheduler construction; reject overlapping callers without a second worker
  or decoder reservation and release the slot on every terminal path.
- [x] Project every tracker sample through its resolved source transform,
  including rotation/flip cross-axis terms and per-sample changes; compensate
  target scaling around its cropped visible center, rotation, flips, and
  authored anchor while emitting only ordinary Position X/Y and Scale X/Y keys.
- [x] Require box loss on the exact first fully occluded frame, with no accepted
  recovery frames after disappearance; expose the failure and last accepted
  frame in evidence.
- [x] Evaluate point and box quality independently and derive their public
  go/no-go decisions from their own thresholds rather than the combined flag.
- [x] Pass 24 focused research tests, all 2,328 Vitest cases across 172 files,
  all 16 benchmark-runner checks, production build/typecheck, oxlint, clean diff
  checks, and `npm audit --omit=dev` with 0 vulnerabilities.
- [x] Rerun real Chromium at strict port 41844 against exact clean implementation
  commit `9f45e44a514d7540637ab466d48516593b59a404`: textured hard-cut rejection,
  typed overlapping-run denial, successful analysis, cancellation, exact
  worker/frame/OPFS parity, zero console problems, and released port.
- [x] Advance the artifact to schema 3 / `issue-44-motion-analysis-v3` and rerun
  strict-port Chromium against exact clean commit
  `3e632ab6dd0b24cc26ff61e38cf812ef4764f470`: independent point/box go results,
  loss on occlusion frame 18 after accepted frame 17, exact worker/frame/OPFS
  parity, zero console problems, and released port.

## Milestone 5 Part 10a / issue #44 - follow-up review hardening

**COMPLETE LOCALLY (2026-08-12).**

- [x] Contain OPFS probe-file removal failures as a cleanup-specific unsupported
  result; preserve honest created/removed diagnostics and route a research run
  through typed `resource-unavailable` before scheduler or worker allocation.
- [x] Validate every generated tracking Position X/Y and Scale X/Y track through
  the canonical animation validator; reject mapped frame overflow, derived
  finite-position overflow, and scale overflow instead of returning tracks that
  a future Apply or portable validator must reject.
- [x] Pass 28 focused research tests, all 2,332 Vitest cases across 172 files,
  all 16 benchmark-runner checks, production build/typecheck, oxlint, clean diff
  checks, and `npm audit --omit=dev` with 0 vulnerabilities.
- [x] Rerun artifact schema 3 / `issue-44-motion-analysis-v3` in real Chromium
  on strict port 41844 against exact clean implementation commit
  `3632e47c4cd3bf136b6c35d698ffa6ebcc009e76`: independent point/box go,
  occlusion loss at frame 18 after frame 17, typed overlap rejection,
  cancellation, exact worker/frame/OPFS parity, zero console problems, and a
  released port.

## Milestone 5 Part 10a / issue #44 - worker-readiness review hardening

**COMPLETE LOCALLY (2026-08-12).**

- [x] Require an explicit matching `probe`/`ready` handshake before declaring
  dedicated module-worker support; fail closed on async load/message errors,
  synchronous post failure, or a bounded five-second timeout.
- [x] Thread admitted-run cancellation through readiness probing; terminate and
  clean the pending worker immediately, release shared admission, settle every
  race once, and validate unknown messages at the worker boundary.
- [x] Pass 32 focused research tests, all 2,336 Vitest cases across 172 files,
  all 16 benchmark-runner checks, production build/typecheck, oxlint, clean diff
  checks, and `npm audit --omit=dev` with 0 vulnerabilities.
- [x] Rerun artifact schema 3 / `issue-44-motion-analysis-v3` in real Chromium
  on strict port 41844 against exact clean implementation commit
  `ac555ca6a085f4093b9490107cddfaa79b961c71`: successful worker readiness,
  independent stabilization/point/box go, occlusion loss at frame 18 after frame
  17, cancellation, typed overlap rejection, exact worker/frame/OPFS parity,
  zero console problems, and a released port.

## Milestone 5 Part 10a / issue #44 - concurrent OPFS-probe follow-up

**COMPLETE LOCALLY (2026-08-12).**

- [x] Give every support invocation a distinct origin-wide OPFS filename backed
  by a 128-bit Web Crypto nonce, and remove only the name owned by that call.
- [x] Cover two overlapping probes with deterministic nonces, distinct filenames,
  two successful support results, exact cleanup ownership, and balanced created/
  removed diagnostics.
- [x] Pass all 2,337 Vitest cases across 172 files plus 16 benchmark-runner checks,
  production build/typecheck, oxlint, clean diff checks, production audit at 0
  vulnerabilities, and a normal-bundle scan with no motion-research identifiers.
- [x] Rerun real headed Chromium only on strict port 41844; retain the complete
  capability matrix, three `go` decisions, exact frame-18 occlusion loss,
  cancellation and admission outcomes, 2/2 workers, 1/1 frames, 1/1 OPFS files,
  zero console problems, and a released port.

## Milestone 5 Part 10a / issue #44 - integer-pixel tracking follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Reject a point-tracking seed unless both coordinates are safe integers,
  before the separate analyzable-frame bounds gate, so fractional typed-array
  indices cannot silently read as zero-valued pixels.
- [x] Keep the reviewed matcher bounded to integer patch search: integer offsets
  preserve integral point matches, while every regenerated box seed remains
  rounded. Do not introduce subpixel interpolation in this research change.
- [x] Add a deterministic translated-texture regression that rejects a
  fractional seed distinctly and proves the valid integer target tracks across
  three frames without a false `lost-point`.
- [x] Pass 10/10 focused tracking tests, 29/29 domain matcher/tracking/controller
  tests, all 16 benchmark-runner checks, oxlint, and `git diff --check`.

## Milestone 5 Part 10a / issue #44 - OPFS cancellation follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Race the entire owned OPFS capability operation against the admitted run's
  `AbortSignal`, returning typed `AbortError` and releasing controller-wide
  admission without waiting for a stalled browser storage promise.
- [x] Keep the abandoned operation observed through late settlement; stop
  between capability steps, close any late writer, remove only the invocation's
  128-bit name, suppress post-settlement success diagnostics, and retain the
  cleanup-specific unsupported result for an ordinary uncertain removal.
- [x] Defer all seven OPFS steps deterministically and prove prompt cancellation,
  a newly admitted run, balanced late cleanup, exact overlapping filename
  ownership, no cross-removal, and no late diagnostic drift.
- [x] Pass 18/18 controller tests, 36/36 controller/matcher/tracking tests, all
  16 benchmark-runner checks, the TypeScript build gate, oxlint, and
  `git diff --check`.

## Milestone 5 Part 10a / issue #44 - readback and retained-memory follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Race support `VideoFrame.copyTo()` against both the admitted run's
  `AbortSignal` and a finite five-second deadline; close its frame exactly once
  before abort/timeout settles and shared research admission is released.
- [x] Keep the original readback promise observed after caller settlement, so
  late resolution or rejection cannot re-close the frame, mutate diagnostics,
  or surface as an unhandled promise rejection.
- [x] Require every grayscale `Uint8Array` to be a zero-offset full view of its
  backing buffer, preventing a small visible plane from hiding a larger retained
  allocation from the reviewed 32 MiB gate.
- [x] Cover deferred abort, deadline, second-run admission, close ordering, safe
  late resolve/reject, zero-offset and nonzero-offset oversized backing rejection,
  and valid tightly sized buffers; pass 42/42 focused controller/matcher/tracking
  tests, all 16 benchmark-runner checks, and the standalone TypeScript gate.

## Milestone 5 Part 10a / issue #44 - worker-send cleanup follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Catch a synchronous failure from the initial research-worker `postMessage`
  and reject through the existing idempotent finish path instead of bypassing
  termination and leaving shared worker diagnostics active.
- [x] Detach the run worker's message/error and abort listeners before terminating
  it, preserve the original send exception, and release controller-wide
  admission only after the worker counters are balanced.
- [x] Prove deterministic synchronous-send failure cleanup, rejection-time 1/1
  worker parity, zero active listeners/workers, and a successful admitted retry.

## Milestone 5 Part 10a / issue #44 - OPFS deadline follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Apply one non-resetting five-second deadline to the complete owned OPFS
  support-probe chain, including default calls without an external signal.
- [x] Preserve first-winner semantics: external abort returns `AbortError`, while
  an internal deadline reports a distinct unsupported reason through the typed
  `resource-unavailable` research path and promptly releases shared admission.
- [x] Keep abandoned browser work observed for late progress and owned cleanup;
  close a late writer, remove only the invocation's 128-bit nonce file, and
  suppress successful diagnostics after caller settlement.
- [x] Cover all seven deferred OPFS boundaries, deadline-versus-abort ordering,
  admitted retry before late release, exact cross-probe filename isolation,
  resource parity, and normal timer/listener cleanup; pass 33/33 controller and
  54/54 focused tests, 174/174 files with 2,382/2,382 full-suite tests, all 16
  runner checks, build, oxlint, high-severity production audit, and diff check.

## Milestone 5 Part 10a / issue #44 - tracking scale-axis follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Express every transformed source box in the target's rotation-local Scale
  X/Y basis using support extents at the per-sample source-minus-target relative
  angle; retain first-sample ratios and authored base-scale multiplication.
- [x] Swap anisotropic growth at quarter turns, mix it at arbitrary angles, and
  treat source/target flip signs as size-invariant. Keep the four-track contract
  explicit: fixed target Rotation uses a deterministic enclosing envelope where
  exact rotated or sheared geometry is not representable by Scale X/Y alone.
- [x] Make exact quadrants use semantic zero/one coefficients, retain the first
  sample's authored base scale exactly, divide later extent ratios before base
  multiplication, and reject non-positive/non-finite extents or derived scales.
- [x] Cover target rotation, relative 0/+90/-90/arbitrary angles, per-sample
  rotation and anisotropy, mirrors, cropped-center compensation, finite extents,
  extreme ratio arithmetic, and canonical scale overflow without adding another
  runtime evaluator.
- [x] Pass 20/20 tracking tests, 64/64 focused controller/domain/tracking tests,
  174/174 files with 2,392/2,392 full-suite tests, all 16 runner checks,
  TypeScript/Vite build, oxlint, high-severity production audit at 0
  vulnerabilities, and `git diff --check`.

## Milestone 5 Part 10a / issue #44 - worker-response cleanup follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Register the admitted research worker's `messageerror` listener before its
  initial post and reject deserialization failure as a typed `unexpected`
  terminal result through the existing idempotent cleanup owner.
- [x] Remove abort, message, error, and messageerror listeners before terminating
  exactly once; balance worker diagnostics before caller settlement and release
  scheduler/controller admission for a retry.
- [x] Prove deterministic response-deserialization cleanup, rejection-time 1/1
  worker parity, zero active listeners/workers, late competing-event immunity,
  and a successful admitted retry. Audit the support-probe worker and retain its
  already-complete messageerror lifecycle without a broad refactor.
- [x] Pass 34/34 controller tests, 65/65 focused controller/domain/tracking
  tests, 174/174 files with 2,393/2,393 full-suite tests, all 16 runner checks,
  TypeScript/Vite build, oxlint, high-severity production audit at 0
  vulnerabilities, and `git diff --check`.

## Milestone 5 Part 10a / issue #44 - crop-feasibility follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Replace the saturated 49% crop estimate with an explicit finite-centered-
  zoom result: preserve exact feasible ratios below one half, and return
  `finite-centered-zoom-unavailable` at or above half the shorter frame
  dimension without fabricating a ratio or zoom.
- [x] Keep path/correction/jitter diagnostics on crop failure, use the exact
  half-open boundary without an epsilon dead zone, measure direct similarity
  corner deltas, and reject non-finite accumulation or crop geometry before it
  can leak `Infinity` or `NaN` into evidence.
- [x] Require available 50% and 100% crop results in the stabilization quality
  gate, propagate a stable failure reason into evidence, and render unavailable
  browser evidence without numeric formatting errors.
- [x] Advance the incompatible nested-crop evidence contract to schema 4 /
  `issue-44-motion-analysis-v4`; preserve earlier schema 3 / v3 browser records
  as history and require the next clean-commit evidence run to emit v4.
- [x] Cover immediately-below/exact/immediately-above boundary geometry,
  sustained pan with the maximum smoothing radius, ordinary finite plans,
  non-finite transforms/path metrics, JSON safety, and stabilization `no-go`
  refusal.
- [x] Pass 18/18 motion-analysis cases, 72/72 focused controller/domain/tracking
  tests, 174/174 files with 2,400/2,400 full-suite tests, all 16 runner checks,
  TypeScript/Vite build, oxlint, high-severity production audit at 0
  vulnerabilities, normal-bundle canary scan, and `git diff --check`.
- [x] After the schema-only v4 correction, rerun 72/72 focused cases, all 16 Node
  runner checks, TypeScript/Vite build, oxlint, runner syntax, the normal-bundle
  canary scan, and `git diff --check`. Do not repeat the unchanged
  2,400-case production-TypeScript suite or dependency audit; retain the
  clean-commit v4 Chromium artifact as the next source-bound gate.

## Milestone 5 Part 10a / issue #44 - refined-similarity envelope follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Centralize the research similarity envelope: every transform field must
  be finite, scale must remain in inclusive `[0.85, 1.15]`, and absolute
  rotation must remain at or below `pi / 12` radians.
- [x] Apply the same envelope to deterministic pair hypotheses and the
  least-squares refined transform before final-inlier filtering. Reject rather
  than clamp an escaped refinement.
- [x] Reproduce the eight-match review fixture whose identity hypothesis keeps
  every match but whose refinement contracts to `92 / 122`, approximately
  `0.754098`; cover interior, exact-boundary, immediately exterior, and
  non-finite transforms.
- [x] Audit both consumers of refined similarity acceptance: stabilization
  rejects the failed frame pair and similarity-box tracking reports loss before
  applying a rejected transform.
- [x] Pass 29/29 motion-analysis cases, 83/83 focused controller/domain/tracking
  tests, 174/174 files with 2,411/2,411 full-suite tests, all 16 Node runner
  checks, build/typecheck, oxlint, Issue #44 runner syntax, the production audit
  at 0 vulnerabilities, and `git diff --check`.
- [x] Scan the normal 32-file, 5,871,592-byte artifact: zero motion-research
  canaries, zero WebGPU API references, and zero WebGPU experiment chunks. The
  clean-commit headed research run follows after the root commits the exact tree.

## Milestone 5 Part 10a / issue #44 - pair-schedule and seed-budget follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Replace lexicographic prefix truncation with an exact, deterministic cap
  distributed across the complete unordered-pair rank space; enumerate all
  pairs when they fit, include both endpoints for cap >= 2, select the middle
  rank for cap 1, un-rank without materializing all pairs, and retain one
  cancellation check per hypothesis plus stable tie order.
- [x] Advance deterministic algorithm provenance to
  `similarity-block-ransac-v3`, keep artifact schema 4 because its shape is
  unchanged, reject cached v2 analysis as stale by algorithm version, and make
  the headed runner refuse to publish unless evidence reports the exact current
  fixture v2 / algorithm v3 pair.
- [x] Reproduce the ordered 29-match foreground / 35-match background review
  fixture and a deterministic permutation; prove exact sampled-rank count,
  uniqueness, endpoints, middle-rank behavior, and small-set all-pairs behavior.
- [x] Cap box seeds to `min(maxFeatures, 16)` with spatially progressive
  selection, explicitly reject box budgets below the eight-match estimator
  minimum, preserve the default sixteen-seed result, and keep point tracking
  valid at a one-feature budget.
- [x] Pass the final 100/100 focused tests, 175/175 files with 2,454/2,454
  full-suite tests, all 17 runner checks, build/typecheck, oxlint, runner syntax,
  the high-severity production audit with 0 vulnerabilities, and `git diff
  --check`; retain only the established large-chunk advisory.
- [x] Scan the normal 32-file, 5,871,618-byte bundle: zero motion-research,
  WebGPU, or plugin-runtime/profile canaries; six generic
  `WebAssembly.instantiate` calls remain only in four established Mediabunny
  codec chunks. Run the source-bound headed browser artifact after the exact
  tree is committed, proving schema 4 / fixture v2 / algorithm v3.

## Milestone 5 Part 10a.1 / issue #108 - motion-analysis job/cache foundation

**COMPLETE LOCALLY (2026-08-13).**

- [x] Add the production one-job/one-decoder motion-analysis controller and
  StrictMode-safe editor lifecycle without adding document mutation or browser
  resource ownership to React/Zustand state.
- [x] Decode real sources sequentially in one dedicated worker, close each
  `VideoFrame` immediately after bounded 320x180 grayscale extraction, and
  stream acknowledged two-frame-overlap windows within 300 frames / 32 MiB.
- [x] Validate worker progress, window order/offsets, tight frame ownership,
  sample totals, peak facts, errors, deserialization, synchronous sends, abort,
  terminal cleanup, and post-consumer buffer detachment independently in the
  app bridge.
- [x] Implement the strict schema-1 origin-local analysis sidecar with exact
  provenance, result-first/manifest-last transactions, final currentness
  recheck, rollback, 1,024-entry/256-MiB-entry limits, origin-aware LRU, exact
  remove/clear, and recoverable unavailable/quota/corruption behavior.
- [x] Reuse the proxy sampled SHA-256 byte contract and register only the exact
  analysis cache with disposable derived-storage estimates and clearing.
- [x] Pass 44/44 focused tests plus all 17 runner checks; pass 179/179 files and
  2,485/2,485 full-suite tests plus those checks; pass TypeScript/Vite build,
  oxlint, production audit at 0 vulnerabilities, runner syntax, architecture
  boundaries, and `git diff --check`.
- [x] Pass an in-app Chromium real-source gate: 12/12 generated H.264 frames,
  12 retained frames / 172,800 bytes, exact 269-byte miss-to-hit cache round
  trip, scheduler 2 completed / 0 cancelled / 0 failed, worker 1/1 with zero
  active resources, and no browser problems. Publish the reproducible
  clean-commit `qa:issue108:foundation` artifact after commit.

## Milestone 5 Part 10a.1 / issue #108 - first exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Keep cancellation settlement and scheduler admission held while a
  consumer still owns an acknowledged grayscale window; terminate the worker
  promptly, then detach the window before rejecting the run.
- [x] Normalize decoded 0/90/180/270-degree source rotation into display space
  before grayscale extraction, with exact orientation-plan and threaded-frame
  regressions.
- [x] Add the Issue #108 evidence module's exact app/domain/pipeline exception
  to canonical architecture rather than weakening only the test guard.
- [x] Preserve source-open unsupported-codec, resource-limit, and
  resource-unavailable remediation across the worker protocol; reserve
  decode-readback for actual decode failure.
- [x] Pass the refreshed 44/44 focused tests, all 17 runner checks, and the
  authoritative 179-file / 2,485-test full suite. Refresh build, lint,
  production audit, diff checks, and the exact clean-commit Chromium artifact
  before requesting another Codex review.

## Milestone 5 Part 10a.1 / issue #108 - second exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Detach every safely identifiable `ArrayBuffer`-backed grayscale plane
  before rejecting a transferred window that fails order, frame, byte, or
  sample-envelope validation; deduplicate shared backing buffers and preserve
  exact worker/scheduler cleanup if detachment itself fails.
- [x] Reject a terminal zero-sample completion as decode-readback before result
  finalization, result staging, or manifest commit, so the cache's positive-
  sample invariant is enforced at the decode boundary rather than surfacing as
  an indirect storage error.
- [x] Add deterministic ownership and zero-sample regressions; pass 61/61
  focused tests plus 17/17 runner checks and the authoritative 179-file /
  2,486-test suite plus those checks. Pass build/typecheck, oxlint, the
  high-severity production audit with 0 vulnerabilities, runner syntax, and
  `git diff --check`. Clean-commit Chromium, CI, and fresh exact-head Codex
  review follow on the committed tree.

## Milestone 5 Part 10a.1 / issue #108 - third exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Detach cache-read and processor-result buffers that resolve after abort or
  the owned-operation deadline, and detach accepted result ownership on every
  unsuccessful stale/stage/commit path while preserving successful caller
  ownership.
- [x] Reject non-primary video stream indices before fingerprint, cache, or
  worker work; carry accepted index `0` explicitly through the worker protocol
  and validate it before opening the primary video track.
- [x] Add deterministic deferred-result ownership and stream-provenance
  regressions; pass 63/63 focused tests plus 17/17 runner checks and the
  authoritative 179-file / 2,488-test suite plus those checks. Pass build/
  typecheck, oxlint, the high-severity production audit with 0 vulnerabilities,
  runner syntax, and `git diff --check`. Clean-commit Chromium, CI, and exact-
  head Codex review follow on the committed tree.

## Milestone 5 Part 10a.1 / issue #108 - fourth exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Treat every mismatched worker request ID as a terminal malformed-protocol
  response rather than ignoring it; for mismatched windows, detach every
  identifiable transferred plane before rejecting and terminating the worker.
- [x] Preserve the existing consumer-ownership rule when a mismatched reply
  arrives during an acknowledged window: stop the worker immediately but keep
  scheduler settlement held until that independently owned window releases.
- [x] Add a deterministic mismatched-window regression proving zero-length
  transferred bytes, no consumer call, exact worker termination, listener
  removal, and balanced decoder/worker diagnostics. Pass the refreshed 64/64
  focused tests plus 17/17 runner checks and the authoritative 179-file /
  2,489-test full suite plus those checks. Pass build/typecheck, lint, runner
  syntax, and the diff check; confirm 0 high-severity production
  vulnerabilities. Clean-commit Chromium, CI, and exact-head Codex review
  follow on the final committed tree.

## Milestone 5 Part 10a.1 / issue #108 - fifth exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Add the exact motion-analysis worker imports of the bounded pipeline
  decode core and serializable protocol to canonical architecture, matching the
  already-narrow architecture guard without permitting any other cross-layer
  runtime dependency.
- [x] Validate worker reply values as non-array objects with a recognized
  discriminator and non-negative safe-integer request ID before reading them;
  reject malformed values through common cleanup and release any identifiable
  embedded ownership first.
- [x] Cover `null`, `undefined`, primitive, and unknown-discriminator replies
  with deterministic termination/listener/decoder/worker-balance regressions;
  prove identifiable buffers embedded in an unknown-discriminator reply
  detach; pass 69/69 focused tests plus 17/17 runner checks and the
  authoritative 179-file / 2,494-test suite plus those checks. Pass
  build/typecheck, lint,
  runner syntax, and the diff check; confirm 0 high-severity production
  vulnerabilities. Clean-commit Chromium, CI, and exact-head Codex review
  follow on the final committed tree.

## Milestone 5 Part 10a.1 / issue #108 - sixth exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Emit periodic progress from decoded-frame cadence before skipping an
  unsampled frame, so every sampling interval reports at decoded counts 8, 16,
  and onward with the exact retained-sample count.
- [x] Preserve signed safe-integer exact primary-video start/end timestamps
  through worker validation and playback-lane conversion while keeping seek
  targets non-negative and rejecting reversed ranges.
- [x] Attempt both decoder-owner close paths, reject an otherwise successful
  run when either close fails, and aggregate the primary operation failure with
  every synchronous or asynchronous cleanup failure when both phases fail.
- [x] Add deterministic progress, signed-bound, and cleanup regressions; pass
  67/67 focused tests, 180/180 files and 2,500/2,500 full-suite tests, plus all
  17 runner checks. Pass build/typecheck, warning-free lint, production audit
  at 0 vulnerabilities, runner syntax, and the diff check. Clean-commit
  Chromium evidence follows before the next exact-head review request.

## Milestone 5 Part 10a.1 / issue #108 - seventh exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Preserve immediate public abort/deadline settlement while retaining the
  staged result and scheduler admission until a pending manifest commit settles
  and any required rollback completes; do not admit the next job into that
  unresolved transaction window.
- [x] Surface rollback/discard failure as cache corruption instead of silently
  dropping cleanup failure, while retaining the first interruption cause for a
  successful rollback.
- [x] Reject a result larger than the origin-aware computed cache ceiling before
  LRU manifest mutation or result-file removal.
- [x] Add deterministic cancellation, deadline, queued-retry, exact one-job,
  and impossible-allocation preservation regressions. Pass 72/72 focused tests
  across nine files, 180/180 files and 2,503/2,503 full-suite tests, plus all
  17 runner checks. Pass build/typecheck, warning-free lint, production audit at
  0 vulnerabilities, runner syntax, conflict/diff checks, then refresh clean-
  commit Chromium, CI, and exact-head Codex evidence before merge.

## Milestone 5 Part 10a.1 / issue #108 - eighth exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Translate the motion-specific public failure into a
  `MediaJobExecutionError` carrying the matching scheduler failure class before
  it reaches bounded scheduler history.
- [x] Preserve unsupported-codec and resource-limit exactly, map decode/readback
  to decode-failed, map unsupported runtime/quota/cache corruption to resource-
  unavailable, and leave only uncategorized analysis outcomes as unexpected.
- [x] Add a five-case worker-failure matrix proving public status, scheduler
  history, and worker teardown remain aligned. Pass 77/77 focused tests across
  nine files, 180/180 files and 2,508/2,508 full-suite tests, plus all 17 runner
  checks. Refresh build/typecheck, lint, production audit, static checks, clean-
  commit Chromium, CI, and exact-head Codex evidence before merge.

## Milestone 5 Part 10a.2 / issue #109 - bounded video stabilization

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-13).**

- [x] Build the first product consumer of Issue #108 with exact source/project/
  SourceTimeMap/cache provenance, one bounded local job, typed failure and
  cancellation behavior, strict result parsing, and stale-session rechecks.
- [x] Implement a full-product O(n) global translation/rotation/uniform-scale
  smoother with strength 0-100%, integer radius 1-120, canonical timestamp-to-
  source-time conversion, and duplicate retime projection rejection.
- [x] Project analysis corrections through crop, anchor, flips, rotation, and
  uniform base scale. Reject aspect-rounded analysis geometry beyond 0.25
  project px instead of silently treating an affine as a similarity.
- [x] Simplify ordinary Position X/Y, Rotation, and equal Scale X/Y tracks under
  pre-zoom tolerances that guarantee <=0.5 project-pixel corner, <=0.05 degree,
  and <=0.05% scale error after the reviewed 1.35x maximum safe zoom. Solve
  exact project coverage after simplification at every integer clip frame.
- [x] Enforce 1,000,000 clip frames, 65,534 retained analysis samples,
  4,000,000 comparison attempts, 1,024 keys per transform track, and the
  100,000-document-key ceiling. Recheck the document budget in the immutable
  Apply operation and require explicit replacement of existing transform
  tracks.
- [x] Add accessible Analyze/Retry/Cancel/progress, strength/radius, exact crop/
  zoom/key/jitter evidence, playhead Preview, Apply, Reset, and disabled-control
  explanations. Keep analysis, preview, parameter tuning, cache hits, cancel,
  and failure out of project history.
- [x] Add the reproducible Issue #109 real-source browser gate and package
  command. Dirty-tree Chromium evidence is green for 32 H.264 samples, exact
  cache hit, 31 keys per track, 1.0224x zoom / 2.20% total crop, balanced
  workers/scheduler/cache removal, and zero console/page problems.
- [x] Pass 136/136 focused tests, the authoritative 184-file / 2,528-test suite,
  17/17 evidence-runner checks, build/typecheck, warning-free lint, the
  high-severity production audit with 0 vulnerabilities, runner syntax, and
  diff/conflict checks.
- [x] Pass headed Chromium from clean exact commit `cabd4202fc` on exclusive
  port 41866: 32/32 samples, 31 keys per track, 1.0224x safe zoom / 2.20% total
  crop, exact cache hit, one worker created/terminated with zero active, cache
  removal, zero console/page problems, and full port release.
- [ ] Pass exact-head CI and a fresh no-major-issues Codex review before squash
  merge.

## Milestone 5 Part 10a.2 / issue #109 - first exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Invalidate every in-flight Inspector analysis on clip change, Cancel, or
  unmount with a request generation and the original clip ID. Ignore both late
  success and late failure before they can install stale session/UI state.
- [x] Add a deterministic deferred-result regression proving clip A is
  cancelled, clip B stays idle, no plan/preview appears, and Apply remains
  disabled after the old result arrives.
- [x] Add the Issue #109 gate's exact `app`/`domain`/`state` composition to the
  canonical dev-exception rules so the executable architecture guard no longer
  weakens the written boundary.
- [x] Pass the 8/8 review-focused tests and the refreshed 184-file / 2,528-test
  suite plus 17/17 runner checks; refresh build/typecheck, warning-free lint,
  and diff checks. Re-run clean Chromium, CI, and fresh exact-head Codex review
  after committing the follow-up.

## Milestone 5 Part 10a.2 / issue #109 - second exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Derive a 32 MiB stabilization working-result budget from the shared
  256 MiB cache-entry ceiling, reserve 1 KiB for the enclosing record, cap each
  serialized sample at 512 bytes, and stop before analyzing or retaining sample
  65,535. Reject an oversized cached stabilization result before UTF-8 decode.
- [x] Remove false stabilization-ownership wording from ordinary transform
  tracks. Disclose in visible and accessible UI that Reset removes all Position,
  Rotation, and Scale animation, including manual and other-tool keyframes.
- [x] Add deterministic streaming-cap and destructive-scope UI regressions;
  pass 18/18 review-focused tests, the authoritative 184-file / 2,530-test suite
  plus all 17 evidence-runner checks, build/typecheck, warning-free lint, the
  high-severity production audit with 0 vulnerabilities, and diff checks.
  Re-run clean Chromium, CI, and exact-head Codex review after commit.

## Milestone 5 Part 10a.2 / issue #109 - third exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Preserve every exact SourceTimeMap freeze by adding matching correction
  keys at the first and last plateau frames, assigning ordinary `hold` easing
  to the first key, and protecting both keys from simplification. Keep moving
  spans linear and the shared ordinary preview/export evaluator canonical.
- [x] Keep plateau boundaries inside the existing 1,024-key track budget;
  reject the bounded plan instead of discarding a required freeze edge.
- [x] Add a deterministic moving-then-0× speed-curve regression proving all
  five authored transform properties remain constant at every frozen timeline
  frame. Pass 5/5 focused files with 28/28 tests, 184/184 full-suite files with
  2,531/2,531 tests, all 17 evidence-runner checks, build/typecheck, warning-
  free lint, the production audit with 0 vulnerabilities, and diff checks.
- [x] Pass headed Chromium on clean exact code commit `b9695cd6c2` and port
  41870: 32 samples, 31 keys per track, 1.0224× safe zoom, exact cache hit,
  worker 1/1/0, zero console/page problems, and complete port release. Keep the
  direct 0× semantics in deterministic domain coverage because the broad
  source-bound browser fixture uses ordinary 1× timing. Refresh CI and exact-
  head Codex review before merge.

## Milestone 5 Part 10a.2 / issue #109 - fourth exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Replace zero-rate-only plateau detection with canonical decoded-source-
  frame run detection. Pin matching corrections and `hold` easing at every
  repeated run's first/last timeline frames for both exact 0× and fractional
  speeds below 1×. On maps that can repeat, index analyzed corrections by
  decoded source frame and rematerialize them at the timeline frame that
  actually displays that image, including singleton runs between repeats; keep
  the no-repeat path allocation- and scan-free.
- [x] Count protected repeated-frame edges before retention and reject when
  they exceed the existing 1,024-key track envelope.
- [x] Add deterministic 0.25× regressions proving all five properties remain
  constant over three consecutive four-frame runs, change only at decoded-
  frame boundaries, and reject a 2,052-frame structural-key overflow. Add a
  separate 0.75×/1× parity matrix proving six analyzed corrections align with
  the same displayed source frames despite between-frame timestamp inversion.
- [x] Pass 5/5 focused files with 31/31 tests, 184/184 full-suite files with
  2,534/2,534 tests, all 17 evidence-runner checks, build/typecheck, warning-
  free lint, the production audit with 0 vulnerabilities, and diff checks.
  Refresh clean Chromium, CI, and exact-head Codex review before merge.

## Milestone 5 Part 10a.2 / issue #109 - fifth exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Convert conformed SourceTimeMap ticks to WebCodecs request microseconds
  with the document frame rate, not the connected asset's native frame rate;
  retain floor/ceil half-open request-bound rounding.
- [x] Convert analyzed WebCodecs timestamps back to source ticks with the same
  document frame rate and canonical nearest-frame adapter. Keep the native rate
  only for bounded decoder sampling, including the 60 fps source / 30 fps
  project stride of two native frames.
- [x] Add a deterministic 60 fps native / 30 fps project regression covering
  both directions, a nonzero source timestamp, and floor/ceil subframe edges.
  Pass 5/5 focused files with 32/32 tests, 184/184 full-suite files with
  2,535/2,535 tests, all 17 evidence-runner checks, build/typecheck, warning-
  free lint, the production audit with 0 vulnerabilities, and diff checks.
  Refresh clean Chromium, CI, and exact-head Codex review before merge.

## Milestone 5 Part 10a.2 / issue #109 - sixth exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Replace fractional tick request bounds and fixed sampling strides with a
  bounded render-parity schedule: containing conformed project frame, shared
  nearest project-to-native rescaling, unique native images, and one sparse
  ordered `samplesAtTimestamps` lane. Bound the half-open decoder range to the
  first through last selected native images.
- [x] Version stabilization results and product provenance to schema 2 /
  `similarity-product-v2`. Store the first exact displayed SourceTimeMap tick
  beside every analyzed sample, verify that schedule again after fresh/cache
  parsing, and use both logical native identity and nondecreasing actual decoded
  timestamp for correction lookup and repeated-run `hold` boundaries.
- [x] Validate and copy sparse timestamps at controller, protocol, worker, and
  source-cursor boundaries; retain signed exact stream support; reject an empty,
  unordered, out-of-range, non-unit-stride, or over-budget schedule before
  decoder allocation or sample 65,535 retention.
- [x] Add deterministic fractional-bound, 24-to-30 fps 1x repeat, 24-to-30 fps
  4x retime, sparse decode/protocol, signed cursor, product-version, duplicate
  decoded-timestamp, and early-cap regressions. The first clean headed-Chromium
  run on local commit `450da854fc` exposed the legitimate equal-timestamp
  Mediabunny result; after the correction, the complete dirty-tree flow passed
  with exact cache reuse, one history entry, balanced resources, and no console
  problems. Pass 8/8 focused files with 78/78 tests plus 17/17 runner checks;
  pass 184/184 full-suite files with 2,542/2,542 tests plus the same runner;
  pass the 4,810-module TypeScript/Vite build, warning-free lint, production
  audit with 0 vulnerabilities, and diff checks. Refresh clean-tree Chromium,
  CI, and exact-head Codex review on the amended commit.

## Milestone 5 Part 10a.2 / issue #109 - seventh exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Replace the duration-sized coverage-transform array with a lazy iterable
  over every admitted integer clip frame. Accumulate exact reciprocal crop
  constraints and maximum scale in the same traversal, retaining only the
  already bounded simplified keyframes plus one transient transform.
- [x] Keep `requiredVideoStabilizationSafeZoom` iterable-based and add a
  deterministic single-use stream regression that fails on a second traversal.
  Pass 9/9 focused files with 83/83 tests plus 17/17 runner checks and 184/184
  full-suite files with 2,543/2,543 tests plus the same runner. Pass TypeScript,
  build, warning-free lint, the production audit with 0 vulnerabilities, and
  diff checks; refresh clean headed Chromium, CI, and exact-head Codex review
  after commit.

## Milestone 5 Part 10a.2 / issue #109 - eighth exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Remove the container first-PTS offset from stabilization's source-tick,
  native-frame, sparse request, and inverse mappings so they match preview and
  export's zero-relative rendered-source timeline. Normalize exact bounds to a
  checked duration and reject mismatched connected-source timestamp facts.
- [x] Advance product provenance to `similarity-product-v3` and add positive
  plus negative first-presentation-timestamp regressions with identical target
  timestamps, source ticks, and half-open decode bounds. Pass 9/9 focused files
  with 85/85 tests plus 17/17 runner checks and 184/184 full-suite files with
  2,545/2,545 tests plus the same runner. Pass TypeScript, build, warning-free
  lint, the production audit with 0 vulnerabilities, and diff checks; refresh
  clean headed Chromium, CI, and exact-head Codex review after commit.

## Milestone 5 Part 10a.2 / issue #109 - ninth exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Replace the per-pair zero-delay timer with a bounded cooperative-yield
  schedule: check cancellation before every pair, then yield after at most 16
  pairs or eight milliseconds of synchronous work.
- [x] Prefer `scheduler.yield()`, otherwise deliver one non-clamped
  `MessageChannel` task and close both ports. Retain a zero-delay timer only for
  environments without either primitive, driven by the same bounded
  batch/deadline rather than unconditionally after every pair.
- [x] Add deterministic batching and deadline-cancellation regressions. Pass
  9/9 focused files with 87/87 tests plus 17/17 runner checks and 184/184
  full-suite files with 2,547/2,547 tests plus the same runner. Pass the
  4,810-module TypeScript/Vite build, warning-free lint, production audit with
  0 vulnerabilities, and diff checks; refresh clean headed Chromium, CI, and
  exact-head Codex review on the final tree.

## Milestone 5 Part 10a.2 / issue #109 - tenth exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Keep every video `sourceFrame` at its conformed document-rate timestamp
  through streaming preview, legacy preview, export, and stabilization
  analysis. Let the decoder select the containing native media sample instead
  of rounding to a nearest native frame before decode.
- [x] Use native rate only for decode tolerance and deterministic containing-
  sample deduplication. Store the first direct request timestamp and exact
  SourceTimeMap tick that display each retained native sample.
- [x] Advance stabilization provenance to `similarity-product-v4` and add a
  mismatched 24 fps source / 30 fps project regression proving source frame 2
  stays at 66,667 µs across both preview protocols, export, and analysis. Pass
  11/11 focused files with 152/152 tests plus 17/17 runner checks and 184/184
  full-suite files with 2,548/2,548 tests plus the same runner. Pass the
  4,810-module TypeScript/Vite build, warning-free lint, production audit with
  0 vulnerabilities, and diff checks; refresh clean headed Chromium, CI, and
  exact-head Codex review on the final tree.

## Milestone 5 Part 10a.2 / issue #109 - eleventh exact-head review follow-up

**COMPLETE LOCALLY (2026-08-13).**

- [x] Remove average-native-rate sample deduplication. Submit every distinct
  conformed document-rate render request and use only the sparse decoder's
  returned sample timestamp as displayed-media identity.
- [x] Encode equal returned timestamps as explicit null-motion holds, retain
  motion for every later distinct timestamp, and protect repeated runs by the
  request-to-returned-timestamp map. Advance result schema to 3 and product
  cache provenance to `similarity-product-v5`.
- [x] Pin the hostile VFR 0/33 ms request -> 0/25 ms sample case plus true
  repeats. Pass 11/11 focused files with 154/154 tests plus 17/17 runner checks
  and 184/184 full-suite files with 2,550/2,550 tests plus the same runner. Pass
  the 4,810-module TypeScript/Vite build, warning-free lint, production audit
  with 0 vulnerabilities, and diff checks. Pass clean headed Chromium on code
  commit `c6005ca437` and strict port 41883 with 32 samples/keys, exact cache
  reuse, 1.0232x safe zoom, one history entry, balanced worker/cache cleanup,
  zero console/page problems, and complete port release; refresh exact-head CI
  and fresh Codex review after the final docs-only amend.

## Milestone 5 Part 10a.3 / issue #110 - bounded point and box tracking

**COMPLETE LOCALLY; CI/REVIEW PENDING (2026-08-13).**

- [x] Add exact-frame Program Monitor point/box selection and the accessible
  Inspector analyze/cancel/retry/confidence/loss/preview/apply/reset workflow.
- [x] Reuse #108 for bounded ascending/descending sparse decode, cache,
  provenance, cancellation, cleanup, and scheduler ownership; retain only the
  prior tight grayscale frame while tracking.
- [x] Stop explicitly on failed point/box agreement with no extrapolation.
  Revalidate cache geometry and the complete directional frame/tick schedule.
- [x] Map accepted samples through resolved source crop/flip/anchor/transform
  to ordinary target Position X/Y and optional Scale X/Y. Preserve unrelated
  state, require replacement consent, reject overlap/lock/duplicate/key-budget
  failures, and Apply in one undo entry.
- [x] Add a source-bound Chromium product gate. The clean-commit run on
  `f278aa23594cd694213385469e02782d615408b7` and strict port 41886 passed
  point mean/max 0.333/1.000 px, box center mean
  0.333 px, scale error 0%, loss at exact occlusion frame 18, exact cache reuse,
  one history entry, a reverse 17-to-0 sparse lane, worker lifecycle 3/3/0,
  cache cleanup, zero browser problems, and complete port release. The source
  fingerprint was
  `sha256:799c29664da65cf40b75bc543e35ecd5f8a319d9201ba0d071bbe5a4f27e9010`;
  JSON/PNG SHA-256 values were
  `E9A4242F8AD80CB5F2FD72EA3D1F53F855838841A0B94F2D1DC5C77142EAD516` /
  `364F32294130A88BDBB1440CD77946B72E2184AA950F9BFF6CA15A59469CF02A`.
- [x] Freeze the final source tree; pass 12 focused files / 120 tests, 190 full
  files / 2,575 tests, all 17 runner checks, build/typecheck, lint, a production
  audit with 0 vulnerabilities, diff/architecture checks, and normal-dist
  canaries.
- [ ] Pass exact-head CI, request fresh exact-head Codex review, and merge only
  after its clean verdict.

## Milestone 5 Part 10a.3 / issue #110 - first exact-head review follow-up

**COMPLETE LOCALLY; PUBLICATION REFRESH PENDING (2026-08-13).**

- [x] Give stabilization and motion-tracking transport previews explicit owners;
  clear only the calling editor's preview so simultaneously mounted Inspector
  surfaces cannot erase one another.
- [x] Filter live progress by the requested point/box kind and select the newest
  queued/running status ahead of retained terminal jobs.
- [x] Resolve the target transform at every accepted frame. Use preserved
  target Rotation for target-local box extents and crop/anchor compensation,
  and preserved Scale for compensation whenever tracking does not author Scale.
  Pin off-center Position and 0-to-90-degree box-scale regressions.
- [x] Pass 14 focused files / 135 tests, 190 full files / 2,578 tests, all 17
  evidence-runner checks, build/typecheck, lint, a production audit with 0
  vulnerabilities, and diff checks.
- [ ] Commit the exact follow-up tree, refresh clean headed Chromium, push, pass
  exact-head CI, and request a new Codex review.

## Milestone 5 Part 10a.3 / issue #110 - second exact-head review follow-up

**COMPLETE LOCALLY; PUBLICATION REFRESH PENDING (2026-08-13).**

- [x] Scope user cancellation by analysis kind: point/box tracking cannot abort
  stabilization on the same source clip, and stabilization cannot abort
  tracking. Preserve whole-clip cancellation only for attachment removal and
  controller disposal.
- [x] Prove a queued point job can be cancelled while same-clip stabilization
  remains running, completes successfully, and drains the one-slot scheduler.
- [x] Exclude the tracked source from the Inspector target list and independently
  reject equal source/target clip identities in domain planning.
- [x] Pass the directly affected six-file matrix at 53/53 tests and the
  authoritative suite at 190/190 files / 2,581/2,581 tests plus all 17
  evidence-runner checks. Pass the 4,816-module build/typecheck, warning-free
  lint, production audit at 0 vulnerabilities, and diff checks.
- [ ] Commit the exact tree, refresh clean headed Chromium, push, pass exact-head
  CI, and request a fresh Codex review before merge.

## Milestone 5 Part 10a.3 / issue #110 - third exact-head review follow-up

**COMPLETE LOCALLY; PUBLICATION REFRESH PENDING (2026-08-13).**

- [x] Derive the expected tracking-result width/height through the shared
  bounded decode sizing rule and reject any result that does not exactly match
  the connected source before product normalization.
- [x] Preserve source-aware error provenance: cached geometry mismatch is
  `storage-corrupt`, while a fresh worker mismatch is `decode-readback`.
- [x] Pin exact bounded, one-axis-corrupt, and unscaled geometry regressions.
- [x] Pass 35/35 focused controller/domain tests, 190/190 full-suite files and
  2,582/2,582 tests plus 17/17 runner checks, the 4,817-module build/typecheck,
  warning-free lint, production audit at 0 vulnerabilities, and diff checks.
- [ ] Refresh clean Chromium, exact-head CI, and Codex review before merge.

## Milestone 5 Part 10a.3 / issue #110 - fourth exact-head review follow-up

**COMPLETE LOCALLY; PUBLICATION REFRESH PENDING (2026-08-13).**

- [x] Bound transport preview to the inclusive first/last accepted tracking keys
  as well as the target clip, so ordinary endpoint hold cannot display draft
  motion on unaccepted frames.
- [x] Pin preview absence before the first key, presence at both accepted
  boundaries, and cleanup immediately after the last key.
- [x] Pass 6/6 focused UI tests, 190/190 full-suite files and 2,583/2,583 tests
  plus 17/17 runner checks, the 4,817-module build/typecheck, warning-free lint,
  production audit at 0 vulnerabilities, and diff checks.
- [ ] Refresh clean Chromium, exact-head CI, and Codex review before merge.

## Milestone 5 Part 10a.3 / issue #110 - fifth exact-head review follow-up

**COMPLETE LOCALLY; PUBLICATION REFRESH PENDING (2026-08-13).**

- [x] Replace the single last-writer preview slot with transport-owned candidate
  arbitration for stabilization, motion tracking, and direct Program Monitor
  manipulation. Keep activation priority stable across hidden owner updates.
- [x] Restore the newest still-live sibling immediately when the visible owner
  releases; clear all candidates on project reset. Prove tracking-off restores
  stabilization and gesture completion restores the editor it covered.
- [x] Pass 43/43 focused transport/editor/overlay tests, 190/190 full-suite files
  and 2,586/2,586 tests plus 17/17 runner checks, the 4,817-module
  build/typecheck, warning-free lint, production audit at 0 vulnerabilities,
  and diff checks.
- [ ] Commit the exact tree, refresh clean headed Chromium, push, pass exact-head
  CI, and request a fresh Codex review before merge.

## Milestone 5 Part 10a.4 / issue #111 - parity-safe manual lens remap

**IMPLEMENTED LOCALLY; PUBLICATION GATES PENDING (2026-08-13).**

- [x] Preserve the pure version-1 normalized Brown-Conrady model and fixed
  33x33/Jacobian foldover gate; expose one immutable validated mapper so bounded
  frame loops do not repeat model validation for every output pixel.
- [x] Build seven deterministic RGBA fixtures covering neutral, barrel,
  pincushion, tangential, off-center, strong-valid, and transparent-edge cases.
  Keep the CPU/ImageData path as a cancelable truth oracle only.
- [x] Implement one build-unreferenced WebGL2 RGBA8/UNSIGNED_BYTE candidate with
  manual transparent-edge bilinear sampling. Share its shader/program between
  preview draw and export readback; compare pixels within 1 byte/channel and a
  33x33 transform-feedback geometry grid within 0.25 source pixel.
- [x] Freeze source ordering before authored crop/transform/masks/effects/
  opacity/blending/transitions. Reject the invalid-folding fixture before GPU
  work and preserve the 256 MiB aggregate surface envelope at every selectable
  project size.
- [x] Measure CPU, preview, and export at 720p/1080p/4K. The headed shakedown
  measured 1080p preview/export p95 10.4/13.6 ms, 4K 33.4/55.7 ms, maximum
  pixel delta 1, geometry delta 0.000035 px, and 232,243,200-byte combined 4K
  peak. Treat timings as host evidence, not universal guarantees.
- [x] Make context loss terminal for the disposable owner, prove a fresh-worker
  retry, cooperatively abort the CPU probe, terminate all three workers, observe
  `error`/`messageerror`, and retain zero candidate bytes after disposal.
- [x] Specify explicit unavailability with no CPU substitution. Keep product
  schema/UI/render imports and every bundled/downloaded/automatic profile
  catalog outside #111.
- [x] Freeze and validate the full tree: 4 focused files / 20 tests, 192 full
  files / 2,598 tests, 17/17 runner checks, 4,817-module build/typecheck, clean
  lint, production audit at 0 vulnerabilities, diff checks, and zero Issue #111
  canary files in normal production output.
- [ ] Commit/push, replace preliminary data with clean exact-head headed
  evidence, pass CI, request `@codex review`, and merge only after Codex reports
  no major issues. On that clean go decision, open a separate bounded product
  implementation issue.

## Milestone 5 Part 10a.4 / issue #111 - first exact-head review follow-up

**VALIDATED LOCALLY; CLEAN-HEAD PUBLICATION PENDING (2026-08-13).**

- [x] End the context-loss worker after its terminal result. Start a separately
  owned recovery worker, re-probe WebGL2 context-loss/texture facts, render and
  dispose one exact frame, then terminate before starting cancellation.
- [x] Flip RGBA8 readback rows in the original frame buffer. Do not retain a
  second frame-sized output while the raw readback is live; preserve the exact
  seven-surface / 232,243,200-byte 4K envelope.
- [x] Update lifecycle/result/runner contracts and deterministic gate tests for
  three created, three terminated, and zero active workers.
- [x] Refresh the authoritative full suite: 192/192 files, 2,598/2,598 tests,
  and 17/17 runner checks. Build/typecheck, lint, production audit, diff checks,
  and production-isolation canaries are green.
- [ ] Publish a clean exact-head Chromium artifact, pass CI, and receive a clean
  Codex review before merge.

## Timeline automation follow-up - playhead-local speed sections

**COMPLETE (2026-08-14).**

- [x] Replace the ambiguous Inspector `Speed` action with `Speed at playhead`,
  authoring or updating an exact integer-frame boundary inside the selected
  timed clip. Keep `Whole clip speed` as a separate explicit fallback.
- [x] Default newly introduced boundaries to held sections so a change begins
  at the requested playhead frame instead of gradually affecting the untouched
  prefix. Preserve explicit hold/linear/smooth editing in the ramp controls.
- [x] Derive a presentation-only video speed lane from the same persisted
  `SourceTimeMap` used by preview and export. Label normal, slow, fast, freeze,
  and mixed sections and draw their exact boundaries without duplicating the
  lane on linked audio.
- [x] Include effect-parameter keys in the existing timeline marker surface and
  de-duplicate frames shared with ordinary transform/opacity animation.
- [x] Pass 130/130 focused tests and the authoritative 193-file / 2,603-test
  suite. Pass build/typecheck, warning-free lint, and diff checks.
- [x] In in-app Chromium on exclusive port 41892, import and place a real
  H.264/AAC fixture, author 100% / 50% / 100% sections at clip frames 0, 60,
  and 180, verify linked timing and the video-only lane at Detail Zoom, compare
  directly with the supplied Resolve reference, and observe no console warnings
  or errors. `design-qa.md` records `final result: passed`.

## Milestone 5 Part 10a.5 / issue #119 - ship bounded manual lens correction

**COMPLETE LOCALLY; PUBLICATION PENDING (2026-08-15).**

- [x] Advance timeline schema 13 -> 14 with nullable versioned lens intent,
  bounded future-intent preservation, exact migration/round-trip validation,
  and video-only ownership.
- [x] Add the canonical immutable operation/store action and accessible Crop
  Inspector controls for the complete manual model. Keep one history entry per
  commit; provide enable/reset/keyboard/lock behavior and honest coverage plus
  renderer capability status.
- [x] Promote `webgl2-rgba8-manual-bilinear-v1` into production. Route preview
  and export through the same source-space `compositeFrame` seam before crop,
  transform, masks/chroma, effects, opacity/blend, and transitions. Never use
  the CPU oracle as a product fallback.
- [x] Make unsupported WebGL2/context/texture/readback/budget facts explicit,
  make context loss terminal per owner with fresh-worker recovery, and prove
  exact success/cancel/failure disposal.
- [x] Fail motion-tracking authoring closed for lens-corrected sources until an
  accepted inverse projection can map Program Monitor picks into decoded-source
  coordinates.
- [x] Admit two reusable remap surfaces and one finite export readback through
  the shared budget. Keep the 4K seven-surface peak at exactly 232,243,200
  bytes under 256 MiB.
- [x] Pass 193/193 files and 2,613/2,613 tests plus 17/17 runner checks,
  4,821-module build/typecheck, and warning-free lint. Pass source-bound in-app
  Browser QA on strict port 41889: runtime backend/texture facts, 10.00%
  overscan, 1.20x full coverage, exact undo/redo/reset, corrected 1080p MP4
  Export ready, and zero console warnings/errors.
- [ ] Push the exact commit, pass CI, request a fresh current-head Codex review,
  and complete PR/issue closeout only when explicitly authorized.

## Milestone 6 Part 12 / issue #78 - editor-structure research gate

**COMPLETE LOCALLY (2026-08-17).**

- [x] Compare current adjustment-layer, compound/nested-sequence, and multicam
  workflows against Myrelith's real single-document schema, integer-frame
  planners, audio-master-clock playback, project/recovery boundary, history,
  and shared preview/export path.
- [x] Freeze bounded recommendations: adjustment layers first; then a central
  same-settings sequence graph; then live depth-8 nested instances; then manual
  two-to-eight-angle multicam with fixed or follow-video audio. Keep mixed-rate
  nesting, automatic sync, and simultaneous live angle playback no-go for the
  first slices.
- [x] Add build-unreferenced pure prototypes for post-composite adjustment
  ordering, complete-project cycle/depth/reference validation, exact 1:1 nested
  frame expansion, logarithmic multicam switches, and the 256 MiB surface
  envelope. Pass 19 focused tests.
- [x] Run representative large fixtures: 128x1,024 adjustment items, 256
  sequences/255 references, and eight angles/24,000 switches/250,000 lookups.
  Pin seven/eight/nine 4K surfaces at 232,243,200 / 265,420,800 / 298,598,400
  bytes, proving that a ninth surface exceeds the shared limit.
- [x] Record migration, portability, history, nested resource ownership,
  performance risks, explicit non-goals, recommended order, and four
  implementation-ready child issue specifications in
  `docs/EDITOR_STRUCTURE_RESEARCH.md`. No product schema/UI/runtime behavior or
  remote GitHub item is changed by the local-only gate.
- [x] Pass the complete 226-file / 3,074-test suite plus all 17 runner checks,
  the 4,872-module production build/typecheck, source lint excluding the
  user-owned untracked `.worktrees/` directory, a production audit with zero
  vulnerabilities, production-isolation search, and diff checks. Chromium is
  not applicable because the gate adds no observable browser/runtime path.

## Post-MVP issue #179 - marquee selection and grouped movement

**IMPLEMENTATION COMPLETE LOCALLY (2026-08-24).**

- [x] Add Select-tool primary left-drag marquee selection from empty timeline
  lane space, with live translucent intersection feedback across visible,
  unlocked lanes and robust release/cancel cleanup across the sticky gutter.
- [x] Keep marquee and multi-selection truth ephemeral in transport state; no
  document mutation, persistence, or undo entry occurs until a clip move is
  committed.
- [x] Add one pure atomic horizontal group-move operation, expand selected roots
  through existing A/V link groups, and reject the entire edit on stale ids,
  locks, bounds, or final-layout collisions while preserving transitions.
- [x] Reuse the shared selected/link closure for drag preview, pointer commit,
  and Ctrl/Cmd + Arrow. Preserve the existing single-clip cross-track path;
  grouped clips remain on their current lanes.
- [x] Browser-verify reverse cross-gutter box selection, live highlighting,
  +40-frame grouped movement, one-step Undo/Redo, and a clean console in desktop
  Chromium at 1280x720.
- [x] Pass all 236 Vitest files / 3,364 tests plus all 17 repository runner
  checks, production build/typecheck, lint, production dependency audit, and
  diff hygiene.

## Post-MVP issue #180 - Compatibility and HEVC export flush error

**FIXED BY MERGED PR #178; REGRESSION LOCKED LOCALLY (2026-08-24).**

- [x] Correlate the issue timestamp and affected-profile split with PR #178.
  Compatibility/AVC and HEVC share MP4/AAC; the merged `f0165ed` fix already
  maps 96 kHz document audio to the 48 kHz WebCodecs encoder boundary while
  preserving document-rate mix math and the exact selected profile.
- [x] Add an audio-bearing 96 kHz fresh-adapter regression for both affected
  profiles. Reject any non-48 kHz probe sample with the reporter's exact
  `Flushing error`; require a supported result, exact profile identity,
  successful finalization, and no cancellation.
- [x] Prove the causal differential in an isolated pre-fix worktree: the test
  fails on `f53219c` with the exact MP4/AVC and MP4/HEVC unavailable messages,
  then passes unchanged on the current branch with only 48 kHz probe samples.
- [x] Browser-verify downloadable Compatibility and HEVC MP4 results from a
  1920x1080, 30 fps, 96 kHz five-second title project. The browser path covers
  visible selection/start/result behavior; the adapter differential covers the
  load-bearing audio track.
- [x] Pass all 236 Vitest files / 3,366 tests plus all 17 repository runner
  checks, production build/typecheck, clean lint, production dependency audit,
  and diff hygiene.
