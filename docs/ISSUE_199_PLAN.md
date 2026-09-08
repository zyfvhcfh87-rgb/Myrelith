# Issue #199 — unified animation editor plan

Status: Gate 3 runtime segments have been accepted by the parent. Corrected
Gate 4 passed all nine mixed-browser/export/decode/cleanup checkpoints at
`705f07135ec30681ccc9593b41045dd378498698`; see the
[completion evidence](evidence/issue199/g4-completion.md). Earlier failures and
their bounded diagnostic corrections remain preserved. Consolidated Gate 5
tests/build/lint and final integration/publication are owned by the parent task.
No new browser or performance run is requested by this status update.

Issue: <https://github.com/zyfvhcfh87-rgb/Myrelith/issues/199>

Baseline: `ce91074c276ca6892a74addb7dd673b9a19c7eeb`, branch
`codex/issue199`, isolated checkout `.worktrees/issue199`.
The issue body is captured in [Gate 0 evidence](evidence/issue199/gate0.md).

## Outcome and scope

Add one lazy animation workspace over the active sequence: a searchable dope
sheet with exact multi-key timing edits and a curve view with numeric and
keyboard alternatives. Transform, crop, clip audio, built-in and declared
plugin effect, title-element, and adjustment scalar lanes use one scalar
evaluator. Mask path lanes participate in timing operations but expose their
hold-only geometry status. Sequence/track video buses remain static; semantic
captions, audio bus effects, arbitrary JSON, expression scripting, and
per-point vector curves do not become animation targets through this work.

All editing is local and portable. This issue adds no decoder, worker, remote
request, font service, runtime plugin authority, or second playback clock.

## Existing contracts verified in the baseline

| Area | Existing authority and implication |
| --- | --- |
| Scalars | `src/domain/clipAnimation.ts` validates and evaluates clip and effect keys, with nearest endpoint hold, outgoing hold/linear/CSS Bézier and 24-step fixed bisection. Preserve its outputs. |
| Timing | `src/domain/sourceTimeMap.ts` owns exact source ticks, slip re-anchoring, and all-or-nothing retime when distinct keys collapse to one frame. `shiftClipAnimation` owns local origin shifts. |
| Bounds | 1,024 keys/track, ±1,000,000,000 local frames, 1,280 effect tracks/clip, 100,000 document keys. `projectSequences.ts` separately counts every sequence; new collections must enter both counters. |
| Audio | `volume` already means linear gain in [0,2]; `balance` already means stereo balance in [-1,1]. `audioMixPlan.ts` validates once and calls the same scalar primitive at ephemeral sample/clock positions. No new pan algorithm or dB storage is needed. |
| Effects | Built-ins declare `animatableParams`; plugins declare bounded `number` parameters with `animatable: true`. `pluginVideoEffectStagePlan.ts` resolves those through `evaluateAnimationTrack`. UI step is not render quantization. |
| Existing UI | `AnimationCurveEditor.tsx` selects one clip property, samples at most 64 values, and renders its key list. Inspector effect/color controls are separate. These are adapters to converge, not independent interpolation models. |
| Current restrictions | `clipAnimationKindError` and `animationEditLocationResult` reject procedural-text keys; audio accepts only volume/balance. Existing single-key move replaces a colliding key. |
| Crop | `clipInspector.ts` bounds each normalized source edge to [0,0.99] and each opposing sum to at most 0.99. Per-key bounds alone cannot prove two independently eased edges remain compatible. |
| Persistence | Project format 8, timeline schema 21. Current property names form a closed union; effect tracks intentionally preserve unknown/dangling identities. New payloads need explicit migrations and shared traversal. |
| History | Rejected/idempotent operations preserve document/project reference and redo. Store commits one whole-project history entry. Gesture previews belong to transport; app controllers reconcile stale selection and previews. |

Historical totals in HANDOFF/PLAN are context, not this branch's validation.

## Proposed property and temporal contract

### One typed property catalog

Keep persisted `tracks` and `effectTracks` compatible. Add explicit crop
members to `ClipAnimationProperty`: `crop-left`, `crop-right`, `crop-top`,
`crop-bottom`. Values are fractions of the oriented/lens-corrected source,
defaulting to the corresponding existing static crop field, ordinarily zero.
No new crop coordinate system is introduced.

Expose a pure property catalog with a discriminated structural address:

```ts
type AnimationAddress =
  | { owner: 'clip'; clipId: string; property: ClipAnimationProperty }
  | { owner: 'effect'; clipId: string; effectId: string; parameter: string }
  | { owner: 'title'; clipId: string; elementId: string;
      propertyVersion: number; property: string }
  | { owner: 'adjustment'; adjustmentId: string; property: 'opacity' }
  | { owner: 'adjustment-effect'; adjustmentId: string;
      effectId: string; parameter: string }
  | { owner: 'effect-path'; clipId: string; effectId: string;
      parameter: string; valueType: string; valueVersion: number }
```

This is an edit/selection address, not a serialized replacement for existing
tracks. Sequence identity and project generation belong to the command/session
envelope. Never use element order, labels, array indexes, or concatenated
unescaped strings as identity. Keys are addressed by lane plus original local
frame; stable key UUIDs are unnecessary. Successful edits return the resulting
addresses for selection reconciliation. Version/kind fields are applicability
guards, not extra independently competing targets. Enforce one persisted lane
per semantic target: clip property, title element+property, or effect id+parameter.
Current/future versions and scalar/path kinds cannot both own that same target.

Each scalar catalog entry supplies label, units, min/max, editor step, static
fallback, supported easing, applicability, and a structured unavailable reason.
Domain declarations are the authority; UI imports them through `state/editorUi`.
No inference from arbitrary numeric JSON or manifest strings is allowed.
Path entries advertise `valueKind: 'path'` and `easing: 'hold-only'`.

The canonical scalar primitive may be extracted into a browser-free leaf to
avoid a `clipAnimation`/title-validation import cycle. Existing public exports
remain compatibility facades, with exact evaluator regression fixtures. Shared
temporal helpers operate on `{frame, sourceTimeTicks?}` while preserving typed
payloads; they must never turn path strings into scalar tracks.

### Source-time semantics for every collection

| Operation | Required behavior |
| --- | --- |
| Move clip / slide | Local keys and source ticks remain unchanged; global animation moves with the clip. |
| Split | Both halves retain surrounding keys needed for the same interpolation; shift the right local origin exactly. Count duplicated payload before accepting the whole linked edit. |
| Head trim / ripple head trim | Shift local key origins to preserve the global curve. Retain out-of-range keys within the existing signed-frame bound. |
| Tail trim | Do not destructively remove future keys; reopening the range preserves intent. |
| Slip timed media | Keys retain their local frames; re-anchor source ticks by the canonical source delta, as today. |
| Retime / speed points | Remap from durable source ticks through `sourceTimeMap`; reject the entire linked operation on duplicate/unsafe target frames. No destructive rounding or key dropping. |
| Still/title clip | Preserve fixed source semantics; Slip remains a no-op and retiming remains unavailable. Title split/head trim shifts local frames, then re-anchors procedural ticks to `frame * SOURCE_TIME_TICKS_PER_FRAME` because its source map restarts at zero. Timed-media absolute ticks must not receive that title-specific reanchor. |
| Move/add/paste key | Recompute destination source ticks; never copy the source clip's source-time ticks into a different destination map. |
| Adjustment | Item-local integer frames only; no invented media source map or source ticks. |
| Change project FPS | Preserve the existing content-empty project restriction. A populated project remains unchanged; this issue does not introduce rate conversion. |

Extend clone/default/shift/count/remap/id-reservation/file-validation helpers
together, including clip attributes, presets, sequence duplication, compounds,
history, and recovery. A new array omitted by an older helper must never
silently disappear from a successful edit.

### Crop coupling

Resolve crop in the same `resolveClipAnimationAtFrame` result consumed by the
composition planner, Program geometry, tracking/stabilization projection, and
export. Never resolve it only in Inspector or CSS.

The standalone certificate partitions all four lanes at the union of key
boundaries. The shared 24-step decision tree orders its resulting parameter by
progress; the rounded cubic output need not itself be monotone. Directed
interval arithmetic follows the exact scalar polynomial operation tree and
value interpolation. Exact keys and holds use their actual short-circuits.
Certify an interval only when both rounded upper-bound sums are at most 0.99
and every individual edge stays in range. Otherwise subdivide at integer
midpoints until a singleton is evaluated by the canonical scalar authority.
Work stops at 16,384 interval visits per clip edit or validation, plus a
1,048,576-visit whole-project ceiling and 100,000 retained key visits. An unsafe
frame or exhausted proof budget rejects with a specific
reason before mutation. Include endpoint-held regions and the ranges needed
for real crossfade handles. Keep this proof cached by immutable relevant
animation/static fields rather than rerunning it per rendered frame.

The initial orchestrator review accepts bounded rejection in principle and
requires the proof above before implementation acceptance. Equality at 0.99
must never use an unproved permissive epsilon: an uncertain enclosure must
subdivide or reject, and a leaf tests the actual rendered integer-frame pair.
Never silently clamp, normalize, or change another authored crop edge
to conceal an invalid interpolated rectangle. Tests must cover opposing
different-easing keys whose endpoints are valid but interior sum is unsafe,
ordinary opposing moves that are safe, huge signed frame ranges, and equality
at the crop boundary.

The implementation, numerical argument, bounded-memory argument and qualified
evidence are in [the crop certificate gate](evidence/issue199/crop-certificate.md).
The accepted proof is integrated into all-sequence project admission and portable
serialization. It covers complete integer crossfade leg ranges and held tails.
The cache binds the deeply frozen ownership, crop, tracks, keys, easing and
range graph; mutable or changed inputs require fresh proof. Runtime resolution
uses admitted values without running a new certificate for each frame.

## Dependencies and shared ownership

### #200 — title elements and scalar properties

The #200 worker proposes `Clip.title` version 1 with stable ordered
text/rectangle/ellipse elements, and:

```ts
interface TitleAnimationTrack {
  elementId: string
  propertyVersion: number // supported v1 is 1; bounded future versions survive
  property: string       // explicit v1 catalog; unknown names remain opaque
  keyframes: ClipAnimationKeyframe[]
}
// Additive optional ClipAnimation.titleTracks; absent remains canonical for old saves.
```

Requested v1 names from #200: `position-x`, `position-y`, `scale-x`, `scale-y`,
`rotation`, `opacity`, `box-width`, `box-height`, `font-size`, `outline-width`,
`shadow-blur`, `shadow-offset-x`, `shadow-offset-y`. Units are project pixels,
degrees, scale factors, or unit opacity as appropriate. #200 must freeze exact
bounds, per-element-kind applicability, defaults and element-count budgets in
its reviewed plan; #199 consumes those definitions instead of duplicating
them. Roll/crawl authors ordinary position keys with one evaluator.

The complete on-disk #200 proposal was subsequently read before the final
Gate 0 handoff. Its offered table is: position/rotation ±1e9, scale [0,100],
opacity [0,1], box width/height [16,65535], text font size [8,1024], outline
width [0,64], text shadow blur [0,128], and text shadow offsets ±512. All
geometry/style lengths are project pixels; values stay continuous. Text box
dimensions must each exceed twice static padding at the base and every key.
The same bounded easing keeps that per-element constraint valid between keys.
Shapes do not expose font/shadow tracks. Anchor, element crop/flip, padding,
content, fonts, colors, booleans and ordering remain static.

Use #200's proposed 16 elements/title, 256 title tracks/clip, 256-character
property names, 1 MiB title-plus-tracks size bound and 64 MiB retained title
data allowance, together with the existing per-track and aggregate key limits.
The shared key clipboard participates in both title and path retained-budget
checks; separate allowances must never omit a shared payload. The general
clipboard's 128-lane limit is intentionally below the title authoring maximum.

#200 owns legacy text compatibility and its exact painter/layout parity.
Its reviewed direction retains `Clip.text` as a mutually exclusive supported
legacy variant; title upgrade is explicit and budget-checked. An accepted
upgrade moves transform/visual values into a single element while clip
opacity/effects/blend remain outside. #199 owns title scalar
evaluation and common timing/batch editing; #200 composes the resolved elements
through the shared title renderer. Outer clip animation applicability must be
explicit so a title cannot acquire double transforms: outer clip opacity stays
eligible, while outer transform/crop/audio properties are unavailable. Any
title-level scalar effect eligibility needs the joint Gate 1 contract; path
animation on text remains unavailable unless #198/#200 explicitly agree it.
#200 owns fresh element
identity remapping for templates; #199 provides corresponding track remapping.

The orchestrator accepted the pure title/property/path contracts and assigned
the migration order on 2026-09-08. Their exact commits are recorded in the
Gate 1 evidence. Clip.title ownership remains #200 schema 23 work. #200's fixed-local
source tick rule is a required shared-helper branch, not the timed-media rule.

### #198 — hold-only mask paths

The orchestrator relayed #198's typed path-track proposal: bounded M/C/Z path
strings, 1–8 cubic segments, at most 2,048 characters per path, exact local
frames/source ticks, and hold-only v1. The existing mask is normalized PROJECT
space after crop/transform; do not invent a source-space path renderer.

#198 owns representation/version, shape editing, source/monitor projection,
hold evaluator and path byte/point/string budgets. #199 owns shared traversal,
key counts, batch timing operations, clipboard selection and the dope-sheet
adapter. Path lanes show an editable frame and a shape-edit entry point, with
scalar value/Bézier controls visibly unavailable. Copy is a defensive typed
payload, never arbitrary SVG or per-point animation.

The #198 on-disk plan was read during this gate (still uncommitted at that
read). It offers `ClipAnimation.effectPathTracks`, keys with
`{frame, sourceTimeTicks, value: string, easing: {type: 'hold'}}`, and tracks
with `{effectId, parameter, valueType, valueVersion, keyframes}`. The v1 target
is `parameter: 'path'`, `valueType: 'mask-bezier-path'`, `valueVersion: 1`.
Adopt those structural names instead of this issue inventing another version
field for paths. Proposed limits are 256 keys/path track, 256 path tracks/clip,
4,096 path keys and 1,048,576 value code units across all project sequences,
plus 32 MiB retained animation payload across candidate/current/history and
both clipboards. All path keys also consume the 100,000-key aggregate. The key
clipboard obeys whichever general or path-specific limit is stricter.

Both owners must agree the exact future-track opaque envelope and retained
accounting before product edits. Path
strings count across all keys, dormant sequences, history and clipboard before
retention. An unsafe path must not bypass admission through a generic move or
paste. Lens-corrected coordinate inversion remains unavailable until separately
proven by #198; this editor adds no inversion claim.

### Migration and conflict ownership

The orchestrator assigned #199 timeline schema **22**, followed by #200's title
owner schema **23** and #201's caption schema **24**. Do not implement 22 until
#200's pure title property/type adapters (without a Clip change) and #198's pure
held-path value adapters have been committed, reviewed and shared. Scalar/timing
extraction can proceed independently with no wire/runtime compatibility change.
The proposed additive timeline changes are crop vocabulary, `titleTracks`,
#198's path collection, and approved plugin parameter identity binding. The
outer project format changes only if the orchestrator's combined contract needs
one. #199 owns common animation helpers
and UI; #200 owns title data/static validation; #198 owns paths. The orchestrator
shares accepted foundation commits and consolidates ARCHITECTURE/HANDOFF/PLAN.
All three owners must review traversal changes before their feature gates.

Schema 22 must not add compulsory empty title/path arrays or `propertyVersion: 1`
to unchanged legacy saves. Absent collections and implicit existing scalar v1
are canonical compatibility forms; default reads may expose empty lists without
serializing them. Preserve explicit authored metadata, including unknown data.
Actual new tracks/future identities alone require new bytes. Keep the current
10,000,000-character file limit. Test actual production serialization of legacy
no-animation and scalar-animation files at 9,999,999/10,000,000 characters,
including equal-length edits. Gate 1 now exercises the actual schema 22
production migration, serializer, app preflight and store undo/redo at both
exact limits. This does not qualify the future schema 23 title-owner upgrade.

## Portable future/plugin intent

Known built-ins remain keyed by effect type/version and parameter name. A
future title/path property must survive bounds-only parsing, copying, history,
split/trim and save/reopen without being treated as a current supported value.
Proposed clip-scalar wire extension: keep the existing `tracks` collection,
add optional `propertyVersion` (absence means existing v1 without adding bytes),
and permit a bounded
nonempty property string in portable parsing. Unknown names/positive versions
retain ordinary finite scalar keys within the same signed-frame/value/easing
bounds; there is at most one lane per semantic `property`, so a future
version cannot compete with the executable v1 lane. Known editing APIs keep a
narrow `ClipAnimationProperty` type and require an exact version match before
reading/applying a field. This widens durable intent, not executable behavior.
Propose at most 64 clip scalar lanes (including the 12 known visual/audio/crop
properties) and property identifiers bounded to 256 characters. Unknown lanes
are visible with timing/copy/delete operations but no numeric reinterpretation.
Malformed or excessive payloads still reject at admission.

Plugin animation requires explicit numeric declarations, current descriptor
version, installed catalog generation and live availability. Existing code
does not persist which package supplied an old key's parameter semantics. The
review must decide a durable, data-only parameter identity for newly authored
tracks: an optional bounded `parameterIdentity` record on `effectTracks`, with
`version: 1`, effect type, descriptor version, contribution id/version and exact
package digest. This binds the exact immutable declaration so same-name/
same-range package updates cannot silently reinterpret old units.
An identity is not a trust grant; runtime permission remains app-owned.

Proposed legacy treatment: retain unbound plugin keys exactly, label their
parameter identity unverified, and require an explicit undoable bind-to-current
declaration action before activating them under a changed/unknown declaration.
Do not infer a historical identity from whichever package is installed now.
This is a compatibility decision requiring orchestrator review: historical
package provenance cannot be reconstructed from the baseline files. No new
plugin ABI/manifest field or automatic descriptor migration is approved here.
Animated descriptor migration remains unavailable under its existing contract.

### Gate 2 title-owner integration contract

`AnimationTitleOwnerAdapter` in `domain/animationOwners.ts` accepts an immutable
`isTitleClip(clip)` predicate and `readElement(clip, elementId)` reader. #200 G1b
has offered canonical `textOverlay.isProceduralTitleClip` and
`titleOwnership.readTitleClipElement`; after both commits are accepted, compose
those functions in `app/animationEditorController.ts`. The predicate includes
compact text and bounded unsupported expanded titles. The reader returns only
the exact supported requested element, including disabled supported elements.
Outer title geometry/crop/audio remain inactive; outer opacity stays available.
All title-owned timing uses fixed local ticks, even for unavailable payloads.
The current schema 22 default recognizes legacy text and resolves no expanded
element. No schema 23 parsing is duplicated or consumed before acceptance.

## Atomic commands, clipboard and history

Implement one pure batch planner taking a snapshot, structural key selection,
typed operation, and explicit declarations. It builds a validated candidate
once, checks final per-lane/document/project counts and payload budgets, then
returns either the untouched source with a structured reason or candidate plus
selection mapping. The app pins project generation, sequence, immutable source, selection, playhead,
media and declaration references; immutable source identity also pins locks.
After full portable-file preflight, the store rechecks project generation,
sequence, source identity and project/retention limits before its single commit.

- Move uses one signed integer delta for the whole selection. Remove all
  selected source positions first; collisions with unselected or other
  destination keys reject the whole batch. Same-delta zero move is idempotent.
- Duplicate/copy/paste preserves relative spacing and outgoing easing. Duplicate
  keeps originals; a zero-offset duplicate collides and rejects. Delete is one
  command; deleting the final key removes that supported track and reveals its
  unchanged static fallback.
- Existing explicit single-key Set at the same time retains replacement
  semantics. Unified multi-key Move never delegates to the legacy destructive
  single-key move loop. If the old Inspector move remains reachable, label its
  replacement semantics or route it through the reviewed collision policy.
  Gate 2 keeps that existing single-key behavior and labels it at both Inspector
  frame editors; the new batch API always rejects destination collisions.
- Internal clipboard bounds: 4,096 selected keys, 128 lanes, plus
  #198's stricter path-byte allowance. It is defensive, project-generation
  scoped, data-only, and cleared on project replacement. No OS clipboard/API
  permission is needed for this slice.
- Default paste anchors the earliest copied GLOBAL frame at the current
  playhead, preserving signed global offsets between all copied lanes. Convert
  back to each destination owner's local frame and recompute source intent.
  An explicit "Paste at original time" uses copied global frames. Paste cannot
  silently create missing effects/title elements: exact compatible destination
  addresses or a reviewed explicit lane mapping are required.
- A cross-lane paste requires matching property kind/version/units/bounds and
  path/scalar kind. No fps resampling: reject a clipboard whose captured rate
  differs after a project-rate edit. No partial paste, truncation, value clamp,
  destination overwrite or dropped unsupported payload.

Transport stores selected keys, focused lane/key, visible range, filter and
one active data-only preview. An app gesture owner coalesces pointer changes
with rAF; cancel, Escape, lost capture, stale document, sequence/project switch,
unmount and declaration replacement cancel without history. Pointer-up performs
one fresh batch preflight and one commit. Undo restores data, never resurrects
deleted selection; focus moves to a surviving logical neighbor.

## Unified workspace, accessibility and bounded planning

Open a lazy docked Animation workspace from Inspector or the timeline. Show
lanes for the active sequence, grouped by track/clip/element/effect, with
selected-clip, animated-only, property-kind and text filters. Full sequence
navigation must remain reachable; a single-selected-clip-only implementation
would not meet the requested timeline-wide workflow.

Use the existing timeline pixels-per-frame zoom, exact global frame origin and
bounded-window math for horizontal alignment. Curve vertical zoom/pan is
session-only. Scalar curve samples call the canonical validated evaluator;
include discontinuity boundaries so a hold is not drawn as a diagonal ramp.
Show one focused scalar lane initially; multiple selected properties remain
visible in the dope sheet without pretending incompatible units share a scale.

Build lane/key indices once per immutable document/selection-filter identity,
with binary-search visible ranges. Proposed UI bounds: at most 40 mounted rows
including overscan, 512 individually painted key glyphs across the viewport,
and 256 curve samples for the focused lane. Dense pixel buckets show count and
retain exact keyboard access; they never drop authored keys. Pin at most the
focused row within the row allowance. Do not rebuild all project key indices
on each playhead tick or mount 100,000 buttons.

Keyboard acceptance includes lane/filter selection, previous/next/Home/End
key navigation, multi-select, add-at-playhead, ±1/±10-frame moves, delete,
duplicate, copy/paste modes, numeric frame/value entry, easing presets and
bounded Bézier handles, horizontal and vertical zoom/pan, reset/fit and Escape.
Inputs preserve native text editing/IME behavior; announcements describe
selection, successful edit, collision/lock/budget rejection and unavailable
parameters. Pointer snapping uses the domain resolver with playhead, clip
edges, markers and eligible unselected keyframes; exclude the moving keys,
preserve deterministic tie order and 8px threshold, and provide Alt bypass.
Snapping candidates and dense-key searches must be indexed/bounded.

## Implementation gates

Each gate is independently reviewed at its committed SHA. No product edit
precedes Gate 0 acceptance.

1. **Gate 0 — contract and plan.** Commit this proposal and baseline evidence.
   Orchestrator decides shared schema order, title/path identities, crop proof
   and plugin compatibility treatment; request concrete amendments if needed.
   Initial review has authorized the independent scalar/timing extraction;
   see [its focused evidence](evidence/issue199/foundation-scalar.md).
2. **Gate 1 — canonical foundation.** Implement agreed property/typed timing
   traversal, additive migration, bounds and scalar crop/title evaluation.
   Cover unknown intent and every lifecycle operation. Share the accepted
   foundation with #198/#200 before either duplicates these contracts.
3. **Gate 2 — atomic operations.** Pure multi-key commands, project/budget
   preflight, app clipboard/gesture ownership, store one-entry history and
   selection reconciliation. Test stale/locked/collision/no-op/redo behavior.
4. **Gate 3 — unified UI.** Indexed lane planning, bounded dope sheet, scalar
   curves, snapping, keyboard/screen-reader controls and Inspector entry points.
   Migrate duplicate local editors to common adapters; preserve lazy loading.
5. **Gate 4 — cross-feature browser acceptance.** Integrate accepted title/path
   foundation commits and run the real mixed-feature suite. Fail this gate if
   title/path dependencies, unknown-plugin behavior or parity remain unproved.
6. **Gate 5 — local completion.** Full tests, build/typecheck, lint, production
   audit, diff/architecture checks, final observable QA and exact-head review.
   Commit evidence and report; orchestrator owns integration and publication.

## Acceptance matrix and evidence

| Issue requirement | Required proof |
| --- | --- |
| Stable properties and all timing semantics | Table-driven scalar/path/title tests; hostile files; old migration fixture; split/head/tail trim/slip/retime/freeze and the existing empty-project FPS restriction; nested/dormant sequence and duplication coverage. |
| One evaluator | Reference scalar outputs through Inspector, video composition, text painter, plugin parameter records, sample-boundary audio plan and export. No UI interpolation formula. |
| Atomic multi-key edits | Collision with selected/unselected keys, negative/overflow frames, per-track/document/project/path/clipboard budgets, stale declaration/document, lock, no-op, populated redo, undo/redo and exact selection mapping. |
| Unknown/plugin preservation | Save/reopen missing/future descriptors, orphan elements/effects, version/units/package mismatch, unavailable timing-only operations and explicit legacy binding behavior. |
| Accessible editor | Role/name/focus tests plus real keyboard workflow, screen-reader metadata, no focus loss under virtualization, responsive 720px and normal desktop layout. |
| Large documents | 100,000-key document plus many dormant keys, 1,024-key lane, 1,280 effect lanes/clip; assert mounted/glyph/sample bounds and indexed visit counts. Record cold/warm timings with commit/browser/fixture provenance under an exclusive slot. |
| Chromium | Mixed transform/crop/effect/title/audio timeline; Bézier/hold and path hold keys; relative/original-time copy/paste; collision; snapping; retime/split; drag/cancel/stale cleanup; undo/redo; save/reopen; muted playback; export-reopen pixel/PCM oracles; clean console. |
| Complete validation | Focused tests each gate; full canonical npm test runner, npm run build, npm run lint, npm audit --omit=dev, git diff --check, production exclusion/lazy-load and architecture tests at final accepted code. |

Use issue port 5199 and muted headless Chromium. Never generate speaker-output
tones. Use silent live scheduling fixtures and inspect deterministic PCM
internally where a nonzero oracle is needed. Prove actual exported output,
not just a mocked plan or export-completed status. Record pixel/PCM tolerances
per exact codec and distinguish pure equality from lossy media tolerance.

Full-suite, browser and timing runs require the orchestrator's exclusive slot.
Focused baseline tests do not claim a full build/browser gate. Any suspected
baseline failure must reproduce on unchanged `ce91074` before being called
unrelated. Retain failing attempts and environmental qualification honestly.

## Decisions requested at Gate 0

1. Accept/amend the scope, typed scalar/path adapter, atomic collision and
   clipboard time policies, and proposed UI/command limits.
2. Reconcile this proposal with the committed #198/#200 plans and freeze their
   exact property/payload/budget tables and assigned 22/23/24 migration order.
3. Accept/refine the bounded crop interval proof and its failure behavior.
4. Decide plugin parameter identity and legacy unbound-track treatment before
   claiming that package changes cannot reinterpret existing units.

These are internal orchestration review decisions under the user's delegation;
no additional task, push, PR, merge, issue closure or legal agreement is part
of this worker's scope.
