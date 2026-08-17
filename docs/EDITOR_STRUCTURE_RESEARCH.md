# Editor-structure research: adjustment layers, nested sequences, and multicam

Issue: [#78](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/78)
Date: 2026-08-17
Status: research gate complete; product schema and UI unchanged

## Decision summary

| Family | Decision | Smallest valuable product slice |
|---|---|---|
| Adjustment layers | Go first, bounded | One full-frame, video-only post-composite item with the existing ordered effect vocabulary, exact timeline range, enable/disable, trim/move, and shared preview/export behavior. |
| Project-level sequence graph | Go as a foundation | Multiple same-settings sequences in one portable project, one explicit root/active sequence, project-wide identity/history, and no nesting yet. |
| Compound/nested sequences | Go after the graph | Live shared sequence instances, exact 1:1 integer-frame mapping, create/open/trim/move, acyclic depth at most 8, and black/silent gaps when referenced content is absent. |
| Multicam | Go after the graph, bounded | Two to eight manually aligned angles, exact cut points, independent fixed or follow-video audio choice, and explicit missing coverage. |
| Mixed-rate or mixed-dimension nesting | No-go for the first slice | It needs a separately reviewed rational retiming, scaling, audio-resampling, and duration policy. The first child must not improvise one. |
| Automatic waveform/timecode sync and simultaneous live angle playback | No-go for the first multicam slice | Both add analysis, decoder, memory, proxy, cancellation, and UX scope beyond the manual cut contract proven here. |

The umbrella deliberately does not add a production button, persisted field,
timeline item, decoder, canvas, worker, or renderer branch. The executable code
is a build-unreferenced pure feasibility contract with deterministic fixtures.
Follow-up issues must replace the relevant prototype with separately reviewed
production contracts; production code must not import it as a shortcut.

## Evidence basis and user workflows

The common workflow is consistent across current professional editors:

- An adjustment layer/clip is a transparent item above ordinary footage. Its
  effects apply to the completed lower composition for its timeline range,
  rather than being copied onto every underlying source clip. Adobe documents
  the layer-above-clips model and Final Cut Pro documents the same
  below-the-adjustment behavior.
- A nested/compound sequence is edited as one parent item while retaining a
  live relationship to separately editable child contents. Premiere exposes a
  nested sequence as one linked audio/video clip; Final Cut Pro describes an
  active parent/child compound relationship and also offers an explicit command
  to make an independent parent.
- A multicam source groups synchronized angles, then records video and audio
  angle choices as cuts. Both Premiere and Final Cut Pro distinguish angle
  assembly/synchronization from later switching and allow video and audio to
  switch together or independently.

Primary workflow references:

- [Adobe: Create adjustment layers](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-effects/create-adjustment-layers.html)
- [Apple: Add adjustment clips](https://support.apple.com/en-gb/guide/final-cut-pro/verfda63436e/mac)
- [Adobe: About nested sequences](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-nested-sequences/about-nested-sequences.html)
- [Apple: Create compound clips](https://support.apple.com/guide/final-cut-pro/create-compound-clips-verca9e8d33/mac)
- [Adobe: Create a multi-camera source sequence](https://helpx.adobe.com/premiere/desktop/edit-projects/set-up-multi-camera-sequences-for-editing/create-a-multi-camera-source-sequence.html)
- [Adobe: Create and edit a multi-camera target sequence](https://helpx.adobe.com/ca/premiere/desktop/edit-projects/set-up-multi-camera-sequences-for-editing/create-and-edit-a-multi-camera-target-sequence.html)
- [Apple: Multicam editing workflow](https://support.apple.com/en-euro/guide/final-cut-pro/ver10e087fd/mac)

These products inform workflow expectations, not Myrelith's implementation.
Myrelith remains browser-local, portable, integer-frame based, and constrained
by explicit frame/resource ownership.

## Current Myrelith boundary

The current product has one `TimelineDoc` per `.myrelith` project. Track order
is bottom-to-top; one track contains non-overlapping `Clip` records; every media
clip maps an exact document frame through `SourceTimeMap`; text is a procedural
clip; captions remain semantic lanes. `createVideoCompositionPlanner()` emits
one paint-ordered plan consumed by both preview and export. Audio uses the
separate pure `createTimelineAudioMixPlan()` and live playback remains driven by
the `AudioContext` master clock. `documentStore` snapshots the complete
`TimelineDoc` for one bounded undo/redo history.

That architecture gives the follow-ups strong seams, but none of the three
families is just another current `Clip`:

- An adjustment item consumes the completed pixels below it. A reserved fake
  asset id would misrepresent its ownership and put it at the wrong effect
  stage.
- A sequence instance references another editable timeline definition, not a
  media descriptor, Blob, object URL, or decoder.
- A multicam source owns a stable angle/cut contract whose active video and
  audio angle may differ. Flattening it into ordinary clips would lose the
  editable switch intent.

The proposed project model therefore uses explicit discriminated timeline
items and a project-level sequence graph. It does not overload `assetId`, text
sentinels, link groups, effects, collections, or media descriptors.

## Shared architecture decision

```text
portable project
  rootSequenceId
  active sequence preference (session/UI, not render truth)
  sequences: stable id -> sequence definition
    settings + tracks + markers + captions
    ordinary media/text items
    adjustment items
    sequence instances -> another sequence id
    multicam instances -> bounded angle/cut definition
  media descriptors (owned once at project level)

frame planning
  root integer frame
    -> exact nested local frame (same-rate v1)
      -> ordinary source requests
      -> multicam active video/audio selections
    -> adjustment post-composite boundaries

runtime ownership
  project/app controller owns handles, URLs, decoders, workers, and teardown
  pure project/sequence plans own only serializable ids and integer frames
```

Sequence definitions live once in a central map. Instances retain only a
stable sequence id and exact local range. Recursive embedded snapshots are
rejected because they duplicate shared edits, make cycles hard to detect, and
make project-wide migration/history/resource teardown ambiguous.

Every sequence reference is validated across the complete project, including
currently unreachable definitions. A hidden dormant cycle cannot wait inside a
portable file and become active after a later edit. The first nested slice has
an exact maximum depth of 8 and a per-frame expanded leaf-request cap of 4,096.
Those are denial-of-service and diagnosability bounds, not recommended editing
targets.

## Adjustment layers

### Problem statement

Users need one consistent grade or visual treatment across a scene without
copying and later synchronizing the same effect stack on every clip.

### Bounded MVP

- Add an explicit `adjustment` video-track item with stable id, name, half-open
  timeline range, enabled state, opacity, and the current ordered visual effect
  stack/animation vocabulary that is valid at a post-composite boundary.
- Paint ordinary/transitional/text layers below it first, then apply the
  adjustment to that completed lower result. Tracks above it remain unaffected.
- Multiple adjustment items compose bottom-to-top in ordinary track order.
- Support select, move, trim, split, duplicate, enable/disable, effect editing,
  undo/redo, save/recovery, and preview/export parity.
- Keep it full-frame. There is no transform, crop, source time, asset, audio,
  relink, thumbnail, waveform, or media ownership.

### Required model and planning changes

The persisted track item must be a discriminated union. It must not make most
of current `Clip` optional or invent a procedural asset id. A pure planner can
index each track's non-overlapping ranges, preserving the current logarithmic
active-item lookup. At an active adjustment item it emits an explicit
post-composite operation whose input is every completed operation below it.

The current effect descriptor registry may be reused only for contributions
whose declared stage accepts a complete composition surface. Source-geometry
operations such as manual lens correction cannot silently migrate to this
stage. Unknown/future effect intent stays portable and bypassed through the
same compatibility rules as ordinary effects.

### Audio, history, portability, and ownership

- Adjustment items never enter the audio mix and never change the audio master
  clock.
- One committed gesture creates one normal document history entry. Drag/scrub
  previews remain transport-only until commit.
- Project and recovery serializers validate the new item explicitly. Old files
  migrate with no adjustment items and unchanged byte-level visual behavior.
- The item owns no browser resource. Render hosts borrow/reuse bounded
  compositor surfaces and release them through their existing owner.

### Performance and migration risks

The research planner indexed 128 tracks with 1,024 items each and planned 4,096
frames with 5,767,680 range comparisons, below the deterministic 6,291,456
bound. Host time was 133.8 ms and is descriptive only. Planning is not the main
risk; full-frame pixel passes and surfaces are.

At 3840x2160 RGBA8, the proven seven-surface lens/export envelope is
232,243,200 bytes. Eight surfaces use 265,420,800 bytes and still fit the
256 MiB (268,435,456-byte) aggregate limit by only 3,014,656 bytes. Nine use
298,598,400 bytes and fail. The child issue must prove reuse or at most one
additional simultaneous surface across adjustment, transition, plugin,
lens-remap, preview, and export paths. It may not raise the shared envelope or
silently disable another authored feature.

### Explicit non-goals

- No audio adjustment/bus layers.
- No spatial adjustment masks, transforms, crops, or track mattes.
- No effect preset/library redesign.
- No rasterized adjustment cache in project or recovery data.
- No separate preview evaluator or CPU fallback.

## Project-level sequences and compound/nested sequences

### Problem statement

Users need to organize a long edit into reusable scenes and edit a group as one
parent item without flattening away the child edit.

### Bounded MVP

The work is intentionally split:

1. A project-level sequence foundation ships multiple independently editable
   same-settings sequences, stable identities, explicit root/active selection,
   portable migration, and project-wide history/resource reconciliation. It
   adds no nested render item.
2. A nested-sequence child then adds live shared instances, create compound
   from a bounded selection, open parent/child navigation, move/trim/split,
   exact preview/export/audio behavior, and an explicit make-independent
   operation.

The first nested version requires identical reduced frame rate, width, height,
and audio sample rate between parent and child. Parent local frame `p` maps to
child frame `sourceStartFrame + (p - instanceStartFrame)`. All terms are safe
integers and all ranges are half-open. No seconds or float accumulator enters
the document or plan.

Instances are live references: editing the source sequence updates every
instance. Making one independent clones the complete sequence definition with
fresh sequence/item ids and retargets only that instance in one undo entry.
Trimming an instance changes its range/source start, not its source definition.
If a later source edit removes coverage inside an existing instance, preview
and export produce explicit black/silence for the uncovered interval; they do
not stretch, hold, or silently shorten authored parent timing.

### Graph, history, and project-file implications

- Project format advances atomically from one document to a central sequence
  collection plus `rootSequenceId`. Migration wraps the current document as
  the sole root sequence without changing its ids, ranges, settings, media
  descriptors, collections, or visual/audio result.
- Timeline schema and outer project format changes remain distinct versioned
  migrations. Parsing validates all sequence/item ids, references, settings,
  ranges, cycles, depth, aggregate counts, and source bounds before any store or
  browser resource changes.
- The current document-only history cannot safely undo a source edit that
  affects several parent instances. The foundation must move history to one
  immutable project-edit snapshot authority while keeping session selection,
  navigation, handles, URLs, and decoder state outside history.
- Project replacement invalidates every sequence planner generation before
  releasing shared media. A media asset remains owned once by the project even
  when many sequences or instances reference it.

### Shared preview/export and audio behavior

The project planner resolves nested structure into an ordinary leaf plan before
the existing render and audio planners acquire resources. Both preview and
export consume that same immutable expansion. Nested audio is flattened into
the parent integer-frame domain before the existing gain/envelope plan is
converted at the audio boundary. Live playback remains scheduled from
`AudioContext.currentTime`; nested video never starts its own clock.

Every decoded frame remains owned by the render host and closes through the
existing `finally`/cache owner. A sequence definition or plan contains no
`VideoFrame`, `AudioData`, `ImageBitmap`, Blob, handle, URL, worker, decoder, or
canvas. Shared child definitions do not imply shared live frames.

### Performance evidence and risks

The pure graph fixture validated 256 sequence definitions and 255 references
100 times in 17.1 ms on the recorded host. One representative frame expanded
256 leaf requests while visiting 256 sequence instances. The executable gate
also rejects cycles in reachable and dormant definitions, depth above 8,
out-of-child ranges, missing references, setting mismatches, and more than
4,096 leaf requests at one frame.

The numbers prove the browser-free graph and exact frame mapping are cheap at
the chosen bounds. They do not prove that decoding/compositing thousands of
leaves is viable. The product planner must preserve current per-frame request
deduplication/ownership and reject resource admission beyond its bounded render
plan instead of allocating toward the theoretical cap.

### Explicit non-goals

- No recursive embedded sequence snapshots or cycles.
- No cross-project live links.
- No mixed-rate, mixed-resolution, mixed-pixel-aspect, or mixed-audio-rate
  instances in v1.
- No nested sequence speed ramps in the first slice; parent trim/move/split are
  enough.
- No background prerender cache or hidden media duplication.
- No flatten operation that loses the source definition without an explicit,
  undoable user command.

## Multicam

### Problem statement

Users need to align several recordings of the same event and change the active
camera without destructively cutting/copypasting each source, while often
keeping one stable master audio recording.

### Bounded MVP

- Two to eight angles inside one project, each with a stable id/name, exact
  multicam-local coverage range, and integer source start.
- Manual integer-frame alignment. The user may align a marked clap/event or
  enter an offset; no waveform correlation or timecode interpretation runs.
- A strictly ordered switch list begins at multicam-local frame zero. Each cut
  selects one video angle.
- Audio policy is either one fixed master angle for the complete multicam item
  or explicit audio-follows-video. Video and audio source frames are resolved
  independently from the same exact requested frame.
- Missing selected-angle coverage is explicit black/silence. The planner never
  guesses another angle, repeats a frame, or changes a cut.
- The multicam item can be placed, moved, trimmed, split, duplicated, opened,
  and edited through one normal history authority. Preview and export consume
  the same angle selection.

The smallest UI may show paused/on-demand angle previews and author a cut at the
exact playhead with a keyboard/button choice. Simultaneous real-time playback
of every angle is deliberately not required for the first slice; the normal
Program Monitor plays the active angle from the audio master clock.

### Model, audio, and ownership implications

A multicam definition owns serializable angle references, offsets, coverage,
switches, and audio policy. It does not own duplicate media descriptors or live
sources. A switch edit changes only the multicam definition; ordinary parent
clip edits still target the instance.

The active video angle becomes one normal source request. Fixed master audio
remains one stable audio plan even while video cuts change; follow-video emits
matching audio segments with exact cut boundaries. Playback/export must share
that pure result. Switching during playback, if included later, derives the
authored frame from the existing audio clock and commits one edit; it cannot
free-run a multicam timer.

### Performance evidence and risks

The fixture used eight angles and 24,000 switch points across 120,000 frames.
It performed 250,000 deterministic lookups with 3,658,690 comparisons, within
the 16-comparison-per-lookup bound, in 41.2 ms on the recorded host. The switch
plan is therefore not the expensive part.

Real-time multi-angle display would multiply active decoders, transferred
frames, canvases, scheduling pressure, and proxy demand. It remains a no-go
until a separate source-bound browser gate proves a bounded decoder/surface
owner, adaptive/proxy policy, cancellation, project replacement, backgrounding,
and all-zero cleanup. Automatic audio sync similarly needs a separate analysis
job/cache/provenance/quality contract and must never block manual alignment.

### Explicit non-goals

- No automatic audio waveform, source-timecode, device-clock, or metadata sync.
- No unlimited angles or 32-channel routing matrix.
- No simultaneous live angle wall in the first slice.
- No AI shot selection, face detection, or cloud processing.
- No silent fallback to another angle when coverage is missing.
- No flattening that discards editable switch intent by default.

## Executable evidence

The research contract is
`src/domain/editorStructureResearch.ts`; its focused regression is
`src/domain/editorStructureResearch.test.ts`. Run:

```text
npm test -- --run src/domain/editorStructureResearch.test.ts
npm run qa:issue78:research
```

The source-bound run used baseline commit
`0ea31bc2902224cd0f0c52f06915f802e8620664` and fingerprint
`sha256:be18ffef4f500980f03a7c3adb1508c693751efd02125e826c818f2b67b045f3`.
The timing values above are one Windows-host sample; deterministic count,
range, graph, complexity, and surface bounds are the acceptance facts.

The final tree passes 19 focused tests and the complete 226-file / 3,074-test
Vitest suite plus all 17 evidence-runner checks. TypeScript/Vite builds 4,872
modules, the source lint gate is warning-free with the user-owned untracked
`.worktrees/` directory excluded, the production dependency audit reports zero
vulnerabilities, and diff checks are clean. The normal production output
contains no Issue #78 research module or string.

No observable browser behavior or production bundle entry was added, so a
Chromium UI run is not applicable to this umbrella. Every product child that
adds a visible or runtime behavior must provide real source-bound Chromium
evidence appropriate to that behavior.

## Recommended implementation order and child issue specifications

No GitHub items are created by this local-only delivery. The following bodies
are implementation-ready and should be opened only when publication is
explicitly authorized.

### Part 12a — Ship bounded adjustment layers

**Goal:** apply one editable visual treatment to the completed lower
composition across an exact timeline range.

**Dependencies:** #78; current effect/plugin and render-surface contracts.

**Acceptance:** explicit persisted adjustment item; no fake asset; full-frame
video-only semantics; track-order post-composite plan; existing supported
effect animation; move/trim/split/duplicate/enable; one history entry per
gesture; old-file migration; portable save/recovery; preview/export pixel
parity; unknown intent preservation; lens/transition/plugin coexistence; at
most one additional simultaneous 4K surface with the total under 256 MiB;
focused/full tests, build, lint, audit, source-bound Chromium, zero cleanup.

**Non-goals:** audio bus layers, spatial masks/transforms, preset libraries,
prerender caches, new effect types.

### Part 12b — Add a project-level sequence graph foundation

**Goal:** let one portable project own several independently editable
same-settings sequences with stable project-wide history and resources.

**Dependencies:** #78. It can begin after 12a's schema design is frozen, but
must rebase on the final discriminated-item contract.

**Acceptance:** central sequence map plus root id; atomic current-file
migration; create/rename/duplicate/delete/switch sequence workflows; global id
validation; no dangling refs; project-wide immutable history; session-only
navigation; shared media descriptor/handle ownership; project replacement and
recovery correctness; no nested render item; full persistence and browser
evidence.

**Non-goals:** nesting, cross-project links, mixed settings, background render,
multicam.

### Part 12c — Ship bounded compound and nested sequences

**Goal:** edit one same-settings child sequence as a live reusable parent item.

**Dependencies:** 12b.

**Acceptance:** explicit sequence-instance item; create compound from bounded
selection; open/back navigation; move/trim/split/duplicate/make-independent;
1:1 integer-frame mapping; source gaps render black/silence; complete-project
cycle validation; depth 8 and bounded expansion; shared preview/export/audio
plan; project-wide undo/redo; no live browser resources in domain/state;
focused/full tests, build, lint, audit, source-bound Chromium and cleanup.

**Non-goals:** mixed settings/rates, nested retiming, cross-project live links,
unbounded depth, implicit flattening.

### Part 12d — Ship manual-sync multicam editing

**Goal:** keep one editable cut plan across two to eight manually aligned
angles while preserving an explicit master-audio choice.

**Dependencies:** 12b; reuse 12c's central graph/planning seams where accepted,
without requiring users to create an ordinary nested sequence first.

**Acceptance:** explicit multicam definition/item; manual integer offsets;
strict frame-zero switch list; fixed-master and follow-video audio policies;
exact missing-coverage behavior; cut/change/roll edit operations; paused or
on-demand angle selection UI; active-angle playback from the audio master
clock; shared preview/export plan; portable migration/recovery/history;
two-to-eight-angle fixtures; focused/full tests, build, lint, audit, real
Chromium and balanced decoder/frame cleanup.

**Non-goals:** automatic sync, unlimited angles, simultaneous live angle wall,
AI selection, cloud work, complex channel routing.

## Final boundary

Issue #78 is a go decision for four bounded implementation slices, not a hidden
implementation of all three feature families. Product schemas remain at their
current versions until a child owns one atomic migration. The pure research
contract carries no production authority and must stay unreferenced by normal
application entries.
