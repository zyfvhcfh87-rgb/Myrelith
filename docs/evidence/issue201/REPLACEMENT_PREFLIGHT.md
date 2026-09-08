# Issue #201: replacement speech laboratory preflight

Date: 2026-09-08. **Source/artifact preflight only. No inference has run.**
The previous heavy slot was released. The committed harness and manifest require
orchestrator review and a fresh exclusive slot before execution. Production
dependencies, editor behavior and project schema are unchanged.

## Why the initial runtime was replaced

The exact initial browser dependency inventory contains `protobufjs@7.2.6` and
`@protobufjs/utf8@1.1.0`. The public npm bulk advisory response is preserved,
including query versions, affected ranges, severities, IDs and URLs, in
[candidate-advisories.json](candidate-advisories.json). Its protobuf entries are:

- GHSA-66ff-xgx4-vchm, GHSA-2pr8-phx7-x9h3, GHSA-fx83-v9x8-x52w,
  GHSA-75px-5xx7-5xc7, GHSA-jvwf-75h9-cwgg, GHSA-685m-2w69-288q and
  GHSA-q6x5-8v7m-xcrf: affected through 7.5.5; the last also covers utf8 1.1.0.
- GHSA-jggg-4jg4-v7c6: affected through 7.5.7.
- GHSA-xq3m-2v4x-88gg: npm reports versions below 7.5.5 and critical severity.
  The upstream advisory describes conditional use of untrusted descriptors and
  a revised high assessment. This preflight does not claim exploitability in
  the selected, immutable Whisper graph. [Upstream advisory](https://github.com/protobufjs/protobuf.js/security/advisories/GHSA-xq3m-2v4x-88gg).
- GHSA-wcpc-wj8m-hjx6: affected through 7.6.0; GHSA-f38q-mgvj-vph7:
  affected through 7.6.2.

The replacement removes that JavaScript parser/import route. It does not claim
that renaming a vendored bundle or changing an unrelated dependency patches
already bundled code. Native graph parsing remains inside the selected ORT WASM;
the JavaScript advisory lookup is not a complete native component security scan.

## Actual selected import and binary closure

`prepare-speech-lab.mjs` fetches exact npm archives, verifies their published
integrity, and extracts actual distribution bytes without installing a product
dependency. It parses imports with the repository's TypeScript parser.

Transformers 4.2.0's web module has two external imports: namespace
`onnxruntime-web/webgpu` and named `Tensor` from `onnxruntime-common`. The lab
replaces only those two AST-located string literals with `./ort.wasm.min.mjs`.
Both original and transformed hashes are retained. The WASM entry exports
`InferenceSession`, `Tensor`, `env` and the other runtime functions from a single
module, so the named Tensor and session implementation share the same bundled
common classes. No separate Common package is loaded at runtime.

The selected ORT Web artifact identifies itself as
`1.26.0-dev.20260416-b7804b056c`; its bundled Common source identifies itself as
`1.24.0-dev.20251116-b39e144322`. This mismatch is the archive's actual content,
not an invented matching version. Both are queried and recorded. The source map
is restricted to Common and the WASM backend/entry/version source paths. It has
no static module imports and excludes the WebGL JavaScript protobuf/flatbuffers
closure. The unminified Transformers module identifies only tokenizers 0.1.3 and
jinja 0.5.6 as embedded package sources. The exact source-map list/hash, package
integrity and metadata digests are in the manifest.

That evidence supports a concrete compatibility hypothesis, not successful
inference. A namespace entry-point substitution still requires execution against
the pinned graph. Any failed export, loader, Tensor identity, operator or model
configuration check is a lab failure; changing it requires a new frozen source
and retained failure report. The dev-suffixed runtime is never labelled stable.

| Selected file | Raw bytes | Local gzip level 9 bytes |
| --- | ---: | ---: |
| transformers.local.mjs | 431,648 | 120,673 |
| ort.wasm.min.mjs | 50,069 | 16,185 |
| ort-wasm-simd-threaded.mjs | 24,180 | 9,090 |
| ort-wasm-simd-threaded.wasm | 12,942,611 | 3,321,755 |
| Existing Mediabunny audio adapter | 624,835 | 159,759 |
| **Runtime and audio adapter** | **14,073,343** | **3,627,462** |
| Pinned model/config/tokenizer | **43,622,127** | Separate optional acquisition |

These exclude HTML, harness source, metadata and notices, which the browser
request report counts separately. The test server is a local HTTP mirror of the
exact approved bytes. Its transfer timing does not measure a real model-CDN
download, and the Node server's resident memory is outside Chromium RSS.

## Licenses, notices and advisory scope

| Actual JavaScript package inventory | Version | Declared license |
| --- | --- | --- |
| @huggingface/transformers | 4.2.0 | Apache-2.0 |
| @huggingface/tokenizers | 0.1.3 | Apache-2.0 |
| @huggingface/jinja | 0.5.6 | MIT |
| onnxruntime-web | 1.26.0-dev.20260416-b7804b056c | MIT |
| onnxruntime-common | 1.24.0-dev.20251116-b39e144322 | MIT |
| Existing mediabunny | 1.50.9 | MPL-2.0 |

The exact six-package advisory query returned `{}`. Query time/input/result and
all package integrity/metadata hashes are frozen in
[replacement-manifest.json](replacement-manifest.json). This is an inventory
query, not a statement that all possible package or native vulnerabilities are
absent. Do not substitute it for the eventual production audit.

Full Transformers, tokenizers, jinja and Mediabunny licenses, plus ORT's license
and **325,054-byte ThirdPartyNotices.txt**, are saved with content digests. The
full ORT notice is preserved because its native dependency list is broader than
the executable JS inventory. The model's declared Apache-2.0 provenance remains
bound by the initial pinned model-card evidence. Any eventual redistribution
must carry applicable licenses/notices and record the two import substitutions;
this lab does not itself publish a deployment or accept an agreement.

## Frozen fixture evidence and earlier preparation failures

Both public recordings are CC-BY-4.0 and are never played aloud. Their dataset
revision, row, original identifier, signed-URL-free asset path, exact downloaded
SHA-256, format, sample count and reference transcript are frozen in the manifest.

- English: LibriSpeech dummy clean/validation row 0, revision
  `5be91486e11a2d616f4ec5db8d3fd248585ac07a`, source recording
  `1272-128104-0000`. Mono PCM16, 16 kHz, 93,680 samples, **5.855 seconds**.
  [Source license](https://www.openslr.org/12).
- French: MINDS-14 fr-FR/train row 0, revision
  `40ce77cb32a384e4d50a568e1ec39ac804019d33`, source recording
  `fr-FR~ADDRESS/response_4.wav`. Mono mu-law, 8 kHz, 30,037 samples,
  **3.754625 seconds**. [Dataset/license](https://huggingface.co/datasets/PolyAI/minds14).
- A deterministic 300-second derivative repeats that English recording with
  0.5-second digital gaps and an exact final cutoff. This is a bounded-work
  fixture, not natural long-form accuracy evidence. One-second digital silence
  and a 43-byte corrupt input are generated separately and hashed.

Preparation initially rejected French under PCM16/Float32 assumptions; reading
the WAV format showed mu-law codec 7. The parser/profile was explicitly expanded
before any inference. An earlier FLEURS index request returned HTTP 501 because
the dataset server's scan was too large; a dummy-FLEURS probe returned HTTP 401.
Those sources were not silently substituted or used as successful evidence.

## Preregistered executable measurement contract

The lab scripts are separate from production and have no production importers.
Before execution, `run-speech-lab.mjs` requires `ISSUE201_EXCLUSIVE_SLOT=1`, a clean
committed harness/manifest, and matching SHA-256 for every served artifact/model/
fixture. It records the starting commit, script hashes, browser build and results,
and verifies script hashes again at completion. Any failure output is retained.

- **Model and work:** single-thread q8 WASM, one disposable worker and input at a
  time, 1–300 seconds, 30-second windows with 5-second overlap, at most 448 new
  tokens per window. Twelve windows cover the 300-second stress source. Explicit
  English/French language selection; no upload, language download or fallback.
- **Known audio memory:** at most 3,840,000 bytes owned PCM; no whole-source PCM
  or multi-window SDK chunker. Source decode accepts the pinned mono 8/16 kHz
  profiles only, at most one-second decoded samples, finite complete coverage,
  fixed-radius resampling and finally-closed sample/input owners. The 2 MiB
  preparation-scratch allowance is separate from runtime/native allocations.
- **Result bounds:** at most 20,000 transcript characters and 1,000 segments per
  window, 4,000 characters per segment and 20,000 aggregate segment characters.
  Finite positive ordered segment times within the source interval are required
  for fixture timestamp acceptance. Missing endpoints remain explicit failures
  of that acceptance, not invented cue timing. Long-window overlap reconciliation
  and integer-frame/editor apply are later product gates.
- **Accuracy:** normalized Unicode word edit distance ≤0.20 for the English
  recording and ≤0.40 for the French recording. These tiny fixtures do not qualify
  a language generally. Exact all-zero PCM skips inference and yields empty text;
  this is not voice-activity detection or general hallucination prevention.
- **Time and memory:** 120 seconds per load/inference window; 100 ms idle disposal
  deadline followed by forced termination. Complete Chromium process-table RSS
  is sampled every 250 ms, with named idle/closed snapshots. Reject >1 GiB
  incremental resident high-water over idle; missing/incomplete sampling is not
  success. Report absolute peak/delta and repeated-job residuals. A separate
  manual verdict must assess sustained residual growth; allocator/GC timing and
  sampling gaps prevent claiming exact native peak/live-owner equivalence.
- **Cache:** 96 MiB model payload ceiling covers committed plus fully staged
  model before eviction. Verify all seven lengths and SHA-256 before registration
  and before inference. Reject corruption before creating a worker. Capacity and
  cancelled cache writes/registry commits must preserve the prior complete model
  and remove staging. Tests use explicit 250 ms instrumentation pauses only in
  cancellation cases; those timings are not acquisition performance measurements.
- **Local acquisition:** both the verified HTTP mirror and browser `File` input
  route exercise the same bounded verification path. Lab-selected Files are
  reconstructed from known fixture bytes; this is not an editor file-picker UX
  acceptance test. No model action must cause zero model/runtime requests.
- **Ownership/cancellation:** acquisition, model-load, preparation and inference
  cancellation; project replacement; corrupt input; retry and removal. Log exact
  generations and ownership. Idle disposal must acknowledge zero model/input/
  sample/PCM owners within the deadline. Active termination is labelled forced
  cleanup, never a cooperative zero ledger. Short preparation phases may require
  a separately frozen instrumented test if real phase observation misses them.
- **Offline:** no Playwright routing (which disables the HTTP cache). Independently
  block networking for a loaded page plus fresh worker, page reload, and a closed/
  reopened persistent browser profile. Runtime dynamic imports are checked by
  observed browser requests as well as the worker fetch allowlist. Any unlisted
  outbound request fails the lab. Failure to boot offline is recorded as failure,
  not worked around by pretending a warm worker proves the deployment can reopen.

The host identity supplied by the orchestrator is Mac17,6, 64 GiB, Apple M5 Max.
It is not a memory measurement. Actual memory, transfer/cache behavior, model
compatibility, accuracy, timings, cancellation and offline results remain
**unmeasured**. Broader codecs/channels/rates, source offsets, project history,
editable cue review/export/save/reopen, UI accessibility and final product bundle
cost remain later gates even if this isolated experiment passes.

## Reproduction and static validation

Run from the issue #201 worktree. Preparation only:

```sh
node scripts/issue201/prepare-speech-lab.mjs
```

Only after the orchestrator grants the exclusive inference slot:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools ISSUE201_EXCLUSIVE_SLOT=1 node scripts/issue201/run-speech-lab.mjs
```

Syntax checks and repository lint cover the committed harness; the byte-preflight
completed without importing/invoking the model. No full suite, model execution,
production browser check or model GO is represented by these static checks.
