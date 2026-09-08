# Issue201: a separate whisper.cpp WASM route for review

2026-09-08. **Research/proposal only. Speech remains NO-GO.** Parent accepted
run05 failure evidence174fe8a and requested a materially different route. No
runtime/dependency/model/manifest/cap has changed; no weights were downloaded,
toolchain installed, source built, or native inference performed for this work.
The exclusive5201 grant is consumed and its slot released.

Recommendation: consider a source-preparation gate for the pinned whisper.cpp
core with multilingual **tiny-q8_0**, a dedicated single-thread non-pthread WASM
build, and an owned C API adapter. The stock browser demo is not suitable under
our constraints. This proposal does not yet establish build compatibility,
runtime bytes, the448-token adapter bound, measured memory, quality or GO.

## What the ONNX failure actually establishes

Run05's historical singleton encoder starts but does not return before complete
Chromium RSS exceeds1GiB incremental. The record has no operator allocation
trace, live WASM heap-size samples, optimized graph dump or allocator accounting.
It therefore does **not** identify an exact allocation site, fragmentation amount
or arena as the cause. Removing unused declared outputs failed to make this
candidate pass; another output-selection change is not justified by that result.

The exact ORT source at
`b7804b056c30aa35c1748f8e4e239d0e2ff25d6d` narrows the possibilities:

- Session options coerce omitted arena/pattern flags to false; the native API
  calls DisableCpuMemArena/DisableMemPattern. Disabling them again changes
  nothing. [JS options](https://github.com/microsoft/onnxruntime/blob/b7804b056c30aa35c1748f8e4e239d0e2ff25d6d/js/web/lib/wasm/session-options.ts#L225),
  [native options](https://github.com/microsoft/onnxruntime/blob/b7804b056c30aa35c1748f8e4e239d0e2ff25d6d/onnxruntime/wasm/api.cc#L136).
- CPUAllocator delegates to the platform allocator. A disabled ORT arena does
  not prove that the underlying C allocator or WASM memory returns capacity.
  [Allocator source](https://github.com/microsoft/onnxruntime/blob/b7804b056c30aa35c1748f8e4e239d0e2ff25d6d/onnxruntime/core/framework/allocator.cc#L160).
- A binary-only section reader found that the exact served13MB WASM imports a
  shared memory with16,777,216 initial bytes and4,294,967,296 maximum bytes.
  The generated JS grows memory geometrically, with an additional growth cap
  of100,663,296bytes. That cap is allocator growth logic, separate from our
  coincidentally same-sized model-cache cap. The pinned build enables memory
  growth and a4GiB maximum. These are static limits, not resident measurements.
  [Build source](https://github.com/microsoft/onnxruntime/blob/b7804b056c30aa35c1748f8e4e239d0e2ff25d6d/cmake/onnxruntime_webassembly.cmake#L225).
- The float32 CPU Softmax kernel permits in-place output. Attention tensor
  dimensions alone therefore cannot establish a sum of simultaneously live
  buffers. [Kernel registration](https://github.com/microsoft/onnxruntime/blob/b7804b056c30aa35c1748f8e4e239d0e2ff25d6d/onnxruntime/core/providers/cpu/math/softmax.cc#L30).

Exact asset hashes, parsed memory limits, growth excerpt and source digests are
in [speech-route-source-comparison.json](speech-route-source-comparison.json).
No WebAssembly compilation/instantiation was used for that inspection. An exact
ONNX allocation diagnosis would need a separately reviewed instrumented route;
the current evidence does not warrant claiming that one flag fixes the peak.

## Frozen primary-source comparison

Runtime source: official release[b4938](https://github.com/ggml-org/whisper.cpp/releases/tag/b4938),
commit`371b5a7561823ab2bb32142d2751e35e7534727b`, published2026-08-20.
The repository contains the matching ggml source. Model metadata is pinned to
`ggerganov/whisper.cpp` revision`5359861c739e955e79d9a303bcbc70fb988958b1`.
The publisher card declares MIT and identifies the original OpenAI conversion;
the runtime's[MIT license](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/LICENSE)
has the ggml authors' attribution. Preserve both notices and the exact model card.
The downloaded metadata does not identify the quantizer toolchain/source commit
that produced each weight file; do not invent that provenance.

| Multilingual file | Publisher bytes | Two model copies | Old05 plus staged |96MiB atomic-cache fit |
| --- | ---: | ---: | ---: | --- |
| `ggml-tiny-q8_0.bin` |43,537,433 |87,074,866 |87,147,898 |Yes |
| `ggml-tiny-q5_1.bin` |32,152,673 |64,305,346 |75,763,138 |Yes |
| `ggml-tiny.bin` |77,691,713 |155,383,426 |121,302,178 |No |

[Pinned publisher inventory](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1).
For q8_0 the published LFS SHA-256 is
`c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca`.
These are metadata claims, not locally verified weight bytes. Source preparation
would download once, check actual size/hash and parse the expected multilingual
tiny dimensions/vocabulary before any runtime loading. The `.en` variants cannot
meet required French acceptance. Choosing q8 over q5 is a conservative precision
preference, not evidence that it matches ONNX q8 or meets the WER gates.

The[model-format documentation](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/models/README.md)
describes the preconverted ggml model; the loader reads its vocabulary, filters
and tensors from one stream. No separately fetched tokenizer is proposed.

## Material execution difference and build requirements

whisper.cpp has explicit graph-allocation reuse and per-context compute/KV
buffers. Its encoder has a flash-attention branch with a CPU implementation,
instead of always materializing the full KQ/softmax graph. This is a substantive
execution-path difference worth investigating; it is not a measured memory
saving. Use explicit CPU-only, flash-attention-enabled context settings, default
audio context, no experimental DTW and no GPU/backend fallback in a candidate.
[Encoder](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/src/whisper.cpp#L2147),
[CPU kernel](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/ggml/src/ggml-cpu/ops.cpp#L8468),
[graph allocator](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/ggml/src/ggml-alloc.c#L791).

The official demo forces pthreads, creates a C++ worker, holds up to four contexts,
and allows512MB initial/2000MB maximum WASM memory. The JS binding additionally
requests an eight-thread pool. Passing n_threads=1 to either is not a non-pthread
build. Root CMake itself unconditionally appends-pthread for Emscripten.
[Root build](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/CMakeLists.txt#L52),
[demo build](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/examples/whisper.wasm/CMakeLists.txt#L31),
[JS binding](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/bindings/javascript/CMakeLists.txt#L36).

The core ggml path explicitly uses one thread when Emscripten pthreads are absent;
the CPU build enables WASM SIMD. A reviewed build-only patch would need to make
the root pthread flags optional, build static core libraries without the demo,
disable OpenMP/GPU/BLAS/optional backends, and link an app-owned C adapter in one
dedicated JS worker. No SharedArrayBuffer, Emscripten thread pool, remote loader,
MEMFS model copy or dynamic code generation is proposed.
[Core single-thread path](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/ggml/src/ggml-cpu/ggml-cpu.c#L2793).

The[Emscripten threading documentation](https://emscripten.org/docs/porting/pthreads.html)
requires distinct builds for threaded and non-threaded operation. Its[compiler
settings](https://emscripten.org/docs/tools_reference/settings_reference.html)
support explicit heap growth/maxima and modular ES output. Proposal for review:
64MiB initial linear memory,512MiB maximum, bounded growth, one context, one PCM
buffer and no filesystem. This adds a stricter internal resource bound; it does
not replace or relax the1GiB whole-Chromium incremental guard. Actual OOM behavior,
temporary copies, heap replacement and cleanup need a built-candidate audit.

The official[WASM CI](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/.github/workflows/build-wasm.yml)
pins the setup action but specifies no exact SDK version. The release inventory
contains no WASM artifact to adopt with an existing digest. Therefore no runtime
byte-size or reproducible-bundle claim is available now. Before a build grant,
pin the full Emscripten/LLVM/Binaryen/SDK archives and digests, CMake/build tools,
source revision, build patch and flags; enumerate the actual linked toolchain
licenses/notices. A later source-preparation phase must produce hashed JS/WASM
artifacts, import/export/memory inspection, exact raw/gzip sizes and build logs.
No toolchain version is silently selected by this proposal.

## Public API adapter and unresolved bounds

The[public header](https://github.com/ggml-org/whisper.cpp/blob/371b5a7561823ab2bb32142d2751e35e7534727b/include/whisper.h)
provides buffer-based initialization, owned state/free functions, full inference,
segment text/times and abort/logit/segment callbacks. Buffer loading copies model
data synchronously; free the input allocation after initialization while retaining
one context. Keep one bounded16kHz float PCM window, free on every terminal path,
and destroy the worker to release its WASM instance on forced cancellation.

| Existing contract | Proposed mapping / necessary proof |
| --- | --- |
|1–300s,30s windows/25s step/5s overlap,max12 |Reuse existing exact source-window/audio preparation authority. Keep audio_ctx=0; do not shorten the model context as a hidden memory fix. |
|448 new tokens per window |**Unresolved adapter proof:** max_tokens in whisper_full_params is per segment; multiple seeks/retries can exceed a window total. Require an audited whole-call pre-sampling guard and deterministic counter tests across segments/retries before qualification. Public callbacks may help, but no claim of sufficiency is made; any necessary core patch needs explicit review. |
|120s per window |Host deadline/termination plus a monotonic deadline in computation abort callback. Never accept partially completed output after abort/OOM/token budget failure. |
|Cancellation/replacement |Synchronous WASM blocks its own worker event loop. Without shared memory, a posted cancel cannot promise cooperative interruption; host termination remains the honest100ms fallback. Keep model/audio admissions until termination is observed. |
|Positive ordered source-bounded timestamps |Use integer segment t0/t1 (10ms units), verify all endpoints before rational frame conversion; no invented endpoints, epsilon repair or parsed console output. |
|Language/quality |Explicit en/fr, transcription rather than translation, no auto-language/VAD/beam fallback. Freeze all decoding parameters and run the same EN≤0.2/FR≤0.4 WER fixtures; no current accuracy claim. |
|Cache/offline/error lifecycle |Keep96MiB atomic committed-plus-staged admission, exact model/runtime identity, selected-file hash validation, lazy runtime, corrupt-input checks, all cancellation/retry/replacement/remove/offline23 cases. No CDN or remote inference. |
|Native memory |Keep1GiB complete Chromium RSS guard. A later reviewed runner should schedule100ms and fail missing/incomplete samples or actual gaps>250ms, preserve worst gap and trigger immediate termination. |

The token limit is an explicit source gate, not a permission to weaken a case.
The optional-local transcription deliverable remains required. Root owns the
route decision; source preparation, build and native execution are distinct
future authorizations. Captions-only closure is not claimed.

## Research evidence

Forty pinned/public source or metadata files were downloaded as inert text and
rehash-verified. The JSON records exact URLs/sizes/hashes, including two404 source
lookups (no content used), model metadata and parsed current-runtime memory.
The inspected sources remain in ignored `.tmp/issue201-whispercpp-research/`.
No compiled alternate artifact, model download, runtime import, native test,
changed manifest or executable production dependency was produced.
