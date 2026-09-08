# Issue #202: final research decision

**No-go for promoting the managed 10-bit/HDR candidate into Myrelith.** The
research supports limited raw transport, numerical and resident-composition
operations. It also records an exact scope precision failure, an extended P3
transfer failure, a 4K preview deadline no-go on the measured configuration, and
unqualified HDR monitoring/complete metadata delivery. Those outcomes remain
separate; successful narrow experiments do not resolve failed or unknown stages.

The research deliverable is ready for orchestrator review. This is a decision
and reproducible evidence, not implementation acceptance. Existing SDR behavior,
production source, dependencies, project schema, plugin ABI and defaults remain
unchanged. No new mode, migration, encoder preset or remote child issue is added.

## The six criteria

| #202 criterion | Evidence delivered | Research disposition and remaining limits |
| --- | --- | --- |
| 1. Primary-source browser/API/codec support matrix | [Sources and measured matrix](support-matrix.md); exact requested/returned configurations; raw/storage/transfer/mux probes; saved VP9 packet/readback evidence; version-pinned Chromium source and runtime revision | **Addressed for the scoped environment.** Supported operations, measured no-go cells and unmeasured platforms are distinguished below. Safari, Firefox, other OS/GPU combinations and physical HDR remain unqualified; absence of a test is not platform impossibility. |
| 2. Every color stage, defaults and migration | [Versioned architecture proposal](../../ISSUE_202_PLAN.md), [frozen equations](equations-v1.md), source inventory and stage disposition below | **Contract proposed; product promotion no-go.** Legacy defaults/ABI are preserved. Managed scopes fail their exact precision requirement; real spatial/effect/text/plugin/sequence paths are not qualified. No schema version is reserved or migration installed. |
| 3. Independent oracle fixtures and comparisons | Independent Decimal/Fraction references frozen before candidate authorship; 118 scalar and 68 stored-view cases, retained scope failure; 40 shader cases plus 40 fresh-owner retry cases per R3 run; negative controls and structural metadata parsers | **Qualified numerical subsets, explicit failure and gaps.** Real font rasterization/filtering, independent full-size pixel comparisons, independent compressed decoding and a complete encoded HDR/mastering oracle remain unmeasured. Same-browser decoding and header-only mux fixtures are not substitutes. |
| 4. Resource/performance and lifecycle evidence | [Original R3 audit](r3-run-1-results.md), [corrected R3 evidence](r3-completed-results.md), raw samples, admission ledgers, setup cost, cancellation/context-loss/retry and teardown | **1080p resident stage passes; measured 4K preview envelope no-go.** Original finish-only preview completion stays unqualified. Full readback export-stage timings pass their narrow budgets. Full video playback/export, native memory/GPU and physical presentation remain unqualified. |
| 5. Unsupported monitor/encoder/metadata behavior | Raw/config/transfer/codec/mux results, explicit candidate rejections, preserved missing/unknown source facts and output requirements | **Explicit exclusions delivered.** No silent HDR claim or precision recovery through unchanged RGBA8 paths. Extended P3 transfer fails on the tested backend; exact unavailable encoder configurations remain unavailable; complete edited HDR10/HLG delivery and physical monitoring are not qualified. No new product rejection UI is implemented by research. |
| 6. Bounded child issues where viable | Two scoped follow-up proposals below, each with prerequisites, exclusions and acceptance gates | **Proposals delivered, not created or authorized for implementation.** Source-fact handling has a viable independent boundary. A narrowly gated 1080p managed SDR-view foundation is a candidate for further proof; full 4K/HDR rollout, compatible effects/scopes and HDR delivery are not promoted. |

## What is supported, rejected or unknown

All runtime observations concern headless Chromium 151.0.7922.34 on the
inventoried macOS/arm64 host. The corrected run records exact CDP revision
`782af9cb30a53f54487e5d2e44738645a8ec457c` and **ANGLE/SwiftShader software**.
The supplied Mac17,6 / Apple M5 Max / 64 GiB identity does not qualify native
GPU performance, process RSS or reference HDR display behavior.

| Exact operation/path | Evidence and status |
| --- | --- |
| Raw I420P10/I444P10 construction/copy | Tested layouts/tags/planes are exact; I444P10 ramp retains 1,024 levels. Supported only for those raw transport fixtures. |
| Direct sRGB/P3 float16 ImageData put/get | Tested signed/above-one values and level ramp survive. This does not qualify subsequent drawing, filtering, VideoFrame interchange or display. |
| Extended P3 canvas drawing | All four requested standard/extended source/destination combinations change pixels/alpha; requested extended mode returns standard. **No-go for unchanged extended-value transfer on this backend.** |
| Unchanged RGBA8 compositor/effects/lens/plugin ABI | The direct unorm8 storage negative control collapses 1,024 levels to 256; the source inventory confirms these production paths use eight-bit boundaries. **Cannot preserve the missing original 10-bit detail through that unchanged boundary.** Merely selecting a 10-bit encoder cannot restore it. |
| WebGL2 Float32 arithmetic/RGBA16F storage | Fixed 40-case working/view fixture and fresh-owner retry pass actual Float32 readback. This is not exhaustive spatial/full-frame correctness or a native GPU qualification. |
| VP9 profile 2 software transport | Three valid saved packets decode to I420P10 visible 1024×16 within coded 1088×16. Luma has 896 levels, 4,496/16,384 mismatches, maximum error 1 code; neutral chroma is exact. No lossy-quality GO threshold was defined. |
| Other tested encoder configurations | Exact AVC high-bit-depth, HEVC Main10 and AV1 requests return unsupported; VP9 prefer-hardware also returns unsupported. This is not a verdict on every profile/platform. Decoder configuration support alone is not decode proof. |
| Basic mux tags | Six complete SDR/PQ/HLG structural cases carry expected basic fields; two missing-transfer cases reopen with incomplete tags. These eight files have header-only synthetic VP9 prefixes, not usable encoded pictures. |
| VP9 in-band/container authority | WebM changes BT.2020 ID 5 to unknown ID 0 in three synthetic cases; MP4 preserves those prefixes. VP9 permits external signaling for unknown. Lost in-band information is observed; a displayed-color bug is not established. |
| PQ versus HLG identification | Their valid saved packet bytes are identical. Returned matching transfer tags follow supplied decoder configuration; they do not independently identify the transfer from the bitstream. |
| Complete HDR10/PQ or HLG output | Required output statistics/mastering contract, independently checked container/bitstream authority and edited delivery path are absent. **No-go for promotion of the current proposed output contract.** No claim that all future pass-through/library paths are impossible. |
| WebGPU / physical HDR / other browsers | No WebGPU adapter in the measured configuration; physical monitor calibration and other browser/OS/GPU combinations are unmeasured. They remain unsupported for a product claim, not declared universally incapable. |

The exact scope failure is retained: expected bins
`[2,2,1,0,0,0,0,0,0,0,2]` become `[1,3,1,0,0,0,0,0,0,1,1]` after binary16
storage. In particular, 99.999/100/100.001 nits collapse to 100.01318359375.
A reader of that stored image cannot recover those distinctions. No epsilon,
new expected bin or relaxed threshold was introduced. An earlier precision
branch or a new explicitly versioned scope definition requires separate proof.

## Stage contract and compatibility boundary

The following remains a reviewed research proposal. It is not serialized or
installed in the product. The full equations/conditions remain in the plan and
frozen reference artifacts rather than being inferred from encoder labels.

| Stage | Proposed authority and current qualification |
| --- | --- |
| Source interpretation | Keep bit depth, primaries, transfer, matrix, range, chroma location and alpha association independent, with provenance/explicit overrides. P3/BT.2020 primaries alone do not identify HDR. Full decode/chroma reconstruction/import integration is unqualified. |
| Transfer/primary conversion | Display-linear BT.2020/D65, one working unit = 203 cd/m²; PQ absolute luminance and HLG at declared 1,000-nit/zero-black, gamma-1.2 reference conditions. Independent scalar graphs pass; alternative viewing conditions are different transforms. |
| Storage and alpha | Straight interchange, associated linear RGB for spatial/composition work, zero-alpha managed RGB zero; proposed RGB range −64..64, alpha 0..1. Float32 shader/RGBA16F storage passes the tiny view fixture but fails exact stored scope bins. |
| Orientation, crop, transform, lens and sampling | Orientation precedes geometry; spatial operations use associated linear color/coverage. Fixed geometry/nearest-sample math exists in R1. Real lens remap, filtering and production integration are unqualified; the old RGBA8 backend is not relabeled. |
| Composition | Normal source-over and complementary integer-frame dissolve in associated working color. Scalar and tiny shader fixtures pass. Baseline shares composition topology only; legacy nonlinear and managed linear pixels are intentionally different versions. |
| Effects, LUTs and other blends | Existing SDR descriptors keep their old equations. Managed stages need explicit input/output space, association, precision, bounds and cost. Old/unknown managed stages are rejected by the lab; real managed grading/blends remain unqualified. |
| Text and coverage | Authored sRGB colors convert at declared diffuse white; glyph coverage stays separate. Fixed-mask color/alpha math is qualified; actual browser/font rasterization is not. |
| Plugins and sequences | ABI v1 stays straight nonlinear sRGB RGBA8. No silent HDR→SDR→HDR island. Managed ABI negotiation and real nested/bus paths are unqualified. Legacy nested content must retain a declared legacy rendering boundary. |
| Scopes | Pre-view luminance in cd/m² with named working/encoding semantics. Exact scope precision after binary16 storage is a recorded no-go. A post-view SDR scope must be explicitly labeled; neither repairs original lost values. |
| SDR view | Frozen technical shoulder, BT.2020→709 transform, gamut clipping and sRGB output. Qualified reference/tiny results only; not a finished artistic look, BT.2390 implementation or HDR display transform. |
| Monitoring and delivery | Verified SDR readback is separate from physical HDR. 10-bit SDR, HDR10/PQ and HLG need independent output profiles/metadata qualification. The current application export path remains legacy. |
| Proxies, caches and migration | Future cache keys must bind interpretation/render/view/output versions. Missing old project fields map to `legacy-srgb8-v1`; new ordinary projects also remain legacy by default. Unknown versions retain intent and fail unsupported before resource/state replacement. No migration number is reserved. |

Resource ownership stays in existing pipeline/worker/app layers; domain records
contain no browser resources. UI reads state, audio remains the playback master,
and authored timing remains integer-frame based. The research's synthetic worker
schedule does not replace the application's audio clock.

## Performance/resource decision with its limits

The original R3 preview figures are unqualified because the pinned Chromium
implementation turns `finish()` into a flush. They remain in the immutable raw
result. The separately reviewed correction ends preview/setup frames through
charged readback and captures the actual runtime revision before any worker.

Corrected 1080p preview passes all three resident-stage repetitions: candidate
p95 **7.9 / 10.4 / 10.6 ms**, zero deadline misses. At 4K, repetition 0 stops
after 79 frames with **two misses**, already more than 1% of the planned 120;
no complete p95 is fabricated. Later 4K p95s are 27.5 / 27.8 ms with zero/one
misses, but cannot erase the required three-repetition failure. The two failed
frames finish 0.2000 / 0.2667 ms late after delayed starts; their individual
durations are 27.5 / 27.3 ms. This is a no-go for the measured schedule envelope,
not proof that all 4K shaders or native GPUs cannot meet a 33.33 ms duration.

The absolute `no-go-certificate` is retained even though its paired ratio is
`unqualified-incomplete-pair`. Those dispositions are never collapsed into one
generic unqualified status. No extra run was used to obtain a more favorable
result. Native GPU, physical display, audio playback and full decoded video
pipeline performance remain unqualified.

Original full SDR readback-stage p95 is **8.0–8.1 ms at 1080p** and
**31.0–32.3 ms at 4K**, within its fixed absolute/paired limits. No full export
timing pair was repeated by the correction. These are resident composition and
returned byte-buffer costs, not codec throughput or independently verified
full-size output correctness. Source setup and per-video-frame upload are not
free: completed corrected setup is 130.7–137.9 ms and 333.5–343.4 ms.

Corrected preview peaks are 58,552,356 / 233,226,276 declared image bytes;
the original 4K export-stage peak is 265,420,836 bytes. All fit the unchanged
268,435,456-byte known-image ceiling. This narrow layout does not prove room for
every decoder, filter, scope, staging or output variant. The direct seven-surface
4K16F swap remains a static no-go at 464,486,400 bytes. Opaque browser/driver
copies, native memory, GC timing and process RSS are additional/unmeasured.

Ten corrected completed-draw start/stop cycles, five export-stage cancellations
(9.3–9.8 ms), context-loss rejection and fresh-owner correctness pass with zero
owned ledger. Twenty corrected-run workers terminate and browser/server close
is awaited. This proves the bounded ownership/readback lifecycle, not multi-hour
stability or immediate native memory reclamation. All exclusive slots are released.

## Bounded follow-up proposals

These are proposals for later selection, not remote issues or permission to
implement now. Neither assumes that the rejected/unknown HDR path is viable.

**A. Explicit source color facts and provenance.** A bounded domain/import
foundation can preserve primaries/transfer/matrix/range/depth/chroma/alpha facts,
their source/conflict status and explicit user overrides without enabling a new
renderer. Prerequisites: codec-aware precedence, including VP9 external signaling;
reviewed serialization/cache ownership within the then-current project format.
Acceptance: independent missing/conflicting/P3-SDR fixtures, lossless unknown-fact
round trips, explicit unsupported interpretation, and unchanged legacy render
selection/SDR fixtures. Excludes automatic HDR detection from primaries, conversion,
new codec profiles, HDR display and edited HDR metadata generation.

**B. Gated 1080p normal/dissolve managed SDR-view foundation.** The resident
1080p result justifies a narrowly scoped proof before a product change.
Prerequisites: proposal A; independent full-size pixel/alpha/color validation;
decode/upload/admission measured with the real source path; a resolved precision
contract for scopes or explicitly unavailable managed scopes; fresh review of
the actual preview/export integration. Acceptance: preserve legacy defaults and
unknown intent, use one managed authority, reject unsupported authored stages
visibly, maintain the 256 MiB ceiling/cleanup and original timing criteria over
complete repeated runs. Excludes 4K real-time claims, HDR monitoring/delivery,
legacy plugin reinterpretation, effects/LUTs, lens/filtering, text rasterization,
buses and nested sequences until each receives separate evidence. No existing
failing golden is relaxed to open this gate.

Full 4K rollout, a managed effects/scopes/text/lens suite, physical HDR monitoring,
and HDR10/HLG export are **deferred**, not proposed as currently implementable
product work. They need suitable independent source/output/display evidence and
explicit future selection. No hardware/tool installation is assumed.

## Validation and reproducibility

The [R0 baseline record](initial-validation.md) retains 107 focused tests across
six files, 17 runner checks, a successful TypeScript/Vite production build and
lint. Those are historical checks on the unchanged baseline; no full suite or
unrelated integration pass is claimed. Later preparation records eight R1
negative/guard tests and fourteen R3 correction admission/completion tests, with
static worker/controller compilation and scoped lint. Native experiments are
the separately granted, hashed runs, not those static checks.

The final audit checks all frozen references, original/raw source identities,
22 baseline product hashes, 72 compiled production-closure hashes, 99 original
and 109 corrected historical manifest entries, original 2,880 timing samples,
corrected 1,399 samples, exact no-go/incomplete-pair distinction and terminal
ledgers. Numerical/stage failures are retained, never made green by the verifier.
The worktree diff is confined to `docs/ISSUE_202_PLAN.md` and this evidence folder;
no production/dependency/architecture/HANDOFF change exists. No deterministic
encoded-file byte-identity or new serialized-project acceptance is invented.

Reproduce saved-result audits without a browser or new slot:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools node docs/evidence/issue202/verify-r4.mjs
```

That audit checks the final manifests and local document links, then runs:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools node docs/evidence/issue202/verify-evidence.mjs
DEVELOPER_DIR=/Library/Developer/CommandLineTools node docs/evidence/issue202/verify-r3-run1.mjs --verify
DEVELOPER_DIR=/Library/Developer/CommandLineTools node docs/evidence/issue202/verify-r3-completed.mjs --verify
```

The first verifier retains its historical `r3PreparationOnly` field; it checks
that preparation evidence, not the later experiment outcome. The two explicit
run verifiers audit actual results. Raw evidence and manifests are retained at
their immutable commit identities. Further execution requires a separately
selected task and fresh slot; it is not necessary to conceal or retry the
recorded no-go in order to complete this research decision.
