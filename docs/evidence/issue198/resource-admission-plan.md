# Remaining actual resource-admission matrix: preparation for review

Status: **proposed native matrix with tested source-only geometry fixtures**.
No new native matrix, browser, encoder or production build has run. The accepted
180-cell raster result and complete immutable diagnostic remain separate
evidence. Product and architecture stay frozen at `d9759917`.

## Geometry that reaches the actual boundary

The sixteen fixed rows in
`scripts/issue198/resourceAdmissionFixtures.ts` are prepared for an eventual
native runner. They use valid 8-cubic paths and canonical clipped bounds, not
invented retained-byte counters. Output is 3840×2160, feather 0.05, frame 0 of
the original 256-held-key fixture. No quality reduction or descriptor rewrite.

For output pixels P, clipped mask pixels A and lens source pixels S, the plain
shared-mask ledger is `20P + 5A + 8S` bytes for preview; finite-export use adds
`4P`. The first 16P is the canonical four-surface compositor reserve, 4P is
mask readback, and 5A is the mask's inside/distance scratch. S is zero without
lens surfaces. These are canonical logical ownership units, not process RSS.

| Mask bounds | Lens source | Preview bytes | Export-use bytes | Expected admission |
| --- | --- | ---: | ---: | --- |
| 3840×2160 | None | 207,360,000 | 240,537,600 | Both allowed |
| 3840×2160 | 1920×1080 | 223,948,800 | 257,126,400 | Both allowed |
| 3840×2160 | 3840×2160 | 273,715,200 | 306,892,800 | Both refused |
| 960×540 | None | 168,480,000 | 201,657,600 | Both allowed |
| 960×540 | 1920×1080 | 185,068,800 | 218,246,400 | Both allowed |
| 960×540 | 3840×2160 | 234,835,200 | 268,012,800 | Both allowed |

Four further rows realize exact boundaries using image dimensions:

| Use | Mask bounds | Lens source | Total bytes | Expected |
| --- | --- | --- | ---: | --- |
| Preview | 3840×2160 | 3224×2368 | 268,435,456 | Allowed |
| Preview | 3827×2159 | 4673×1638 | 268,435,457 | Refused |
| Export | 3840×2160 | 1946×1792 | 268,435,456 | Allowed |
| Export | 3819×2159 | 4039×871 | 268,435,457 | Refused |

The adjacent totals come from two different representable geometries; the plan
does not pretend that increasing one RGBA pixel allocates one byte. Canonical
`maskPixelWork`, the actual frame planner and `videoPixelWorkBudget` confirm the
exact bounds and totals. Tests also call the real lens reservation/remap
provider with a clearly labelled recording backend: refused rows never reach
its render entry, and releasing a frame permits the next reservation.
**17 focused checks pass** (sixteen rows plus manifest validation). They create
no surface-sized arrays, canvases, WebGL contexts, servers or decoded media;
this is meaningful source evidence, not native allocation evidence.
Isolated TypeScript and scoped oxlint also pass. The original three source-check
logs and exact fixture hashes are preserved in
[admission-geometry-source-checks.json](admission-geometry-source-checks.json).
No production build or broader test suite is implied by these focused checks.

## Proposed coverage: 30 scenarios, at most 38 composite attempts

Run two independently granted segments, each using a fresh owned process,
browser and output directory. Segment 2D has fifteen scenarios, at most eighteen
composite attempts; segment Lens has fifteen scenarios, at most twenty attempts.
There is no Cartesian expansion or automatic repeat. Each source checkpoint
must include the complete ordered scenario manifest and independently computed
expected totals before native execution is requested.

| Scenarios | Required native behavior |
| --- | --- |
| G01–G16: the sixteen geometry rows above | Actual compositor/presentation profile and, where applicable, production lens provider/backend. Export-use means the real compositor's export-readback admission flag; it does not construct an encoder. |
| S01–S06: mask→outline and outline→mask, each with no grading, grading in the same stack, or grading in a sibling stack | Preserve the actual shared versus isolated lifetime. Width-32 outline scratch is 810,372 bytes at 4K. A prior mask adds that scratch while retained; the reverse order takes the peak. Only grading in the same stack selects isolated built-ins; the 2 MiB grading reservation remains separate. |
| P01–P02: two sequential identity plugin stages, preview/export use | Use real ordered stage execution and a deterministic local executor at the public seam. Verify each actual request/result is wiped before the next stage and after completion. Preview is allowed at 265,420,800 bytes; export-use is refused at 298,598,400 before source/provider/readback work. This does not independently qualify third-party plugin RPC transport. |
| N01: two masked child clips reached through a two-level sequence graph | Use the actual project planner's flattened items, both source requests and actual compositor. Independent sequential mask stacks take the peak, not the sum; no child scope may disappear from admission. |
| L01: source growth/shrink inside one frame, then one later frame | Small clipped mask; real source remaps 1920×1080→3840×2160→1920×1080. The active reservation retains the high-water obligation until release; the next frame uses actual remaining backend storage. Maximum two composite attempts. |
| L02: lens intent removed while old storage remains | Populate the real backend with the admitted clipped 4K source. A following full mask with lens intent removed must still count retained lens bytes and refuse before fresh frame work. Dispose that owner; the same full mask then succeeds without lens. Three attempts. |
| L03: grading cache retained into a later plain-mask frame | Populate actual grading/cache and lens storage using an admitted clipped scene. The exact-cap full-mask case must count the nonzero real retained cache and refuse; disposing grading allows the same otherwise-exact-cap scene. Three attempts. No fabricated retained byte count. |
| C01: cancellation while a plugin response is pending, followed by one explicit retry | Use the actual compositor/stage owner with a controlled deferred response. Cancellation must settle borrowed inputs and wipe any late result before a fresh retry succeeds. Two attempts; first failure remains recorded. |
| W01: real render-worker profile change while a composite is borrowed | Start portrait 2160×3840, hold a plugin response, supersede with landscape 3840×2160 and settle cleanup before replacement presentation. Then close the worker and prove a clean new owner can render. At most three attempts. Use existing typed worker/bridge APIs and telemetry; no substitute worker. |

The 2D segment contains four no-lens geometry rows, S01–S06, P01–P02, N01,
C01 and W01. The Lens segment contains twelve lens geometry rows and L01–L03.
The source-only fixture module currently supplies **G01–G16 only**; the other
fourteen scenario factories and the native driver still require implementation
and exact-source review. The table is a preparation plan, not a claim that
those scenarios have already been implemented or measured.

## Native observation and refusal boundaries

Use real OffscreenCanvas contexts, real ImageBitmap source owners and the
actual compositor. Lens rows construct the unchanged production
`WebGl2LensRemapBackend`. Wrap only owned public interfaces to count source
requests, transition-provider gets, effect readback/put, pending plugin work,
source-image release, backend render entries/retained bytes and grading ledgers.
Do not monkeypatch global typed-array or canvas allocation or alter a production
budget to force a case through. Static source images may be generated directly
as bounded canvases; no source video encoding is needed.

Use the accepted raster fixture's deterministic source pattern at each actual
source width: `i = x + y * sourceWidth`, `R = i % 251`, `G = (7 * i) % 253`,
`B = 173`, `A = 255`. Cap caller-owned verification RGBA arrays at 64 MiB:
two full 3840×2160 arrays occupy 66,355,200 bytes. Source construction must
release its array after creating the native source and before output/reference
arrays coexist. Generate the static reference in place from the same pattern.
Native source bitmap/canvas extents remain separate owners. Canonical mask
scratch (up to 41,472,000 bytes), spatial scratch (810,372 bytes here), and
grading cache (up to 2,097,152 bytes) are separately recorded; the verification
array cap does not cover those production allocations.

Distinguish early frame refusal from later new-source-size refusal. Early frame
refusal must precede source fetch, scratch provider and effect readback. When
new lens dimensions first become known, one borrowed source may already exist;
that refusal must precede backend rendering/resizing and effect readback, with
retained backend bytes unchanged. Do not call both outcomes zero-allocation.
Pre-existing tiny constructor surfaces and source owners are recorded separately.

Allowed rows must draw the expected plan/source IDs with no missing inputs or
console errors, record complete output hashes and actual surface extents, and
release all owned work before the next row. No-lens mask pixels retain the
accepted static-reference contract; lens correctness continues to use the
existing lens-owner contract, not a new tolerance invented for this matrix.
Where only a logical component or internal lifetime is observable, label it
as such. Existing small metrics tests and raster evidence prove mask/spatial
scratch formulas; process RSS cannot independently identify those arrays.
Existing worker tests prove exact setter ordering; native W01 must prove the
borrow/cleanup/presentation lifecycle without claiming a sampled native peak is
an observation of every transient resize.

Capability is a real gate. The production lens backend requests WebGL2 with
`failIfMajorPerformanceCaveat: true`; the recorded headless environment has
reported software rendering. Do not disable that production requirement, force
another backend or label recording-double checks as native passes. If the
unchanged backend cannot initialize or exposes insufficient texture dimensions,
record the Lens segment as capability-blocked and stop it. The separately
completed 2D segment remains usable evidence. Parent review chooses any later
qualified environment; no environment switch or retry is automatic.

## Bounds, evidence and source review

Propose a 150-second browser work ceiling and 180-second host evaluation ceiling
per segment, plus existing separate setup/cleanup deadlines. Keep the accepted
10-second post-return 4K raster ceiling and preregister bounded asynchronous
composite/worker waits; a host case timeout must terminate a synchronous hang.
The manifest caps composite attempts at 18/20 respectively and public source
requests at 64 per segment, claimed before dispatch. Refused/capability-blocked
rows may complete less work; extra unlisted composites or retries are forbidden.

Use the bounded evidence wrapper: record deadline 5 seconds, final closure
10 seconds and bounded stdout partial receipts. At most 2,048 numbered 2 MiB
records per segment, with terminal slots reserved; retain original failures and
exact manifests. Sample native process memory separately with explicit missing
fields, no forced GC and no whole-browser-memory interpretation of the 256 MiB
render ledger. Persist owned process identities and verify all PIDs/port 5198
released after every segment; the parent independently confirms release.

Before launch, source review must prove the executable oracle/readback owner
cap and fixed source pattern above, and settle scenario order, source-request
counts, per-case timeout and available telemetry at the real worker boundary. Inert
tests must prove count admission, first-failure cleanup and incomplete evidence
retention, plus all expected geometry/lifetime/byte totals. Native canvas or
codec experiments are not part of this preparation. No product change is
authorized by an unmeasured or unsupported row.
