# Issue201 whisper.cpp source-preparation checkpoint

Follow-up source review found a startup-blocking locator in checkpoint763baed.
[WHISPER_CPP_LOADER_CORRECTION.md](WHISPER_CPP_LOADER_CORRECTION.md) records the
separate correction, pinned-loader regressions and current source checkpoint.
The original48-check evidence below is retained as historical preparation.

2026-09-08. **Prepared for source review only. Speech remains NO-GO.** The
supervisor authorized downloads, byte/format verification, a bounded build patch,
an explicit core token-budget patch, and owned adapter/protocol source after
accepting proposal002194d. No SDK was installed or activated; no compiler,
downloaded executable, generated JS, WASM instance or alternate inference ran.
No runtime dependency, production module, original lab runner,23-case contract,
existing cap or failed ORT evidence was changed. No native slot is held.

## Exact inputs and local verification

[assets.json](whispercpp-preparation/assets.json) records all eight downloaded
archives/assets, sizes, SHA-256 values, primary URLs, SDK component revisions,
license inventory, existing caps and remaining qualification limits. All eight
were rehashed after preparation. The model was downloaded once and reused for
byte inspection and deterministic tests.

| Selected input | Exact identity | Actual bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| Multilingual tiny-q8_0 | HF revision5359861c739e955e79d9a303bcbc70fb988958b1 |43,537,433 |c2085835d3f50733 |
| whisper.cpp source |371b5a7561823ab2bb32142d2751e35e7534727b / b4938 |9,136,244 |89051d8fca516a3a |
| Emsdk source |e5bd3d0874e302a18f13c5b41f5bacf9a40c8e59 /6.0.8 |175,845 |e5f44ea2158626a0 |
| Emscripten arm64 tool bundle |9d70dbe8860ccdd3595f6e6065d94bfb543ae955 |273,726,956 |63ec9acba14b67a9 |
| CMake macOS universal |4.4.3 |89,445,170 |0c5d65251c14cc88 |
| Ninja macOS |1.13.2 |314,051 |c99048673aa76596 |
| Node macOS arm64 |24.19.0 |52,234,372 |8294b7aa9b039974 |
| SDK Python macOS arm64 |3.13.3 |44,280,478 |2b0899d7ade9463b |

The model matches the publisher's full LFS SHA-256
`c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca`.
CMake/Ninja hashes match their saved release asset digests; Node matches its
saved SHASUMS256. The GCS compiler bundle matches its published CRC32C; Python
matches CRC32C and MD5. Their storage generations are retained. SHA-256 for
those two and the GitHub source tarballs is locally computed, **not claimed as
a publisher-signed digest**. No detached signature verification is claimed.
These exact archives are available locally; no unversioned SDK fallback is used.

The pinned SDK maps6.0.8 to the selected bundle. Its inert DEPS text specifies
Emscripten`aeb67926e7de656da38bc807d83050af93578758`,
LLVM`c0125a7bf833b6cf0d5b4a085b63094e0893c85a`, and
Binaryen`8d546dc4aea1c3e81e77643f1ed0dea1a649d21d`. The archive's version file
actually says **6.0.8-git**; this is preserved, not rewritten. Executable version
checks and reproducible build behavior remain untested.
[Pinned SDK manifest](https://github.com/emscripten-core/emsdk/blob/e5bd3d0874e302a18f13c5b41f5bacf9a40c8e59/emsdk_manifest.json),
[fixed build DEPS](https://chromium.googlesource.com/emscripten-releases/+/9d70dbe8860ccdd3595f6e6065d94bfb543ae955/DEPS).

All1,881 file/symlink Git blob hashes from the whisper.cpp archive match its
saved pinned recursive tree, with no missing files. The model format reader
accepts only the exact tiny profile: magic0x67676d6c, multilingual vocabulary
capacity51,865, audio context1500, text context448, state384, six heads/four layers
per side,80mels, quantization version2/type7. It checks80×201 finite mel filters,
50,257 stored base vocabulary entries (maximum33bytes here), and all167 unique
named tensor shapes/types/payload lengths through exact EOF:100float32,
2float16 and65q8_0 tensors. Special multilingual tokens are constructed by the
core; the smaller stored base vocabulary is expected. Hash verification remains
mandatory because structural checks do not establish weight correctness.
[Format report](whispercpp-preparation/model-format.json),
[archive proof](whispercpp-preparation/source-archive-verification.json).

The model card declares MIT and credits OpenAI conversion. The upstream OpenAI
MIT notice is also saved at an explicitly resolved commit; it is not presented
as the unknown conversion/quantization revision. The exact converter/
quantizer revision is not published in the inspected metadata and remains
unknown. Runtime source has its MIT notice. SDK, Emscripten, LLVM, Binaryen,
CMake, Ninja, Node and Python notices are retained along with bundled notices.
[Archive inventory](whispercpp-preparation/archive-notice-inventory.json) maps442
notice/version entries to245 deduplicated full text files in the deterministic
[notice archive](whispercpp-preparation/archive-notices.zip). This is an archive
inventory, not a claim that every component is linked. The exact eventual link
closure and shipped notice set still require review. Additional upstream LLVM/dlmalloc source notices retain exact whitespace in
[upstream-notices.zip](whispercpp-preparation/upstream-notices.zip). No legal
agreement changed.

## Reviewable build and token patches

Source lives only under`scripts/issue201/whispercpp/`. There is no product import
and no runnable native lab entry. The CMake recipe is **not executed**.

- `01-optional-pthreads.patch` makes the root pthread flags opt-in via a default-
  on option, preserving upstream defaults. A separate default-off ggml option
  skips its pthread discovery and Threads::Threads link for our single-thread
  target. It also honors an explicitly supplied ggml build commit so an archive
  inside this worktree cannot accidentally report Myrelith's parent Git SHA.
- `CMakeLists.txt` selects those non-pthread paths, static libraries, CPU+SIMD,
  no OpenMP/accelerator/repacking/dynamic backend/demo/server,64MiB initial and
  512MiB maximum unshared memory,16MiB linear growth,5MiB stack, dlmalloc,
  no filesystem or dynamic JS execution, ES module worker output, and bounded
  owned exports. The exact compiler settings source is retained; the recipe
  uses canonical PTHREADS=0 rather than relying on the legacy USE_PTHREADS alias.
  CPU flash attention and use_gpu=false are fixed in context initialization.
- `02-whole-call-token-budget.patch` explicitly changes the private candidate
  ABI. It adds max_tokens_total and an optional synchronous output counter;
  default0/null preserves unbounded upstream behavior outside this adapter.
  The owned adapter always supplies448 and its private counter. Limits outside
  0..448 or positive-limit profiles other than one greedy decoder, one thread,
  explicit en/fr, no VAD/auto-detection reject with-90 before mel computation.

The token counter is initialized **once in whisper_full_with_state**, outside
all seek/segment/temperature/decoding loops. Every live decoder sampling
iteration reserves one token before either greedy sampling call. EOS, timestamp
and discarded retry tokens all count. Prompt tokens do not count as newly
sampled tokens. A defensive n_decoders_cur==1 check rejects profile drift.
Attempt449 clears all partial results and returns-91 before sampling; there is
no fabricated EOS or silent truncation. The wrapper never calls full_parallel.
Changing max_tokens alone would remain insufficient because it is per segment.

`patch-identities.json` records exact pre/post hashes for all five patched files.
Deterministic checks apply every hunk against pinned source with full context,
verify those hashes, and check counter scope/profile/placement before both
sample sites. They execute the actual tiny C helper's arithmetic body with only
`budget->field` mapped to`budget.field` in a JS VM, across every1..448 limit and
multiple segments/discarded retries. This proves the reviewed source arithmetic
on that integer range; **it is not compiled-C or WASM execution proof**. The
later built artifact must demonstrate the same boundary with an instrumented
sampler, including a real assertion that sample449 is never invoked.

## Adapter, ownership and timestamps

`adapter.cpp` owns one context, one input model allocation and one PCM allocation.
Only bounded allocators are exported. The verified model copies into WASM once;
the input allocation is freed after synchronous initialization on success/failure.
The retained core model/context is separate from that input allocation. Each
16kHz PCM call admits0.1–30s (the whole source request still admits1–300s), checks
finite samples, and frees PCM through scope cleanup. The existing decode/window
authority must still own source coverage and audio-sample closing; this adapter
does not decode files or replace that authority.

Decoding is fixed to transcription, explicit en/fr, no history/prompt, no VAD,
no token-DTW timestamps, default audio context, greedy best_of1, temperature0
with no temperature fallback, and the stated448-token budget. Remaining numeric
thresholds are explicitly set in the wrapper. No beam/GPU/runtime fallback.

The C abort callback and encoder-begin callback share a sticky monotonic120s
deadline. Encoder-begin cancellation can otherwise return nominal upstream
success; the wrapper checks its deadline again before accepting any result.
Any nonzero status, exception/trap, output/time/budget error rejects the entire
window. JS rejects malformed UTF-8, absent/noninteger/unordered/overhanging
centisecond endpoints, more than1,000segments, more than4,000characters/cue or
20,000aggregate characters. Endpoints remain integer10ms units;1unit equals160
samples. No rounding/clipping/epsilon repair invents coverage. Rational timeline
conversion, overlap ownership and the fresh editable-cue review stay with the
future existing source-window/application integration.

`worker-protocol.mjs` has a lazy injected local factory, explicit reviewed WASM
identity and full model/runtime hash checks before factory creation. It refuses
SAB-backed heaps and undeclared asset lookup, refreshes heap views after growth,
allows one pending request and at most12windows per owner, and rejects stale ids/
generations. No actual factory or runtime identity is supplied in this checkpoint.
That missing bootstrap is intentional until the built JS/WASM bytes pass review.

`worker-owner.mjs` retains a pending operation until terminal handling. It arms
a host120s timer so busy synchronous WASM need not process a cancellation
message. Busy cancel immediately terminates the worker; idle close allows100ms
for a valid zero-owned-resource acknowledgement and then terminates. Forced
termination never becomes a cooperative-zero claim. A zero C ownership ledger
means context/input/PCM have been freed; it does not mean WASM heap capacity or
Chromium RSS has returned to zero. Caller admission must additionally await its
own cache transaction rollback/drain before release. Deterministic fakes verify
these boundaries; actual worker termination/cleanup latency remains unmeasured.

## Proposed resident sampling and unchanged acceptance

`resident-coverage.mjs` is an unconnected runner seam. Target scheduling is100ms;
the **actual** maximum accepted gap remains250ms. Every observation brackets its
RSS read with full Chromium process inventories. Missing/duplicate/new/vanished
PIDs, invalid RSS, long captures, late samples and terminal-tail gaps permanently
invalidate coverage. The unchanged1GiB incremental ceiling remains independent
of the internal512MiB WASM maximum. A deterministic256ms sequence fails even if
later samples recover. Named/periodic sampling must use the existing serialized
sample queue when the later runner is assembled; first complete baseline must
precede runtime loading, watchdog checks run during pending captures, and every
violation must immediately stop the owned native run. This scheduling/teardown
wiring has **not** been executed or promoted to the original runner.

Two q8_0 copies total87,074,866bytes; candidate05 plus staged q8_0 totals87,147,898,
both below the unchanged100,663,296-byte atomic model-cache cap. Ignored research
archives are developer assets, outside that browser model-cache accounting.
The23 existing lifecycle/offline/quality cases remain in the shared original
LAB_CASE_NAMES list. All five failed ORT run records remain unmodified.

## Verification and the next gates

48 deterministic source/VM checks pass:23new plus25existing. The first combined
invocation omitted the existing lab's required experimental-vm-modules flag,
causing a module-import failure before those old VM tests ran; its log is retained.
The corrected command passed all48 with zero skips. Focused JS lint passes without warnings (one unnecessary test-regex escape was
removed after its first lint warning). No product build, native
compiler, full/performance/browser suite or inference was invoked for this
source-only checkpoint. Original source/dependencies/runner/contracts still match
500a483. `verify-assets.mjs` independently rehashes all eight assets and23saved
evidence files and repeats publisher/format checks without network or execution.

Commands, from this worker checkout:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue201/whispercpp/verify-assets.mjs
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS='--no-experimental-webstorage --experimental-vm-modules' node --test --test-concurrency=1 scripts/issue201/whispercpp/preparation.test.mjs scripts/issue201/lab-review.test.mjs scripts/issue201/composite-model.test.mjs
```

Build authorization must separately cover isolated extraction/activation of these
exact tool archives and offline compilation of the reviewed source/patch/recipe.
Do not invoke emsdk's install/download hooks or unversioned tools. Verify tool
versions and compile_commands/link response flags; inspect every WASM import,
export, unshared memory declaration and growth maximum before instantiation.
Record exact JS/WASM raw/gzip sizes/digests, complete build logs and linked
notices, then independently test compiled token guard/exception/allocation paths.
Only a later explicit native gate may instantiate/infer and run the unchanged23
cases with the reviewed100ms sampler. Memory, WER, timestamps, offline lifecycle,
cleanup and production integration remain open requirements.

Root separately authorized sync to its renderer integratione6a64a7 **after this
checkpoint is clean**, then caption Gate3 source work under its approved plan.
That independent caption authorization does not open any speech execution gate.
