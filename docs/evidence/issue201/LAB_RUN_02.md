# Issue #201 speech lab run 02: session preparation failure

Date: 2026-09-08. **Speech remains NO-GO; no inference occurred.** The exclusive
run used clean reviewed `36588c9ef4608206f6b5c8beda0c7cdb88683f57`, unchanged model,
runtime, fixtures and acceptance thresholds, with manifest SHA-256
`ee3043df0f8d04d895fb1c2c90a32c905c733e4ae53bbfd2516798db8d6582dd`.

The untouched [lab-run-02-results.json](lab-run-02-results.json) is 89,914 bytes,
SHA-256 `b33eab7f8ac7200836a3ec0b94d7b4980d95e8f0cf8986fb45a0fd8458b9d797`.
It records source/script hashes, browser 151.0.7922.34, single-thread arm64 WASM
configuration, requests, process observations, case evidence and final cleanup.

## What reached its intended stage

All eight initial checks passed: no-model/lazy-runtime behavior, acquisition
cancellation, verified install, cancelled cache writes and publication preserving
the committed model, rejection of corrupted cache before inference, selected
local files, and capacity rejection preserving the model. The first English
case then failed during `model-load`. All seven pinned model files were served
by exact cache aliases, and the WASM binary was requested successfully. Run 01's
cache lookup prerequisite is resolved.

The new failure is structured `initialization-failed`:

```text
Can't create a session. ERROR_CODE: 1, ERROR_MESSAGE: qdq_actions.cc:137
TransposeDQWeightsForMatMulNBits Missing required scale:
model.decoder.embed_tokens.weight_merged_0_scale for node:
model.decoder.embed_tokens.weight_transposed_DequantizeLinear
```

The error identifies session graph preparation; it does **not** prove corrupt
weights, a broken audio decoder or poor transcription. Its worker ledger reports
zero model/input/sample/PCM/window owners. No ready-model event, decoded audio,
transcript, timestamps or inference measurement exists.

## Stop and qualification

The corrected runner stopped immediately on this systemic prerequisite, saved
evidence, and exited 1. Acceptance is `failed-incomplete`: 9 of 23 cases reached a
result, with 8 passed, 1 failed and 14 explicitly missing. No impossible phase
wait, manual termination, runtime substitution or threshold change occurred.
The later quality, silence, corrupt-audio, decode/inference cancellation, project
replacement, long-work and offline cases remain unqualified.

Final cleanup was verified before browser close: zero worker/acquisition owners,
idle phase, missing-model status, zero storage usage and only the empty registry
cache remaining. After the runner exited, scoped process inspection found no
owned lab/browser processes and no port 5201 listener. The orchestrator also
independently verified this and released/reassigned the exclusive slot.

Only six complete process RSS observations exist, all before the initialization
failure: baseline 271,761,408 bytes, sampled peak 814,350,336 bytes, delta
542,588,928 bytes, maximum sample gap 255 ms. They cannot establish inference peak
or post-inference residual memory;
the raw `memoryAssessment` is null. No measured inference-memory gate pass is
claimed. Request evidence is confined to the lab's same-origin served set.

The next authorized step is source investigation of this exact runtime/model
interoperability, including documented session optimization settings. Any next
configuration or runtime candidate must be explicit, measured where applicable,
committed and reviewed before a fresh exclusive run. The product speech criterion
remains unresolved while independent ASS/batch work continues.
