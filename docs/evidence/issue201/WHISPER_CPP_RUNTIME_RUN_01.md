# whisper.cpp runtime attempt 01: initialization abort

The single granted attempt at source commit
73395b5e39df01b6e19b0fb847cc2079d3f437d6 failed during initialization. Product
speech remains NO-GO. Eight acquisition/cache cases passed, the first English
case failed, and fourteen of the original twenty-three cases were not reached.
There was no retry or change to the reviewed source, model, generated artifacts,
resource limits or fixtures. The exclusive slot was released after independent
physical verification at 2026-09-08T20:23:26.616921Z.

The accepted protocol checkpoint SHA-256 was
074d223786a46d3d58d094b23e1b26da1a218f927524cb78bf42919089b810e0.
Fresh read-only preflight and final verification both matched all 16 served
inputs and the source/reference/evidence pins. Six unrelated caption drafts
were recorded before the run and paused while the slot was held.

## Observed failure

Runner PID 27397 started at 20:22:35.993Z and exited with status 1. The browser
was HeadlessChrome/151.0.7922.34, revision
782af9cb30a53f54487e5d2e44738645a8ec457c, on macOS arm64 with Node v26.8.1.
The first eight no-model, acquisition/cancellation, complete cache, corrupt-cache,
local-file and capacity cases passed. `transcribe-english-8` failed in 113 ms:

    Core Aborted(). Build with -sASSERTIONS for more info.; cooperativeZero=false

The recorded worker phases were model-cache-read, runtime-import and model-load.
The worker read the exact 43,537,433-byte model and the server delivered the exact
accepted generated JS and WASM. No ready, prepare, infer, window or complete
message occurred; the ledger recorded zero native audio samples and windows.
The initialization route calls the generated factory and then allocates/loads
the model. This generic abort does not locate the failure within that route.
The accepted protocol silences print/printErr, so the result does not contain a
more specific native diagnostic. No allocation cause, unsupported instruction,
model-format cause or successful native initialization is inferred from it.

The client recorded error termination in 0 ms at browser timer precision,
cooperativeZero=false. This means forced worker termination, not proven
cooperative native cleanup. The runner stopped immediately and started no later
acceptance case. Model load completion, speech quality/timestamps, silence,
corrupt decode, cancellation phases, long workload, project replacement and
all three offline checks remain unqualified.

## Memory and cleanup

Fifteen complete before/after process observations covered the short active
browser epoch. Baseline was 272,777,216 bytes; sampled peak was 778,502,144 bytes,
a delta of 505,724,928 bytes against the fixed 1,073,741,824-byte allowance.
Maximum active-epoch gap was 109 ms, below the unchanged 250 ms limit. The
monitor qualified this observed epoch only. The early initialization abort
prevents full runtime/resident qualification or comparison with a successful
inference workload. Browser bootstrap remains outside the disclosed epoch.
No heap-ready event was returned, so an actual initialized heap size is unknown.

The browser closed in 70 ms with no forced process signal, and the runner
verified all owned browser processes absent. Final cooperative model/cache
cleanup remained unavailable, explicitly recorded as a problem. Separate
filesystem teardown removed only the created profile: 83 files / 46,130,163
bytes. This is not an application Remove-model pass.

An independent process/port/profile check after runner exit verified PID 27397
and recorded browser PIDs 27426, 27427, 27428 and 27429 absent, port 5201 refused
with errno 61, and profile-01 absent. No awake helper was created by this worker.
The root-owned awake process was not altered. The exact browser command/start
identities and release time are retained in runtime-independent-release-01.json.

## Evidence

All raw files are copied byte-for-byte under `whispercpp-runtime-run-01/`.

| Raw file | Bytes | SHA-256 |
| --- | ---: | --- |
| runtime-results-01.json | 72,111 | c89c7a700c805acc02085f504fc4ad0bc3839ac3b325b4c4688e3c3925c0c21d |
| runtime-partial-01.jsonl | 59,032 | b95f224e0c25648396f128ab9dbcf39eb0326fb21305e6892226d25c15d6db79 |
| runtime-attempt-01.json | 208 | a87c1ba7f077403a65b4d1fd91c6cfdeefcdcb45e84600daeca19db4a3a0639b |

The journal has 46 sequential records, including the final run-complete record.
The final JSON's journal counter is 45 because it is captured immediately before
that last record is appended; the original raw value is preserved. The journal
was not broken. Its fifteen raw RSS samples and nine case results exactly match
the final JSON. The unchanged acceptance and resident monitor functions reproduce
the stored results, including the absent cases and qualified short epoch.
`analysis.json` records these derived facts; it does not replace raw evidence.
The checkpoint pins the report, decision update, exact accepted protocol and all
raw records. No production build, new source correction or diagnostic runtime
was performed as part of preserving this failed attempt.
