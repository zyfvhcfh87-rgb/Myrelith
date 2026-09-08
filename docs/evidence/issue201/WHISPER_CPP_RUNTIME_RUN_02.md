# Diagnostic runtime attempt02 — failed initialization, released

One separately granted diagnostic attempt ran at source commit
406cbcb6af10c3e57b71a367caf3b193ae03dddd, with checkpoint SHA-256
5351db3c709f200338a6cad122320dcfe1d5908494064de31c1eda6e1458186b.
The runner started at 2026-09-08T21:01:22.979Z and exited 1. Eight cases passed;
the first English transcription case failed during initialization after 122 ms;
fourteen cases were not run. First failure stopped the attempt. No retry occurred.
Speech remains NO-GO; an opt-in working local route still requires qualification.

## What the diagnostics establish

The generated factory returned, and `_speech_model_alloc` returned pointer
5933608 for the exact 43,537,433-byte model. `_speech_load` then emitted:

    ggml/src/ggml-backend.cpp:124: GGML_ASSERT(buffer) failed

The exact source file matches the accepted extraction inventory: 96,019 bytes,
SHA-256 507577061d22e673a4f002bb215c65aa9c63b88a4e6d1586f52c74ca0b98fa07.
Line 124 is the initial argument assertion in `ggml_backend_buffer_get_base`.
It runs before inspecting buffer size, metadata or the backend base pointer.
This establishes a null backend buffer passed to that function during model
load. It does not establish why the buffer was null, the requested allocation
size, heap exhaustion, or the complete native call chain. The preserved WASM
stack offsets remain unsymbolized. The assertion is not the later base-pointer
assertion at line 138.

The observer retained 12 records containing 1,628 UTF-16 code units, with zero
omitted or truncated records. It captured direct native stderr, the empty abort
argument, callback stack, thrown RuntimeError stack and subsequent cleanup call.
`_speech_close` returned -92. The worker reported `cooperativeZero=false` and
was forcibly terminated after about 0.1 ms (browser timer precision applies).
The diagnostic event precedes the original initialization error in raw evidence.

There was no ready event, audio preparation, inference, window completion or
transcript. Audio sample and PCM counters remained zero. No ready heap value
was available. Logical owner counters do not prove native resource release.

## Resident measurements and cleanup

| Observed active epoch | Result |
| --- | ---: |
| Complete RSS samples | 15 |
| Initial Chromium RSS | 288,129,024 bytes |
| Sampled peak Chromium RSS | 834,797,568 bytes |
| Peak delta from initial baseline | 546,668,544 bytes |
| Maximum actual epoch gap | 109 ms |
| Browser close | 59 ms |

The frozen resident monitor qualifies only this short observed epoch. These
measurements do not qualify inference, long workloads, offline reopening or
the full runtime. Browser launch/bootstrap remains separately disclosed and
outside active-epoch coverage. No cap, sampling rule, candidate artifact, model,
fixture or native setting changed from the accepted diagnostic proposal.

The runner verified browser absence without signals, closed its HTTP listener,
and removed only its owned profile02: 88 files, 89,670,574 bytes. Profile removal
is physical teardown, not an application Remove-model pass. Cooperative final
model/cache cleanup remained unavailable because the browser had already closed.

An independent process/socket/filesystem check at
2026-09-08T21:02:08.528434+00:00 confirmed runner PID 38084 and observed browser
PIDs 38113, 38114, 38115 and 38116 absent; port 5201 returned connection-refused
errno 61; profile02 was absent. There was no owned awake helper. The exclusive
slot was released immediately. No new grant is implied by this evidence.

## Preserved evidence and reproduction

`whispercpp-runtime-run-02/` retains exact raw marker, 46-record JSONL journal,
final result, independent release, outer output and input/grant preflight bytes.
The 9 case results and 15 RSS records in the journal exactly match final JSON.
Final JSON's journal counter is 45 because it precedes the last run-complete
record; this is preserved without rewriting. All 17 served asset receipts match
the final input verification. Original run01 files and consumed marker remain
unchanged; all prior failed ORT evidence also remains untouched.

The read-only verifier recomputes the frozen acceptance and resident assessments,
checks journal sequencing and raw case/sample equality, validates diagnostic
bounds and ordering, and produces the preserved analysis:

    DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue201/whispercpp-diagnostic-evidence/verify-run02.mjs

It never starts a browser, factory or WASM runtime. Caption UI work is separate
and was paused for the native attempt. No caption UI acceptance, production build
or working speech route is claimed by this checkpoint.
