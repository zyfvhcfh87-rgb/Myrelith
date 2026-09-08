# Issue #198: direct masks and bounded manual path animation

Status: **initial plan gate ready for internal review; product implementation has not started.**

Prepared on `codex/issue198` from `ce91074c276ca6892a74addb7dd673b9a19c7eeb`.
The Milestone 9 orchestrator owns approval, migration ordering, integration and
publication. This document proposes contracts; it does not assign a final
timeline schema number or advertise implemented functionality.

## Outcome and decisions proposed for review

Authors can select one mask in the Inspector and move/resize it in Program,
edit its cubic anchors/controls, and author a sequence of explicit held paths.
Pointer and numeric/keyboard input use the same pure commands. A drag publishes
only a transport preview, then commits once. Existing scalar box/feather keys
continue through the canonical evaluator.

1. Preserve `builtin.mask` version 1 and its **project-space** pixel contract.
2. Use **hold-only path animation v1**, explicitly labeled in the UI. Point
   count/topology can differ between keys. No path morphing or per-point scalar
   tracks are inferred.
3. Add a versioned, typed `effectPathTracks` member to `ClipAnimation`, with
   shared timing, identity reminting, transaction and budget hooks agreed with
   #199. Keep the existing bounded path string as each value.
4. Include tracking-to-mask attachment as a separately tested implementation
   gate: ordinary `x/y` and optional `width/height` effect tracks, with explicit
   replacement and first-loss behavior. No new analysis or renderer.
5. Reserve path bytes across projects, history and clipboard before growth;
   keep the existing whole-file and total-animation limits.
6. Preserve the existing ban on unproved lens-coordinate inversion. Direct
   project-space handles do not need a lens inverse; source feature picking
   and tracking remain unavailable whenever the source has lens intent.

The issue expressly permits hold-only v1. No additional user choice has been
identified; the orchestrator must approve this concrete proposal and settle
the shared #199 contract before implementation.

## Evidence from the starting tree

| Authority | Existing behavior and implication |
| --- | --- |
| `ARCHITECTURE.md`, `docs/EFFECTS.md` masks section | Masks run after source crop/transform, before opacity/blend. Mask handles must not accidentally become source-attached. |
| `domain/maskPath.ts` | Closed uppercase `M/C/Z`, 1–8 explicit cubics, coordinates in `[0,1]`, 2,048 characters; final cubic endpoint exactly equals the start. |
| `domain/effectStack.ts` | Box `x/y` in `[-4,4]`, width/height in `[0.001,8]`, feather `[0,1]` of the shorter project side. Path coordinates are local to that box. |
| `domain/effectPixels.ts` | One shared ordered pixel stage. Each cubic has eight subdivisions: at most 65 flattened vertices/64 edges. Feather uses bounded clipped-region `Uint8Array`/`Float32Array` scratch. |
| `domain/clipAnimation.ts` | Scalar keys use exact local frames and source ticks, endpoint hold, shared evaluation, 1,024 keys/track and 100,000 aggregate keys. Several clone/edit helpers explicitly reconstruct only `tracks/effectTracks`; all must preserve the new member. |
| `domain/sourceTimeMap.ts` | Slip holds local timing and shifts source intent; retime maps durable ticks and rejects integer-frame collisions. Generic timing code must handle path values without treating them as numbers. |
| `domain/projectFile/clipValidation.ts`, `migrations.ts` | Exact current animation keys; current timeline schema 21/project format 8. An explicit migration and serializer update are required. |
| `domain/projectSequences.ts`, `sequenceProjectLimits.ts`, `state/documentStore.ts` | All active/dormant sequences and both history branches matter. LUT retention already provides a pattern for preflighting owned immutable data before clearing redo. |
| `ui/VisualOverlayControls.tsx`, `MotionTrackingOverlay.tsx` | Existing monitor measurement/projection math and gesture sessions; source projection is partly duplicated. Extract only the shared pure geometry genuinely required by this work. |
| `app/colorGradingController.ts`, `previewController.ts`, `transportStore.ts` | Exact project/selection/frame-bound, data-only effect preview precedent. New preview owners must coexist without overwriting live sibling drafts. |
| `domain/motionTracking.ts`, `app/motionTrackingController.ts` | Proven bounded point/box analysis, schedule/freshness validation and ordinary-track Apply. Existing attachment targets clip transforms and rejects same-source targets; masks need a distinct typed target. |

The full issue body was read from the orchestrator's frozen `issues.json`.
The local issue snapshot supplies the complete acceptance text, so no external
research or package choice is needed for this plan. Baseline check evidence is
in [the plan-gate record](evidence/issue198/plan-gate.md).

## Exact path representation and evaluation

Proposed portable shape (names are the contract offered to #199):

```ts
interface EffectPathAnimationKeyframe {
  frame: number
  sourceTimeTicks?: number
  value: string
  easing: { type: 'hold' }
}

interface EffectPathAnimationTrack {
  effectId: string
  parameter: string
  valueType: string
  valueVersion: number
  keyframes: EffectPathAnimationKeyframe[]
}

// ClipAnimation gains effectPathTracks?: EffectPathAnimationTrack[].
// Current portable files include the list; historical in-memory fixtures may omit it.
```

Supported target: `effectId` resolves to `builtin.mask` v1, `parameter = 'path'`,
`valueType = 'mask-bezier-path'`, `valueVersion = 1`. Exactly one path track may
address an `(effectId, parameter)` pair, including future versions; a version
change never creates competing tracks for one parameter. Scalar and path kinds
cannot both author the same target. No arbitrary string property is exposed.

The envelope has exact keys, bounded nonempty identifiers (existing 256-character
effect IDs / 4,096-character parameter/type ceilings), safe positive version,
1–256 keys, strictly increasing unique frames in `[-1e9,1e9]`, and safe signed
integer source ticks. Current portable keys require ticks; historical pure
fixtures can receive them through `animationWithSourceTimeIntent`.

Each known v1 value uses the existing normalized closed cubic grammar. Authoring
always validates it. Portable loading preserves bounded malformed values as
unavailable intent, consistent with existing mask descriptors; it never parses
them as SVG or permits extra commands. Only validated paths enter the renderer.
Future type/version/parameter values retain their strings and exact envelope,
including source timing, but are not interpreted or offered as editable v1
geometry. Unknown fields outside this envelope reject rather than disappearing.

For an executable track at local frame `f`, use a binary-search predecessor;
before the first key use the first path, after the last use the last. Exact key
frames select that key. Any malformed known-v1 key makes the whole path track
unavailable, with a stable status and unchanged static descriptor fallback;
valid sibling scalar tracks still work. Unsupported/dangling tracks likewise
preserve data and visibly bypass. A rectangle/ellipse keeps dormant path intent
but does not execute it until the effect is Bezier.

`resolveClipAnimationAtFrame` remains the public resolution authority. It
resolves scalar and path values into one transient descriptor, validates the
result, and sends it to the existing mask stage. No new renderer, browser API,
frame cache or state-owned pixel object is introduced. A pure index may cache
validated targeting facts by immutable animation/descriptor identity; it must
not retain a duration-sized frame table or an unbounded global cache.

## Timing and editing semantics

| Operation | Exact behavior |
| --- | --- |
| Add/update path at playhead | With no path track, update the static descriptor. Explicit Animate adds a held key at the current clip-local integer frame. Once animated, path edits replace/add only that key and compute source ticks from the target map. |
| Move/duplicate/delete keys | Shared #199 transaction rules; a move or multi-key paste collision rejects the whole edit. An explicit single-key Set at an occupied frame replaces it. Removing the last key removes the track and restores static fallback. |
| Move/slide clip | Preserve local frames, source ticks and path values. Timeline placement alone changes. |
| Head trim | Shift every local key by the negative trim delta; retain off-clip keys and exact source ticks so endpoint holds do not change. |
| Tail trim | Preserve keys and source intent, including out-of-range keys. |
| Split | Copy full held tracks to both halves, shift right-local keys by the split offset, keep ticks, and remint right effect IDs and all target references together. Preflight complete duplicated key/string growth. |
| Slip | Keep local key frames/paths fixed; add the canonical source delta to every tick. This deliberately matches current scalar semantics. |
| Retime/ramp/freeze changes | Remap each durable tick through `SourceTimeMap`. Any missing inverse, unsafe frame or duplicate result rejects the whole linked edit. Repeated rate round trips retain original ticks; no seconds math. |
| Still clips | Use the same logical fixed-source timing convention as existing scalar tracks; do not invent retimable media or a decoder. |
| Text | Direct static masks remain possible; animated text masks stay explicitly unavailable unless #199/#200 approve a shared text effect contract. Existing title behavior is preserved. |
| Copy/paste attributes | Defensive clipboard; preserve clip-local offsets and recompute ticks through each destination map. Remint effect/path targets with the existing project-wide ID authority. Budget the entire selected batch before copying. |
| Presets | Capture only the resolved static path at the selected frame, as existing presets capture scalar values. No animation/cache/analysis bytes enter a preset. |
| Remove/reset effect | Prune its scalar and path tracks atomically. Path-only reset removes only the path track. Unknown descriptor parameters remain preserved by existing reset policy. |

Any animation-rebuilding helper must retain opaque path tracks, including clip
insertion, project/sequence duplication, compound creation, attribute workflows,
source-time conformance, adjustment validation and plugin migration eligibility.
Adjustments and track/master buses cannot author masks/path tracks. A plugin
target with a preserved path track cannot use the current static-only migration
ABI as though it had no animation.

## Geometry, direct editing and accessibility

Define pure `domain/maskGeometry.ts` mapping functions using numeric facts:

- CSS monitor point to project pixels: `(client - canvasRect.origin) *
  projectDimensions / canvasRect.dimensions`. Canvas CSS bounds, not backing
  pixels, DPR or adaptive output dimensions, determine this mapping.
- Local path point to project: `((x + u * width) * projectWidth,
  (y + v * height) * projectHeight)`; inverse uses the same positive box extent.
- Source point to project for tracking: use the existing centered-source,
  crop visibility, anchor, signed scale/flip and rotation contract. Extract a
  pure shared mapper used by the tracking picker/adapter; prove its inverse
  only for admitted affine geometry. Crop clips visibility rather than changing
  the normalized source origin. No duplicate UI interpolation/projection.

Project masks do not rotate or move when the underlying clip is transformed.
That is existing authored output. Tests explicitly combine crop, noncentral
anchor, both flips, signed scale, rotation, full/half/quarter preview, DPR and
responsive resize. Direct handles remain aligned with the masked result.
Lens-corrected project-space masks can be edited without sampling/inverting
the lens; source picking and tracking explain their unavailable state.

Rectangle/ellipse edits expose center move, four corners and numeric box fields.
Bezier editing exposes at most eight anchor groups and sixteen control handles.
Closure is structural: the final endpoint aliases the start. Moving an anchor
translates its adjacent control handles by the same bounded delta by default;
moving a control changes only that control. Numeric input and pointer drags call
the same command and enforce `[0,1]`; multi-handle translation intersects legal
delta ranges, avoiding per-point clamping distortion.

Add inserts a point by splitting the selected cubic at `t=0.5` with de Casteljau
arithmetic; it exactly preserves that curve before canonical string rounding.
Delete joins the preceding/following segment using the outer surviving controls;
it is an explicit shape-changing edit and cannot leave zero cubics. An open new
path is a bounded transport/UI draft only. Close adds a cubic whose endpoint is
the start (line controls at one-third/two-thirds unless explicitly adjusted),
respecting the eight-segment ceiling. Only a valid closed path can commit.
Authoring serialization rounds normalized coordinates to six decimals,
normalizes negative zero, emits explicit commands, and leaves untouched imported
strings byte-for-byte. At the maximum 8x box and 4K dimensions this has a small,
measurable subpixel error; the geometry gate bounds it, not an assumed exact
decimal round trip. Curve-splitting does not promise unchanged legacy flattened
raster pixels because the existing renderer uses eight subdivisions per cubic.

Use a roving focus anchor/control list with selected-part labels, arrow-key
movement (one project pixel, Shift ten), numeric x/y entry, Add/Delete, Close,
Invert, Feather, visibility and Escape cancellation. Keep handles at least 24 CSS
pixels without changing authored coordinates. At most one mask overlay mounts;
all keys/points are also accessible without dragging. Announce selected point,
held-key mode, limits and unavailable reasons via adjacent described status.

The app-owned gesture pins project reference/generation, sequence, clip/effect
identity/version, selection, playhead and transport reset revision. Coalesce to
one preview publication per animation frame. Pointer-up flushes the latest valid
draft, reruns currentness and complete budgets, then dispatches one document
action. Escape, pointercancel, lost capture, unmount, selection/frame/document
change and project exit cancel pending rAF/subscriptions and release only that
owner's preview. Best-effort capture is not gesture truth. Resize during a drag
cancels it; fresh measurements serve the next gesture. No-op/rejected actions
preserve document/history/redo references. Preview arbitration must coexist with
grading, clip-transform, stabilization and tracking drafts.

## Tracking attachment gate

Introduce a discriminated attachment target with `kind: 'mask-effect'`, clip ID
and effect ID; preserve the existing `kind: 'clip-transform'` behavior. Existing
source-to-self transform attachment remains forbidden. A same-clip mask target
is valid only through the new separately validated branch because it changes
project-space mask parameters, not the source transform. This is an explicit
architecture wording amendment for review, not an implicit relaxation.

Reuse only provenance-fresh #110 point/box samples, their exact source schedule
and loss record. At each accepted sample, project the point or all box corners
through that frame's resolved source geometry. Relative to the selection frame,
point tracking translates the existing box; box tracking may additionally scale
its width/height using the projected box's axis-aligned extent ratios. The UI
states that this follows position/box size and does not author rotation. Compute
new top-left around the reference tracked center so a mask's initial offset
from the feature is retained. Reject zero/unsafe projected extents and every
out-of-range result before any preview or Apply.

Author ordinary scalar mask tracks with target-local frames and target-source
ticks, preserving path keys, feather and unrelated effects. Retain every
accepted sample within the existing 1,024-key scalar limit. Require explicit
replacement when the owned `x/y[/width/height]` tracks exist. Preview exists only
within the inclusive accepted range; expose first loss and never extrapolate a
tracked preview. Applied ordinary tracks hold endpoints under the existing
contract, which the Apply description must disclose. Refresh source/selection,
target overlap/lock/effect identity and all budgets immediately before one
undoable Apply. No analysis bytes or hidden tracking provenance enter the clip.

## Proposed budgets and resource gates

These are limits to implement and prove, not measured acceptance yet.

| Data/work | Proposed limit and accounting |
| --- | --- |
| One executable path | Existing 2,048 code units, 1–8 cubics, at most 8 distinct anchors/16 controls; parser may hold 25 coordinate pairs including repeated closure. |
| One path track | 256 held keys; 256 path tracks/clip maximum, additionally constrained by global totals. |
| All active/dormant sequence path keys | 4,096 keys and 1,048,576 value code units (2 MiB conservative UTF-16 payload allowance). Every key also consumes the existing 100,000-key aggregate. |
| Strings/import | All path key strings, including unknown/malformed values, count toward that allowance and the existing 10,000,000 effect-string characters; serialized project remains at most 10,000,000 characters. Static descriptor paths retain existing limits/compatibility. |
| Retained path animation | 32 MiB of accounted bytes across candidate/current/past/future and both attribute/key clipboards: two bytes per value/identity/type/parameter code unit, plus 128 bytes per key and 128 per track. Count each key occurrence conservatively; shared immutable project snapshots may be deduplicated by object identity, never assumed engine string interning. |
| Static paths in history | Remain under existing per-project effect and whole-file bounds and the 100-snapshot history cap. Inventory their bytes too; the new 32 MiB animation allowance must not retroactively reject otherwise-valid static-only projects. Report this separate inherited bound explicitly. |
| Clipboard and drafts | At most one attribute snapshot and one #199 key snapshot; each obeys the project path key/string limits, shares the 32 MiB retained accounting, and clears on project generation change. One active mask draft, one pending rAF, at most one 2,048-character replacement path. |
| Render geometry | Existing eight subdivisions/cubic, at most 65 flattened vertices. No geometry indexed by clip duration; parse at most the selected held path per frame/owner. |
| Pixel work/scratch | For output `P` pixels, clipped bounds `A <= P` and `E <= 64` edges: scanline `O(P + height*E)`, feather worst-case `O(P + A*E)`, one inside byte plus four distance bytes per clipped pixel. At 3840x2160 this is at most 41,472,000 scratch bytes, separate from RGBA readback/surfaces. |

Check cheap array counts/string lengths and overflow-safe sums **before cloning,
parsing paths, creating history/clipboard snapshots or allocating raster buffers**.
JSON input first passes the existing bounded whole-file read, then structural
array/string accounting before per-path parsing. Do not claim validation happens
before the browser has received the user's file. Unknown values consume full
budgets. Whole-project, split/duplicate/paste and history checks must run before
clearing redo. If retained-animation growth exceeds its cap, reject atomically
with a reason; do not silently discard history. Removals and proven zero-growth
edits remain possible. These are conservative payload/metadata accounting units,
not a measurement of engine-dependent JS object layout. This memory is additional
to LUTs, documents and browser resources, not a total-browser-memory claim.

Before rendering ships, inspect aggregate overlap with existing effect readback,
spatial/grading scratch, nested/plugin stages and lens surfaces. Count maximum
simultaneously live bytes, not every sequential stage. Admit actual output/source
sizes below the existing 256 MiB surface/work envelope before allocation; make
unsupported combinations explicit. Do not claim all 4K lens+feather compositions
fit without that ledger. The current pure pixel executor creates bounded scratch
for a call and reuses it across stages; any persistent reuse would need an
explicit render owner and disposal proof, not a global cache.

Preregister exclusive 720p/1080p/4K cells: rectangle, ellipse, 1/4/8-cubic paths;
zero/5%/maximum feather; inverse/off-canvas; static and 256-key held tracks.
Compare identical resolved static/path frames through the same stage: RGBA bytes
must match exactly. Held-path selection overhead for 256-key tracks must stay
under 1 ms p95 per selected mask on the recorded host; measure with warmed
batches separately from raster time. Existing static raster timing thresholds
must remain green; full 4K cells have a preregistered 10-second completion ceiling
per frame and exact operation/scratch bounds, with raw p50/p95 reported. This is
a finite-work safety gate, **not** a real-time 4K feather promise. A missed ceiling
requires optimization/review, not retroactively raising it. Repeated 300-frame
held-path export/cancel/retry must show no retained geometry/scratch growth and
terminal owner cleanup. Record unavailable native-memory instrumentation honestly.

## Migration and #199 integration contract

Propose one timeline migration adding empty `effectPathTracks` to all animation
owners, preserving omitted historical animation and existing descriptor strings.
No project-level resource table or project-format bump is presently needed.
**The orchestrator assigns the final timeline version/order after #199/#200/#201
review.** Do not independently rewrite fixture schema literals before that choice.

#198 owns the path value validator/evaluator/editor, geometry, render integration,
tracking adapter and its acceptance. #199 owns common property identities,
indexed multi-key selection/timing commands, collision policy and shared editor.
The offered discriminated editor identity is `{ kind: 'effect-path', clipId,
effectId, parameter, valueType, valueVersion }`; unknown identities remain visible
as unavailable and cannot masquerade as scalar units.

Factor value-agnostic timing traversal/clone/remap/count hooks once under domain
before either worker changes all scalar helpers. #198 plugs held-string value
validation/clone/evaluation into those hooks. #199 can render a held path lane in
the dope sheet and allow atomic timing edits; its scalar curve/value UI shows a
described unavailable state for nonnumeric paths, with a link to the mask editor.
No per-anchor stable project IDs are needed because complete path snapshots hold
at each key; focused point selection is ephemeral and reconciles on topology
change. Attribute/preset/plugin-migration callers must use the shared traversal.

## Implementation gates after this plan is accepted

1. **Shared foundations:** agree #199 identity/timing hooks and assigned migration;
   implement pure path operations, structural/semantic validation, opaque
   preservation, complete budgets, clone/remap, split/trim/slip/retime and file
   migration. Test exact caps plus malformed/future input and baseline parity.
   Commit and report for review.
2. **Rendering and bounded work:** wire the canonical resolver/status/planners;
   prove static/animated pixel equivalence and no regression to authored effect,
   opacity, transition, nested or bus order. Complete byte ledger and request the
   exclusive timing slot for the preregistered matrix. Commit evidence.
3. **Direct editing:** pure monitor/source geometry, app gesture owner and
   transport arbitration, Inspector/Program handles, accessible commands and
   bounded path drafts. Test complete cancellation/currentness/history behavior,
   then muted headless Chromium on strict port 5198. Commit evidence.
4. **Tracking attachment:** reviewed typed target and architecture amendment,
   fresh sample-to-mask scalar adapter, non-mutating preview, replacement/reset
   disclosure and atomic Apply. Test point/box, same-clip mask vs forbidden
   self-transform, lens refusal, first loss, reverse lanes and cleanup. Browser
   acceptance must exercise an actual attachment, not merely show a disabled
   control. If infeasible, report that issue criterion unresolved for review.
5. **Complete acceptance:** focused tests, exclusive full suite, production
   build/typecheck, lint, production audit, diff/architecture checks and real
   Chromium flows: shape/Bezier edits, held path keys, tracking, keyboard/numeric
   parity, cancellation, undo/redo, recovery/save/reopen, retime/split, mixed #199
   edits and actual playback/export parity. Resolve actionable failures; reproduce
   suspected pre-existing failures on frozen master before labeling them baseline.

Every completed gate is a local Aryel commit with an exact message file and
`Co-authored-by: Codex <codex@openai.com>`. #198 owns this plan and
`docs/evidence/issue198/`; the orchestrator consolidates HANDOFF/PLAN. No worker
push, PR, merge or issue closure is part of these gates.

## Initial-gate acceptance and open decisions

- [x] Clean isolated branch/base and private dependencies verified.
- [x] Issue, architecture, relevant handoff/plan and implementation authorities inspected.
- [x] Exact held-string representation, compatibility, geometry, timing and bounds proposed.
- [x] Shared #199 contract sent to the orchestrator; final contract/migration pending review.
- [x] Existing focused animation/timing checks, build/typecheck and lint passed.
- [ ] Orchestrator approves this plan, retained-byte limits and tracking target amendment.
- [ ] #199 shared timing/identity foundation and schema integration order frozen.
- [ ] All product and issue-specific acceptance gates above remain unimplemented/unrun.

Stop here for internal review. No product source file was changed for this gate.
