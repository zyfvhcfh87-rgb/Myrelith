# Issue #200 — reusable titles and animated text

Status: **initial contract proposed; stop before product implementation**.
Source baseline: `ce91074c276ca6892a74addb7dd673b9a19c7eeb`, branch
`codex/issue200`. Issue snapshot: 2026-09-08 orchestration `issues.json`,
issue last updated 2026-08-25T21:36:47Z. [Issue #200](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/200).

The Milestone 9 orchestrator reviews this commit and assigns migration order.
This document assigns **no timeline schema number**. Current baseline is
timeline schema 21 / project format 8. Product acceptance remains open.

## Proposed outcome and boundaries

A title remains one procedural video clip with no media/decoder/relink owner.
It contains up to 16 ordered text, rectangle, or ellipse elements. Users can
edit each element, save a local template, instantiate independent copies, and
apply roll/crawl by authoring ordinary scalar keys. Titles use the same exact
integer-frame evaluator and compositor in scrub, playback, nested sequences,
and export. Caption identity and legacy caption painting stay unchanged.

No arbitrary HTML, SVG, CSS, script, expressions, remote font services, font
enumeration, external template marketplace, or per-element media/effect stack.
Safe-area guides are editor-only 90% title / 95% action rectangles in project
coordinates; they never enter pixels, duration, export, or undo history.

## Existing contracts that constrain the change

| Evidence at the baseline | Consequence |
| --- | --- |
| `textOverlay.ts`: six generic font families, 20,000 characters, strict hexadecimal colors and finite geometry | Migration must retain every accepted style value, including empty text and fractional geometry. |
| `render.ts:drawTextPayload`: box-centered pivot, crop/flip, top baseline, `ceil(fontSize * 1.2)`, outline before shadowed fill | Equivalent-looking new fields alone do not prove equivalent pixels. Reuse the same painter and prove call/pixel equivalence. |
| `render.ts:compositeTextLayer`: one isolated leg, one ordered effect stack, then clip opacity/blend | Multiple elements must finish on this same leg before clip effects/opacity/blend; never filter each primitive independently. |
| `videoCompositionPlan.ts`: resolves animation before emitting text and never requests its media | Resolve title elements at this same boundary, with no UI interpolation or synthetic media asset. |
| `clipAnimationKindError` and `operations/animation.ts`: text currently rejects all keys | Eligibility, editing, cloning, counting, shifting, source intent and persistence all need explicit title support. |
| `geometry.ts`: text source maps reset to `[0, duration)` on split/trim; Slip/retime do not apply | Title keys need fixed-local source intent, including a deliberate reanchor when the clip origin changes. |
| `projectSequences.ts`, project validation/serialization and selectors inspect `clip.text` | Replace all procedural-owner checks together; missing one can create ghost offline media or lose dormant title data. |
| `TextProps`, `wrapTextLines` and `drawTextPayload` also serve captions | Keep the caption-facing type/painter stable; coordinate any mechanical extraction with #201. |

See [source and check evidence](evidence/issue200/initial-gate.md).

## Title definition proposal

Add `Clip.title?: TitleDefinition`; migrate existing `Clip.text` into it.
Do not persist both authoritative forms. Keep the reserved procedural asset id,
clip id, name, source identity/range, timing, audio/link metadata, clip opacity,
blend intent, and ordered effect descriptors. Media clips cannot own a title;
titles remain video-only, non-retimeable, non-transition endpoints, with no lens
intent. The title-bearing clip's outer transform/visual become canonical
identity/defaults; geometry belongs to the elements. Clip opacity stays the
existing clip-level `opacity` scalar. No second title id is needed: the clip
is the composition owner.

Proposed data shape (documentation, not a production declaration):

```ts
interface TitleDefinitionV1 {
  version: 1
  elements: TitleElement[] // array order = bottom-to-top paint and editor order
}

interface TitleElementBaseV1 {
  id: string
  version: 1
  name: string
  enabled: boolean
  transform: Transform
  visual: ClipVisualSettings // static crop/flip/scale lock, existing units
  opacity: number
}

interface TitleTextElementV1 extends TitleElementBaseV1 {
  kind: 'text'
  text: Omit<TextProps, 'fontFamily'>
  font: { family: string; fallbackFamily: TextFontFamily | null }
}

interface TitleShapeElementV1 extends TitleElementBaseV1 {
  kind: 'rectangle' | 'ellipse'
  shape: {
    boxWidthPx: number
    boxHeightPx: number
    fillColor: string
    outlineEnabled: boolean
    outlineColor: string
    outlineWidthPx: number
  }
}
```

Each supported element uses the current centered-box geometry: the untransformed
top-left is `((W - boxWidth) / 2 + x, (H - boxHeight) / 2 + y)`; anchors are
fractions of that box, then rotation, scale and flips follow the exact legacy
order. `position-x/y` are therefore center-relative translations in project
pixels, not CSS pixels or normalized coordinates. The same pure forward/inverse
geometry must serve handles and numeric edits; zero scale offers numeric editing
and an explicit unavailable drag status. A title has no lens-coordinate inversion.

For migration, create one enabled text element with opacity 1, carrying the
**exact original** transform, visual settings and text values. Move only
`fontFamily` into `font.family`, with `fallbackFamily: null`. Reset only the
outer geometric fields that now live in the element. The renderer passes those
exact values back to `drawTextPayload`, with the same context transform, crop,
global alpha, font string, line-height, line count, wrap input, and draw order as
before. Clip effects, clip opacity and blend still run once afterward. Shape
support must not alter text/caption defaults, clipping, shadows or line wrapping.

Migration allocates element IDs deterministically against every existing and
reserved identity in the complete project, without randomness or browser APIs.
It must validate/count input before building output and be idempotent. A bounded
newer title/element version is retained as unavailable intent, not rewritten as
v1. Enabled unsupported elements produce named preview status and block export;
explicitly disabled ones remain editable as retained records. Malformed known
v1 data rejects before rendering. Unknown extension data never becomes executable.

### Legacy pixel gate (required before the authoring UI)

Run the unchanged baseline and migrated renderer in the same real Chromium
runtime/font environment at identical canvas settings. Capture exact raw RGBA
and line/layout facts for all six font families, both weights/styles, multiline,
CRLF/whitespace, long-word wrapping, non-Latin/combining/emoji text, fractional
box/position/font values, anchors 0/0.5/1, scales 0/fractional, rotated/cropped/
flipped text, transparent backgrounds, outlines/shadows, opacity/blend, and
ordered effects. Full/Half/Quarter preview and full-resolution export inputs
must use identical authored coordinates. Require **zero differing RGBA bytes**
for baseline versus migrated output in the same runtime; include caption
canaries unchanged. Do not use image tolerances to conceal a migration change.

Reopen the migrated project, edit the legacy element, undo/redo, and export.
Canvas equality is the migration pixel claim. A lossy encoded reopen is a
separate delivery check with a declared codec/tolerance, never called byte parity.
Cross-platform font equality is not inferred from this same-runtime gate.

## Stable scalar contract for #199

The title property vocabulary and static-field reader/bounds live in a pure
`domain/titleElements.ts` module owned by #200. The scalar validator/evaluator,
key mutation, source-time handling, indexing, selection and clipboard machinery
remain in the single animation authority owned by #199. No title easing engine.

```ts
interface TitleAnimationTrack {
  elementId: string
  propertyVersion: number // v1 semantics below; unknown versions stay opaque
  property: string        // only registered names below can evaluate
  keyframes: ClipAnimationKeyframe[]
}
// Proposed optional-in-memory, required-on-current-save container extension:
// ClipAnimation.titleTracks: TitleAnimationTrack[]
```

Use #199's structured selection address
`{ owner: 'title', clipId, elementId, propertyVersion, property }`, with sequence
identity and project generation in the command/session envelope. Persist only
the last three target fields within the owning clip. Array indices,
element names, displayed labels, locale, and concatenated dotted property paths
are never identities. One track per exact `(elementId, propertyVersion, property)`.
Property version 1 is immutable even if UI units/labels change later.

#200 supplies pure `titleAnimationPropertySpec(element, propertyVersion, property)`
and `readTitleAnimationProperty(element, propertyVersion, property)` adapters;
the spec includes eligibility, bounds/units, static fallback and a stable reason
when unavailable. A pure `applyTitleAnimationValues(element, values)` adapter
returns one fully validated element candidate. These adapters do not interpolate
or import the animation engine. #199 evaluates admitted keys and calls the
adapter; if a common scalar leaf must be extracted, keep compatibility exports
and exact evaluator regression tests. Labels are presentation, not wire keys.

| Property v1 | Element kinds | Static fallback field | Unit / finite inclusive range | New-element default |
| --- | --- | --- | --- | --- |
| `position-x`, `position-y` | all | `transform.x`, `.y` | project px, -1e9…1e9 | 0 |
| `scale-x`, `scale-y` | all | `transform.scaleX`, `.scaleY` | multiplier, 0…100 | 1 |
| `rotation` | all | `transform.rotation` | degrees, -1e9…1e9 | 0 |
| `opacity` | all | `opacity` | multiplier, 0…1 | 1 |
| `box-width`, `box-height` | all | `text` or `shape` box size | project px, 16…65,535 | text: `defaultTextProps(W,H)`; shape: 320×120 |
| `font-size` | text | `text.fontSizePx` | project px, 8…1,024 | `defaultTextProps(W,H)` |
| `outline-width` | all | `text` or `shape` outline width | project px, 0…64 | text: existing default; shape: 0 |
| `shadow-blur` | text | `text.shadowBlurPx` | project px, 0…128 | existing default |
| `shadow-offset-x`, `shadow-offset-y` | text | matching text shadow offset | project px, -512…512 | existing default |

Defaults initialize new records only. Evaluation fallback is always the exact
authored field; Reset removes a track without changing that field. Control step
does not quantize render values. Keep anchors, crop/flip, padding, content, font,
alignment, colors, booleans and element order static in this slice. #199's clip
crop tracks remain a separate owner; do not reinterpret them as element crop.

For a title clip, outer ordinary clip tracks may animate only its existing
clip-wide opacity. Element transform properties use `titleTracks`; outer
position/scale/rotation/crop and audio lanes are not authorable there. Preserve
unknown/ineligible incoming intent with status. Clip effect tracks may use only
the owning registry's declared safe text-stage numeric parameters after the
complete title layer; #198 owns path-track eligibility. This makes the absence
of a second title transform authority explicit.

Padding is static, and **every** base/key box width/height must be strictly
greater than twice padding. Existing bounded easing is convex between endpoints,
so that envelope also protects intermediate frames. Check the whole candidate
after an element patch, padding change or pasted tracks; reject atomically,
without silently clamping either property. Scale-lock edits create/update both
axes in one batch when locked; enabling the lock follows the existing X-authority
policy. Legacy zero scale remains representable.

Known ineligible properties and invalid known values cannot be newly authored.
Bounded future/dangling tracks survive save, copy, split, trim and undo without
interpreting their numbers. They carry status and count toward all budgets.
An enabled title with unevaluable authored animation blocks strict export;
preview may show its static fallback only with the reason visible. Avoid a
single unknown track disabling evaluation of every unrelated supported track.

### Identity and timeline operations

| Operation | Required result |
| --- | --- |
| Reorder, rename, geometry/style/content edit | Keep element ID and target tuples. |
| Duplicate element/title, sequence duplicate, template use, paste elements | Fresh IDs for every copied live element; reserve IDs across active/dormant sequences and orphan targets. Remap internal track targets together. Do not guess targets by name/order. |
| Split at offset `d` | Left retains IDs. Right gets a fresh clip, procedural asset ID and fresh element IDs; remap right tracks. Keep all keys, including keys outside either half; shift right frames by `-d`. |
| Head trim by `d` | Shift all local key frames by `-d`, retaining outside keys and easing so overlapping global frames do not change. |
| Tail trim/extension | Keep keys and base values exactly. Endpoint holds apply; no implicit duration rescaling. |
| Move/ripple/slide | Move the composition; preserve local keys. Adjacent trims follow the same head/tail rules. |
| Slip/retime/speed ramp | Unavailable/no-op exactly as current procedural text. No source-media fiction. |
| Delete element | Remove its owned tracks in the same explicit undoable edit; preserve unrelated and already-orphaned tracks. Undo restores exact IDs/keys. |
| Copy/paste keys | Preserve property version and values; use #199's explicit source-to-destination target mapping and shared absolute/relative policy. Reject unavailable destinations/collisions as a whole. |

Title keys use `ClipAnimationKeyframe`, including required portable
`sourceTimeTicks`. Their time domain is **fixed clip-local procedural frames**:
`sourceTimeTicks = frame * SOURCE_TIME_TICKS_PER_FRAME`, checked as a safe integer.
On head trim/right split, recompute these ticks from shifted frames because the
procedural source map restarts at zero. Ordinary media retains its existing
absolute-source intent. All title/effect/container helper branches must preserve
unknown tracks and obey this owner-specific distinction. Negative/outside keys
remain legal within the existing ±1e9-frame bound; authors add keys inside the
visible clip. Title tracks count within the current 1,024 keys/track and 100,000
keys across the complete project. #199 owns collision policy; this issue must not
create a second policy or change existing media retime behavior.

### Roll/crawl commands, not hidden animation

Provide Roll up/down and Crawl left/right authoring commands with visible
integer start/end frames. Default interval is `[0, durationFrames - 1]`, covering
the first and last displayed frames. Require at least two frames and
`0 <= start < end < duration`; a one-frame title gets an explained unavailable
state. A user may shorten this interval to leave endpoint holds. Each command
precomputes two linear position keys per selected element on the movement axis.
All elements share one displacement from the group's transformed box bounds,
which includes crop/flip/rotation/scale, so spacing stays coordinated. Zero scale
or unbounded/unavailable geometry rejects the command. No wall-clock, CSS motion,
timer, persisted speed or per-frame regeneration enters playback.

At the entry key the complete group is outside the selected canvas edge; at the
exit key it is outside the opposite edge. The first/last fully offscreen frames
are intentional; UI labels disclose them. Custom entry/exit holds are exact
frames, not percentages. At in/out points outside the authored interval the
ordinary nearest-key rule applies. Every in-range interior frame is evaluated
by the same scalar evaluator. Clip visibility remains half-open independently.

Generated keys are ordinary, individually editable keys immediately after Apply.
Trim, extension, split, reopen, undo or an unrelated element edit never regenerate
them. Reapply is an explicit transaction, with a review of all replaced movement
tracks; Cancel preserves everything. A no-overwrite default rejects when target
tracks already exist. Whole-project growth/bounds/locks and the captured project,
sequence, clip and element IDs are rechecked immediately before one commit.

## Font availability and layout gate

Keep title-only font intent separate from caption `TextProps`. The initial
bounded rendering vocabulary is the six existing generic families. Preserve an
unknown bounded family name as missing/unverified intent; it is never passed to
Canvas/CSS as a font source. A missing face with `fallbackFamily: null` is visibly
unavailable and blocks export. Choosing a supported generic fallback is one
explicit history edit that **retains** the original family and persists the
fallback choice. Reopen repeats status resolution; a transient availability
probe never changes saved values. No automatic upgrade back to an original face.

Generic fonts preserve legacy behavior but do not identify font bytes. Their
status must say that exact appearance on another computer is unavailable; do
not label them cross-platform deterministic. CSS Fonts defines generics as
platform-dependent aliases. `FontFaceSet.check()` is not an identity/coverage
test: the font-loading draft expressly permits true when the requested font is
missing and the browser uses fallback. [CSS Fonts, generic families](https://drafts.csswg.org/css-fonts/#generic-font-families),
[CSS Font Loading, check](https://drafts.csswg.org/css-font-loading/#font-face-set-check)
(working drafts, consulted 2026-09-08).

The font-name parser accepts bounded literal identifiers (letters, numbers,
spaces, dot, underscore and hyphen), not a CSS declaration/list, URL, slash,
colon, quote, function, or source expression. Whitespace at either end rejects
instead of changing a saved name. Only an explicitly resolved allow-listed
family reaches the legacy Canvas font string.

**Internal acceptance decision required:** confirm that this visible
platform-font compatibility mode satisfies the first slice's unavailable-font
branch, or require a separate, reviewed bundled-font catalog before font
acceptance can close. The latter needs pinned local font bytes, provenance,
license/size/coverage review, exact worker/export registration and cleanup; no
font package or remote service is selected or added by this plan. Generic
compatibility must remain for identical legacy pixels either way. Do not claim
the full font criterion passes merely because a missing-font badge exists.

The first render gate must compare actual main/worker/export line breaks and
pixels at fixed requested frames, including fallback, combining marks, bidi and
scripts outside the chosen face's coverage. Preserve the existing bounded
greedy wrapping and 512-line ceiling. A failed coverage/parity proof leaves the
case unavailable; it cannot enable a silent substitute. If a face/runtime changes,
discard its derived layout cache and revalidate status before presentation/export.

## Templates and resource budgets

Proposed `TitleTemplateV1`: exact envelope `{ version: 1, id, name, canvasWidth,
canvasHeight, frameRate, durationFrames, title, titleTracks }`. It has a complete
data snapshot, no live link to a clip. Built-ins include centered title, lower
third and card with ordinary editable elements. User capture includes editable
title tracks; it excludes clip effects, media, trust, handles, resource objects,
URLs as sources, and runtime selection/status. Literal content is inert text.
No import/export UI for separate template files is required; used templates are
portable because their complete instantiated data enters the project.

Template use reserves fresh IDs and validates the final receiving project before
one insertion. Same-canvas use preserves geometry. On a different canvas, use one
explicit uniform fit factor `min(W/Wt, H/Ht)`, centered, for position/boxes/font/
outline/shadow/padding and matching numeric keys. Rotation, scale multipliers,
opacity and static normalized crop stay unchanged. Show this conversion before
Apply and reject values outside registered ranges. Template timing preserves
exact local frame numbers/duration at the destination rate; show the resulting
duration and a rate-difference notice. Do not silently approximate seconds or
merge rounded colliding keys. A later seconds-conform option is separate work.

Versioned origin-local storage follows the effect-preset lifecycle pattern:
one app-owned IndexedDB transaction per mutation, connection close on all paths,
write success only at transaction completion, preservation of unknown raw records,
future library envelope read-only, and surfaced corruption/quota errors. The
store publishes only bounded serializable summaries. Removing a template never
changes instances. Library mutations are independent of project history.

| Proposed bound | Scope and enforcement |
| --- | --- |
| 1–16 elements; 80-character element/template names; 256-character IDs; 128-character property/font names | Check array/string sizes before mapping, measuring or allocating. IDs unique project-wide; track tuples unique per clip. |
| 20,000 text characters/element; 80,000 total title content characters; 1 MiB serialized UTF-8/title including its tracks | Retain the complete existing per-element allowance. All independent limits must pass; no truncation. |
| 100,000 total elements across every sequence; existing 10,000,000 project text-character and serialized-character ceilings remain | Legacy one-element migration cannot lower the former clip-count envelope. Dormant/hidden/disabled elements still count. Save/recovery and every live candidate use the same counters. |
| 256 title tracks/clip; existing 1,024 keys/track and 100,000 project keys | Include unsupported versions, dangling targets, disabled elements and all sequences. All clone/split/paste/template/roll operations preflight growth. |
| 4,096 expanded visible title elements/frame | Pure composition-cost preflight includes nested instance multiplicity before layout; this accommodates the existing 4,096-leaf legacy ceiling. No per-frame graph expansion stored in history. |
| Text geometry/style ranges in the property table; static padding 0…1,024, positive inner box; static anchor/crop/flip unchanged | Checked before layout, including all key envelopes. Hex colors only; shapes are bounded primitives. No canvas sized from an element box. |
| 512 rendered lines/element; 64 layout entries/context and at most 8 MiB conservative retained string storage/context | Bounded derived cache, clear on owner/font replacement. Reuse the existing project-sized leg/group surfaces; zero per-element canvases. |
| 64 MiB conservative retained title payload/track data | Count current project, past/future snapshots and app element/title/key clipboards by immutable owned references, including dormant sequences. Validate before clearing redo. Reject growth with a reason; never prune history silently. Existing 100-history-entry cap remains. |
| 100 local user templates; 1 MiB/template; 8 MiB/library | Includes raw unsupported siblings. Capture and use apply both library and destination bounds; maximum additional retained library allowance is separate and explicit. |
| Opaque future title: depth 8, 4,096 entries, same aggregate string/byte caps | Bounded non-executing JSON only; supported versions validate exact keys. No getter/prototype traversal of untrusted runtime objects. |

The 64 MiB retained-data figure is a conservative serialized-data admission
measure, not total JS/browser memory. It needs a pure bounded size walker and
reference-aware snapshot accounting, modeled on existing LUT retention. Immutable
unchanged elements/tracks are shared; gestures keep one disposable draft and one
commit. Validate old-format input within existing bounds before migration, then
check any new envelope overhead. If a previously valid near-limit project would
be rejected solely by added schema bytes, treat that as a migration defect to
resolve at the schema gate, not a license to truncate or silently drop data.

## Implementation gates and ownership

Each gate is a local commit with an exact message file, Aryel author and Codex
co-author. Update `docs/evidence/issue200/` and the orchestration report each turn.
Orchestrator owns HANDOFF/PLAN consolidation, shared schema assignment, review,
integration, remote publication and issue closure.

1. **G0 — this plan/contract review.** Commit documents only. #199 reviews target
   tuples, field mapping, fixed-local ticks and helper preservation. Orchestrator
   accepts title schema/migration direction and resolves the font acceptance
   branch. Stop here until that review completes.
2. **G1 — reviewed foundations and migration.** Implement pure title validation,
   property specs, identity allocation/remapping, all-sequence/retained budgets,
   migration/serialization/clone/source/media-owner checks. Coordinate #199's
   empty title-track container and scalar hooks before any renderer/UI support.
   Focused adversarial/round-trip/split/trim/history checks; no unsupported future
   data loss. Font support decision becomes a concrete status contract here.
3. **G2 — shared rendering and parity.** Resolve scalar elements in the canonical
   plan; paint ordered elements into one existing isolated leg. Implement strict
   title font status in preview/export owners and cache invalidation. Pass the
   legacy zero-difference gate, caption canaries, multi-element/raw export parity,
   effect/blend/scale/sequence cases and cleanup/capacity checks before UI polish.
4. **G3 — authoring, templates and generated motion.** Accessible element list,
   numeric Inspector and direct manipulation, add/delete/reorder, safe guides,
   template library/capture/instantiate, explicit fallback, roll/crawl preview and
   one-commit Apply. Pin project generation/sequence/selection while a dialog is
   open; a raced/locked/changed owner rejects without history. Integrate #199's
   shared dope sheet/property controls without inventing animation state.
5. **G4 — complete acceptance on the committed implementation.** Focused/full
   tests, build/typecheck, lint, production audit, architecture/diff checks and
   real muted headless Chromium on port 5200. Reserve the orchestrator's exclusive
   slot for full suites, browser/performance runs and final timing evidence.
   Reproduce suspected baseline failures on unchanged `ce91074` before classifying
   them; no weakening of assertions or invented complete-suite green labels.

Expected files: `domain/titleElements.ts`, `domain/titleTemplates.ts`, existing
schema/animation/operations/sourceTimeMap/project validation/serialization/
sequence and composition modules; `state/documentStore.ts` plus title selection/
preview/status projections; `app/` template storage/controller and preview/export
status wiring; title UI/Inspector/Program controls; shared renderer and relevant
worker protocol only as necessary. `domain/` remains browser-free; `.tsx` uses
state and app facades; app owns storage, font/runtime preparation and lifecycle.
Any new architecture exception requires explicit review, not an implicit import.

## Acceptance matrix

| Issue criterion | Required evidence before closing |
| --- | --- |
| Existing text migrates identically and stays editable | Same-runtime zero-RGBA-difference matrix, migrated reopen/edit/undo/export; original generic intent preserved. |
| Hostile budgets reject before layout/surface allocation | Unknown keys/versions, duplicate IDs/tuples, excessive arrays/depth/strings/elements, invalid font/color/shape/numbers, coupled box envelopes; allocation spies stay at zero on reject. |
| Local templates are safe/fresh/editable | Built-ins plus capture/use/delete; IDs disjoint across duplicate/split/paste/sequence/template; atomic quota/future-envelope behavior; no source network request or executable path. |
| Roll/crawl/animated properties use exact frames everywhere | Every property at boundary/interior frames and all easing modes; arbitrary nonsequential seeks equal sequential playback/export; trim/split/extend/reapply preserve manual edits. |
| Deterministic or visibly unavailable fonts/layout | Accepted G0/G1 font mode decision, actual worker/export proof, missing/unknown/fallback and reopen tests; cross-platform qualification stated honestly. |
| Accessibility and responsive editing | Keyboard element selection/order/add/delete, labeled numeric alternatives, focus return/trap/Escape, screen-reader status, safe-area labels and contrast, 1280×720 and 720×800 with no overflow. |
| Real Chromium flow and cleanup | Legacy title, multiple coordinated elements, user template create/use, roll/crawl, #199 keys, missing-font explicit fallback, save/reopen, export raw pixels/reopen, cancel/dispose/retry and clean console. |
| Full engineering gates | Exact commit provenance, focused/full result separation, build/typecheck, lint, audit, diff and production graph exclusion of any evidence-only harness. |

G0 completion means the proposal is ready to review. It does not complete any
unchecked product acceptance criterion in issue #200.
