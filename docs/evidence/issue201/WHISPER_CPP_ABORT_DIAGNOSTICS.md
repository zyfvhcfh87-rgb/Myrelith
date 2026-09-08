# Initialization abort: bounded JS diagnostic proposal

Run01 at73395b5 failed with the generic `Aborted()` message during the worker's
model-load phase. The source review can explain lost diagnostics, but cannot
identify the exact native failure site from that result. This proposal records
context around the existing generated module; it changes no generated JS/WASM,
C code, build flags, model, work budgets, resident limits or acceptance cases.
It is source-only. No rebuild, assertions build or runtime retry has occurred.
The faithful failed run is committed separately atb046a67.

## What the actual source establishes

The accepted generated JS's `__abort_js` import calls `abort("")`. Its `abort`
function forwards that empty value to onAbort, prints `Aborted()` through err,
then throws WebAssembly.RuntimeError with the generic assertions suggestion.
Other abort routes exist; the generic message does not uniquely identify the
C caller. The generated startup selects supplied printErr and print functions.

The accepted core supplies empty print/printErr callbacks; onAbort only changes
its state to faulted. Its catch sends `error.message` and discards the exception
stack. Its load operation verifies model/WASM bytes, calls the generated factory,
checks the returned heap, calls _speech_model_alloc, copies the model, and calls
_speech_load. The existing phase covers all of those steps, so the failed raw
phase alone cannot distinguish them.

The C adapter calls whisper_log_set(quiet_log). Exact accepted whisper.cpp source
shows that this also installs the quiet GGML log callback. WHISPER_ASSERT reports
through the suppressed Whisper logger before aborting. Separately, ggml_abort
formats a bounded 2048-byte fatal message and directly fprintf's it to stderr
unless an abort callback is set, then aborts. That direct stderr path bypasses
ordinary logging but still reaches the currently silenced JS printErr path.

`source-excerpts.json` records exact line ranges and full-file hashes. The ggml.c
hash matches the accepted archive extraction inventory; the actual whisper.cpp
hash matches the accepted token patch's after hash. The generated artifact,
protocol and adapter are pinned by reference. No C source was executed in this
investigation. Model preflight and format validation remain valid prior facts;
they do not prove successful native loading or exclude every runtime failure.

## Smallest proposed observation change

`observe-module.mjs` wraps the supplied factory, preserving its options, supplied
WASM bytes and locateFile function. It retains bounded stderr, the onAbort
argument and callback stack, and caught exception stacks. It forwards the
original callbacks and rethrows the original error. After factory return, it
wraps only _speech_model_alloc, _speech_load and _speech_close to record entry,
return and exception phase. The original module object, live heap properties,
method receiver, arguments, results and native-call count are preserved.

The recorder stores at most64 records and32,768 UTF-16 code units of text, with
at most2,048 per record. It keeps the latest tail and explicitly counts omitted
and truncated records. It does not stringify arbitrary objects, retain native
heap views or retain Error objects. These diagnostic records are separate from
logical resource ownership and memory/heap acceptance.

The unapplied `proposed-wiring.patch` shows the precise worker and preflight
integration: wrap the factory passed to the unchanged protocol; emit one bounded
native-diagnostics event in finally after load succeeds or fails; serve the
one added JS module. The existing client already records that event and the
runner retains the failed state. Applying the patch is not an execution grant.
It has passed `git apply --check` against the exact current frozen source.

This cannot recover messages already silenced by the C quiet callback. It can
capture direct stderr and distinguish factory/allocation/load failures, with
WASM/JS stack context where the runtime supplies it. It does not fix the abort
or guarantee a diagnostic message from every native path. No assertion, heap,
model or callback-selection correction is proposed without evidence.

## Verification and remaining gate

Five tests pass using the unchanged actual core protocol and fake module exports:
factory abort, allocation abort, load abort, successful identity/receiver/heap/
callback behavior, and bounded diagnostic overflow. Real model bytes are hashed
by the protocol but no generated factory or WASM API executes. The supplied four
WASM fixture bytes are never compiled or instantiated. Whole-project lint passes.

The active run01 worker, runner, manifest and checkpoint remain byte-identical.
The proposed wiring is not applied. Before a diagnostic runtime, the supervisor
must review this change and a separately pinned complete candidate/one-attempt
entry point that preserves the consumed run01 marker and evidence. Any such
runtime still needs a fresh exclusive grant. No slot is held and speech remains
NO-GO; transcription remains required by issue #201.
