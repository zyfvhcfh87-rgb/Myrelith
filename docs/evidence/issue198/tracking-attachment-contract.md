# Issue #198 mask tracking attachment contract — proposed, not promoted

This is the concrete review proposal requested by the orchestrator. It changes
no production code or canonical architecture text. Reviewed source is integration
`125a8c8c69cedb9d3435c39128f94eaf2c54215b`, followed by open-authoring product
source `ef5c191bf7db65c0ce9adb7b6243b9882f59ea41` and evidence-only `a4bb578`.
Implementation must wait for explicit contract acceptance and consume #199's
reviewed schema 22 timing, identity, traversal and retention authorities.

## Proposed architecture amendment

The current tracking paragraph in `ARCHITECTURE.md` at lines 975–994 requires
distinct source/target clip identities and describes only transform attachment.
The proposed narrow replacement for its identity/target wording is:

> Clip-transform attachment requires distinct source and target clip identities.
> The Inspector must never offer the tracked source as its own transform target.
> A separately validated mask-effect attachment may address an enabled, supported
> mask on the source clip or another eligible media clip that overlaps the complete
> accepted tracking range and the exact selection frame. It authors only that
> effect's ordinary x/y and optional width/height scalar tracks; it never changes
> clip transforms or retiming. Masks remain in project space, so source motion is
> mapped once and target transforms do not rebase the mask. Each accepted sample
> uses freshly resolved source geometry. A point outside the resolved source crop,
> or a box not wholly inside it, rejects the complete attachment proposal. No
> accepted sample may be clamped, dropped or extrapolated to obtain an attachment.

All remaining #110 rules stay binding, including directional schedule validation,
exact selection provenance, first analysis loss, transport-only preview inside the
accepted range, one atomic Apply and ordinary post-Apply endpoint semantics.
Any source lens-correction intent keeps picking, analysis and this attachment
unavailable. This amendment neither permits self-transform attachment nor adds
a tracker, decoder, lens inverse, schema collection or alternate evaluator.

## Target, reference and complete range

The app facade dispatches a discriminated target: existing clip-transform or
mask-effect with exact target clip/effect identity. Existing transform planning
and its same-ID rejection remain authoritative. Mask eligibility uses the shared
scalar-effect authority: connected eligible media on an unlocked video track,
an enabled supported `builtin.mask` v1, and valid executable geometry/animation.
Unknown or future effect/track intent cannot masquerade as an editable lane.
This proposal does not independently enable title, adjustment or bus targets.

Validate the admitted analysis in its original forward/backward order before
sorting output keys. At least two accepted samples and the exact selection-frame
sample are required. A nearest sample, interpolated reference or first sample
after sorting cannot replace that reference. The target must cover every accepted
global frame and the selection frame, using its half-open timeline range. Partial
overlap rejects the whole plan; accepted samples are never filtered to fit it.

Resolve the selected mask's rectangle at that exact global selection frame to
obtain `B0`; convert its normalized x/y/width/height to project pixels before the
calculations below. Resolve the source at the same frame to obtain the reference
point/box center `C0` and, for size following, its reference projected extents.
Backward results remain anchored here even when the sorted first key is earlier.

## Crop visibility and source geometry

For each accepted sample, including the reference, use its own integer global
frame and `resolveClipAnimationAtFrame` to obtain the source transform and visual
settings. Pass those facts, exact connected source/project dimensions and
explicitly null lens intent to the accepted `createMaskSourceProjectMapper`.
Never reuse selection-frame geometry for later animated crop, anchor, flip,
rotation or scale. Reject mapper admission failure and unsafe/nonfinite output.

Normalize analysis coordinates by `analysis.width` and `analysis.height`; these
dimensions must already match the admitted decode/cache contract. A point is
visible only when `sourcePointVisible` accepts it against that frame's crop.
A box uses all four raw-source corners; every corner must pass this same test.
The inclusive crop boundary is the mapper's existing authority, without a new
tolerance. For an axis-aligned box and rectangular crop, all four corners inside
also prove the complete source box lies inside. A visible center alone is
insufficient. Do not call `clampSourceToCrop`, intersect a box with the crop,
rebase its origin, resize it to the visible fragment, or change the sample list.

The first crop failure encountered in analysis direction stops preparation and
returns an unavailable reason naming the frame and point/box visibility issue.
**The whole mask attachment is rejected**, with no candidate preview, replacement
confirmation, history edit or shortened usable prefix. Existing analysis remains
an unchanged record; a crop failure is not rewritten as estimator loss. If later
source changes invalidate an active proposal, clear its preview immediately and
require fresh analysis under existing provenance rules. Restoring valid geometry
does not silently resurrect the old proposal.

Examples: a point at x=0.19 with left crop=0.20 rejects; a box spanning x=0.15–0.35
with that crop rejects even though its center is visible. This also applies if
only one later accepted sample becomes partially cropped by animated crop.
The contract proves visibility at accepted samples; it does not claim additional
raw tracking observations between the existing sparse samples.

## Project-space output and canonical timing

Map the admitted point, or all four admitted box corners, to project pixels.
For boxes, `C_i` is the projected center and `E_i` the project-axis-aligned extents
of the projected corners. Zero or unsafe reference/current extents reject.

| Attachment | Output at accepted sample i |
| --- | --- |
| Point, or box position only | `B_i.origin = B0.origin + C_i - C0` |
| Box position and size | `S = E_i / E_0`; `B_i.origin = C_i + (B0.origin - C0) * S`; `B_i.size = B0.size * S` |

All component operations use project pixel units. Convert the resulting origin
and size back to project-normalized mask values, then validate `MASK_LIMITS`
without clamping. Position-only output owns x/y and preserves existing width/
height values and animation; it does not freeze them. Size output owns exactly
x/y/width/height. Neither mode follows rotation or modifies path, feather,
inversion, static descriptor fields, clip transforms or source-time maps.
Projected box size may change with source rotation because its output is an
axis-aligned bounding box; the UI must describe position/box size, not rotation.

Each output key's local integer frame is the sample global frame minus target
timeline start. Its durable source ticks come only from
`sourceTicksAtTimelineOffset(clipSourceTimeMap(target), localFrame)` through the
shared timing authority. Never copy analysis/source-clip ticks into target keys
or derive them from seconds. Keep every accepted sample, including equal values,
within the existing per-track 1,024-key bound. Duplicate/unsafe local frames and
shared document/project/retention admission failures reject before mutation.
Do not introduce a separate retime/remap or retained-byte implementation.

## Preview, replacement and Apply

Preview uses the existing named effect-document owner and canonical ordinary
animation resolver. It changes no saved descriptor/history and clears outside
the inclusive first/last accepted global frames, on cancellation or on stale
source, target, selection, project or session facts. It never presents endpoint
hold outside that interval as tracked motion. Post-Apply ordinary interpolation
and endpoint hold are disclosed before Apply; no tracking-only renderer exists.

The review UI identifies the exact clip, effect and owned parameter lanes. If
any owned lane already has animation, confirmation names exactly those lanes
whose entire tracks will be replaced, including keys outside the accepted range.
Confirmation is bound to that candidate and existing lane content; a changed
target/effect, owned-lane set or existing lane requires a fresh review. Position
only must not request replacement of width/height. Unsupported conflicting intent
rejects instead of being removed. Preserve unrelated and opaque sibling tracks.

Apply performs one fresh plan/currentness check and one atomic document operation
against the exact expected project/generation. Independently validate the effect
identity/version, exact owned track set, complete candidate animation and shared
budgets before clearing redo or mutating history. Rejection, stale confirmation
and cancellation preserve both history branches. Successful Apply is one undoable
edit. Reset, if exposed, must state the exact mask scalar lanes it removes,
including later manual edits; it cannot imply hidden tracking ownership.

`app/motionTrackingController.ts::sourceSnapshot` currently includes the entire
`clip.animation`, transform, visual, source map and selection/request/source facts.
Applying mask keys to the source clip therefore invalidates its old session.
Keep this conservative behavior and clear the preview after Apply. Do not weaken
provenance or silently rebind the session to permit another same-clip Apply.

## Implementation boundaries and review evidence

- Preserve `domain/motionTracking.ts::createMotionTrackingPlan` transform behavior
  and `domain/operations/framing.ts::applyMotionTrackingWithResult` Position/Scale
  ownership. A separate typed mask plan/operation consumes admitted analysis and
  the shared effect/timing/budget authorities.
- `app/motionTrackingController.ts` owns dispatch, freshness and media facts;
  state owns the atomic history boundary; UI reads state and sends commands.
  Projection is pure domain math. No UI interpolation or pixel-resource ownership.
- Prove same-clip mask acceptance versus self-transform rejection at domain, app
  and UI boundaries; exact selection anchoring in both directions; complete
  overlap; and independent projection oracles covering crop, anchor, both flips,
  nonuniform scale, rotation, differing aspects and transformed targets.
- Test point outside crop, box with visible center but cropped corner, exact crop
  boundary, animated crop failure at first/interior/final accepted samples, and
  reversed order. Assert whole-plan refusal and unchanged samples/history/redo.
- Test estimator loss at first/interior/final sample, canonical held/ramped source
  schedules and target ticks, lens refusal, source replacement/offline/staleness,
  target lock/effect/lane mutation, explicit replacement scope and budget edges.
- Require real quiet Chromium attachment preview/Apply/undo, same-clip session
  invalidation, accepted-range cleanup, reopen/export parity and the remaining
  reviewed full/render/performance gates before issue completion.

Only source inspection and document diff hygiene qualify this proposal. It is
ready for contract review; none of the proposed tracking behavior is implemented
or validated by the separate open-path browser run.
