# Effect stack contract

Issue #45 establishes the durable visual-effect boundary: an ordered,
serializable descriptor stack with persistence, history, capability fallback,
and shared preview/export evaluation. Later built-ins extend that same contract
without creating parallel effect models.

## Durable descriptor

Each `Clip.effects` item contains exactly:

- `id`: globally unique stable instance identity;
- `type`: stable registry key;
- `version`: non-negative registry schema version;
- `enabled`: authored bypass state;
- `params`: bounded primitive JSON values.

Timeline schema 10 adds `version`. During 9→10 migration, the registry-owned
`builtin.color-adjust` descriptor advances from the reserved legacy version 0
to version 1 and receives missing defaults. Unknown types receive version 0.
Their type, enabled state, order, and complete parameter payload are preserved.
Current saves never substitute or delete unknown data. Timeline schema 13 adds
bounded `Clip.animation.effectTracks` addressed by stable effect id and
parameter name; schema-12 clips receive an empty list without changing their
rendering.

`domain/effectBounds.ts` is the shared authority for descriptor shape and
budgets: 256 effects per clip, 10,000 per document, 256 parameters per effect,
50,000 parameters and 10,000,000 parameter-string characters per document,
plus bounded ids/types/keys, finite numeric magnitude, and 65,536 characters
per string value. Live add/parameter edits and portable validation call this
same contract. A rejected or idempotent edit returns the original document and
does not create history, so every accepted live state remains serializable.

## Registry and failure rules

`domain/effectStack.ts` owns the registry, defaults, validation, migration,
capabilities, and ordered Canvas2D evaluation. Resolution is deterministic:

1. unknown type or version → report `unsupported`, preserve and bypass;
2. invalid registered parameters → report `invalid`, preserve and bypass;
3. missing renderer capability → report `unsupported`, preserve and bypass;
4. disabled descriptor → report `disabled`, preserve and bypass;
5. otherwise → report `ready` and emit its operation in authored order.

The render worker probes the actual Program Monitor compositor context and
reports its capability through the bridge. The app projects ordered resolution
status into session state, and the Inspector only reads that projection; it
does not assume Canvas support or run another evaluator. Export probes its own
export-owned context through the shared compositor, so preview may report
unsupported even when a separate export context supports the effect (or vice
versa). Reorder, bypass, and remove remain available for opaque descriptors, so
unsupported data is never stranded.

## Built-in color correction

Issue #71 extends `builtin.color-adjust` version 1 without a timeline-schema
bump. Existing version-1 descriptors that omit `temperature` and `tint` remain
valid and interpret both as zero; round trips preserve the omission. New and
reset descriptors write all five defaults.

| Parameter | Range | Default | Operation |
| --- | ---: | ---: | --- |
| Exposure | -4 to 4 stops | 0 | multiply RGB by `2 ** exposure` |
| Contrast | -1 to 1 | 0 | scale RGB around 0.5 by `1 + contrast` |
| Saturation | -1 to 1 | 0 | scale RGB from Rec.709 luma by `1 + saturation` |
| Temperature | -1 to 1 | 0 | red gain / blue inverse gain, `2 ** (temperature * 0.5)` |
| Tint | -1 to 1 | 0 | magenta gain `2 ** (tint * 0.125)` and green gain `2 ** (-tint * 0.25)` |

An empty stack, a wholly bypassed stack, and a descriptor with all five
defaults are exact identity paths. The historical exposure/contrast/saturation
only case retains its ordered Canvas filter path. If any ready descriptor
requires pixel access, every ready built-in stage in the chain emits one
explicit pixel command in exact authored order. Noncontiguous color adjustments
are never collapsed across a mask or key, and one stack never mixes filter and
pixel precision.

The pixel contract reads straight/unassociated 8-bit `ImageData` in the
compositor's display-referred IEC sRGB context: sRGB/Rec.709 primaries, D65
white point, and nonlinear sRGB OETF-encoded R/G/B bytes, never linear-light or
Display-P3. Alpha is an independent linearly quantized 8-bit coverage byte; RGB
is not premultiplied by it. The implementation uses float64 JavaScript
intermediates in the table order for each descriptor, clamps RGB to `[0, 1]`
after every descriptor, and rounds to nearest 8-bit only at the end. Alpha is
copied byte-for-byte. Transparent RGB is still corrected, but unchanged zero
alpha keeps it invisible. Ordinary media/stills, complete procedural-text
layers, and each crossfade leg use the existing reusable isolation surfaces;
correction happens before clip opacity, transition weighting, and destination
blend mode.

The proposed plugin-frame ABI version 1 uses that same exact byte encoding for
both input and successful output. Its future host converts the isolated
compositor layer into the ABI representation before copy-in and interprets and
converts the result identically after copy-out. Preview and export share those
boundary conversions. ICC/profile metadata never enters plugin memory.

Preview, scrub/seek, and export consume the same composition plan and
`pipeline/render.ts` implementation. A context without Canvas filter or pixel
read/write support reports the exact missing capability, preserves the
descriptor, and bypasses only the unsupported operation. No presets ship in
this slice: the five bounded defaults plus existing enable, reset, reorder, and
remove controls are sufficient and avoid an unversioned preset contract.

## Masks and chroma key

Issue #73 adds `builtin.mask` version 1 and `builtin.chroma-key` version 1.
Both are ordinary ordered descriptors in `Clip.effects`; enable, reset,
reorder, remove, history, recovery, and portable persistence use the existing
effect-stack operations.

Mask geometry is evaluated in normalized project-canvas space after the source
crop and clip transform have produced an isolated project-sized layer. `x` and
`y` are the bounding box's left and top divided by project width and height;
`width` and `height` are fractions of those dimensions. Bounds may extend
off-canvas and are clipped by the project surface. Rectangle and ellipse use
that box. Bezier masks use a closed, normalized `M x y C x1 y1 x2 y2 x y ...
Z` path with one to eight explicit cubic segments, coordinates from 0 through
1, and at most 2,048 characters. Invalid paths and parameters are preserved,
reported, and bypassed deterministically.

`feather` is a fraction of the shorter project dimension and ramps alpha inward
from the mask boundary. `invert` complements the resulting coverage. Multiple
masks multiply the current 8-bit alpha in authored order; disabled, identity,
invalid, unknown, and unsupported entries do not change pixels. Effects finish
before clip opacity, transition weighting, and destination blend/composite.
That order is shared by media, still, text, transition, preview, and export
paths.

Chroma key stores an explicit six-digit sRGB key color plus normalized
`tolerance`, `softness`, and `spill`. New descriptors default to `#00ff00`,
`0.08`, `0.12`, and `0.5`. RGB distance is normalized by the maximum sRGB
cube distance: pixels inside tolerance are fully keyed, softness applies a
deterministic smooth transition, and spill blends keyed RGB toward Rec.709
luma before alpha reduction. All three scalar controls are bounded from 0 to
1. Invalid values are preserved and bypassed.

Mask `x`, `y`, `width`, `height`, and `feather` are keyframeable for visual
media through the existing pure scalar evaluator. An effect track targets
`effectId + parameter`, carries the same integer local frame, absolute
`sourceTimeTicks`, easing, per-track keyframe limit, and global project budget
as ordinary animation, and therefore distinguishes multiple masks. Split
remints the right-hand effects and targets together; head trim, slip, and
retime preserve the same source-time semantics as clip-property tracks.
Unknown or dangling effect targets remain portable but are ignored at
evaluation. Removing an effect prunes its tracks, while Reset restores known
defaults and clears every track for that effect so keys cannot silently defeat
the reset.

The Inspector exposes labeled numeric fields, ordered effect/keyframe lists,
shape and easing selects, a color input, invert/enable toggles, and a bounded
Bezier text field. Text effects remain static because text is outside the
existing visual-media keyframe property contract. Issue #73 intentionally does
not add Program Monitor mask handles: there is no second pointer gesture or
pointer-up history claim in this slice; precise numeric/list editing is the
safe authoring surface.

## Video scopes

Scopes are session-only diagnostics over the completed preview composite; they
never enter `TimelineDoc`, history, recovery, or portable saves. The render
worker samples at most one 160 x 90 sRGB frame (14,400 pixels) every 250 ms,
after the frame has already been presented. It transfers that tiny sample to a
dedicated analysis worker, keeps at most one request pending, and never awaits
scope work from the render queue.

The worker produces 256-bin RGB/luma histograms, a 160 x 64 luma waveform, and
a 64 x 64 Rec.709 Cb/Cr vectorscope. Fully transparent samples are ignored;
partial alpha is premultiplied over black so the signal matches the displayed
preview background. Saturating 16-bit counters bound every result. Generation
checks discard disable/re-enable/close races. Disabling or closing shrinks and
releases the sample canvas, terminates the analysis worker, rejects pending
work, and clears UI data. Browsers without Canvas pixel access expose a visible
`Scopes unavailable` fallback instead of starting analysis.

## Editing and history

Pure domain operations add, enable/bypass, patch parameters, reorder, reset, and
remove descriptors. Every successful store action commits exactly one immutable
document snapshot; rejected and idempotent operations commit none. Reset changes
only registered parameters and retains unknown forward-compatible keys.

The Inspector uses native tabs, labels, checkboxes, ranges, and buttons. Arrow,
Home, and End keys move across tabs; every stack action has an explicit
screen-reader label and native keyboard activation. Add is disabled with a
visible/accessibly-associated reason whenever the selected clip or document
has no remaining effect budget.

## Proposed third-party plugin descriptors

Issue #76 reserves `plugin:<reverse-dns-plugin-id>/<contribution-id>` as the
durable namespace for future plugin effects. The descriptor remains this exact
bounded `EffectDescriptor`; projects never embed a package, URL, signature,
trust decision, permission grant, sandbox state, or executable code. On the
current tree every such type is intentionally unknown, preserved, reported as
unsupported, and bypassed. Issue #76 adds only a pure non-executing manifest
validator; no plugin registry or runtime is present.

The gated package, capability, compatibility, isolation, recovery, and failure
contract is in [PLUGINS.md](PLUGINS.md), with threats and residual risk in
[PLUGIN_THREAT_MODEL.md](PLUGIN_THREAT_MODEL.md). A future Issue #77 runtime must
retain the existing authored stack order and shared preview/export path rather
than create a second effect model.

Shared planning and pixel semantics do not permit shared mutable plugin runtime
state. Every export attempt must use a fresh export-owned worker, instance, and
memory, receive calls in deterministic frame/plan order, and be destroyed at its
terminal outcome; preview/scrub state can never enter or mutate it.

## Issue #73 review hardening

Program Monitor support status resolves animated effect parameters at the
current integer playhead through the same pure evaluator as Inspector and
rendering. The controller indexes effect-owning clips when the document changes,
then refreshes only clips with `effectTracks` on animation frames; it does not
rescan an otherwise static large timeline on every frame. Missing pixel access
uses effect-neutral preservation and bypass copy for color, chroma, and masks.

The 100,000-key portable-project limit is also a live-edit invariant. Operations
that add ordinary or effect keys, add several animated parameters at one frame,
insert an animated clip, or split and duplicate animation reject before mutation
when their positive key-count delta would cross the limit. Replacement, movement,
and removal remain available at the limit. Reset validates the merged descriptor
and aggregate replacement budgets before clearing the target's tracks, so a
rejected reset preserves both forward-compatible parameters and history.
Insert and split apply the same aggregate effect-count, parameter-count, and
effect-string authority before cloning descriptor stacks. An exact-cap growth
attempt is rejected atomically; an effectless insert or split remains legal.

Bezier coverage uses scanline parity over the clipped polygon bounds. With zero
feather it performs no distance-field work. With feather, exact segment distance
is evaluated only for inside pixels in each clipped, feather-expanded edge
neighborhood, backed by reusable region-sized `Uint8Array` and `Float32Array`
scratch. Typical work therefore tracks the covered edge neighborhoods, while the
honest maximum-feather worst case can still approach flattened edges times all
pixels in the clipped mask bounds. Ellipse feather uses a normalized, robust
nearest-boundary construction with exact circle/axis cases and a fixed maximum
of 32 bisections. Zero feather needs only the implicit inside test; outside
pixels and interior pixels whose minor-radius lower bound proves full coverage
skip the solve. This keeps project-pixel Euclidean coverage continuous at the
center of wide ellipses as well as at equal inward distances on wide and tall
axes without turning the common path into an all-pixel root solve.
