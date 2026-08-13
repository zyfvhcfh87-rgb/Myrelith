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
- The opt-in Issue #54 and Issue #70 evidence panels plus the checked-in Issue
  #108, Issue #109, and Issue #110 browser gates have narrow,
  architecture-guarded dev exceptions. `dev/performance/runtime.ts` may compose
  existing `app/` controllers with `state/` and its bounded Mediabunny fixture
  generator;
  `dev/performance/framePlanningBenchmark.ts` may import only browser-free
  `domain/` planners to produce the Issue #59 legacy/indexed parity and timing
  evidence;
  `PerformanceBenchmarkApp.tsx` may reuse existing `ui/` surfaces.
  `ProxyEditingBenchmarkPanel.tsx` may read the selected document/media state
  and call the app-owned preview/proxy/transport facades solely to measure the
  exact live source path. `dev/issue108/motionAnalysisFoundation.ts` may compose
  only the production `app/` motion-analysis facade, browser-free `domain/`
  cache constants, and the serializable `pipeline/` protocol to run the
  source-bound Issue #108 gate; only `scripts/issue108/foundation-gate.html`
  imports it. `dev/issue109/videoStabilizationGate.ts` may compose only the
  production stabilization `app/` facade, browser-free `domain/` facts, and
  document/media/provenance `state/` needed to install and verify its isolated
  encoded fixture; only `scripts/issue109/stabilization-gate.html` imports it.
  `dev/issue110/motionTrackingGate.ts` has the same narrow app/domain/state
  composition exception for its isolated encoded point/box fixture; only
  `scripts/issue110/motion-tracking-gate.html` imports it.
  No ordinary application entry may import any gate, and no other `dev/`
  module may reach those layers. Only
  the build-gated exact route in `main.tsx` may import the Issue #54 UI, and
  only `EditorShell.tsx` may dynamically import the Issue #70 panel behind its
  development-only query guard. Ordinary production builds remove both
  dynamic imports and their complete closures.
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
  - `workers/motion-analysis.worker.ts` may import only
    `pipeline/motionAnalysisDecode.ts` (the bounded sequential decode and
    grayscale core) and `pipeline/motionAnalysisProtocol.ts` (its serializable
    worker contract); the worker is their sole production runtime host,
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

Timeline snapping follows the same boundary. `domain/timelineSnapping.ts`
collects eligible playhead, clip-edge, transition-edge, and marker candidates
from an immutable document snapshot, then resolves a bounded signed delta with
deterministic distance/kind/frame/track/id ordering. Locked and hidden tracks,
the moving linked group, and wrong-kind track candidates are excluded. The
8px interaction threshold is converted with authoritative pixels-per-frame
`zoom`, so it stays visually stable without introducing fractional authored
frames. Pointer and keyboard moves call this same resolver. Their alignment
guide lives only in `transportStore`; Alt bypasses snapping for the current
move, while the persistent preference remains unchanged.

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
- `Clip.sourceMode` and `Clip.sourceTimeMap` make source mapping explicit.
  Timed clips retain an exact affine fallback: integer micro-frame source ticks
  plus a reduced rational rate in whole 25-percentage-point steps across the
  inclusive 1/4×–4× range. Schema 12 may add a bounded piecewise speed curve
  over that fallback. Its strictly ordered integer-frame points use the same
  rational steps plus explicit 0× freezes; each left point owns `hold`, `linear`,
  or fixed `smooth` easing. One integer-valued segment primitive makes direct,
  split, and trimmed evaluation telescope exactly without a float accumulator
  or hidden remainder state. The map retains its
  exact source span independently from the whole-frame timeline duration, so
  changing speed repeatedly cannot discard a fractional source tail. All
  preview, playback, export, transition, thumbnail, waveform, seeking, trim,
  split, slip, slide, move, and keyframe-remap paths delegate to
  `domain/sourceTimeMap.ts`; no consumer reconstructs `sourceStart + offset`.
  Timeline schema 11 adds the affine contract. Schema 9 first migrates effect
  descriptors through schema 10, then the 10→11 migration installs an exact 1×
  identity map and durable keyframe source-time intent. The 11→12 migration adds
  an empty curve, preserving every constant-speed document byte-behaviorally.
  Still and text clips retain their fixed source semantics and cannot be
  retimed.
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
- `Clip.effects` is a durable ordered list of versioned `EffectDescriptor`
  records in timeline schema 10. `domain/effectStack.ts` is the browser-free
  registry, validation, migration, capability, and evaluation authority.
  `domain/effectBounds.ts` is the one browser-free descriptor and aggregate
  budget contract used by both live operations and portable validation: no
  successful edit may create a document that save/recovery must reject.
  Schema-9 migration assigns the reserved legacy version zero to unknown types
  without changing their payload; registry-owned legacy descriptors migrate to
  their current version. Unknown types, versions, and parameter keys must remain
  ordered and serializable, while evaluation reports and bypasses anything it
  cannot safely execute. The normative contract is in `docs/EFFECTS.md`.
- `domain/pluginManifest.ts` is the pure, non-executing structural validator and
  compatibility negotiator for the proposed plugin manifest. It reuses the
  durable effect-number/key bounds, requires one package-unique render export per
  contribution as the WebAssembly-call discriminator, keeps those render names
  disjoint from differently typed migration exports, and declares bounded
  descriptor-migration ABI facts. It may define only serializable data and must
  never read packages, verify signatures, mutate trust/permission state, register
  runtime code, or instantiate WebAssembly. Descriptor migration ABI version 1
  is static-instance-only: before any migration export runs, the future host must
  reject an instance targeted by any owning `ClipAnimation.effectTracks` entry
  and preserve its original descriptor plus complete animation. Existing keys
  that happen to fit new ranges are not proof of schema or unit compatibility;
  animated migration requires a future, separately versioned contract.
  Frame capability version 1 has one input/output representation: four-byte
  straight RGBA with nonlinear IEC sRGB OETF code values, sRGB/Rec.709 primaries,
  D65 white, and independent 8-bit alpha; it is neither linear-light nor
  Display-P3. The future host owns conversion into and out of that encoding,
  preview/export share the boundary, and no ICC/profile metadata enters plugin
  memory.
  Each future render call also receives one immutable parameter record at the
  fixed ABI parameter page: exactly one property per selected contribution
  declaration and no other fields, serialized with RFC 8785 JCS and encoded as
  UTF-8 without a BOM, whitespace, terminator, or trailing bytes. A present
  authored value must match its declared number/boolean/enum kind and bounds;
  invalid values fail/bypass without calling plugin code. An absent declared
  value is completed ephemerally from the manifest default without mutating the
  document, while an undeclared durable key keeps the descriptor unsupported
  and never crosses the call boundary. Before serialization, the future Issue
  #77 host must expose plugin `animatable: true` number declarations to the same
  pure effect-track authority used by the composition plan, resolve them at the
  exact requested global integer timeline frame, and use the materialized base
  number (valid authored value, otherwise the manifest default) as the static
  fallback; control `step` never quantizes render evaluation.
  Preview/scrub/playback/export using the same immutable snapshot and frame must
  produce byte-identical records. Descriptor migration remains a separate,
  static-record ABI and never receives this frame-resolved render record.
  Package-signature version 1 is one closed RFC 8785 JCS envelope with exact
  `format: "myrelith-plugin-signature"`, `formatVersion: 1`, and
  `algorithm: "Ed25519"` literals; a canonical unpadded-base64url 32-byte public
  key and 64-byte signature; a `sha256:` plus lowercase-hex public-key
  fingerprint; and exactly two strictly ASCII-path-sorted expanded-entry
  records for `manifest.json` and the manifest's normalized Wasm entry. The
  Ed25519 message is the UTF-8 JCS encoding of that exact envelope without its
  `signature` member. The package digest is a separately domain-separated,
  `u32`-length-framed SHA-256 over those message bytes and the decoded signature
  bytes, represented as `sha256:` plus lowercase hex. Exact member sets, entry
  length bounds, digest encodings, framing bytes, and the self-verifying golden
  vector in `docs/PLUGINS.md` are the authoritative wire contract; duplicate
  keys, noncanonical bytes, extra entries/members, or alternate encodings fail.
  The future trusted parent owns bounded archive/manifest parsing, exact module-
  entry framing and the 32 MiB byte-length check, digest/signature/trust preflight,
  one non-resetting five-second activation deadline, and termination. It treats
  the framed WebAssembly bytes as opaque and never synchronously iterates
  attacker-driven sections, bodies, instructions, or initializer expressions.
  The parent starts that deadline before creating a fresh disposable activation-
  candidate worker. Entirely inside the candidate, the host-authored byte-policy
  parser rejects every start section and enforces the exact per-module
  declaration, segment, memory, and table ceilings in `docs/PLUGINS.md` before
  any engine API. Compressed function signatures and code-local groups are
  charged by expanded multiplicity, including each defined function's reused
  parameter vector; raw declarations, expanded signatures, expanded runtime
  slots, and their combined checked sum are all bounded before engine work.
  Unsupported value types/features fail at this candidate-worker parser boundary.
  The candidate selects one exact binary-policy profile from the already-
  validated signed manifest facts before it scans the module. A module whose
  every contribution has an empty `migrations` array uses
  `myrelith-wasm-render-general-v1`, the wider render-only profile described in
  `docs/PLUGINS.md`. That wider profile preserves common render toolchains and
  fixed-width-SIMD performance, but version 1 does not promise bit-identical
  third-party plugin pixels across different browser engines or hardware; the
  exact host input/parameter encoding, call ordering, and lifecycle boundaries
  remain shared. If any contribution declares one or more migration steps,
  the entire signed module instead uses
  `myrelith-wasm-migration-integer-v1`: `f32`, `f64`, and `v128` types are
  forbidden in every signature, block type, typed-`select` result, local, and
  global. Every float
  constant/load/store/arithmetic/comparison/conversion/reinterpretation form,
  every float-related prefixed conversion, and the complete fixed-width SIMD
  prefix/table are absent from its closed table. Only the existing deterministic
  `i32`/`i64`, control, variable, parametric, fixed-memory, bulk-memory, and
  bounded `funcref` table subset remains, except `table.grow` is forbidden so
  allocation-dependent success cannot affect migration output; no host clock,
  randomness, or callable import exists. This whole-module rule deliberately
  constrains render exports in migration-bearing packages too, so an unreachable
  helper, `call_indirect`, or table entry cannot evade deterministic migration policy.
  Each profile has its own exact id and normative opcode/immediate-table digest;
  both enter the raw-module cache identity, and a prior general-profile parse can
  never authorize a migration-bearing activation.
  Executable bytes are independently bounded too: a defined-function body is at
  most 256 KiB and all bodies total at most 16 MiB; canonical instruction
  decoding admits at most 65,536 opcodes per body and 1,048,576 per module,
  256 simultaneously open explicit control constructs, and `br_table` vectors
  of at most 1,024 labels/16,384 per body/65,536 per module. Constant and
  initializer expressions admit 64 opcodes each and 16,384 per module. The
  selected profile's binary-policy-versioned opcode/immediate table is closed;
  the parser bounds
  every immediate vector before allocation, validates branch/control structure,
  and requires the final `end` to consume the exact body/expression with no
  trailing bytes. These byte/opcode/depth gates and declaration charges all pass
  independently before validation, compilation, or instantiation.
  The imported memory is fixed-size from 258 through 1,025 pages. Its first
  8 MiB is reserved for passive-data materialization, the next 8 MiB for the
  module stack/heap, page 256 for host parameters or migration input, and pages
  257 onward for host pixels or migration output. Active data segments are
  forbidden before instantiation; the only accepted initialization is bounded
  lazy `memory.init`/`data.drop` from consistent passive data into the first
  region during a watchdog-protected call. Both imported limits and both host
  memory limits equal the manifest request, so growth is impossible. A request
  of `P` pages supports at most
  `(P - 257) * 16,384` RGBA pixels; the maximum is 48 MiB or
  12,582,912 pixels at 1,025 pages. A larger compositor surface remains valid
  project/render input but makes that plugin stage preview-unavailable and
  export-blocking under the existing explicit bypass policy. The host refreshes
  and validates its fixed I/O regions for every call; these regions constrain
  conforming module allocation but do not pretend to isolate an untrusted
  module from its own imported memory.
  Only after the complete byte-policy parse succeeds may that same candidate
  worker perform engine validation, compilation, and instantiation. The parent
  deadline was already running before worker creation, never resets between
  those phases, and expires after five seconds. Parse rejection invokes no
  engine API; every parse/engine failure or timeout destroys the candidate and
  sandbox. A ready candidate promotes in place to the lifecycle's dedicated
  runtime worker, so attacker-driven parsing cannot block the app/UI realm.
  Every explicit descriptor migration separately activates one fresh migration-
  owned worker, instance, imported memory, private port, queue, and generation
  for exactly one descriptor chain after current trust/revocation/static-target
  preflight. Steps in that chain may run serially in the same instance, but it
  receives no pixel/editor/export traffic and shares no mutable state with any
  other descriptor. A multi-descriptor action processes fresh owners serially in
  stable document order, stages validated candidates, and commits once only if
  all chains and final document budgets pass against the unchanged starting
  generation. Every success, failure, cancellation, watchdog, or stale-state
  path terminates the owner and preserves all originals unless that final atomic
  commit succeeds; retry is fresh. An activation may receive a fresh copy of
  exact-key verified raw module bytes, but it always repeats candidate parsing,
  engine validation, asynchronous compilation, and fresh instantiation.
  Editor preview/scrub may reuse only its editor-owned runtime instance. Every
  export attempt, including a retry, must instead create a fresh export-owned
  worker, `WebAssembly.Instance`, and imported memory. It may receive only a
  private fresh copy of digest-bound verified raw module bytes; it shares no
  worker, instance, compiled artifact, memory, port, queue, request generation,
  or other mutable plugin state with preview/scrub. Calls to one export sandbox
  are serialized by ascending requested timeline frame and authored plan order.
  Terminal success destroys that sandbox; failure, cancellation, or watchdog
  expiry makes the trusted parent terminate it without waiting for plugin
  cooperation. A retry begins at the first requested frame with another fresh
  instance.
  An optional trusted-parent session cache may retain only verified raw module
  bytes: at most eight private, write-once `Uint8Array` entries and at most
  64 MiB of their actual checked `byteLength` sum. Its exact identity binds the
  plugin/signing/package/module facts plus every negotiated ABI and binary-policy
  fact. The retained backing buffer is never exposed, shared, transferred, or
  detached; each activation receives another fresh copy. Consequently an entry
  has no in-use lease, and deterministic oldest-access-sequence then key LRU may
  evict it after that copy is made. A hit skips no candidate-worker parse,
  `WebAssembly.validate`, compilation, or instantiation gate. Myrelith retains
  no `WebAssembly.Module`, compiled/JIT/native/engine artifact, instance, memory,
  table, global, worker, port, queue, or request state across lifecycles.
  Revocation, disable/uninstall, package replacement, policy/ABI change, and app
  teardown invalidate the relevant raw-byte entries; cache pressure may bypass
  insertion without weakening activation.
  Plugin packages, sandboxes, ports, workers, watchdogs, grants, and revocations
  remain future app-owned Issue #77 resources. Projects may retain only bounded
  namespaced effect descriptors; package bytes, URLs, trust, grants, and runtime
  state never enter `TimelineDoc`, Zustand, recovery, or portable saves. The
  reviewed design and complete boundary are normative in `docs/PLUGINS.md` and
  `docs/PLUGIN_THREAT_MODEL.md`; this Issue #76 prototype executes nothing.
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
- `domain/renderSurfaceBudget.ts` is the shared browser-free allocation gate
  for parsed projects, preview-worker canvas synchronization, and export. It
  bounds each dimension, total pixels, and the aggregate memory represented by
  the compositor's reusable RGBA surfaces before any canvas is resized or
  created. Creation presets stay inside that envelope; hostile portable files
  fail closed instead of reaching a browser allocation.
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
- `domain/sourceTimeMap.ts` is the browser-free authority for constant and
  piecewise-speed retiming. It maps integer timeline offsets to exact source
  ticks and only
  floors at a decoder/frame-selection boundary. `sourceRange` remains the
  integer envelope used for asset-bound validation; `sourceDurationTicks`
  preserves the exact authored out-point. Retime keeps the timeline start
  fixed, chooses the greatest whole-frame timeline duration whose mapped span
  fits the preserved source interval, rejects unsafe timeline ends and overlaps
  atomically, and remaps keyframes from durable exact source-time intent. If two
  authored instants would occupy the same integer timeline frame, the whole
  retime rejects instead of destructively dropping either key. Invalid in-memory
  curve intent is never partially interpreted: visual mapping uses the preserved
  constant fallback, audio fails closed, and portable validation rejects it.
- The unsupported timing-audio policy removes muted audio-only contributors from
  `outputMediaAssetIds`, export/offline preflight, retained Blob ownership, and
  source fetches. A video clip using that same asset remains an output
  contributor, so its visual media is still required.
- Every composition item carries resolved blend intent. Ordinary decoded media
  applies its ordered effect stack during the source draw, then blends after
  transform/crop and opacity. Procedural text paints background, outline, and
  fill unfiltered into one isolated source-over layer, then applies the ordered
  stack once while drawing that completed layer before opacity/blend. A
  crossfade keeps source-over
  legs plus premultiplied `lighter` weighting and applies a non-normal mode to
  the isolated group only when both legs agree on the same supported name;
  mixed/unknown intent uses normal without rewriting either clip. The concrete
  Canvas operation is capability-probed and restored in `finally`; the adapter
  permits a future parity-verified WebGL backend but never selects an implicit
  shader fallback. Canvas filters use the existing saved context and reusable
  text/transition surfaces; effects never allocate per-frame scratch resources.
  Preview and export share this exact plan/compositor path.
- Preview capability is runtime fact, not a UI constant. The render worker
  probes its actual Program Monitor compositor context and reports the result
  through the worker protocol/bridge. `app/previewController.ts` evaluates the
  document against that report and publishes a session-only status projection;
  the Inspector only reads it. Export uses the same compositor but separately
  probes its own export-owned context, so preview and export capability status
  may differ without either path inventing support.
- Issue #75 keeps video-scope compute behind the existing post-presentation
  analysis boundary. `domain/videoScopes.ts` is the browser-free integer/fixed-
  point CPU oracle. The ordinary dedicated analysis worker calls it directly;
  only a build explicitly marked with the internal WebGPU experiment flag may
  dynamically import `workers/video-scopes-webgpu.ts`. That adapter owns one
  device/pipeline plus request-scoped buffers, parity-checks itself before use,
  observes device loss, falls back to CPU on every unsupported/failure path,
  and releases through the child-worker shutdown handshake. Release is terminal
  across every awaited opt-in module, session-request, and parity-self-test
  boundary: late candidates are released, and neither self-test resolution nor
  rejection may restore ready/fallback state or permit a later CPU result. The
  render worker does not acknowledge its own close until that child acknowledges
  release or reaches its bounded termination fallback. It never changes
  preview/export composition, state, project data, or the production default.
- `domain/audioMixPlan.ts` is the shared live/export audible-contributor and
  envelope contract. Valid linked fades open real virtual handle ranges and
  apply clip volume with an absolute linear or equal-power envelope. Web Audio
  schedules that plan against the shared audio anchor; export evaluates it on
  the exact BigInt-derived sample grid before one final sum/clamp. Invalid or
  unavailable audio falls back to the ordinary hard cut without weakening a
  valid visual crossfade.
- Timing audio is deliberately supported only for an exact integer-origin 1×
  mapping; an explicit all-1× curve is equivalent and remains supported. Any
  constant non-1× speed, variable-speed ramp, or freeze is omitted from the
  shared live/export mix plan and produces silence with an explicit reason;
  preview and export therefore agree. Pitch-safe time stretching is a separate
  future capability and must not be approximated with divergent browser
  `playbackRate` behavior. The Inspector exposes this policy for every map.

## Editing-proxy representation and cache

- `domain/proxyCache.ts` is the browser-free authority for proxy provenance,
  profile parameters, strict manifest parsing, and preview/export representation
  selection. Preview may select only a fresh proxy; final export always selects
  and revalidates the original. Every current entry also carries the opaque
  local-project binding that owns it. Same asset ids in copied or unrelated
  portable projects cannot select each other's offline sidecars. Schema-1
  entries load as quarantined legacy data and may be adopted only after a
  connected original proves the saved fingerprint. A proxy is never project
  truth.
- `app/proxyStorage.ts` owns the versioned origin-local OPFS sidecar and
  manifest-first replacement/LRU transactions. Strict parsing rejects unknown
  or unbounded fields before cache-byte arithmetic. Replacement exposes an
  explicit finalize/rollback transaction; remove and clear serialize through
  the same mutation tail. Its registry entry is the only derived-storage
  clearing capability. Project files, recovery, media handles, and portable
  schemas cannot reference or clear through this boundary.
- `app/proxyController.ts` composes exact source/output capability probes, a
  one-job/one-decoder `MediaJobScheduler`, provenance checks, serializable UI
  facts, source replacement/removal cancellation, awaitable cache quiescence,
  async editor-lifecycle leases, and representation facades. A late cache
  commit is rolled back unless the source, job, and controller lifecycle still
  match after commit. `pipeline/proxyGeneration.ts` alone owns the temporary
  Input/decoder, CanvasSource/encoder, muxer, direct OPFS writer, and their exact
  cleanup. It uses the durable primary-video PTS span, normalizes proxy output
  to zero, and probes the exact encoder configuration including frame rate.
- `previewController.ts` and `exportController.ts` both call the shared pure
  representation policy. Preview worker runtime tokens distinguish proxy
  failures from original-media failures; export cannot resolve a proxy when an
  original is offline. The exact supported codec/profile matrix is published in
  `docs/PROXY_CODEC_SUPPORT.md` and is runtime-probed before generation enables.

## Motion-analysis foundation and research boundary

- Issue #108 is the production motion-analysis job, decode, and derived-cache
  foundation. `app/motionAnalysisRuntime.ts` is leased from `EditorShell` and
  composes `app/motionAnalysisController.ts`, which alone owns the one-job/
  one-decoder `MediaJobScheduler`, support facts, source/document-currentness
  checks, cancellation, and serializable status snapshots. React and Zustand
  never receive `File`, `Blob`, `VideoFrame`, worker, decoder, OPFS, or result
  byte ownership, and the controller never mutates the timeline document. The
  controller status retains motion-specific remediation while scheduler failure
  history uses the scheduler's matching canonical class: unsupported runtime,
  quota, and cache corruption map to resource unavailable; decode/readback maps
  to decode failed; unsupported codec and resource limit remain exact.
- `pipeline/motionAnalysisDecode.ts` owns sequential source decode and grayscale
  downsampling after applying each decoded frame's 0/90/180/270-degree source
  orientation into display space. Its dedicated
  `workers/motion-analysis.worker.ts` closes every decoded `VideoFrame` in the
  same operation that acquired it, streams at most 300 tightly owned grayscale
  planes / 32 MiB through one acknowledged window, preserves source-open codec,
  resource-limit, resource-unavailable, and decode-readback failure classes,
  accepts the signed exact primary-stream timestamp bounds carried by project
  metadata, and reports decoded-frame progress independently of whether the
  current frame is sampled. It attempts both cursor and source closure before
  terminal settlement; any close rejection makes the run fail, and a decode
  plus cleanup failure preserves both causes in one aggregate. The app bridge owns
  abort/error/messageerror/send failure, terminates the worker exactly once,
  detaches every identifiable transferred plane before rejecting a malformed
  window or mismatched request identity, detaches accepted planes when their
  consumer settles, and does not
  settle the run or release scheduler admission while an acknowledged window
  remains consumer-owned. A terminal completion with zero decoded samples is a
  typed decode/readback failure before processor finalization or cache staging;
  only positive-sample completions may become cache provenance. The production
  contract currently admits only primary video stream index `0`, carries that
  index explicitly through the worker protocol, and rejects any other stream
  before cache lookup or worker creation. Cache reads and processor results are
  app-owned transferable bytes: cancellation/deadline late arrivals detach
  immediately, and every unsuccessful post-result path detaches before
  scheduler admission can be reused.
- `app/analysisStorage.ts` implements the strict schema-1 origin-local OPFS
  sidecar under `myrelith-derived/analysis-cache-v1`. `domain/analysisCache.ts`
  owns the exact key, provenance, freshness, and stale-rejection policy. Writes
  stage result bytes before the manifest, publish only after a final currentness
  check, and roll back late commits. Abort or the manifest-write deadline may
  reject the caller, but the admitted scheduler operation continues to own the
  staged sidecar until the underlying commit settles and any required rollback
  finishes; no later job may observe an entry whose sidecar was discarded early.
  Capacity checks reject a single result larger than the computed cache ceiling
  before LRU mutation, so an impossible allocation cannot evict usable entries.
  Corrupt, unavailable, quota-exhausted, or stale entries are recoverable
  derived-data failures rather than project loss.
- Issue #109 is the first production consumer of that foundation.
  `app/videoStabilizationController.ts` binds one exact clip/source/project
  snapshot to the production analysis request and cache identity, converts its
  strict result bytes into browser-free facts, and rechecks the binding before
  preview or Apply. `domain/videoStabilization.ts` alone owns SourceTimeMap
  inversion, O(n) product smoothing, analysis-to-source similarity projection,
  exact crop/anchor/flip/rotation project geometry, bounded key simplification,
  and safe-zoom planning. Aspect-rounded downsampling that cannot be projected
  back to a similarity within 0.25 project px is unavailable rather than
  silently authored. Safe zoom is solved after simplification against the
  interpolated transform at every integer clip frame; its displayed crop is
  the total cropped span `1 - 1 / safeZoom`, and the shared envelope is at most
  1.35x. Coverage interpolation is a single-pass stream that accumulates the
  reciprocal crop interval and maximum scale together; it must never retain an
  array with one transform object per admitted clip frame. Product runs admit
  at most 1,000,000 clip frames, 65,534 retained
  analysis samples, 1,024 keys per transform track, four million simplification
  comparisons, and 100,000 document keys. Before retaining each sample, the
  adapter enforces a 512-byte serialized-sample ceiling inside a 32 MiB working
  result budget derived from the shared 256 MiB cache-entry envelope; cached
  bytes are rejected before decode when they exceed the same product ceiling.
  Pair estimation checks cancellation before every pair and cooperatively yields
  after at most 16 pairs or eight milliseconds of synchronous pair work.
  `scheduler.yield()` is preferred, with a non-clamped `MessageChannel` task
  fallback; the zero-delay timer fallback is reached only when neither browser
  primitive exists and is batch/deadline-driven rather than unconditional per
  retained sample.
  SourceTimeMap ticks are conformed project-frame units. Product analysis walks
  the bounded clip timeline with the same canonical selector as preview:
  containing conformed project frame first, then that frame's direct
  project-rate timestamp. Preview, export, and analysis all submit this same
  time and let the decoder select the containing native media sample; none may
  round to or deduplicate with an average native frame rate first. Analysis
  submits every distinct conformed request through one sparse
  `samplesAtTimestamps` decode lane and uses the returned sample timestamp as
  the only displayed-media identity, including when a container's first
  presentation timestamp is positive or negative. Exact
  container bounds are normalized to their checked duration; the first PTS is
  never added to render requests. The half-open admitted bounds encompass the
  first through last direct request timestamps, including fractional trim
  starts; they are never raw fractional SourceTimeMap tick conversions. Result
  schema 3 stores every submitted request's exact SourceTimeMap tick and
  returned sample timestamp. Equal adjacent returned timestamps are explicit
  null-motion identity steps; every later distinct timestamp retains its
  measured motion. Planning indexes corrections and repeated-run `hold`
  boundaries through the complete request-to-returned-timestamp map. This is
  mandatory for variable and mismatched native/project rates, slow conforming
  repeats, and fast retiming that skips nonuniform native-frame counts.
- Stabilization Apply is one immutable document operation and one history
  entry. It writes only ordinary Position X/Y, Rotation, and equal Scale X/Y
  tracks, preserves unrelated tracks, and requires explicit consent before
  replacing any owned property. Moving spans use ordinary linear easing. Every
  run of timeline frames that resolves to the same canonical decoded source
  frame receives matching keys at its first and last frames, with `hold` owned
  by the first key. That covers exact 0× plateaus and repeated frames below 1×,
  so the displayed image cannot interpolate stabilization motion. On any map
  that can repeat, analyzed corrections are indexed by decoded source frame and
  rematerialized at the timeline frame that actually displays it; floor-style
  timestamp inversion cannot place a 0.75× correction on the preceding image.
  Repeated-run boundaries are protected from simplification and remain inside
  the same 1,024-key track envelope; excess structural boundaries reject the
  plan. The operation independently rechecks the document key budget. Preview is
  transport-only session state and never mutates history; cancel, failure,
  cache hit, and parameter tuning likewise do not mutate the project. Preview
  and export therefore continue through the shared ordinary animation
  evaluator, with no stabilization-only render path.
  Reset has no hidden ownership provenance: it removes every ordinary Position,
  Rotation, and Scale track on the clip, including manual or other-tool
  animation, and the Inspector must disclose that complete scope before action.
- Issue #44 remains build-unreferenced feasibility work for the algorithms and
  quality gates. Its browser runtime is owned by
  `app/motionAnalysisResearchController.ts`; its disposable dedicated worker
  imports only browser-free domain modules. Production/editor entry graphs do
  not import the research controller, and the research adds no portable project
  schema, effect descriptor, or document mutation.
- `domain/motionAnalysis.ts` owns bounded grayscale feature detection, patch
  matching, deterministic similarity fitting, stabilization smoothing, and
  conservative crop estimates. Every retained grayscale `Uint8Array` must be a
  zero-offset view covering its complete backing buffer, so the reviewed byte
  gate accounts for the allocation actually pinned by each frame rather than
  only a smaller visible view. `domain/motionTrackingResearch.ts` owns bounded
  point and similarity-box tracking plus conversion to existing Position X/Y
  and Scale X/Y tracks. `domain/lensCorrection.ts` owns only the versioned,
  normalized manual lens model and its fixed-grid safety validation.
- Issue #110's production point/box workflow is composed only by
  `app/motionTrackingController.ts`. The Program Monitor selection store is
  session-only and pins the normalized source selection to the exact integer
  project frame where pointer-up committed it. Forward and backward requests
  use one strict monotonic sparse timestamp lane; a processor retains only the
  previous tightly owned grayscale frame, checks cancellation before work and
  after bounded cooperative yields, and stops on the first rejected pair
  without extrapolation. Result schema 1 and `point-box-product-v1` cache
  provenance bind the source clip, canonical SourceTimeMap, resolved projection,
  direction, selection frame/geometry, shared estimator, and work budget.
  Parsed cache samples must match the exact requested frame/tick schedule and
  remain inside the decoded frame.
- Tracking preview is transport-only. Planning rechecks the latest source,
  media connection, project binding, target overlap/lock/dimensions, ordinary
  animation validity, and exact selection snapshot. Accepted samples map
  through each frame's resolved source crop, flips, anchor, and transform into
  project space. Point tracking may author Position X/Y; box tracking may also
  author Scale X/Y, but never Rotation. Backward analysis is reordered only
  after directional validation and remains anchored to the selected sample.
  Retaining every accepted sample is the zero-error simplification; duplicate
  projected frames, non-finite/out-of-range values, per-track limits, and the
  document aggregate key budget reject before mutation. Apply replaces only
  the explicitly confirmed owned properties in one immutable history entry and
  leaves unrelated clip/effect animation unchanged.
- Both the production controller and research controller admit at most one
  analysis job and reserve at most one decoder slot. Each child operation must
  own and close every VideoFrame, decoder, temporary surface, worker, and OPFS
  handle it creates. Cancellation and bounded support/storage deadlines settle
  the caller without abandoning late ownership; original promises remain
  observed and late-created resources are cleaned without publishing results.
- Analysis results remain preview-only until an explicit Apply operation writes
  ordinary canonical tracks through normal history. Lens remapping remains a
  no-go for production until issue #111 proves a bounded renderer with exact
  preview/export parity; bundled camera-profile catalogs are out of scope.

## Export profile and delivery contracts

- `domain/exportProfile.ts` is the sole browser-free authority for allowed
  concrete container, video/audio codec, channel-layout, bitrate, key-frame,
  MIME, extension, and destination shapes. `auto` is selection policy only and
  resolves Modern → Web → Compatibility; HEVC is explicit-only. Dimensions,
  exact rational FPS, and audio sample rate remain `TimelineDoc` facts.
- `domain/exportWorkBudget.ts` rejects unbounded finite work before a sink,
  encoder, or frame lease exists. The current ceiling is five million frames,
  24 hours, a conservative bitrate-derived four-GiB buffered-output estimate,
  or a 256-GiB direct-file estimate. Long but valid projects remain openable;
  the limit applies only when export is requested.
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
  `retimeClip(clipId, rate)` (timed decoded media only; linked groups retime
  atomically through the pure linking wrapper), `setClipSpeedPoint(clipId,
  frame, rate, easing)`, `removeClipSpeedPoint(clipId, frame)`,
  `clearClipSpeedRamp(clipId)` (all three link-aware and atomic),
  `rippleDelete(clipId)`, `addEffect(clipId, effect)`,
  `setEffectEnabled(clipId, effectId, enabled)`,
  `updateEffectParams(clipId, effectId, patch)`,
  `reorderEffect(clipId, effectId, targetIndex)`,
  `resetEffect(clipId, effectId)`, `removeEffect(clipId, effectId)`,
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
  `redo`. The geometry/timing actions (move/trim/rippleTrim/slip/slide/retime/
  setClipSpeedPoint/removeClipSpeedPoint/clearClipSpeedRamp/rippleDelete/
  splitClipAt/splitClipAtPlayhead) are LINK-AWARE: they
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
  `customZoom`; `setTimelineOriginFrame` changes translation only. These
  geometry fields are ephemeral/non-history and reset deterministically. Also
  `inOut`,
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
  owner dispatches its single pointerup mutation. `snapGuide`
  (`{frame, kind} | null`) is the equally ephemeral visible-alignment result;
  it is published with a drag/edit/ruler preview and cleared on commit, cancel,
  lost capture, or reset. It never enters project data or history.
  `ui/timeline/useClipGestureSession.ts` is the
  single owner of clip pointer/keyboard routing, pointer capture, cancellation,
  rAF-coalesced previews, and the one pointerup document dispatch. At
  pointerdown it delegates to pure `ui/timeline/gestureBounds.ts`, using one
  fresh document/media snapshot to intersect every participating linked
  member's legal signed-delta interval, so no owner can preview beyond a
  partner's timeline, source, duration, and headroom bounds. It snapshots
  snapping candidates from that same document and uses the domain resolver for
  pointer previews, pointer commits, and applicable Ctrl/Cmd+Arrow moves. A
  snapped zero-delta keyboard move may show the guide but dispatches no
  document action. The gesture
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
  keyed by opaque local-project binding + asset ids. The binding lives only in
  Recent/recovery/session storage and never enters domain data or `.myrelith`
  JSON. Reopening the exact remembered `FileSystemFileHandle` preserves it;
  opening a copied or independently selected file creates a fresh binding even
  when its portable document id matches. Legacy records retain a narrowly
  derived migration binding. Resume may query permission silently; prompting
  must originate in a user click. Remembered-handle reads use a bounded
  eight-worker pool and stop scheduling after cancellation. Missing, denied,
  moved, changed, or unsupported sources remain offline and may be reconnected
  individually or through one recursively enumerated folder. Folder scans are
  deterministically bounded;
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
