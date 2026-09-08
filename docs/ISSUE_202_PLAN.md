# Issue #202 — managed 10-bit and HDR research

Status: **R1 CPU comparison and bounded R2 probes recorded; full R2/R3/R4 open**.
Baseline: `ce91074c276ca6892a74addb7dd673b9a19c7eeb`, branch
`codex/issue202`, inspected 2026-09-08. Scope comes from
[#202](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/202) and the Milestone 9
coordination contract. Advanced SDR grading is present through merged #196.

This issue produces a decision and reproducible evidence. It changes no
production source, dependency, UI, export preset, project format, plugin ABI,
or existing SDR math. An evidence-backed no-go is a completed research outcome;
an incomplete experiment is not. The orchestrator reviews this initial gate
before continuing the laboratory. Only the orchestrator publishes or integrates.

On 2026-09-08 the orchestrator approved R0 commit `8ce3742` for the R1
independent numerical oracle/candidate and bounded R2 capability/metadata
experiments. The color model remains a research candidate. The original limits
stand; substantial decode/encode, timings and full suites require an exclusive
slot. Two bounded codec sessions have completed and released their slots;
no R3 slot has been granted. Host identity supplied by the orchestrator is
recorded in the evidence inventory and does not qualify HDR presentation.

The [R1/R2 evidence](evidence/issue202/r1-r2-results.md) records 118/118 scalar
comparisons and 68/68 final-view storage comparisons passing, with the exact
scope-bin fixture failing after binary16 storage. The measured browser uses
SwiftShader; P3 canvas drawing changes extended pixels and WebGPU has no adapter.
The initial basic mux-tag inspection used synthetic header-only packets.
These results do not promote the managed candidate or qualify a product HDR
path. 1080p/4K timing remains unmeasured.

The later [three-frame codec run](evidence/issue202/codec-run-1-results.md),
explicitly granted after #198 released the slot, returned profile 2 ten-bit
packets and I420P10 frames. Its pixel comparisons stopped at an over-strict
coded-size guard: saved VP9 headers say 1024×16, while VideoFrame coded width
is 1088 and visibleRect was not captured. Its original failed rows remain
unchanged. All six frames and six codec instances closed before slot release.

That separate slot was subsequently granted at `ea530ec`. The
[saved-packet readback](evidence/issue202/codec-readback-1-results.md) confirms
visible/display size 1024×16 inside coded 1088×16 for all three frames. Each
copied luma ramp has 896 distinct values, 4,496/16,384 mismatches, maximum
absolute error 1 and mean error -0.2509765625 code; neutral chroma is exact.
All three diagnostics completed and all frames/decoders closed. This resolves
the tested size-guard limitation; it is not a lossy-quality GO or independent
codec/display/performance qualification. The second slot is released; no R3
or further heavy extension has run.

## Gates and deliverables

| Gate | Work | Exit evidence |
| --- | --- | --- |
| R0 — plan and source investigation | Trace present precision boundaries; establish sources, proposed color model, independent reference design and fixed measurement ceilings. | This plan, source/support matrix, fixture protocol and source inventory; local commit for orchestrator review. |
| R1 — numerical reference | Freeze separately implemented high-precision reference vectors, implement a disposable candidate, compare every stage and hostile case. | Exact fixtures, oracle/candidate hashes, per-case expected/actual/error, explicit unsupported stages. No product imports of the laboratory. |
| R2 — browser and metadata | Probe exact pixel formats, readback, tags, float surfaces, codec profiles and mux/reopen behavior on installed browsers. | Machine-readable matrix with browser/OS/hardware/flags, requested and returned configs, actual output bit depth/tags and independent structural parsing. |
| R3 — resources and timing | After exclusive benchmark-slot grant, compare paired SDR/candidate 1080p and 4K preview/export paths, cancellation, context loss and reuse. | Raw samples and ledger peaks, per-cell decision under the preregistered envelopes below; retain failures. |
| R4 — decision and review | Resolve every issue criterion as proved, partial, or failed with consequence. Propose bounded child issues only where justified. | Final go/no-go, support exclusions, architecture contract and validation record; local commit for orchestrator acceptance. |

All laboratories, fixtures and results will live under `docs/evidence/issue202/`
and run only from explicit commands there. They may import pure domain
evaluators as subjects under test and existing public app facades for the
paired SDR baseline. They must not change architecture exceptions, install
themselves into an application entry point, or add a production dependency.
An independent oracle imports neither candidate code nor production evaluators.

## Verified current boundaries

| Owner at the baseline | Finding and implication |
| --- | --- |
| `workers/renderWorker/contracts.ts`, `pipeline/export-mediabunny-sink.ts` | Preview and export create explicitly sRGB Canvas2D contexts with default 8-bit storage. Increasing an encoder profile cannot recover values lost here. |
| `domain/effectPixels.ts`, `domain/colorLut.ts`, `domain/colorCurves.ts`, `domain/colorWheels.ts`, `pipeline/colorGradingRuntime.ts` | Ordered effects process `Uint8ClampedArray` pixels. #196 curves/wheels materialize 256-entry byte tables; LUT/wheel results clamp and quantize at the descriptor boundary. Float64 calculations do not make the image pipeline high precision. |
| `pipeline/lensRemapWebgl.ts` | Explicit RGBA8 textures and unsigned-byte readback. Existing shader arithmetic does not preserve higher-precision input/output. |
| `domain/pluginManifest.ts`, `docs/PLUGINS.md` | Frame ABI v1 is straight, nonlinear sRGB RGBA8 with independent alpha. Reinterpreting those bytes as linear or HDR would break plugins. |
| `domain/blendModes.ts`, `pipeline/render.ts` | Existing blends and isolated transition weighting have defined sRGB/premultiplied behavior. Linear-light composition is a new render version, not a correction to old projects. |
| `domain/videoScopes.ts`, `workers/renderWorker/core.ts` | Scopes consume a bounded post-presentation RGBA8 sample. They cannot measure original HDR luminance. |
| `pipeline/proxyGeneration.ts`, `domain/proxyCache.ts` | Current editing proxies render through sRGB Canvas. A managed pipeline needs color-transform provenance; existing proxies cannot stand in for untouched HDR originals. Export still requires originals. |
| Mediabunny 1.50.9 source | Provides track/sample color tags and full codec-string override. Default VP9/AV1 codec strings are 8-bit. MP4 writes complete `colr/nclx` tags and Matroska writes basic color fields; these are not complete mastering/content-light metadata support. |

The [source investigation](evidence/issue202/support-matrix.md) distinguishes
specification affordances from measured implementation support.

## Proposed versioned color architecture

These are research candidates to test, not installed product contracts. The
numerical fixture protocol must freeze exact equations before candidate output
is used to set expected values.

**Compatibility and defaults.** Preserve `legacy-srgb8-v1` as the default for
every existing document and new ordinary project. It retains the current
renderer, effects, plugins, source interpretation and scopes. The research
makes no serialized changes. A future reviewed format migration would add an
explicit project render-color version and immutable source-interpretation
records, with missing old fields mapped only to legacy. No migration number is
reserved here: #198–#201 and integration own their current schema sequencing.
Unknown color versions remain bounded author intent and cannot be rendered or
exported as if they were understood. Opening an unsupported whole-project
format retains the existing refusal before state/resource replacement.

**Source interpretation.** Keep bit depth, primaries, transfer, matrix, range,
chroma location and alpha association as separate facts, each with original
container/bitstream evidence and any explicit override. Compare container and
codec tags; a conflict, missing managed-mode fact, unknown transfer, unsupported
ICC/log profile or unsupported chroma location is unresolved. Do not infer HDR
from bit depth, Rec.2020/P3 primaries, filename or Mediabunny's broad `hasHighDynamicRange()`
heuristic. Decoder-provided tags must be compared with the admitted description.
Keep mastering display metadata and content-light statistics distinct from
sample colorimetry. Source metadata is not valid output metadata after editing.

**Managed working representation.** Candidate `managed-linear2020-v1` uses
display-linear BT.2020 RGB, D65, normalized so RGB 1 corresponds to 203 cd/m²,
straight alpha at interchange and premultiplied alpha for spatial filtering and
composition. Arithmetic is Float32 in the GPU candidate; retained textures are
RGBA16F. A Float64/Decimal CPU path is a reference, not an automatic product
fallback. Preserve finite negative and above-reference-white RGB through linear
stages; reject non-finite samples and out-of-contract magnitudes. Candidate
working bounds are [-64, 64] per straight RGB channel and [0, 1] alpha. Values
beyond those bounds reject admission rather than silently clamp. Test whether
RGBA16F error is acceptable; promote no precision choice solely because it fits.

**Decode/conversion order.** Decode to demonstrably unchanged 10-bit planes (or
another verified high-precision format); unpack using actual plane layout and
stride; reconstruct chroma with a frozen location/filter; remove full/limited
range coding; invert the signaled Y′CbCr matrix; apply the transfer's inverse;
convert linear primaries through D65 XYZ into BT.2020; then associate alpha.
sRGB uses its piecewise transfer. SDR BT.709 display interpretation uses a
declared BT.1886/reference-black policy, not an accidental sRGB curve. PQ maps
to absolute luminance through BT.2100's ST 2084 equations. HLG requires inverse
OETF **and** the declared OOTF/viewing parameters: initially 1,000 cd/m² peak,
zero reference black and system gamma 1.2. Normalize to the working scale only
after that mapping. Alternative HLG viewing conditions are distinct transforms.
Prove both RGB and neutral-axis results; do not apply a per-channel power where
the HLG OOTF requires luminance coupling.

**Stages and alpha.** Orientation precedes geometry. Lens correction, crop,
transform and spatial sampling operate on premultiplied linear RGB plus
coverage; zero-alpha samples contribute zero color. Unassociate only at a stage
that requires straight color; define zero-alpha output RGB as zero in managed
mode. Coverage/masks affect alpha and associated RGB together. Source-over uses
`Cp = Cs*as + Cd*ad*(1-as)` and `a = as + ad*(1-as)`. A dissolve adds the
two complete associated legs with complementary weights, then composites that
group once. Preserve exact integer-frame weights and shared sequence planning.
Do not reuse an sRGB blend equation under a different encoding without a new
declared blend version. Initial managed support may admit only normal and
linear-light dissolve; all other authored blends are explicit unsupported cells.

**Effects, text and plugins.** Each managed stage declares input/output color
space, alpha association, precision, numeric bounds and resource cost. Exposure
in a new linear effect is a power-of-two multiplier; existing SDR exposure,
curves, wheels, LUTs and chroma-key versions keep their original definitions.
An untagged LUT is never presumed to be a managed transform. Text/caption colors
start as sRGB and convert into working primaries at the declared 203 cd/m²
diffuse white; glyph coverage is independent. Font rasterization is a separate
qualification from color math. Managed lens correction needs a new float
surface backend. Existing plugin ABI v1 remains byte-for-byte sRGB8. In managed
mode it is unavailable unless a future explicitly authored SDR compatibility
island declares its lossy output transform. No implicit HDR→SDR→HDR round trip.
A future ABI v2 needs independent version negotiation and memory ceilings.
Legacy nested sequences can be rendered completely by the legacy renderer and
then treated as declared SDR sources; internal legacy stages are not relabeled.

**View and output transforms.** Scopes branch from the completed working image
before view mapping and report luminance in cd/m² with BT.2020 coefficients;
code-value/PQ views must name their encoding. A separate post-view SDR scope is
allowed only with that label. SDR preview/export has an explicit versioned
tone/gamut transform with declared peak and diffuse white. R1 starts with a
fully specified neutral-axis luminance compression plus hard gamut clipping as
a deliberately limited reference; it cannot be marketed as a finished look.
BT.2390/BT.2446 alternatives require separate equation/version and oracle
review. The browser must not perform an additional unaccounted transform.
HDR display uses a verified extended-range presentation surface and explicit
monitor status. CSS `dynamic-range`/`color-gamut`, canvas creation and screenshots
cannot qualify a calibrated reference monitor or prove physical peak brightness.
Headless tests qualify storage/conversion only. Unsupported monitoring retains
an explicitly named SDR view and does not claim HDR monitoring.

**Encoding and metadata.** Treat 10-bit SDR, HDR10/PQ and HLG as separate output
profiles. Each requires a freshly validated exact codec configuration, actual
10-bit decoded output and independently inspected color signaling. Candidate
SDR BT.709 is CICP primaries/transfer/matrix 1/1/1; PQ/BT.2020 nonconstant-luminance
is 9/16/9; HLG is 9/18/9; each declares range and chroma location. RGB exports
would require different matrix signaling and are outside the first candidate.
HDR10 is a reviewed PQ profile with valid mastering-display and content-light
metadata, not a synonym for HLG. Never fabricate mastering capability or copy
source MaxCLL/MaxFALL into an edited composite. A candidate must either measure
output statistics and accept explicit valid mastering parameters, or mark the
profile unavailable. Encoded SEI/OBU and container tags must agree. Missing,
rewritten or uninspectable required metadata means export no-go. A successful
`isConfigSupported` response alone cannot pass this gate.

Future provenance must bind render-color version, source interpretation,
transform versions, working precision and output profile into proxies, thumbnails,
scope results and other color-dependent caches. Resource ownership stays in
existing worker/pipeline/app layers; domain data contains no browser resources.
Preview and export share the same managed composition/conversion authority;
audio remains master and timeline arithmetic remains integer-frame.

## Preregistered performance and resource decision

Measurements require the orchestrator's exclusive slot. Proposed matrix:
1920×1080 and 3840×2160, 30 fps, opaque SDR/PQ/HLG and mixed input, two-layer
dissolve, text+mask, grading, lens, plugin rejection; paired preview and finite
export. Use exact synthetic 120-frame sources; 30 warm-up plus 120 measured
frames per cell, three sequential repetitions in alternating baseline/candidate
order. Record every sample, p50/p95/max, failures and terminal cleanup. Timing
runs may sample a smaller predeclared representative subset after R1/R2 reject
unsupported cells; record all omitted cells with their failed prerequisite.

Keep a **256 MiB known owned image-storage ceiling per admitted render owner**
for this candidate, counting backing buffers, CPU copies, retained textures,
readback, staging and decode planes before allocation. Decoder/encoder native
allocations, browser/GPU internal duplication, encoded payload and process RSS
are additional and reported separately, never included by assertion. One
sequential source decode lane per input, at most two active inputs, one encoder,
one in-flight candidate frame and one scope sample; no duration-sized buffers.
Preview and export run separately and borrow no resources from each other.

| Cell | Research pass condition |
| --- | --- |
| 1080p30 preview | Candidate composite+view p95 ≤33.33 ms, no >100 ms stalls, no more than 1% missed presentation deadlines over each run. Separately report decode and presentation costs. |
| Full 4K30 preview | Same deadline; otherwise full-resolution real-time is no-go. A separately measured half-resolution view may justify only a bounded preview child issue. |
| Finite export | Full-resolution correctness first; per-frame candidate color/composite/readback p95 ≤250 ms at 1080p, ≤1,000 ms at 4K, and ≤4× paired SDR stage cost. Encoder/total throughput reported separately. |
| Cancellation | Stop submitting immediately; acknowledge within 250 ms at cooperative boundaries or record forced termination. Await/drain late resource creation; terminal owned ledger is zero. |
| Stability | Ten repeated start/stop and five export/cancel lifecycles; ledger returns to zero every time. No unsupported claim about multi-hour/native-memory behavior. |
| SDR compatibility | No production or dependency diff. Baseline golden fixtures and existing relevant tests remain exact. Browser SDR raw pixels and serialized project bytes compare exactly where deterministic; encoded file byte identity needs a qualified deterministic encoder and is otherwise unproven. |

Static arithmetic already rejects a direct seven-surface float16 conversion at
4K: 464,486,400 bytes (442.96875 MiB), versus 232,243,200 bytes for RGBA8.
Four RGBA16F 4K surfaces alone use 265,420,800 bytes (253.125 MiB), leaving
almost no readback/input allowance. This is allocation math, **not a measured
benchmark**. Any viable float candidate must reduce live surfaces, tile work,
or narrow its supported composition. Raising the existing product cap is not
authorized by the research.

## Decisions expected from the evidence

The first gate proposes the above model and ceilings for orchestrator review.
It requests no user confirmation of ordinary delegated research. No physical
HDR monitor qualification or additional software installation is presumed.
If the host cannot provide independent encoded-fixture/oracle tooling, keep
that criterion incomplete or produce a bounded no-go; never use Mediabunny to
both generate and validate all metadata expectations.

If viable, final child proposals separate: (1) explicit color metadata and
10-bit SDR transport; (2) managed linear composition and SDR view; (3) compatible
effects/scopes/text/lens; (4) qualified HDR monitoring; (5) HDR10/PQ and HLG
export with independently verified metadata. Each will name prerequisites,
exclusions and acceptance. This task creates no remote child issues.

## Initial validation

Pending commands/results are recorded in
[initial validation](evidence/issue202/initial-validation.md). The issue's
six acceptance criteria remain open until R1–R4 supply their evidence. R0
must not be described as HDR implementation or completed research.

Current follow-up validation and exact command limits are recorded in
[R1/R2 results](evidence/issue202/r1-r2-results.md) and the hashed evidence
manifest. Existing production source and dependency hashes remain the baseline.
