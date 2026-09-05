# Multicam alignment — Issue #194

Status: first contract and synthetic feasibility proof ready for review.
Product integration and the new audio-cache provenance still require review.

## Intended workflow

Select one reference angle and 1–7 other angles in an existing multicam. Choose
a short source window around a shared event for each angle. Audio analysis
returns a table of current/proposed integer offsets, measured overlap, match
score, and ambiguity. Nothing changes in the project or history while that
table is open. Manual correction remains available. Apply revalidates the
complete selection and commits all accepted offsets in one ordinary project
history entry. Failed or ambiguous rows cannot become applied offsets.

Timecode is a separate optional method. It needs identified rate, counting,
source-origin, continuity, clock, and day semantics. An arbitrary timecode tag,
filename, file modification time, or container creation date is insufficient.

## Existing seams and decisions

- Issue #193 is merged. Multicam definitions already contain ordinary integer
  source starts and local coverage; all preview/playback/export paths share
  their selection planner. Alignment must author this existing representation.
- The app-owned MediaJobScheduler can reserve one job and one decoder. Decode
  reference and target windows sequentially; retaining small reference features
  does not require a second decoder.
- AnalysisStorage already owns serialized OPFS staging, finalize/rollback,
  LRU, and derived-storage cleanup. Its schema-1 identity is specifically for
  video motion: video stream index, dimensions, frame sampling, and clip
  geometry. Audio must not masquerade as a stabilization result with invented
  dimensions or a fake clip id.
- The current import descriptors contain no trusted source timecode. The
  ruler's formatTimecode function formats editor frame numbers; it is not a
  source-metadata parser.
- The first executable proof is browser-free and excluded from production.
  No new cache schema, import behavior, store action, or editor control is
  enabled by this gate.

## Gates and implementation plan

1. **Contract and quality proof (implemented; review pending).** Pin the algorithm, resource
   limits, offset sign/rounding, negative fixtures, strict normalized timecode
   evidence, and a separately versioned audio provenance. Run deterministic
   fixtures and audit the production import graph. Review this contract before
   product use. Synthetic speech-shaped fixtures do not replace real speech QA.
2. **Runtime and cache foundation.** Add a discriminated audio provenance to
   the shared derived cache through an explicit schema migration. Preserve
   existing motion entries and rollback semantics. Decode selected windows
   into streaming energy features with one scheduled job/decoder; bind every
   request to exact project/source/settings identities. Test cancellation,
   late ownership, stale reads/commits, quota failures, and deletion/teardown.
   Separately prove a bounded container timecode profile and its metadata
   adapter. If any required semantic fact is unavailable, expose that reason;
   no generic text tag can stand in for the missing evidence.
3. **Review and Apply.** Add an app facade and serializable proposal store,
   bounded accessible controls, and one atomic multicam-offset domain action.
   Revalidate all shared-definition locks, coverage, source bounds, ids, and
   project budgets at Apply. Do not extend definition/instance durations or
   discard source tails silently: refuse a proposal that cannot fit existing
   geometry and explain the necessary manual edit. Keep manual controls live.
4. **Real-source acceptance and delivery.** Chromium must cover decoded
   speech/noise/event audio, ambiguity, cancellation, cache hit/stale rejection,
   manual correction, one-entry undo/redo, recovery/export parity, and cleanup.
   Timecode success requires a reviewed container adapter and encoded fixture;
   until then the product must explain its unavailability. Run focused/full
   tests, build/typecheck, lint, production audit, and diff checks at each
   applicable gate; commit with repository authorship conventions.

The plan follows the explicitly selected Issue #194. docs/PLAN.md requires a
user-approved plan for new post-MVP work; approval of the product gates and
review of audio provenance are recorded separately from this first proof.

## Audio candidate: log-energy correlation v1

This is a deliberately conservative first-party candidate, not a general
acoustic fingerprint service or a claim of robustness to arbitrary recordings.

| Item | Candidate bound / rule |
|---|---|
| Angles | 2–8, one explicit reference; compare each target directly to it |
| Source rate | Integer 8,000–96,000 Hz; decoded timestamp grid is authoritative |
| Channels | 1 or 2; average squared channel amplitudes, avoiding stereo phase cancellation |
| PCM block | At most 4,096 frames per channel; borrowed, consumed immediately, never retained |
| Selected window | 5–30 seconds, in 5 ms feature-bin increments; no whole-recording scan |
| Feature rate | 200 Hz; mean square over each consecutive source-sample bin, then log(1 + 1000 × RMS) |
| Retention | At most 6,000 float32 values / 24,000 bytes per angle; 192,000 bytes across 8 angles |
| Search | Integer feature lags within ±1–5 seconds of the selected windows |
| Coverage | At least 3 seconds and 60% of the shorter selected window |
| Work | At most 2,001 lags × 6,000 sample pairs = 12,006,000 comparisons per pair; 84,042,000 for 7 pairs |
| Cooperative work | Yield after at most 4,096 sample pairs; host must check cancellation at every yield |
| Match | Pearson correlation on the overlap, with overlap-local means and variances |
| Silence/flatness | Reject average feature energy below the −80 dBFS equivalent or feature standard deviation below 0.005 |
| Quality | Score at least 0.8; gap at least 0.06 to the strongest alternative beyond one project-frame neighborhood |
| Search edge | Reject a peak exactly at the requested search boundary; wider/different windows need a new request |
| Frame rates | 24, 25, 30, 48, 50, 60, 24000/1001, 30000/1001, 60000/1001 for this candidate |
| Declared fixture tolerance | At most 1 project frame; exact timecode conversion admits no rounding |

A steady tone, silence, and repeated motifs must not be represented as unique
sync evidence. The reported score is correlation, not a calibrated probability
of correctness. A high score alone cannot authorize Apply. Clock drift,
different edits, stretches, independent noise, and heavily dissimilar mixes are
unsupported; short windows cannot establish alignment across a long recording.
The UI must describe that the result is a constant offset near the chosen event.

The proof consumes already decoded PCM. Its feature averaging is energy
integration, not an audio resampler. The later decoder must account for real
source timestamps, edit-list origins, priming/discard padding, gaps, and codec
configuration before supplying continuous samples. It must reject gaps or
unknown origin rather than pad silence, shift the first sample, or use native
average video frame rate as the audio clock. Decoder configuration and
implementation versions belong in feature provenance.

### Offset meaning

For a candidate lag L, compare reference feature A[i] with target B[i + L].
If the selected windows start at source samples R and T with decoded rates
Sr and St, target placement relative to the reference is:

    offset seconds = R / Sr − T / St − L / 200

Convert that rational expression once to project frames, using BigInt and
nearest-frame rounding with ties away from zero. A positive result places the
target recording later than the reference. Selecting a window further inside
a source must not reverse this sign or lose the window origin. Preserve all
authored positions as integer frames; samples/seconds exist at this analysis
boundary only.

## Normalized timecode evidence (research only)

The proof validates a closed evidence record; it does not read a media
container or establish trust. The record declares a strict HH:MM:SS:FF label,
an exact reduced frame rate from the same allow-list, non-drop counting,
continuous timecode, source-presentation-frame-zero origin, zero day offset,
and an explicit common clock-domain identifier. All facts must be supplied by
a future independently reviewed metadata adapter; an object passing this
validator alone is not trusted metadata.

Unknown/extra keys, missing flags, semicolon/drop-frame notation, negative
values, frame labels beyond the nominal rate, discontinuity, unknown offsets,
day wrapping, different rates/clocks, and unsupported semantics reject. The
proof aligns only equal source/project rates, including exact rational
non-drop rates, by subtracting label frame counts. It does not infer a shared
clock, day, or midnight wrap from labels. A product adapter must identify those
facts or request explicit user confirmation of a common sync basis.

There is no accepted container timecode profile yet. A successful normalized
fixture proves arithmetic/rejection policy only. Product timecode support is
still a gate, not a promised button backed by guessed metadata.

## Audio fingerprint provenance proposal (review required)

Use a new discriminated record in the shared derived-storage manifest, not a
new independent storage owner. Version and migrate the manifest explicitly;
schema-1 motion records retain their original interpretation. The audio record
must include every fact below in its exact cache-key preimage:

- Opaque local-project binding, asset id, existing sampled SHA-256 source
  fingerprint (including file size/name/modified time), and proven source
  connection generation for publication checks. Sampled hashing is the existing
  conservative cache identity; it does not claim whole-file cryptographic
  identity. A connection generation belongs to session currentness, not a
  durable cross-session cache key.
- Actual selected audio-stream identity, codec and decoder-policy/version
  digest, decoded sample rate and channel count, channel-energy policy, exact
  source presentation origin, requested start sample and sample count, and
  proven continuous coverage.
- Feature kind, algorithm version, feature rate, log/RMS constants, byte
  encoding (tightly owned float32 little-endian), and exact feature count.
- A correlation result additionally binds the ordered reference/target feature
  keys, project frame rate, lag bounds, overlap/score/margin/tie/rounding policy,
  and the multicam definition/angle snapshot used to propose placement.

Key framing must be canonical, exact-key validated and domain-separated;
feature records and pair results cannot alias. Changing any provenance fact
is a cache miss. Validate bytes/counts/finiteness and their exact relation to
requested sample coverage before treating a hit as usable.

The executable preimages in multicamAlignmentProvenanceResearch.ts use fixed
JSON tuples with separate research format identifiers for features and pairs.
They validate the existing bounded opaque local-binding syntax, not a magic
prefix. The future app must obtain that binding from its current local-project
owner; string validation cannot establish project ownership. These preimages
are review evidence and do not register a manifest format or make any OPFS write.

Proposed audio cache ceiling: 1 MiB per entry, 16 MiB per project, 64 MiB total
within the existing shared 512 MiB target; at most 1,024 aggregate entries.
Apply the tighter per-kind ceilings before LRU mutation. No PCM, source bytes,
object URLs, Files, decoders, worker handles, trust claims, or cache keys enter
the portable project or recovery. Only applied ordinary integer offsets do.
Clear/remove uses the existing derived-storage registry after cancelling and
draining matching jobs. Storage failure leaves manual editing and the project
intact; a late committed entry rolls back before the scheduler slot is reused.

## Evidence and remaining gates (2026-09-05)

Run npm run qa:issue194:research to regenerate the source-bound JSON at
.tmp/issue194/alignment-research.json. The committed runner hashes its exact
listed source/test/runtime-leaf files before and after the run and records
HEAD, dirty-tree status, Node version, platform, bounds, measurements, and
explicitly unverified product capabilities.

| Check | Result |
|---|---|
| Coded tone, synthetic speech-shaped, modulated noise | 9/9 signed-offset cases within 1 project frame; 44.1→48 kHz, half gain, opposite stereo polarity |
| Silence, steady tone, repeated motif | 3/3 return unavailable/ambiguous with no applicable offset |
| Eight-angle maximum-window proof | 7 direct reference comparisons at 30 seconds each; 77,035,000 total sample pairs, below the 84,042,000 ceiling |
| Cooperative cancellation work | At most 4,096 sample pairs between yields; closing the iterator ends remaining work |
| Normalized non-drop timecode | Exact +65 frames at 30000/1001; drop-frame/unknown/origin/rate/clock rejection fixtures pass |
| Provenance | Exact-key, domain-separated feature/pair tuples; every source/project/decode/window/order/rate/definition mutation changes the preimage |
| Focused proof + architecture | 106 tests across 4 files plus all 17 repository runner tests |
| Full suite | 277 files / 3,900 tests plus all 17 runner tests |
| Production build/typecheck | Pass; 4,961 modules; research modules/format markers absent from output |
| Lint / production audit / diff | Pass; 0 production vulnerabilities; clean diff hygiene |

The measured code fingerprint is
sha256:835c7e350a5fb630010e5d85def6a2f0f840853ee8934ea732698c2ad15e12c7.
The measured run used Node 24.19.0 on macOS arm64; elapsed time was 1,733.8 ms
including fixture generation. This is descriptive host evidence, not a browser
latency promise. Tests additionally cover all nine admitted project rates,
nonzero source-window origins, weak/unrelated audio, search-edge refusal,
source-sample discontinuity, oversized/pinned feature buffers, and one-shot
ownership.

Real recorded speech, compressed decode, OPFS lifecycle, proposal UI, and
Chromium product acceptance remain required gates. This proof adds no
observable editor behavior, so a product browser gate is not claimed here.

### Honest notes

- The first provenance test incorrectly assumed the existing opaque binding
  validator requires a local-project prefix. It deliberately accepts bounded
  legacy opaque ids too; the test now checks invalid syntax, and the contract
  explicitly assigns ownership verification to the future app controller.
- The first evidence runner produced Vite's WebSocket-listen warning despite
  disabled HMR. The runner now explicitly disables WebSockets as well, and the
  corrected run opens no listener and emits no warning.
- The first full build caught literal-type inference on the configurable
  search-limit parameter after Vitest passed. Both public/helper parameters
  now declare number explicitly; runtime bounds still reject invalid values.
  The corrected full suite and build pass. Vite reports only the established
  non-fatal large-chunk advisory.

## Primary references

- [Kdenlive clip alignment](https://docs.kdenlive.org/en/cutting_and_assembling/right_click_menu.html):
  explicit reference selection for audio/timecode alignment. This informs the
  workflow, not this algorithm's quality thresholds.
- [Mediabunny reading media](https://mediabunny.dev/guide/reading-media-files):
  lazy inputs and primary/explicit track selection. The locked 1.50.9 source
  must be checked before depending on any documented API in product decode.
- [Apple QuickTime timecode flags](https://developer.apple.com/documentation/quicktime-file-format/timecode_sample_description/flags)
  and [AVFoundation timecode support](https://developer.apple.com/library/archive/technotes/tn2310/_index.html):
  labels require format/rate/flag interpretation; a generic text tag does not
  establish the media mapping or a shared recording clock.
