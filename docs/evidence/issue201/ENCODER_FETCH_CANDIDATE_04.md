# Issue #201 candidate 04: fetch only the consumed encoder result

Date: 2026-09-08. **Unqualified lab proposal; no new run or speech GO.**
The run 03 memory rejection remains preserved. This candidate keeps the same
model, runtime, QDQ setting, fixtures, segment timing, windows and ceilings.

## Exact source and model evidence

The read-only `scripts/issue201/inspect-model-metadata.py` checks the pinned model
revision, lengths and SHA-256 before reading protobuf metadata. It skips raw
tensor data and never imports or executes a model. Its field layout follows the
primary ONNX schema. [pinned-model-graph-metadata.json](pinned-model-graph-metadata.json)
is 28,592 bytes, SHA-256
`d4e04252a7279e806cf1b22c806077eb0f9e597d93bf0ec5ba17645d6c867361`.
[memory-source-evidence.json](memory-source-evidence.json) binds primary native
sources and exact runtime archive/source-map members.

The encoder declares `last_hidden_state` and four `encoder_attentions.0–3`
outputs. Each attention is float32 `[batch_size, 6, 1500, 1500]`: at batch one,
the four contain **216,000,000 bytes**. This is tensor-shape arithmetic, not a
measured resident reduction. The merged decoder exposes logits, present/cache
tensors and decoder/cross attentions separately.

Pinned Transformers 4.2 `models/modeling_utils.js:739` consumes only
`last_hidden_state` during generation preparation. Its `encoder_forward:1136`
uses `model.sessions.model`; `sessionRun` and the backend call
`session.run(ortFeed)` without selecting outputs. Pinned ORT's embedded
`inference-session-impl.ts:103–108` therefore fetches every declared output.
The public [ORT inference session API](https://onnxruntime.ai/docs/api/js/interfaces/InferenceSession.html)
allows a fetch-name array. `session-handler-inference.ts:118–141` converts selected
names to native output indices; `wasm-core-impl.ts:867–1042` iterates only those
outputs and copies each CPU tensor from WASM into a new typed array. Selecting
the hidden state avoids the four attention copies on this path. It does not
remove their graph computations or guarantee smaller native buffers/WASM heaps.

Segment timing stays unchanged: Whisper enables token attention for
`return_token_timestamps`; this lab requests segment timestamps. No decoder
outputs, present/cache tensors or timing options are filtered. No graph,
third-party runtime asset or shared prototype is patched.

## Instance adapter and owners

`encoder-fetch-policy.mjs` verifies the pinned encoder input/output names,
captures that instance's original `run`, and invokes the supported
`run(feeds, ['last_hidden_state'])` overload with the original receiver and
feed tensor owners. It returns the original result. Every other session,
metadata accessor and release function remains unchanged; normal model disposal
still releases every session.

The adapter rejects changed interfaces, extra caller arguments or anything other
than one float32 80×3000 feature matrix. This is the existing 30-second padded
feature contract, not a shorter audio window. Unexpected outputs/native failures
reject without retry or all-output fallback. Start/complete events record output
names without tensor data. Failed installation retains the model-owner ledger
until the existing parent cleanup/termination path runs.

Eighteen deterministic lab regressions pass, including actual worker/controller
source with fakes, feed/result/receiver identity, repeat calls, decoder cache
preservation, unchanged release, changed interfaces, error propagation and
refusal of extra output requests. They do not prove native peak memory or quality.

## Frozen inputs and alternatives

- New manifest SHA-256:
  `4aebb4adbd8c0a00615065f4dd3c0d1da5259e2daf5a37f71489e0c5732470e7`.
  The sole semantic change is `runtime.encoderFetchPolicy`. Cache identity,
  readiness and raw runtime metadata include it. The runner hashes/serves the
  adapter through its exact request allowlist.
- Prior manifest is preserved as
  [replacement-manifest-qdq-disabled-all-outputs.json](replacement-manifest-qdq-disabled-all-outputs.json),
  SHA-256 `22504ec7552baeb4adc6c024a4d6ce65306730a1cbf366dd343719636faa07f3`.
- All 23 model/runtime/notice/fixture files rehash unchanged. Runtime assets remain
  14,073,343 raw / 3,627,462 gzip bytes; model 43,622,127 bytes. The adapter is
  additional lab harness code, included in source/transfer evidence rather than
  those asset totals.
- Disabling arena or memory patterns again changes nothing: exact served JS
  already coerces omitted flags to false; pinned `wasm/api.cc:136–145` explicitly
  disables both. Non-training memory-pattern caching starts after first execution,
  so enabling it is not a demonstrated first-window fix. Avoiding known unused
  copies has more direct support than changing allocators. Replacing graph/runtime
  bytes would require a new compatibility/provenance decision; none is implied.

Run 03's peak may precede output copying, so this adapter may still fail the
fixed 1 GiB incremental ceiling. All 23 cases, 120-second window limit, 448-token
budget, 300-second workload, quality/timestamps, sampling and immediate stops
remain fixed. No 216 MB RSS saving, extra GC, shifted baseline or shorter fixture
is claimed. Review the frozen commit before granting a fresh exclusive slot.
