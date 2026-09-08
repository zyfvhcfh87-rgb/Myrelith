# Null backend buffer — static call-path review

Parent runtime evidence 9651c8f9f8ae04133a314e573bfc69f47ff417cc remains a
failed, incomplete attempt. This checkpoint inspects existing bytes and source;
it does not compile, initialize WASM, launch a browser or rerun the candidate.
The original candidate, native limits, run01/run02 markers and raw evidence stay
unchanged. A working local transcription route is still required.

## Captured path and concrete error-handling gap

The existing optimized binary contains no function-name section. Saved pre-link
intermediates have names but different executable sections and function indices;
their names must not be assigned to runtime stack indices. Instead, the exact
accepted WASM was disassembled with the already installed `wasm-dis` tool. Its
59 imported functions precede 1,309 definitions; disassembly `$160` therefore
corresponds to runtime function 219, not function 160.

Runtime function 219 contains the observed line-124 buffer assertion and the
separate line-138 base assertion. Function 540 matches the graph allocator's
reallocation checks, buffer reset, leaf loop and node/source loops. Function 198
matches the scheduler's graph split/allocation flow. These source identities
come from control flow, data access and assertion literals, not debug symbols.

| Exact binary position | Observed or adjacent action |
| --- | --- |
| Function 198, `0xd607` | Calls reservation function 542, then discards its result |
| Function 198, `0xd613` | Captured stack offset: second call to graph allocator 540 |
| Function 540, `0x473b5` | Captured stack offset: first of three calls to function 219, in the leaf allocation loop |

The source counterpart in `ggml_backend_sched_alloc_splits` calls
`ggml_gallocr_reserve_n` at line 1584 without checking its boolean result, then
calls `ggml_gallocr_alloc_graph` again. The generated binary visibly drops that
return value. This is a concrete error-handling defect: a failed reservation
does not stop the next allocation pass.

Reservation updates planned node/leaf sizes and addresses before attempting
physical backend buffers. A failed physical allocation can therefore leave a
plan that passes the next size checks despite a missing buffer. Leaf setup then
enters `ggml_vbuffer_tensor_alloc`, which calls `ggml_backend_buffer_get_base`
on the selected chunk. On wasm32, reading from a zero linear-memory address
does not provide the native null-pointer fault one might expect on a host;
the captured assertion is the reliable observed failure here.

The trace proves that the second allocation path reached the null-buffer
assertion. It does not record the preceding reservation's result or the failed
allocation size. A failed reservation is consistent with this path, but is not
independently measured. No heap-exhaustion, corrupted-model, backend-registration
or numeric-size cause is claimed. CPU buffer allocation can return null when
aligned allocation fails; zero-sized requests have a separate dummy-buffer path.

## Small proposed correction and missing diagnostic

Two unapplied native patches are supplied for review:

- Stop scheduler allocation when `ggml_gallocr_reserve_n` returns false, allowing
  the existing error propagation and cleanup path to handle the failure.
- Emit one fixed-format stderr record on virtual-buffer metadata allocation
  failure or backend-chunk allocation failure, containing only numeric index and
  requested bytes. Existing ordinary logs remain silenced by the adapter. Direct
  stderr reaches the already bounded JS observer, which retains 64 records /
  32,768 UTF-16 code units. These failure records add no native allocation,
  inference calls, model text, tensor dumps or retry.

The diagnostics distinguish metadata failure from a specific backend request.
They do not independently prove OS exhaustion, available contiguous WASM space
or the error returned by aligned allocation. The first proposed correction fixes
the ignored result; neither patch is claimed to make the model fit or produce
transcription. Heap, RSS, stack, token, time, cadence and work bounds stay fixed.

Both patches were actually applied to disposable copies of the exact accepted
source, and their resulting bytes were checked. They were not applied to the
candidate source. This qualifies patch application and source review only;
no C compiler or C syntax check was run because compilation needs a new grant.
A future candidate must have an updated immutable recipe, source identities,
generated artifact review and separate runtime grant before execution.

## Evidence and reproduction

`whispercpp-null-buffer-source/` pins source excerpts, compressed complete
disassembly for functions 198/219/540, captured instruction-byte checks and the
disposable patch receipts. Source files match the accepted extraction inventory,
except `whisper.cpp`, whose hash matches the accepted token-budget patch output.
No historical checkpoint or failure result is rewritten.

The read-only verifier confirms the actual binary SHA, function-body ranges,
captured call bytes and their targets, and checks the saved disassembly against
the raw runtime stack. It is not a general instruction validator or a substitute
for the disassembler/source review:

    DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue201/whispercpp-diagnostic-evidence/verify-stack.mjs

Caption UI checks proceeded separately: 11 focused UI tests and typecheck pass.
The preceding typecheck caught a test using a text/timing-only store action for
style setup; the test now loads a complete fixture through the supported document
boundary. That was our test defect, not a baseline failure. Full caption UI
browser, export and lifecycle acceptance remains pending.
