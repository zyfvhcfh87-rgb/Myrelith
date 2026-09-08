# Issue #200 — reusable titles and animated text

Status: **G2 and the six G3 functional flows are accepted with their recorded
qualifications. The separate fallback first-paint result is accepted and archived
at f8e7370: an early blank canvas followed by exact automatic glyph rendering in
the same unchanged run. Remaining title keyboard/focus/narrow-controls acceptance,
the shared #199 key/encoded gate and root final engineering checks remain open.**
See the [current evidence matrix](evidence/issue200/remaining-acceptance-matrix.md).
No further source fix, integration sync or native/build run is authorized here.
Source baseline: `ce91074c276ca6892a74addb7dd673b9a19c7eeb`, branch
`codex/issue200`. Issue snapshot: 2026-09-08 orchestration `issues.json`,
issue last updated 2026-08-25T21:36:47Z. [Issue #200](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/200).

The orchestrator assigned this order on 2026-09-08: pure title element types and
property adapters first (no Clip or migration changes), then #199's shared
animation foundation as timeline schema 22, then this title-owner change as 23.
Baseline is timeline schema 21 / project format 8. The assignments are reviewed
coordination decisions. G1a adds the independent pure title module and tests;
Clip, animation ownership, migrations, store, renderer and UI remain unchanged.
See [G1a API and validation evidence](evidence/issue200/pure-foundation.md) and
[pure budget completion](evidence/issue200/pure-budgets.md). The accepted combined
foundation `b0e43ed449719fe3e424a46cd97d384b6a11cf1a` was fast-forwarded into this
branch under the orchestrator's instruction. The later corrected budget and
schema22 gates were accepted; this branch then fast-forwarded to exact
`f9945c44f75a4818bc939d8b6e63c09db353e669` before the authorized G1b work.
See [schema23 ownership evidence](evidence/issue200/schema23-owners.md), including
remaining rendering, template-capture and authoring gates. Product acceptance
remains open. The supervisor accepted G1b and released G2 after the shared
integration. See [G2 rendering protocol](evidence/issue200/rendering-protocol.md)
for current scope, compatibility decisions and unrun browser acceptance.

## Proposed outcome and boundaries

A new multi-element title remains one procedural video clip with no media/decoder/relink owner.
It contains up to 16 ordered text, rectangle, or ellipse elements. Users can
edit each element, save a local template, instantiate independent copies, and
apply roll/crawl by authoring ordinary scalar keys. Titles use the same exact
integer-frame evaluator and compositor in scrub, playback, nested sequences,
and export. Caption identity and legacy caption painting stay unchanged.

Existing text clips remain a fully supported compact compatibility variant.
Opening, saving or ordinary text editing never forces their conversion. Adding
elements or title animation starts an explicit, budget-checked Upgrade to title
transaction; Cancel or insufficient capacity leaves the existing text editable.

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
| `projectSequences.ts`, project validation/serialization and selectors inspect `clip.text` | Extend all procedural-owner checks to both mutually exclusive variants; missing one can create ghost offline media or lose dormant title data. |
| `TextProps`, `wrapTextLines` and `drawTextPayload` also serve captions | Keep the caption-facing type/painter stable; coordinate any mechanical extraction with #201. |

See [source and check evidence](evidence/issue200/initial-gate.md).

## Title definition proposal

Add `Clip.title?: TitleDefinition` while preserving supported `Clip.text` exactly.
These are mutually exclusive wire variants: a procedural clip owns text OR title,
never both. A media clip owns neither. Schema 23 does not add a tag, title wrapper,
element ID, font wrapper or empty title field to a legacy text clip. It keeps
that clip's existing text, transform and visual ownership and old editing path.

For newly created or explicitly upgraded titles, keep the reserved procedural asset id,
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

An explicit Upgrade to title creates one enabled text element with opacity 1, carrying the
**exact original** transform, visual settings and text values. Move only
`fontFamily` into `font.family`, with `fallbackFamily: null`. Reset only the
outer geometric fields that now live in the element. The renderer passes those
exact values back to `drawTextPayload`, with the same context transform, crop,
global alpha, font string, line-height, line count, wrap input, and draw order as
before. Clip effects, clip opacity and blend still run once afterward. Shape
support must not alter text/caption defaults, clipping, shadows or line wrapping.
The upgrade preserves appearance but is a user-authored transaction, not a forced
load/save migration. The static legacy editor remains usable indefinitely.

The pure upgrade receives fresh bounded IDs from an injected allocator and
reserves them against every existing/orphan target across the complete project.
It validates a complete candidate, including exact portable serialized character
count and retained-data budgets, before one history commit. Repeat on an already
upgraded clip is an idempotent no-op. No mutation, consumed history or discarded
redo occurs on failure. New title features offered from a legacy clip include
this explicit upgrade in the same reviewable transaction, with its additional
key/element payload already in the preflight; they never upgrade silently first.
Template capture may create an independent title snapshot without upgrading the
source clip, and validates library capacity independently.

A bounded
newer title/element version is retained as unavailable intent, not rewritten as
v1. Enabled unsupported elements produce named preview status and block export;
explicitly disabled ones remain editable as retained records. Malformed known
v1 data rejects before rendering. Unknown extension data never becomes executable.

### Exact legacy file-size boundary

Keep the 10,000,000-character file cap unchanged. In-memory derived status/default
views are not new portable data. Absent empty schema-22 `titleTracks` and other
new empty animation collections remain valid and are omitted on serialization;
#199 must coordinate this rule for its foundation. Compatibility schema-number
updates 21→22→23 each use two digits and add zero characters. The outer project
format stays 8. Legacy `Clip.text` serialization otherwise retains the baseline
allow-listed fields and canonical ordering, with no required new version tag
per legacy clip/element or default animation track. Nonempty new data uses the
new schema and ordinary complete-file budget preflight.

This promises no #200-induced growth for previously valid canonical schema-21
text files. Older accepted schema migrations keep their existing compatibility
path; #200 must not add another expansion after them. Schema-21 documents with
ordinary/effect animation also need #199's default-version serialization to
avoid adding unavoidable bytes: an implicit legacy v1 is not newly emitted just
to open/save, and is never inferred for an explicitly unknown version. These
are shared serialization acceptance obligations, not permission to raise limits.

The executable [boundary fixture](evidence/issue200/legacy-size-boundary.mjs)
uses the unchanged baseline parser, serializer, factory and text edit operation.
It builds two same-settings sequences with 300 bounded legacy text clips each;
one sequence is dormant. Ordinary ASCII text content fills the exact target
character length without whitespace padding, unknown fields or oversized strings.
Every text payload remains at most 20,000 characters. The recorded
[result](evidence/issue200/legacy-size-boundary-result.json) is:

| Existing canonical characters | Baseline open/save and equal-length content/color edit | Compatibility encoding projection | One proposed explicit upgrade | Size decision |
| --- | --- | --- | --- | --- |
| 9,999,614 | pass, same length | 9,999,614 | 10,000,000 | fits the character cap exactly |
| 9,999,615 | pass, same length | 9,999,615 | 10,000,001 | upgrade must reject |
| 9,999,999 | pass, same length | 9,999,999 | 10,000,385 | upgrade must reject |
| 10,000,000 | pass, same length | 10,000,000 | 10,000,386 | upgrade must reject |
| 10,000,001 | parser and serializer reject | no admission | no upgrade | cap unchanged |

For this concrete identity/payload fixture, one expansion costs 386 characters;
forcing all 600 expansions costs 232,500. The actual implementation must count
its exact candidate, not hardcode those measured deltas. Proposed schema-23
encoding sizes are projections only; the future parser and store were not tested
by this baseline experiment.

G1b must run these exact boundaries through the actual schema-22/23 parser,
serializer, recovery and store. It must prove legacy reopen/edit/undo/redo and
same-length save, exact-fit upgrade/undo restoring the original representation,
one-over upgrade rejecting with project/history/redo unchanged, and template
capture leaving the source legacy. Include escaped text and multibyte Unicode
fixtures to distinguish JS serialized-character limits from UTF-8 retained-byte
limits, plus dormant animation/future-intent cases. Size-growing ordinary edits
obey the existing file cap; ordinary content/style/move edits do not require
extra title metadata or a successful upgrade. No automatic conversion back,
hidden retained original JSON, truncation or implicit limit increase is allowed.

### Legacy pixel gate (required before the authoring UI)

Run the unchanged baseline, compatibility renderer and explicitly upgraded title
renderer in the same real Chromium
runtime/font environment at identical canvas settings. Capture exact raw RGBA
and line/layout facts for all six font families, both weights/styles, multiline,
CRLF/whitespace, long-word wrapping, non-Latin/combining/emoji text, fractional
box/position/font values, anchors 0/0.5/1, scales 0/fractional, rotated/cropped/
flipped text, transparent backgrounds, outlines/shadows, opacity/blend, and
ordered effects. Full/Half/Quarter preview and full-resolution export inputs
must use identical authored coordinates. Require **zero differing RGBA bytes**
for baseline versus each supported representation in the same runtime; include caption
canaries unchanged. Do not use image tolerances to conceal a migration change.

Reopen the compatibility project, edit legacy text, explicitly upgrade, edit the
new element, undo/redo across the representation change, and export each version.
Canvas equality is the compatibility/upgrade pixel claim. A lossy encoded reopen is a
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
// Optional additive container; absence resolves to [] and empty stays omitted:
// ClipAnimation.titleTracks?: TitleAnimationTrack[]
```

Use #199's structured selection address
`{ owner: 'title', clipId, elementId, propertyVersion, property }`, with sequence
identity and project generation in the command/session envelope. Persist only
the last three target fields within the owning clip. Array indices,
element names, displayed labels, locale, and concatenated dotted property paths
are never identities. **One semantic lane per `(elementId, property)`**, regardless
of propertyVersion. Version qualifies how one lane's values may be interpreted;
it cannot create a competing writer. A v1 and future-version track for the same
element/property reject as duplicate ownership, including disabled or orphan
targets. Preserve a lone unknown version as unavailable; do not reinterpret or
replace it when adding a current-version key. Version in the selection address
is a stale-state/compatibility guard, not a second identity dimension. Version
replacement needs an explicit separately validated operation. Property version
1 is immutable even if UI units/labels change later.

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

For an expanded title clip, outer ordinary clip tracks may animate only its existing
clip-wide opacity. Element transform properties use `titleTracks`; outer
position/scale/rotation/crop and audio lanes are not authorable there. Preserve
unknown/ineligible incoming intent with status. Clip effect tracks may use only
the owning registry's declared safe text-stage numeric parameters after the
complete title layer; #198 owns path-track eligibility. This makes the absence
of a second title transform authority explicit.

Legacy compatibility text keeps its static clip/text editing contract. Element
keys, multi-element edits and roll/crawl require the explicit upgrade described
above; no synthetic element ID or ephemeral track becomes authored project data.

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

**Internal scope decision accepted 2026-09-08:** the orchestrator approved the six
generic families with explicit platform-dependent status and unknown named fonts
unavailable until an explicit persisted generic fallback. A bundled custom-font
catalog is not required for this issue. Actual main/worker/export parity remains
mandatory before font acceptance closes; the status badge alone is not proof.
Legacy generic intent and pixels remain unchanged. No font bytes, dependency or
remote service is added by this decision.

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
| 1–16 elements; 80-character element/template names; 256-character IDs; 128-character property/font names | Check array/string sizes before mapping, measuring or allocating. IDs unique project-wide; semantic element/property targets unique regardless of version. |
| 20,000 text characters/element; 80,000 total title content characters; 1 MiB serialized UTF-8/title including its tracks | Retain the complete existing per-element allowance. All independent limits must pass; no truncation. |
| 100,000 total logical elements across every sequence; existing 10,000,000 project text-character and serialized-character ceilings remain | Each compact legacy text clip counts as one logical element without allocating an element record. Dormant/hidden/disabled elements still count. Save/recovery and every live candidate use the same counters. |
| 256 title tracks/clip; existing 1,024 keys/track and 100,000 project keys | Include unsupported versions, dangling targets, disabled elements and all sequences. All clone/split/paste/template/roll operations preflight growth. |
| 4,096 expanded visible title elements/frame | Pure composition-cost preflight includes nested instance multiplicity before layout; this accommodates the existing 4,096-leaf legacy ceiling. No per-frame graph expansion stored in history. |
| Text geometry/style ranges in the property table; static padding 0…1,024, positive inner box; static anchor/crop/flip unchanged | Checked before layout, including all key envelopes. Hex colors only; shapes are bounded primitives. No canvas sized from an element box. |
| 512 rendered lines/element; 64 layout entries/context and at most 8 MiB conservative retained string storage/context | Bounded derived cache, clear on owner/font replacement. Reuse the existing project-sized leg/group surfaces; zero per-element canvases. |
| 64 MiB conservative retained expanded-title payload/track data | Count new title data in current project, past/future snapshots and app element/title/key clipboards by immutable owned references, including dormant sequences. Validate before clearing redo. Reject growth with a reason; never prune history silently. Compact legacy text retains its existing file/text/history bounds rather than acquiring a new upgrade-only quota. Existing cap of 100 snapshots in each history branch remains. |
| 100 local user templates; 1 MiB/template; 8 MiB/library | Includes raw unsupported siblings. Capture and use apply both library and destination bounds; maximum additional retained library allowance is separate and explicit. |
| Opaque future title: depth 8, 4,096 entries, same aggregate string/byte caps | Bounded non-executing JSON only; supported versions validate exact keys. No getter/prototype traversal of untrusted runtime objects. |

The 64 MiB retained-data figure is a conservative serialized-data admission
measure, not total JS/browser memory. It needs a pure bounded size walker and
reference-aware snapshot accounting, modeled on existing LUT retention. Immutable
unchanged elements/tracks are shared; gestures keep one disposable draft and one
commit. The supported compact legacy representation avoids mandatory envelope
overhead; only an explicit upgrade can introduce it, after the exact size
preflight above. Existing legacy history remains governed by the unchanged
100 snapshots per history branch and existing file/text bounds. Do not present the expanded-title quota as a total
browser-memory bound, or use it to force an old clip into the new representation.

## Implementation gates and ownership

Each gate is a local commit with an exact message file, Aryel author and Codex
co-author. Update `docs/evidence/issue200/` and the orchestration report each turn.
Orchestrator owns HANDOFF/PLAN consolidation, shared schema assignment, review,
integration, remote publication and issue closure.

1. **G0 — amended plan/contract review.** Commit planning/evidence only. #199
   reviews semantic target uniqueness, field mapping, fixed-local ticks, helper
   preservation and omission of unused compatibility metadata. Font scope and
   migration order are now assigned. Stop before product code until approval.
2. **G1a — independent pure title foundation.** After approval, implement only
   `domain/titleElements.ts` types, bounds, validation and property spec/read/apply
   adapters with focused tests. No Clip, store, migration, renderer or UI edits.
   Commit this module for orchestrator review and sharing with #199. Its shared
   animation foundation then lands as timeline 22.
   **Approved at `381836f`:** bounded title/element readers, explicit font
   resolution and the 13 scalar spec/read/atomic-apply adapters. Focused tests,
   architecture checks, build and lint pass; see the linked G1a evidence.
   Authorized independent completion adds title-plus-track payload sizing and
   reference-aware retained-data admission, with exact 1 MiB/64 MiB fixtures.
   Review corrections preserve 100 snapshots in each history branch and reuse
   nested immutable subtree summaries, with deterministic traversal-count proof.
   This is pure foundation work, not approval to enter a new product phase.
3. **G1b — title ownership, compatibility and upgrade.** After the shared
   foundation is approved, add title-owner schema 23 with retained `Clip.text`,
   explicit upgrade, serialization/clone/source/media-owner checks, identity
   allocation/remapping and all-sequence/retained budgets. Run the exact boundary
   fixtures against the real parser/serializer/store, plus adversarial,
   round-trip, split/trim/history checks. No unsupported future data loss.
   **Implementation for review:** actual title-plus-track ownership, explicit
   compact upgrade, version-only migration, project-wide identity remapping and
   real file/recovery/history boundaries are implemented. Whole future definition
   copies refuse unknown identity semantics; future elements retain known headers.
   See schema23 evidence for final validation and the remaining G3 template
   capture criterion; this gate does not claim renderer/UI completion.
4. **G2 — shared rendering and parity.** Resolve scalar elements in the canonical
   plan; paint ordered elements into one existing isolated leg. Implement strict
   title font status in preview/export owners and cache invalidation. Pass the
   legacy zero-difference gate, caption canaries, multi-element/raw export parity,
   effect/blend/scale/sequence cases and cleanup/capacity checks before UI polish.
5. **G3 — authoring, templates and generated motion.** Accessible element list,
   numeric Inspector and direct manipulation, add/delete/reorder, safe guides,
   template library/capture/instantiate, explicit fallback, roll/crawl preview and
   one-commit Apply. Pin project generation/sequence/selection while a dialog is
   open; a raced/locked/changed owner rejects without history. Integrate #199's
   shared dope sheet/property controls without inventing animation state.
6. **G4 — complete acceptance on the committed implementation.** Focused/full
   tests, build/typecheck, lint, production audit, architecture/diff checks and
   real muted headless Chromium on port 5200. Reserve the orchestrator's exclusive
   slot for full suites and browser/export gates. Root owns the final combined
   engineering run. No standalone title timing benchmark is required; existing
   budget/renderer evidence and #199's mixed playback/export gate cover that scope
   unless an actual regression warrants more.
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
| Existing text migrates identically and stays editable | Compact compatibility survives schema updates without title expansion; exact-limit save/edit/undo/recovery; same-runtime zero-RGBA-difference for legacy and explicit upgrade; original generic intent preserved. |
| Hostile budgets reject before layout/surface allocation | Unknown keys/versions, duplicate IDs/tuples, excessive arrays/depth/strings/elements, invalid font/color/shape/numbers, coupled box envelopes; allocation spies stay at zero on reject. |
| Local templates are safe/fresh/editable | Built-ins plus capture/use/delete; IDs disjoint across duplicate/split/paste/sequence/template; atomic quota/future-envelope behavior; no source network request or executable path. |
| Roll/crawl/animated properties use exact frames everywhere | Every property at boundary/interior frames and all easing modes; arbitrary nonsequential seeks equal sequential playback/export; trim/split/extend/reapply preserve manual edits. |
| Deterministic or visibly unavailable fonts/layout | Approved generic compatibility mode, actual main/worker/export proof, missing/unknown/fallback and reopen tests; cross-platform qualification stated honestly. |
| Accessibility and responsive editing | Keyboard element selection/order/add/delete, labeled numeric alternatives, focus return/trap/Escape, accessible status, safe-area labels and contrast; title controls and dialogs remain reachable/readable at 1280×720 and 720×800. Record surrounding workspace clipping separately for root disposition. |
| Real Chromium flow and cleanup | Legacy title, multiple coordinated elements, user template create/use, roll/crawl, #199 keys, missing-font explicit fallback, save/reopen, export raw pixels/reopen, cancel/dispose/retry and clean console. |
| Full engineering gates | Exact commit provenance, focused/full result separation, build/typecheck, lint, audit, diff and production graph exclusion of any evidence-only harness. |

G1a completion supplies the pure contract for shared-foundation review. It does
not complete any unchecked product acceptance criterion in issue #200.
