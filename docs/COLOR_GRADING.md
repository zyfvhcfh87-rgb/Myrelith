# Issue #196: local SDR color grading

Status: approved on 2026-09-08; implementation in progress.
Inspected on 2026-09-07 at merged master `368bd43`, on `codex/issue196`.
Issue: [#196](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/196).

Approval covers the six implementation gates below, including the proposed
portable LUT catalog and preset migration. Successful gates proceed without
another approval round. A failed proof must retain its evidence; changing the
portable representation, color math, supported subset, or acceptance limits
requires a concrete revised proposal before that affected slice ships.

The user approved the complete plan on 2026-09-08. Gate evidence below will
distinguish implemented and verified behavior from work still pending.

## Editing workflow

Select a visual clip, adjustment, video track, or sequence master and add a
grading effect through the existing Effects browser. Choose Import LUT to
select a local `.cube`, inspect its name, size and input-domain summary, then
apply it. Importing and attaching the accepted table is one undoable edit.
Cancel, parse failure and stale selection leave the project and redo unchanged.

Curves provides Master, Red, Green and Blue tabs with a graph and a numeric
point list. Lift/Gamma/Gain provides three color wheels, channel values and a
brightness control for each wheel. All three effect types have strength,
bypass, reset, reorder and remove controls. Dragging previews temporarily;
release commits once. Numeric entry and keyboard controls offer the same edits.

Save preset captures the resolved correction at the playhead, including its
required LUT data. Applying that preset to another project makes an independent
portable correction. Existing Copy/Paste attributes continues to work.
RGB parade joins the current scope tabs if its separate performance gate passes.

The Inspector describes these as SDR adjustments to the displayed sRGB image.
A LUT file does not reliably identify its intended source encoding. The import
summary therefore asks the user to apply a LUT intended for this input; it does
not infer a camera profile, convert log footage automatically, or promise HDR.

## Verified starting constraints

| Current owner | Consequence for this issue |
| --- | --- |
| `domain/effectStack.ts`, `effectBounds.ts` | Descriptors contain primitive parameters, versioned defaults and explicit stage/capability declarations. Strings cap at 65,536 characters; arbitrary arrays are not effect parameters. |
| `domain/colorCorrection.ts`, `effectPixels.ts` | Existing five-control math and identity paths must remain exact. The actual ordered pixel executor calls each stage separately, with RGBA8 conversion at those stage boundaries. |
| `pipeline/render.ts`, `videoEffectStageExecution.ts` | Clip/text/transition, adjustment, video-bus and mixed plugin paths must receive the same new grading semantics. The plugin path already has additional transactional pixel copies. |
| `domain/projectSequences.ts`, `projectFile/` | Whole-project intent owns sequences and multicams. Current project format is 7 and timeline schema is 21. Portable JSON caps at 10,000,000 characters. |
| `state/documentStore.ts`, `domain/clipAttributes.ts` | History retains up to 100 whole-project snapshots. Copies remint effect identities and animation targets; a resource reference needs explicit copying rules. |
| `domain/effectPresets.ts`, `app/localEffectPresetStorage.ts` | Version-1 presets allow 128 KiB per preset and 2 MiB per library. They currently carry descriptors only. A complete 33-cube needs a new bounded data contract. |
| `domain/videoBusStage.ts`, `renderSurfaceBudget.ts` | Track/master stages must preserve opaque input. Readback, spatial scratch, lens source sizes and the 256 MiB render allowance already constrain combinations. |
| `workers/renderWorker/core.ts`, `video-scopes.worker.ts` | Scopes sample at most 160 by 90, at most every 250 ms, after presentation, with one pending analysis. They are session diagnostics. |

The current effect stack also deliberately keeps the historical Canvas filter
path when no ready stage requires pixels. Adding a neutral grading effect must
not accidentally switch an existing project onto a different precision path.
`docs/EFFECTS.md` needs a narrowly scoped clarification of actual stage rounding
when the new contract is integrated; changing old pixels is not that fix.

## Chosen storage design

Three concrete shapes were compared:

| Shape | Benefit | Cost and decision |
| --- | --- | --- |
| Self-contained table in every effect | Ordinary descriptor copying needs little coordination. | A 33-cube exceeds a parameter string and the preset limit. Splitting it into parameter chunks obscures validation and multiplies copies. Rejected. |
| Local file/IndexedDB reference | Small project files. | Another computer or cleared browser storage loses the look. It introduces LUT relinking into render/export. Rejected for this slice. |
| Embedded project catalog plus small effect reference | Repeated clips share one portable, immutable table. | Requires explicit project migration, catalog-aware copying and preset bundles. Recommended. |

Add `SequenceProject.colorLuts`, a bounded collection of immutable data records.
Advance project format 7 to 8 with an empty-catalog migration. Timeline schema
stays 21 because the new effects use its existing primitive descriptor shape.
Keep `builtin.color-adjust` version 1 and all its defaults unchanged.

Proposed public types and calls, with names open to ordinary implementation
refinement:

```ts
type Rgb = readonly [number, number, number]
type LutShape =
  | { readonly kind: '1d'; readonly size: number }
  | { readonly kind: '3d'; readonly size: number }

type PortableColorLutV1 = LutShape & {
  readonly version: 1
  readonly id: string
  readonly name: string
  readonly domainMin: Rgb
  readonly domainMax: Rgb
  readonly encoding: 'rgb-f64le-base64-v1'
  readonly data: string
}

type GradingTarget =
  | { readonly kind: 'clip'; readonly sequenceId: string; readonly clipId: string }
  | { readonly kind: 'adjustment'; readonly sequenceId: string; readonly adjustmentId: string }
  | { readonly kind: 'track'; readonly sequenceId: string; readonly trackId: string }
  | { readonly kind: 'master'; readonly sequenceId: string }

parseCube(text): ParsedLutResult
validateColorLutCatalog(records): CatalogValidationResult
planLutApply(project, target, table, options, idFactory): ProjectEditResult
materializeCurveChannels(params): ChannelTables
materializeWheelChannels(params): ChannelTables
```

Table entries use canonical padded base64 of little-endian binary64 RGB values.
This preserves each parsed JavaScript number without an extra float32/16
quantization. Normalize signed zero once. Reject noncanonical encoding, wrong
decoded lengths, non-finite values and invalid bounds before materialization.
Source comments and file paths do not become executable or loadable content.
The portable name is a bounded display label, not a file location.

At 33 cubed, the table has 107,811 numbers, 862,488 decoded bytes and 1,149,984
base64 characters. This size calculation is not a browser-memory measurement.

Proposed catalog limits are 16 records, 4 MiB decoded table data and 6 MiB of
serialized catalog UTF-8. The existing complete-project character limit still
applies, including assets, dormant sequences and all other intent. Import and
preset application preflight the complete candidate save, not just the table.
Current plus history and clipboard retention gets a separate 64 MiB limit for
distinct LUT payloads, conservatively counting two bytes per base64 character.
LUT-changing commands reject before exceeding it; they never silently discard
undo history. Shared immutable records count once by retained object identity.

Reuse byte-identical tables with equal shape and domain. Mint an id for changed
content; replacement never edits a table that another clip uses. Retain tables
through ordinary effect removal. An explicit remove-unused operation may remove
only tables proven unreferenced across the complete project, with one undo entry.
Unknown reference semantics prevent automatic pruning. Undo restores exact
records; source deletion, media relink and derived-cache clearing cannot remove
embedded LUT data. Recovery includes the catalog through the normal project file.

Bounded unknown effect types, versions and keys keep their order and data.
Future LUT record versions remain opaque, bounded and unavailable; no version-1
decoder interprets them. Invalid current-version table structure rejects a file
before project replacement. A bounded descriptor with a missing/incompatible
LUT reference remains preserved and visibly unavailable. Live authoring must
never create that condition. Whole-project format versions newer than supported
retain the existing refusal to open, rather than partial migration.

## Proposed LUT and pixel contract

The external format basis is Adobe's [Cube LUT Specification 1.0, mirrored
PDF](https://kono.phpage.fr/images/a/a1/Adobe-cube-lut-specification-1.0.pdf),
sections 5 to 7. It defines separate 1D/3D tables, per-channel domains, red-fastest
3D ordering, linear 1D interpolation and a tetrahedral 3D interpolation basis.
Our limits and compatibility extensions below deliberately define a smaller
profile. This is not a claim of complete `.cube` support.

| Property | Proposed version-1 policy |
| --- | --- |
| Input | One explicitly selected local file, at most 4 MiB. ASCII text; accept one UTF-8 BOM and LF or CRLF as documented extensions. Reject bare CR, NUL and other control/non-ASCII bytes. |
| Lexing | At most 250 bytes per line, 32 bytes per numeric token and 100,000 lines. Decimal/scientific notation only. Bound before splitting or allocating attacker-sized arrays. |
| Headers | Optional quoted `TITLE`, `DOMAIN_MIN`, `DOMAIN_MAX`; exactly one `LUT_1D_SIZE` or `LUT_3D_SIZE`. Case-sensitive, no repeated/unknown headers, all before samples. Blank and full comment lines are allowed, including leading spaces as an extension. No inline comments. |
| Size | 1D: 2 to 4,096 rows. 3D: integer edge 2 to 33. Exactly N or N cubed RGB rows. Never infer dimensions, resize a larger LUT or accept a partial table. |
| Domain | Default each channel to 0 through 1. Accept finite endpoints in -16 through 16, with each upper-minus-lower at least 0.000001. Normalize and clamp input to the domain; no extrapolation. |
| Samples | Exactly three finite values per row, each in -16 through 16. Preserve out-of-unit values until the declared effect clamp. |
| Interpolation | Fixed linear for 1D; fixed tetrahedral for 3D, with explicit RGB tie order. No automatic/default interpolation choice. |
| Rejection | Combined shaper-plus-3D files, Resolve input-range keywords, alternative formats, excessive sizes and unsupported syntax fail with a named reason and line where available. |

OpenColorIO's [interpolation documentation](https://opencolorio.readthedocs.io/en/v2.5.0/api/enums.html#interpolation)
also distinguishes explicit methods from defaults that may change. We pin the
method in our versioned contract and add no OCIO runtime dependency.

`builtin.cube-lut` version 1 stores `{ lutId, strength }`, with strength in
0 through 1, default 1. The selected record determines 1D versus 3D. A palette
entry opens import or offers existing project tables; it does not append a
dangling default descriptor. Reset preserves the selected table, resets strength
and clears that effect's animation. Choose/replace LUT is a separate command.

The pure oracle maps normalized RGB through the table, then evaluates
`input + strength * (mapped - input)`. It clamps to 0 through 1 and rounds to
RGBA8 at the existing descriptor boundary. Tetrahedral fixtures cover all six
fraction orderings, equal-fraction ties, cube corners and domain endpoints.
There is no nearest-neighbor fallback, shader substitution or hidden resampling.

All grading uses straight, nonlinear display-referred sRGB RGB, float64 math
and unchanged alpha. New grading leaves fully transparent RGB bytes unchanged;
it processes partial-alpha RGB as straight values. Existing effects retain their
own historical transparent-pixel behavior. No premultiplication enters the
grading oracle. Canvas premultiplication/readback tolerance is tested separately.

Empty, bypassed, zero-strength and mathematically neutral paths emit no pixel
operation and require no new pixel capability. A canonical identity LUT over
the unit domain is detected from its actual entries, never its filename/title.
With no active new grading, old filter/pixel selection stays byte-identical.

## Curves and wheels

`builtin.rgb-curves` version 1 stores four bounded canonical point strings and
strength. Each string represents 2 to 16 `[x,y]` points, at most 2,048 characters.
Coordinates are finite in 0 through 1, x increases strictly with a minimum gap
of 1/4,096, and endpoint x values are exactly 0 and 1. Endpoint y remains editable.
Duplicate, crossing and excess points reject; the parser does not silently sort
or merge imported intent. All four defaults are `[[0,0],[1,1]]`.

Use a fixed shape-preserving piecewise cubic Hermite interpolation, with local
extrema and zero slopes handled explicitly. Two-point curves are linear. Gate 1
freezes the slope/endpoint equations and independent fixtures before registration.
For each channel, apply Master first and then that channel's curve, without
rounding between them. Mix by strength, clamp and quantize once for the descriptor.
One pure materializer builds three 256-entry byte lookup tables for the current
8-bit input domain. The graph, reference math and runtime use that same authority.
Control points remain static in version 1; strength is the safe animated parameter.

`builtin.lift-gamma-gain` version 1 stores nine scalars and strength. Lift R/G/B
range from -1 to 1, default 0. Gamma R/G/B range from 0.25 to 4, default 1.
Gain R/G/B range from 0 to 4, default 1. Strength ranges from 0 to 1, default 1.
For each straight normalized channel `c`, the proposed exact order is:

```text
u = gain * (c + lift * (1 - c))
graded = max(0, u) ** (1 / gamma)
result = round(255 * clamp01(c + strength * (graded - c)))
```

This is Myrelith's SDR wheel contract. It does not claim numerical compatibility
with another NLE. [Kdenlive's wheel documentation](https://docs.kdenlive.org/en/effects_and_filters/video_effects/color_image_correction/lift_gamma_gain.html)
informs the user-facing shadows/midtones/highlights layout, not our formula.

Each wheel edits its three channels atomically. A pure mapping converts a hue
plane displacement `(x,y)` to RGB offsets proportional to
`(x, -x/2 + sqrt(3)*y/2, -x/2 - sqrt(3)*y/2)`. Preserve the current channel mean;
shorten the displacement uniformly at the channel bounds. Its brightness control
adds a common bounded channel offset. Numeric R/G/B entry remains authoritative,
including off-center values. Freeze scale, inverse projection and keyboard steps
in Gate 1 so UI and numeric edits cannot develop different semantics.

Wheels also materialize three 256-entry byte tables. All nine channel scalars
and strength use the existing effect animation authority where supported.
Clip-local integer frames, retiming, split identities and source-time intent
remain canonical. Adjustment animation follows its existing contract; text and
track/master effects remain static. Curves do not introduce point animation,
and LUT selection, table contents and interpolation are not keyframeable.

All three types preserve opaque input and can declare source-layer and
post-composite eligibility after proof. Reordering changes authored evaluation
order. Never collapse corrections across masks, chroma keys, plugins or other
stages, or combine descriptors in a way that removes a rounding boundary.

## Ownership and integration

| Owner | Responsibility |
| --- | --- |
| New `domain/colorLut.ts`, `colorCurves.ts`, `colorWheels.ts` | Strict data contracts, parsers, validation, identity detection, interpolation and independent-testable pure materialization. No Files, storage or workers. |
| Existing registry, effect budgets, animation and project operations | One parameter/capability authority; fresh ids; catalog reference validation; atomic edits and complete project budgets. Keep primitive effect parameters. |
| New app LUT import controller and disposable import worker | One active local selection, File/byte ownership, bounded read/parse, cancellation and currentness. The app publishes only serializable progress/summary facts. |
| Existing document/persistence/recovery owners | Commit descriptor plus catalog once; serialize format 8; share immutable table records through ordinary edits; check retained LUT payload bounds. |
| Shared pipeline grading runtime | Resolve admitted immutable catalog data, own decoded lookup tables and yield between bounded pixel chunks. Preview worker and each export have separate runtime owners. |
| Existing composition planners/bridge | Pass small LUT identities in frame plans. Send catalog data once per changed catalog generation, not per clip or playhead tick. Include child sequences and static video buses. |
| Inspector and scope UI | Render state, numeric/keyboard editing and app commands. Never decode LUTs, load resources or invent effect/capability rules in `.tsx`. |

The common import flow is selection, bounded parse, temporary summary, Apply,
fresh project/sequence/target/lock/budget check, one project commit, worker release.
Pin the project generation, original target and its relevant version throughout.
Project replacement, a competing import, dialog close or cancellation invalidates
the pending result. The parser worker has a five-second terminal deadline;
termination precedes admission release, and late reads/results remain observed.
Raw source bytes are discarded after canonical data transfers or on any failure.
There is no persistent raw-file cache, external reference, fetch or upload path.

Extend the existing registry/planning context with a pure catalog lookup. Both
status resolution and pixel execution must consult the same validated catalog.
The runtime cache identity binds the project generation, immutable table identity,
validated content and evaluator version. It cannot trust a reused id alone.
Admit at most 2 MiB of decoded/materialized lookup buffers and 256 entries per
render owner, counting pending materialization inside that limit. Evict before
allocating a replacement. Disposal and stale generations release every entry.
Parsed project/preset strings and temporary import bytes are accounted separately.

Grading borrows the current ImageData and isolation surfaces. Curve/wheel tables
add no full-frame scratch. Count the existing plugin transaction copies, readback,
spatial scratch, lens source surfaces and retained LUT tables before allocation.
Use the existing render and optional-media admission authorities. A valid project
can still have an unavailable combination at 4K; display the concrete reason.

The new shared asynchronous grading adapter calls the same pure pixel functions
in bounded row chunks. Yield to a task at most every 4,096 pixels or eight ms,
and recheck cancellation/currentness before publishing. A synchronous loop that
only inspects an AbortSignal cannot process a worker cancellation message.
Do not change the old no-grading path or introduce a second pixel algorithm.
Partial work stays on unpublished scratch. Export cancellation aborts the output;
preview supersession cannot display a stale partially graded frame.

Preserved unsupported grading is visibly bypassed in preview. Enabled grading
that cannot execute blocks export with a named reason; explicit authored bypass
permits export. Do not broaden this into a migration of unrelated old effect
failure policies. Context/readback loss releases the affected runtime, rejects
pending work and permits retry only with a fresh owner.

## Presets and RGB parade

Reuse the existing local preset controller/storage rather than adding a second
grading library. Version 2 bundles ordinary static descriptors with the exact
embedded LUT records they reference. Proposed limits are 100 presets, 32 effects
each, 2 MiB serialized per preset and 8 MiB per library, including all table data
and preserved invalid siblings. These larger limits require quota, parsing and
memory tests before migration ships. Oversized saves fail with an explanation.

Version 1 migrates transactionally with empty LUT bundles; retain bounded corrupt
and unrecognized sibling values. Unsupported future envelopes stay read-only.
Rename/delete/write failure must preserve existing records and never report an
uncommitted success. Applying a bundle validates all references, deduplicates
tables, remints effect ids and commits once in the destination project. Deleting
a library preset cannot change an already-applied correction. Capture resolved
static parameters only; use Copy/Paste attributes for animation. Keep preset-file
exchange, online catalogs and executable/trust payloads outside this slice.

Add small first-party numeric correction recipes only after defaults are frozen.
Do not bundle third-party LUTs. A preset with missing or invalid required LUT data
is unavailable, never partially applied as an apparently successful correction.

RGB parade uses the existing post-presentation 160-by-90 sample, one pending job
and 4 Hz ceiling. Its three 160-by-64 Uint16 density planes add exactly 61,440
result bytes; all four existing histogram planes, waveform and vectorscope plus
parade total 92,160 bytes. Bound sample plus result payload below 160 KiB.
Ignore zero alpha and use the existing alpha-over-black displayed-channel rule.
Scope mode/layout stays session-only and uses one responsive visible canvas.
Update the internal opt-in WebGPU scope path to return complete parade results
or explicitly select the CPU analyzer; an old-shaped result is not a success.

## Ordered implementation gates

1. **Pure contracts and proof.** Freeze parser/profile, portable encoding, curve
   slopes, wheel mapping, defaults, identity and stage rounding. Build fixtures
   and the bounded CPU reference/materializers outside production registration.
   Prove malformed/hostile cases, asymmetric LUT axes, all interpolation regions,
   transparent/partial alpha, endpoints and every 8-bit channel for identity.
2. **Portable LUT ownership.** Implement catalog, format-8 migration, whole-file
   and retained-history bounds, import worker lifecycle, catalog references and
   atomic store operations. Cover save/reopen/recovery, copying, sequence cloning,
   compound/multicam use, removal, locks, stale targets and redo preservation.
3. **Shared execution and resource proof.** Add registry stages and the same
   grading path to clip/text/transition, adjustments, nested track/master and
   trusted-plugin composition. Prove resource admission, cancellation, cache
   invalidation, context loss and the timing matrix below before exposing UI.
4. **Accessible editing.** Add LUT import/reuse summary, curve graph/point list,
   wheels/numeric entry and safe animation. Reuse reset/bypass/reorder and
   snapshot-guarded gestures. Verify keyboard, focus, undo/redo and narrow layouts.
5. **Reusable corrections and scopes.** Migrate local presets and add stable
   numeric recipes. Prove portable LUT bundles and the RGB parade gate. A failed
   optional parade gate retains the existing scopes and records the failure.
6. **Complete acceptance.** Run focused/full Vitest and all runner checks,
   production build/typecheck, lint, production audit and diff checks. Run muted
   headless Chromium and in-app visual checks, record exact evidence, update the
   architecture/effects/handoff docs and commit with the repository author rule.

Each logical gate gets its relevant tests, build and lint before the next gate.
User-observable gates also need Chromium verification. No standalone Chrome
windows or audible test fixtures. GitHub publication and merge are separate
actions; this plan does not post comments, publish or close the issue.

## Preregistered performance and acceptance

Use deterministic asymmetric RGB ramps, neutral ramps, saturated patches,
transparent borders and partial alpha at 1280 by 720, 1920 by 1080 and 3840 by
2160. Include minimum/maximum table sizes, extreme domains, representative and
maximum curve/wheel settings, eight mixed/repeated stages, 256 stored descriptors,
animated parameters, nested buses, lens/mask/chroma and a real trusted plugin.
Label old-effect baseline fixtures separately from the new-effect matrix.

Use two warmups and at least ten measured samples per admitted cell. Record all
samples, source revision, Node/browser version and available host/GPU provenance.
The initial CPU ceilings reuse #197's bounded-preview/offline-export gate:

| Raster | Single grading stage p95 | Eight grading stages p95 |
| --- | ---: | ---: |
| 720p | 40 ms | 320 ms |
| 1080p | 90 ms | 720 ms |
| 4K | 360 ms | 2,880 ms |

Include complete grading evaluation and chunk/yield overhead; report cold parse,
materialization, Canvas readback and full frame presentation separately. These
limits are proposals, not measured results or real-time 4K playback promises.
Admit at most 134,217,728 new-grading pixel-stage visits per requested composite,
including all expanded nested scopes. Over-budget work fails visibly before
painting; stored intent remains intact. This bound does not reclassify unrelated
old effects as new grading work.

Cancellation must settle within 250 ms of a delivered request in the measured
matrix. Exercise cancellation during read, parse, materialization, 4K work,
plugin awaits and export finalization. Repeated teardown/retry must leave zero
owned grading workers/buffers/requests, verified separately from opaque browser
native-memory claims. No full-frame scratch per grading descriptor.

RGB parade qualification needs p95 sample/readback, analysis and UI painting
each at most eight ms. In paired playback, its additional p95 Program frame time
must be no more than the larger of two ms or 10 percent of the no-parade baseline.
Verify one pending request, stale-generation suppression, disable/re-enable and
close cleanup. Failure keeps parade unadvertised pending a revised measured plan.

The pure fixtures require byte-exact channel tables, alpha and stage order.
Preview and export using the same snapshot, frame and raster must match exactly
before encoding. Direct Canvas/oracle comparison allows at most two RGB code
values from premultiplication roundtrips; alpha must match its separate exact
contract. Encoded export uses a declared codec-specific tolerance, set before the
run, and cannot substitute for pre-encode equality. Scaled preview is compared at
the same raster; LUT processing and downsampling need not commute.

Real Chromium acceptance includes successful 1D and 33-cube import, rejection
without mutation, curves, wheel drag and numeric equivalence, all stack actions,
safe keys, presets across a fresh project, save/reopen with source LUT deleted,
recovery/relink, nested/adjustment/bus scope order, original-media export, failure
status, cancellation and context loss. Verify keyboard-only use and Inspector
fit at desktop and 1280-by-720, plus the existing narrow editor layout. Every
browser run checks unexpected warnings/errors and terminal cleanup.

## Initial checks and honest limits

No production source has changed in this planning turn. On base `368bd43`:

- Eight focused Vitest files pass all 70 tests: registry, effect bounds, existing
  color math, presets, scopes, video buses, plugin stage planning and execution.
- All 17 repository runner checks pass with
  `DEVELOPER_DIR=/Library/Developer/CommandLineTools`.
- `npm run build` passes typecheck and production build, 4,994 modules. It emits
  the existing chunk-size warning. `npm run lint` passes.
- The first runner invocation passed 15/17 because its two temporary Git-repo
  tests hit the host Xcode license prompt. The rerun uses already-installed
  Command Line Tools; no license agreement or global developer setting changed.
- Node is 26.8.1. Focused Vitest uses
  `NODE_OPTIONS=--no-experimental-webstorage`, matching the documented jsdom setup.
- Full Vitest, Chromium grading acceptance, performance measurements and a fresh
  production audit have not run in this planning turn. #197's historical full
  results and browser baseline failures are not claimed as current #196 passes.

Reproduce the focused base checks from the repository root:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools \
NODE_OPTIONS=--no-experimental-webstorage npm test -- \
  src/domain/effectStack.test.ts src/domain/effectBounds.test.ts \
  src/domain/colorCorrection.test.ts src/domain/effectPresets.test.ts \
  src/domain/videoScopes.test.ts src/domain/videoBusEffects.test.ts \
  src/domain/pluginVideoEffectStagePlan.test.ts \
  src/pipeline/videoEffectStageExecution.test.ts
npm run build
npm run lint
```

`npm test` includes the 17 runner checks after Vitest. The successful runner-only
retry used `DEVELOPER_DIR=/Library/Developer/CommandLineTools node --test
scripts/performance/run-benchmark.test.mjs`.

The main risks to resolve early are catalog retention through history/copying,
the primitive-descriptor/catalog lookup boundary, deterministic curve/wheel
materialization, and existing plugin/lens memory at 4K. Gate failures can narrow
support only with recorded evidence and the review boundary stated above.

## Gate 1 evidence, 2026-09-08

The pure LUT parser/encoding/interpolator, curve materializer and wheel math
are implemented without production effect registration. 61 grading cases plus
seven architecture cases and all 17 runner checks pass. Build/typecheck and lint
pass. There is no new observable browser behavior at this gate.

Curve slopes use the weighted harmonic PCHIP interior rule and sign-limited
one-sided endpoint rule, as documented by [SciPy's PCHIP reference](https://docs.scipy.org/doc/scipy/reference/generated/scipy.interpolate.PchipInterpolator.html).
Zero or opposite-sign adjacent secants produce a zero interior derivative.
The endpoint candidate is `((2*h0+h1)*d0-h0*d1)/(h0+h1)`; reject its opposite
sign and limit it to `3*d0` when neighboring secants disagree. Evaluate with
the standard cubic Hermite basis. Hand-calculated 0.078125 and 0.546875 midpoint
fixtures, extrema/flat/decreasing segments and full 8-bit maps pass.

Wheel scale is two thirds of each group's numeric range, so all valid numeric
triplets project inside the unit hue disc. Pointer position projects radially
onto that disc, then shortens uniformly at channel limits while retaining the
mean. Brightness applies one common bounded offset. Keyboard movement will use
0.01 normalized position steps and 0.1 with Shift; Home centers chroma.
The two-point curve and wheel defaults are exact identity for all 256 inputs.

The first build caught an unused test callback variable, and lint flagged a
control-character regex. Both were corrected before recording this gate.
No acceptance threshold or approved pixel formula changed.
