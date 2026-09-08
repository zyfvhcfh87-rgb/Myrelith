# Issue #201 configuration candidate 03: disable QDQ fusion

Date: 2026-09-08. **Source-reviewed proposal; no inference or speech GO.**
Run 02 is preserved separately, including its failed session preparation.

## Evidence and smallest proposed change

The pinned ORT package revision resolves to
`b7804b056c30aa35c1748f8e4e239d0e2ff25d6d`. Its `qdq_actions.cc:121–137`
implements `TransposeDQWeightsForMatMulNBits` and returns the exact observed
missing-scale error when `Graph::GetInitializedTensor` fails for that input.
This is a lookup during graph rewriting, not an ONNX integrity verdict. We have
not established whether outer-scope handling or another earlier transformation
causes the missing lookup; no model repair or re-export is justified by this run.

The same revision registers `DQMatMulToMatMulNBitsAction` through
`QDQSelectorActionTransformer`. `graph_transformer_utils.cc:368–379` gates that
transformer on `disable_quant_qdq`; its public session configuration header
defines `session.disable_quant_qdq` with string `"1"` disabling QDQ fusion.
This controls a family of quantization optimizations, not only the failing node.
Sources and downloaded content hashes are in
[interop-source-evidence.json](interop-source-evidence.json), notably
[the failing action](https://github.com/microsoft/onnxruntime/blob/b7804b056c30aa35c1748f8e4e239d0e2ff25d6d/onnxruntime/core/optimizer/qdq_transformer/selectors_actions/qdq_actions.cc#L121),
[transformer registration](https://github.com/microsoft/onnxruntime/blob/b7804b056c30aa35c1748f8e4e239d0e2ff25d6d/onnxruntime/core/optimizer/graph_transformer_utils.cc#L368),
and [configuration definition](https://github.com/microsoft/onnxruntime/blob/b7804b056c30aa35c1748f8e4e239d0e2ff25d6d/include/onnxruntime/core/session/onnxruntime_session_options_config_keys.h#L44).

Proposed frozen `pipeline(..., { session_options })` value:

```json
{
  "graphOptimizationLevel": "all",
  "extra": { "session": { "disable_quant_qdq": "1" } }
}
```

`all` makes the previous default explicit; the change disables QDQ fusion through
the supported option. It leaves other optimization families enabled. Compared
with replacing model/runtime assets or disabling every graph optimization, this
changes fewer independent variables and directly targets the observed path.
It is a hypothesis to test, not a proven compatibility fix.

## Supported route to the runtime

The exact Transformers 4.2.0 archive's `src/pipelines.js:111,167`,
`src/models/modeling_utils.js:277–291`, `src/models/session.js:77–80,150–157` and
`src/backends/onnx.js:286–299` forward caller session options into the constructed
encoder/decoder sessions. The worker passes a deep copy because ORT adds nested
defaults; its frozen evidence manifest must not be changed by initialization.

The served `ort.wasm.min.mjs.map` embeds `../lib/wasm/session-options.ts` whose
SHA-256 is `ffdb6352b62bd4a2a68b17334403be97cb01ba06d14b4093943d47de4f882598`,
identical to the pinned source. It defaults graph level to `all` and forwards
`extra` through `iterateExtraOptions`; the embedded `wasm-utils.ts:21–46` flattens
nested keys with dots into string session config values. The upstream
[JavaScript SessionOptions reference](https://onnxruntime.ai/docs/api/js/interfaces/InferenceSession.SessionOptions.html)
also documents the WASM graph setting and `extra` session options. No custom
binary patch, undocumented environment switch or alternate execution provider
is involved.

## Frozen inputs and review boundary

- New [replacement-manifest.json](replacement-manifest.json) SHA-256:
  `22504ec7552baeb4adc6c024a4d6ce65306730a1cbf366dd343719636faa07f3`.
  The only semantic manifest change is `runtime.sessionOptions`. `preparedAt`
  retains the original asset preparation time; this document dates configuration.
- Previous exact manifest is preserved as
  [replacement-manifest-default-optimizations.json](replacement-manifest-default-optimizations.json),
  SHA-256 `ee3043df0f8d04d895fb1c2c90a32c905c733e4ae53bbfd2516798db8d6582dd`.
- All model/runtime/notice/fixture bytes, versions, licenses, request boundaries,
  23 planned cases and accuracy/timestamp/lifecycle/memory ceilings are unchanged.
  Runtime remains 14,073,343 raw / 3,627,462 gzip bytes; model 43,622,127 bytes.
  Source-only manifest update does not rerun asset preparation or model loading.
- Cache compatibility identity now includes runtime artifact hashes and session
  configuration. Ready events and raw runtime metadata record that configuration.
  No silent retry with another option, graph, model, runtime or threshold exists.
- Sixteen deterministic laboratory regressions pass. Two new regressions execute
  the actual controller/worker source with resource fakes: configuration/assets
  change cache identity, and initialization forwards the exact options while
  preserving manifest data and releasing its model on disposal. These fakes do
  not establish native ORT compatibility. The VM experimental warning is expected.

Disabling fusion may increase model load cost, inference duration and resident
memory. The same 120-second/window and 1 GiB incremental ceilings still reject
this candidate if exceeded; no performance improvement is promised. All quality,
timestamp, cancellation, repeat-work and fresh offline requirements remain
binding. No browser/model run occurs until this exact commit is reviewed and a
fresh exclusive slot is explicitly granted. Speech remains NO-GO meanwhile.
