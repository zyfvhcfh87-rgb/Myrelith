# Issue #201 historical encoder candidate contract

Date: 2026-09-08. **Research contract for review, not a changed lab manifest or
an execution grant. Speech remains NO-GO after run04.** All previous evidence,
runtime assets, worker/controller/runner and frozen thresholds remain unchanged.

## Concrete upstream artifact and native retention rationale

The unmodified published `Xenova/whisper-tiny` encoder at revision
`ce70c25689c3694faf5ec8206517cd53f0cfb03f` (July 8, 2023) has only
`last_hidden_state` as a graph output. Its quantized file is 10,113,248 bytes,
SHA-256 `ca9d7bb2836193704b7e2435e3bbadbed985ac3a79ab7406b244b8865ab1a5c0`.
[Immutable upstream file](https://huggingface.co/Xenova/whisper-tiny/blob/ce70c25689c3694faf5ec8206517cd53f0cfb03f/onnx/encoder_model_quantized.onnx).

The current graph declares four additional float32 attention outputs, each
`[batch,6,1500,1500]`. Exact pinned ORT `allocation_planner.cc:693–694` adds a
caller-use count to every declared graph output, preventing reuse; lines
1572–1574 select `kAllocateOutput` from the graph's declared output list.
These decisions do not use the JavaScript fetch-name list. This provides a
native lifetime reason to investigate the historical graph after run04 stopped
inside its first encoder invocation, before selected output copies returned.
[Exact ORT source](https://github.com/microsoft/onnxruntime/blob/b7804b056c30aa35c1748f8e4e239d0e2ff25d6d/onnxruntime/core/framework/allocation_planner.cc#L693).

Four declared outputs contain 216,000,000 bytes at batch one. Their removal
permits different native buffer lifetimes; it does not prove a 216 MB resident
saving, remove attention computation, or guarantee the fixed 1 GiB gate passes.
The eight MatMul and four Softmax operators still execute in the historical
encoder. Only a fresh reviewed measured run can establish actual peak/quality.

## Reproducible graph and weight comparison

`inspect-encoder-alternatives.py` reads only three exact size/hash-verified
upstream graphs. The shared metadata reader now has a guarded main function so
this second read-only probe can reuse it. Its original pinned metadata output
remains byte-identical, SHA-256
`d4e04252a7279e806cf1b22c806077eb0f9e597d93bf0ec5ba17645d6c867361`.
The probe never imports ONNX/runtime code, writes graph bytes or evaluates
weights. It decodes only bounded int64 shape constants for the view audit.

[encoder-alternative-comparison.json](encoder-alternative-comparison.json) binds:

- Both q8 encoders use IR6, default-domain opset11, `onnx.quantize` producer0.1.0,
  float32 `input_features` and float32 hidden output width384. The existing
  batch1/80×3000 input contract implies 1500 hidden positions in both graphs.
- All **121 initializer contents** match after excluding only their generated
  names. Exact encoded types, dimensions, weights, scales and zero points remain
  hashed. **121 occurrences in 119 named operator/input-slot groups** match too;
  duplicate groups are counted instead of overwritten.
- After documenting the eight added current attention views and the resulting
  downstream view/quantizer renaming, all **305 core operators** match in their
  attributes, input producer roles, quantizer output slots and weight identities.
  All **34 original Reshape occurrences** also match data inputs, attributes and
  recursively inspected target-shape expressions; duplicate anonymous names are
  retained as groups. No original transpose or view is ignored in this check.
- The extra two views in each current attention layer reshape Softmax output to
  `[batch,6,target,source]` for the graph output, then back to
  `[batch*6,target,source]` for the existing MatMul. The record contains all eight
  shape-expression trees, scalar constants and attribute bytes. The historical
  path feeds that Softmax result directly to the same MatMul.

This is explicit structural evidence, not a completed numerical parity or model
quality claim. Different optimizer planning can still alter native execution.
The source-bound English/French quality and segment-timestamp gates stay required.

## Package, tokenizer and generation compatibility

The whole historical seven-file package is 62,907,806 bytes. Its committed plus
staged total is 125,815,612, exceeding the unchanged 96 MiB (100,663,296) cache
budget. **Do not substitute the entire old package.** Its tokenizer configuration
also predates added-token metadata; version labels alone cannot qualify it.

The concrete proposal is an explicitly identified **local composite**: retain
all six current decoder/config/tokenizer/processor files at revision
`5332fcc35e32a33b86612b9a57a89be7906102b1`, substituting only the exact published
historical encoder. This is not a single upstream revision. Total model bytes
would be 43,610,465; committed plus staged 87,220,930, within the original bound.
No graph conversion, renamed weight payload, historical decoder, tokenizer
rollback or runtime update is proposed.

Keeping the current six files preserves the existing decoder's hidden-input
contract, decoder cache/present outputs, language ids, tokenizer, generation
configuration and segment timestamps. The historical preprocessor is identical;
its config differs only in exporter version and missing median-filter width,
and generation config only in exporter version. These observations support an
encoder-only comparison, not adoption of the historical tokenizer. The actual
current six bytes must rehash unchanged in any next frozen candidate.

## License history and transparent source identity

[encoder-alternative-source-evidence.json](encoder-alternative-source-evidence.json)
binds cards, repository history, exact file metadata and source hashes. The
historical Xenova card names `openai/whisper-tiny` as its source but has no license
field. The current Xenova card declares Apache-2.0; that current declaration must
not be relabeled as a declaration present in the historical artifact.

The original OpenAI model card at immutable revision
`ed50ab0ea2fc43b928969fd70d5fe21eefdd350f` already declares Apache-2.0 on
May 5, 2023, before the encoder export. The card is 19,787 bytes, SHA-256
`57a3bbbbf1e79369e4d1ced790812a1723b43a256c1b43fc70cc2f3339ae9881`.
[Historical original model card](https://huggingface.co/openai/whisper-tiny/blob/ed50ab0ea2fc43b928969fd70d5fe21eefdd350f/README.md).
This supplies a historical upstream declaration independently of the current
Xenova card. Preserve the upstream attribution, Apache notice and the absence
of a separate historical converter declaration in the review; do not invent an
exporter source revision or claim that equal weights alone settles provenance.
No agreement was accepted and no model is enabled by this research.

## Required next implementation boundary, only after contract review

1. Give the local composite an explicit bundle identity. Record each file's
   source repository, immutable source revision, upstream path, logical local
   path, byte length and digest. Distinguish the current configuration revision
   passed to the local-only SDK from the composite's content identity. Do not
   call the historical encoder a file from the current revision.
2. Bind the complete per-file source table, composite identity, runtime settings
   and encoder-output contract into cache keys/registry verification, readiness
   and raw evidence. Keep exact allowlisted aliases and reject drift. The worker
   must never discover or fall back to remote/historical package files.
3. Serve the historical encoder from its separately verified scratch source;
   retain original current bytes and preserve the candidate04 manifest. The
   preparer must reproduce only the reviewed explicit file composition and
   recompute full committed/staged byte admission before any write/eviction.
4. Update the instance adapter's declared output contract to exactly the one
   published hidden output, retaining batch/IO checks, original owners, events,
   decoder outputs and disposal. Keep the QDQ setting and all 23 frozen cases,
   RSS sampling/stops, audio/window/token/time limits and quality thresholds.
5. Add deterministic manifest/source-identity, missing/tampered component,
   cache-identity and singleton encoder-output regressions. Commit/freeze and
   obtain source review plus a separate exclusive run grant before inference.

The uint8 encoder in the current package was also inspected: it still exports
all four attention matrices. Its lower count of shape nodes is insufficient
native-memory evidence. Newer onnx-community package cards lacked a license
field, and the automatic ONNX variant's selected q8 decoder alone exceeds the
cache budget. These observations are retained; no unreviewed fallback is active.
