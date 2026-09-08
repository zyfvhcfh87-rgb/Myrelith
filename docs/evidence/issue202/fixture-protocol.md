# Independent fixture and measurement protocol

R0 design, 2026-09-08; updated after the R1 CPU and bounded R2 experiments.
The protocol below was established before candidate results. Numerical sources
and 118 goldens were committed at `4be10d0`, then 68 independent final-view
references at `69dbbbe`, before JS candidate comparison. See
[equations](equations-v1.md), [freeze manifest](oracle-freeze-v1.json) and
[results](r1-r2-results.md). Limits remain unchanged: scalar 118/118 and final
view 68/68 pass; the binary16 scope fixture fails. Full shader, codec, raster,
lifecycle and timing qualification remains open. Earlier rejected/provisional
reference artifacts and original candidate sources are retained.

## Independence and provenance

Use a standalone Python standard-library Decimal implementation with at least
50 decimal digits for transfer functions, linear algebra and scalar reference
composition. It must not import Myrelith or the candidate, read candidate
results, or call browser conversion APIs. Derive primary matrices independently
from chromaticities and D65; cross-check against CSS Color 4 sample matrices.
Check PQ/HLG anchors against the actual BT.2100 tables/formulas, recording
edition and sections. These shared standards are inputs, not shared code.

The disposable JS/GPU candidate separately implements the admitted operations.
Freeze exact rational/decimal fixture inputs and expected outputs as JSON text;
hash all source, fixtures and outputs. Add a dependency/import scan proving the
oracle has no candidate/production imports and the production graph has no
laboratory imports. Do not regenerate expected output during a comparison run.
Store numbers as decimal strings where JSON binary64 would erase oracle detail.

Encoded media needs a second independent path: externally encoded or carefully
constructed checked-in tiny bitstreams plus a bounded standalone MP4/EBML/codec
header parser. Reopening only with Mediabunny is insufficient. Inventory a local
FFmpeg/zscale/ffprobe installation if available; none is currently on PATH.
No dependency installation is implied. If an independent codec pixel oracle
cannot be provided, report that cell unqualified rather than inventing it.
Raw VideoFrame fixtures may still prove transport and reference math separately.

Record base commit; command; UTC time; OS/browser/adapter/flags; package versions;
fixture and tool hashes; requested/accepted codec config; expected/actual sample
format, depth, tags and range; timings; all known owned allocation/release counts;
exceptions and terminal outcome. Avoid collecting serial numbers or user media.

## Required reference cases

| Family | Exact fixture inputs | What must be compared |
| --- | --- | --- |
| Legacy SDR | Unit and empty effects, #196 LUT/curves/wheels, existing blends, legacy text/captions, transitions and plugins | Same portable JSON and raw SDR pixels; no production/dependency diff. Existing reference tests remain authoritative only for the unchanged legacy branch. |
| 10-bit SDR | 1,024-step neutral and primary ramps, endpoints and 8-bit-collapsing neighboring code pairs; full/limited range | Raw plane sample equality and >256 distinguishable values before quantization. Distinguish sRGB and BT.709/BT.1886 interpretation. |
| PQ | 0, near-black, 0.1, 1, 100, 203, 1,000, 4,000 and 10,000 cd/m²; neutral and chromatic samples | ST 2084 encode/decode, reference normalization, correct black guard, no automatic tone mapping. |
| HLG | Zero, piecewise breakpoint, 0.75 and 1 signal; neutral and unequal RGB | Inverse OETF and luminance-coupled OOTF at frozen peak/black/gamma; no per-channel shortcut. |
| Wide gamut | sRGB/P3/BT.2020 primaries, white, negative out-of-gamut channels, P3 SDR negative HDR-classification control | Independent XYZ transform; preserve signed working values; distinguish gamut from transfer/range. |
| Mixed sources | 100-nit and 203-nit SDR whites alongside 1,000-nit PQ and reference HLG patches | Explicit source diffuse-white interpretation and absolute working luminance; no filename or primaries-only inference. |
| Tone/gamut map | Neutral luminance ramp, saturated highlights, negative primaries | Freeze candidate curve, knee, peak, RGB scaling and gamut-clipping equations before output. Check monotonicity, endpoint/diffuse-white behavior and recorded clipping. No claim of BT.2390 compatibility unless that exact algorithm is separately implemented. |
| Transparency | Alpha 0, 1/1,023, 0.25, 0.5 and 1; bright hidden RGB; dark and colored destinations | Association/unassociation, zero-alpha canonicalization, source-over and linear interpolation against high-precision scalar oracle. |
| Transitions | Two associated legs at exact 0, 1/4, 1/2, 3/4, 1 weights, then destination composition | No double attenuation; equal white remains equal white; integer frame and preview/export parity. Unsupported blend versions reject explicitly. |
| Effects/LUT | New linear exposure at -1/0/+1 stops, identity matrix, noncommuting color/coverage order, untagged SDR LUT | Numeric oracle for admitted stages; old version/unsupported stage must report unavailability, never run under a new interpretation. |
| Text/captions | Fixed raster coverage mask plus exact sRGB fill, outline and background; real bundled-font raster as separate cell | Color mapping and alpha via fixed masks independently; browser text raster identity measured separately without pretending fonts are portable pixel goldens. |
| Lens/geometry | Identity and fixed Brown-Conrady map on a tiny HDR checker with transparent colored border | Independently calculated source coordinates and premultiplied bilinear samples. Existing RGBA8 lens path is a deliberate precision-loss negative control. |
| Plugins | ABI v1 identity/known byte transform in legacy mode; v1 on managed HDR; unknown ABI | Exact bytes/parameters on legacy; explicit unsupported managed stage. No implicit SDR conversion. A future v2 cannot be called accepted by this v1 rejection proof. |
| Scopes | Working luminance patches and clipped SDR view of the same patches | Exact bins/counts and peak units on the chosen sample grid. Prove HDR values are read pre-view, and SDR view scopes are distinctly labeled. |
| Metadata | SDR/PQ/HLG complete tags; missing/conflicting/unknown tags; wide-gamut SDR; mastering/content-light presence and absence | Independent expected CICP/container/codec fields, preserve missing as missing, forbid stale source mastering/content-light claims after edits. |
| Lifecycle | Cancel during decode/upload/readback/encode, context/device loss, rejected config, failed flush, late frame | Bounded queue, close in finally, terminal ledger zero or explicitly recorded forced termination. No user-media access or sound. |

## Numeric acceptance fixed before candidate evaluation

- Scalar Float64 candidate versus Decimal: absolute error ≤1e-10 or relative
  error ≤1e-9, with both error values recorded; transfers report luminance and
  signal error separately. Exact zero/white/identity and discrete metadata
  assertions remain exact.
- Float32 arithmetic / RGBA16F intermediate: record maximum absolute and relative
  working error and **maximum output-code error ≤1 code in a 10-bit output**
  for admitted samples after the specified output transform. Near-zero alpha
  has separate associated-RGB and alpha comparisons so division cannot hide
  errors. No averaging away isolated failures.
- Integer raw plane copies must be exact. Lossy codec pixels use separately
  frozen codec-appropriate tolerances, not the raw transport threshold; report
  actual bit depth, level survival and bias independently of codec error.
  Do not claim a final codec quality threshold before an independent decoder
  and fixture profile are selected.
- Scope histogram bins/counts are exact for synthetic sampled inputs. GPU
  filtering coordinates and color errors are separate checks; tolerances never
  excuse selecting a different source pixel or applying a different transfer.
- SDR raw pixel equality is exact on deterministic fixtures. Browser alpha or
  text raster differences are reported at their boundary instead of weakening
  all image comparisons. Encoded byte identity is not assumed for native codecs.

Timing and allocation ceilings are in `../../ISSUE_202_PLAN.md`; no measurement
starts before the exclusive-slot grant. Static envelope rejection is recorded
without attempting a deliberately over-budget allocation.
