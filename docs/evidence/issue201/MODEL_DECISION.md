# Local speech model decision — replacement lab preflight

Date: 2026-09-08. Status: fifth frozen attempt exceeded the fixed resident-memory ceiling.
**Product enablement remains NO-GO pending runtime/offline/lifecycle evidence.**
This status preserves the separate decision required by issue #201. The
orchestrator may approve the independent caption implementation after reviewing
the plan without approving speech enablement.

## Current measured candidate and outstanding decision

Candidate05 completed its single explicitly granted native run after full source
review; it is **NO-GO**. [LAB_RUN_05.md](LAB_RUN_05.md) preserves the unchanged
raw result and separate teardown. Incremental complete Chromium RSS reached
1,107,345,408bytes against the fixed1,073,741,824-byte ceiling before the first
encoder call returned. Eight initial cases passed, one failed and fourteen were
not reached. Maximum observed sample gap256ms also exceeds the requested250ms
gap limit; no sampling-cadence qualification is claimed. The worker was forcibly
terminated, the browser closed, and only its verified private profile removed.
All owned recorded PIDs and port5201 are absent; the exclusive slot is released.
No rerun or production enablement is authorized.

[ENCODER_COMPOSITE_CANDIDATE_05.md](ENCODER_COMPOSITE_CANDIDATE_05.md)
and [composite-preparation.json](composite-preparation.json) record its explicit
seven-file local composite: one exact July2023 published encoder plus six
unchanged current files. The current configuration revision is not represented
as the source of the older encoder. Model bytes are 43,610,465; runtime bytes
remain14,073,343. The25 deterministic source/VM checks passed before native
qualification. Manifest, all9 harness source hashes, original and composite
model files, runtime, notices and fixtures reverified unchanged after run05.
Quality, timestamps, remaining lifecycle/offline cases and full resident-memory
acceptance remain unresolved. The frozen candidate04 manifest and all earlier
failed raw evidence remain preserved. Product speech stays NO-GO.

Parent-requested research now compares a materially different single-thread
whisper.cpp WASM route in [WHISPER_CPP_ROUTE_PROPOSAL.md](WHISPER_CPP_ROUTE_PROPOSAL.md).
The accepted source-preparation grant has now produced exact verified multilingual
tiny-q8_0/source/toolchain assets, explicit build/token patches and an owned C/JS
protocol in [WHISPER_CPP_SOURCE_PREPARATION.md](WHISPER_CPP_SOURCE_PREPARATION.md).
No toolchain was installed/activated or compiler/runtime/inference executed.
The448-token source guard has deterministic arithmetic/placement checks; compiled
behavior, built artifact identity, all measured acceptance and production speech
remain unresolved. The existing raw RSS record cannot identify an exact native
allocation site as the cause. All failed ORT evidence is preserved.

## Measured replacement history through run04

The prior measured isolated-lab candidate kept the exact model revision and seven
model files below, with **Transformers.js 4.2.0** and **ORT Web
1.26.0-dev.20260416-b7804b056c**, using its WASM-only entry point and matching
non-JSEP loader/binary. The concrete browser payload is **14,073,343 raw bytes /
3,627,462 locally gzipped bytes**, including the existing Mediabunny audio adapter.
That measured model was **43,622,127 bytes**; combined raw payload is
**57,695,470 bytes**. These are asset measurements, not runtime or Vite claims.

[REPLACEMENT_PREFLIGHT.md](REPLACEMENT_PREFLIGHT.md) explains the removed
JavaScript protobuf route, actual import substitution/common-version identity,
license and notice inventory, fixture provenance, frozen thresholds, executable
harness and remaining qualifications. The preserved
[encoder-fetch-candidate04-manifest.json](encoder-fetch-candidate04-manifest.json)
binds the selected run04 assets and measurements. The inspected executable JavaScript
package advisory query returned no entries; this does not establish complete
native-WASM advisory coverage or approve production use. The first frozen run
failed before model initialization because the cache adapter omitted the SDK's
leading-slash local lookup key. [LAB_RUN_01.md](LAB_RUN_01.md) preserves the raw
evidence, invalid/aborted downstream classifications and released-slot cleanup.
The corrected adapter in run 02 serves the complete pinned model and WASM. That
run fails with `TransposeDQWeightsForMatMulNBits Missing required scale` during
session preparation. [LAB_RUN_02.md](LAB_RUN_02.md) preserves the separate raw
evidence: eight initial checks passed, the first model initialization failed,
14 downstream cases are explicitly missing, and cleanup was verified. No model
inference occurred. This error does not prove corrupt weights.
[INTEROP_CANDIDATE_03.md](INTEROP_CANDIDATE_03.md) proposes only the supported
`session.disable_quant_qdq='1'` optimization setting with identical assets and
thresholds. Exact source/manifest evidence and 16 deterministic regressions
were reviewed for run 03. [LAB_RUN_03.md](LAB_RUN_03.md) records successful model
initialization and first-window preparation, followed by 1,117,814,784 bytes
incremental Chromium RSS against the unchanged 1,073,741,824-byte ceiling.
The guard terminated the worker and closed the browser before any transcript
completed. Candidate 03 is NO-GO under that gate; later cases remain incomplete.
Forced shutdown and separate removal of only its private browser profile are
recorded honestly; cooperative cache removal was unavailable. No product speech
enablement has occurred.

[ENCODER_FETCH_CANDIDATE_04.md](ENCODER_FETCH_CANDIDATE_04.md) adds an
adapter scoped to the encoder instance, using ORT's output-selection API to fetch
only the hidden state consumed by generation. Pinned source shows this excludes
four unused attention copies totaling 216,000,000 float32 bytes at batch one,
without proving a smaller native peak. All decoder outputs, model/runtime bytes,
windows and thresholds remain unchanged. After source review, one run04 was
granted. [LAB_RUN_04.md](LAB_RUN_04.md) records that the first selected encoder
call began but did not complete before the fixed guard stopped it: incremental
RSS 1,099,415,552 bytes, exceeding the ceiling by 25,673,728. Eight initial cases
passed, one failed and fourteen remain missing. Candidate04 is also NO-GO.
Forced shutdown and separate private-profile teardown are documented; the slot
was released without granting another native run. The separately reviewed and
granted candidate05 attempt is recorded above.

The original 3.8.1 standalone candidate is **superseded for lab execution** after
the advisory lookup in [candidate-advisories.json](candidate-advisories.json).
The sections below preserve its original measurements and source findings so
the replacement cannot erase the reason for changing course. Their package
choice and byte totals are historical; their acceptance requirements remain
binding. Neither unchanged model bytes nor a new version label qualifies the
replacement runtime without fresh execution evidence.

## Historical initial candidate and source selection

- Model: multilingual `Xenova/whisper-tiny`, immutable revision
  `5332fcc35e32a33b86612b9a57a89be7906102b1`, encoder q8 and merged decoder q8.
  The publisher declares Apache-2.0 and identifies `openai/whisper-tiny` as its
  source. Prefer this candidate over `onnx-community/whisper-tiny` revision
  `ff4177021cc41f7db950912b73ea4fdf7d01d8e7`, whose inspected Hub metadata has
  no declared license field. This is a provenance choice, not a quality claim.
  Sources: [pinned model card](https://huggingface.co/Xenova/whisper-tiny/blob/5332fcc35e32a33b86612b9a57a89be7906102b1/README.md),
  [upstream model](https://huggingface.co/openai/whisper-tiny).
- Runtime: `@huggingface/transformers` exactly `3.8.1`, Apache-2.0;
  ONNX Runtime Web exactly `1.22.0-dev.20250409-89f8206ba4`, MIT.
  The dev-suffixed ONNX version is the actual pinned dependency of this stable
  Transformers release; do not relabel it as a stable ORT release or substitute
  another binary silently. Source: [runtime license](https://github.com/huggingface/transformers.js/blob/3.8.1/LICENSE),
  [pinned ORT license](https://github.com/microsoft/onnxruntime/blob/89f8206ba4/LICENSE).
- Proposed device: single-thread WASM, one disposable dedicated worker, no
  WebGPU/WebNN, no native Node runtime and no browser SpeechRecognition fallback.
  Start with segment timestamps, not word timestamps or invented confidence.
  Advertised language support is not locally measured accuracy: expose supported
  language tokens and name the actual qualified language/fixture set separately.
- Alternative self-conversion from OpenAI's original MIT repository would add a
  Python/exporter/conversion provenance gate. It is not silently equivalent to
  these published ONNX bytes. A larger model or a different library/version is a
  new measured decision, not an automatic fallback.

## Downloaded bytes and exact digests

`measure-package.mjs` downloaded the npm archives and all seven selected model
files into ignored worktree scratch. npm archive SHA-512 integrity was checked;
both ONNX SHA-256 hashes match upstream LFS metadata. Every selected config and
tokenizer file was hashed as downloaded. Exact URLs, hashes and sizes are in
[package-measurements.json](package-measurements.json).

| Selected asset | Downloaded bytes |
| --- | ---: |
| `config.json` | 2,248 |
| `generation_config.json` | 3,716 |
| `preprocessor_config.json` | 339 |
| `tokenizer.json` | 2,480,466 |
| `tokenizer_config.json` | 282,683 |
| `onnx/encoder_model_quantized.onnx` | 10,124,910 |
| `onnx/decoder_model_merged_quantized.onnx` | 30,727,765 |
| **Model/config/tokenizer payload** | **43,622,127 (41.60 MiB)** |

This is the source-inspected expected model set, not yet proof of the complete
offline request set. Gate 1 must observe all actual required and optional loader
requests, account for missing optional files explicitly, and bind the final
manifest. The five JSON files include the needed tokenizer and processor facts;
do not assume that supplying two ONNX files makes an offline model complete.

The proposed packaging is the pinned standalone browser distribution, copied
from the verified archive to application-owned same-origin lazy assets. It
avoids introducing the native `sharp`/`onnxruntime-node` execution path. No CDN
module or model fetch is allowed at application launch or ordinary caption use.

| Measured archive member | Raw bytes | gzip level 9 bytes |
| --- | ---: | ---: |
| `transformers.min.js` (standalone bundle) | 888,173 | 222,400 |
| `ort-wasm-simd-threaded.jsep.mjs` | 44,484 | 15,390 |
| `ort-wasm-simd-threaded.jsep.wasm` | 21,596,019 | 5,046,898 |
| **Selected runtime assets** | **22,528,676** | **5,284,688** |

Those are actual archive-member bytes and locally measured gzip sizes, **not
observed HTTP transfer sizes or a final Vite bundle delta**. The 469,931-byte
`transformers.web.min.js` has external runtime imports and must not be presented
as the full runtime cost. The non-JSEP 11,133,407-byte WASM variant was measured
but is not chosen until a compatible JS/loader route has been proved. Mixing
artifacts to advertise a smaller total would invalidate the qualification.

Selected raw model + runtime payload is 66,150,803 bytes. Runtime assets belong
to the app deployment; the optional model is acquired separately. Gate 1 must
measure whether runtime code actually transfers only after the explicit speech
action, which HTTP compression is served, which responses are browser-cached,
and complete offline loading after a fresh context/reload. A warm in-memory
worker alone is not offline evidence.

## License/transitive provenance and outstanding review

[upstream-provenance.json](upstream-provenance.json) binds the upstream release
lockfile, model card, Transformers license, ORT license and full ORT third-party
notice by URL/content digest. Its resolved browser-root dependency closure
records exact versions, registry integrity, nested lock paths and declared
licenses. Nested resolution matters: the root Node-related
`onnxruntime-common@1.21.0` is not the web dependency's matching dev revision.

The closure includes `@huggingface/jinja@0.5.3`, ORT Web/Common,
`flatbuffers@25.1.24`, `guid-typescript@1.0.9`, `long@5.2.3`,
`platform@1.3.6`, `protobufjs@7.2.6` and its declared dependencies. This lock
closure is provenance evidence, not a claim every module executes for Whisper.
Complete notice review and current advisory review of bundled third-party code
remain Gate 1 blockers. Vendoring a prebuilt bundle must not bypass the
production dependency audit by hiding it from package-lock tooling. If advisory
review requires a runtime upgrade, remeasure that exact replacement and its
offline/request closure before requesting GO.

Ship all applicable notices with reviewed browser artifacts/model acquisition;
retain original provider/source and conversion metadata. No legal agreement has
been accepted and no license assessment is claimed for arbitrary user models.
“Select local model” initially accepts only the exact manifest/hash set above,
not a user-supplied script, custom pipeline, arbitrary URL or unknown ONNX graph.

## Implicit-network findings and proposed closure

Verified source in the downloaded 3.8.1 archive:

1. `src/env.js:141-156` defaults to remote Hub loading and browser caching.
2. `src/backends/onnx.js:201-219` defaults WASM paths to jsDelivr. Disabling
   remote **models** alone does not disable the WASM CDN request.
3. `src/utils/hub.js:404-555` checks custom cache before loading, but a cache
   miss may still try `/models/...` even with remote models disabled. A custom
   cache alone is not proof of zero network requests.
4. `src/pipelines.js:1831-1907` can prepare/retain features for multiple audio
   chunks. Feeding the whole 300-second source to this API would evade the
   proposed two-window bound; prepare/submit one bounded window per call.

Proposed production contract for laboratory verification:

- Explicitly override `env.allowRemoteModels=false`, `allowLocalModels=true`,
  `useBrowserCache=false`, `useFS=false`, `useFSCache=false`,
  `useCustomCache=true`; pass immutable revision, `local_files_only=true`,
  `device='wasm'`, `dtype='q8'` for the pipeline and its components.
- Set `env.backends.onnx.wasm.wasmPaths` to the exact same-origin reviewed
  loader/WASM assets before constructing any session, `numThreads=1` and
  `proxy=false`. The app owns the one outer worker.
- Custom cache `match` serves fresh Responses only for the complete verified
  model manifest. Reject unknown paths or report an explicitly known optional
  file as missing; never let a silent miss become network discovery. Its `put`
  must not create a second uncontrolled persistent cache.
- Inside the dedicated worker, enforce a fetch boundary allowing only exact
  same-origin reviewed runtime assets and explicit known missing-file responses;
  all other requests fail before network. Model bytes arrive only through the
  controller's verified cache/local-selection/acquisition flow. Observe actual
  module loader requests separately; a fetch wrapper does not intercept dynamic
  `import()`. The lab must record every request and independently reject outbound
  traffic at the browser routing layer.
- Only a separate user-triggered Download model action can contact the pinned
  upstream HTTPS asset URLs, without cookies, authentication, media or text.
  Limit redirects to known model delivery endpoints; verify final lengths and
  digests. Cancellation aborts network streams and staged cache work.

## Cache, ownership and measurable limits

Use a separate app-owned origin-local namespace such as
`myrelith-models/caption-speech-v1`. Key entries by model id, immutable revision,
dtype, runtime compatibility version and complete manifest digest. Publish a
model atomically only after all lengths/digests validate. Stage files before the
manifest; a late cancelled write must drain/rollback before releasing admission.
No model/audio/result cache key enters portable project identity.

Proposed model-storage ceiling: **96 MiB across committed plus staging data**,
one supported model. The selected committed payload is 43,622,127 bytes; a full
replacement alongside it is 87,244,254 bytes before small manifest overhead,
within that proposed bound. These sums are measured-file arithmetic, not actual
OPFS/browser-cache usage measurements. Check origin quota before acquiring;
deduplicate identical digests; never evict the active generation. Expose Remove
model and exact cached-byte/status facts. Quota/permission/corruption/offline
misses are named recoverable failures. A rejected model never deletes project
captions. Project replacement cancels jobs/results but may retain a validated
opt-in model cache. Clearing models/derived data also disposes its live owners.

Keep raw decoded audio and unapplied speech output ephemeral. One active worker,
one decoder, ≤3,840,000 known PCM bytes, ≤2 MiB preparation scratch,
≤30-second inference window, ≤448 generated tokens/window and ≤300-second job
are proposed ownership/work bounds. ONNX/WASM heaps, tokenizer allocations,
decoder/demux internals and browser process overhead are additional.
**Peak resident size has not been measured.** No byte-payload number above is a
resident-memory bound and no model GO can be granted on it.

## Exclusive lab acceptance before GO

Request the orchestrator's exclusive slot before inference. Preregister these
tests on the frozen lab source and review actual ceilings before execution:

The orchestrator supplied read-only host identification from
`/usr/sbin/sysctl -n hw.model hw.memsize machdep.cpu.brand_string`:
`Mac17,6`, `68719476736` installed RAM bytes (64 GiB), `Apple M5 Max`.
This is supervisor-supplied identity evidence, not a resident-memory measure,
and does not grant the exclusive benchmark slot.

- Cold load, warm reuse and a fresh offline reopen; actual request URLs,
  transferred response bytes, app-cache bytes and browser-cache facts. No model
  action means zero model/runtime requests. No model offline gives a useful
  status; a complete installed model works after reload with network blocked.
- Recorded English plus one licensed non-English fixture, silence and a corrupt
  input. Pin source, license, expected transcript and exact sample spans. Report
  actual words/timestamps/reading-speed diagnostics, not a broad quality score
  or a made-up confidence. Compare against frozen fixture acceptance before GO.
- 1/30/300-second jobs, two consecutive jobs, and cancel during acquisition,
  loading, decode, inference and cache commit. Verify retry, source change,
  project replacement and shutdown, including late transfer/rejection paths.
- Bound measured single-window wall time to 120 seconds and termination
  acknowledgement to the 100 ms fallback policy. Record CPU/runtime configuration
  and window throughput without promising real-time performance.
- Sample complete relevant Chromium worker/renderer process resident bytes
  before, during and after job ownership; report baseline and absolute/delta
  peaks. Proposed rejection ceiling for this machine: 1 GiB **incremental**
  resident high-water over idle during the isolated 300-second test, no sustained
  increase across repeat jobs after owner disposal. OS sampling/GC limitations
  must be explicit; failed/unavailable measurement is not a pass. This ceiling
  is not a portable browser allocation guarantee.
- Show all decoder/worker/PCM/result/cache-transaction owners released; separate
  cooperative disposal evidence from forced termination. Keep original failure
  evidence if remediation/requalification is required.

The final model decision must name the complete manifest, final deployment
artifacts, current advisory/notice results, actual transfer/cache/resident
measurements and qualified browser/hardware/language limits. If any mandatory
condition fails, retain the optional no-model editor, report NO-GO and leave the
speech acceptance criteria unresolved for the orchestrator's scope decision.
