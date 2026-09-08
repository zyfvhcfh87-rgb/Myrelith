# Reservation candidate: build result and runtime03 proposal

The exact two-patch source at d973a08d0851607b1be2bfb62a662b55199a4b4e
built successfully once: configure 4.391 seconds, compile/link 28.960 seconds.
Independent process inspection at 2026-09-08T21:33:52.686940Z found both
processes/groups (48798 and 48987) absent. The compile slot is released.
Raw command logs, receipts and release are retained beside this checkpoint.
No generated factory, WASM or browser has run for this candidate.

The generated JavaScript is byte-identical to the preceding accepted artifact:
22,350 bytes, SHA256 db0bda310e36278e30b9c439f2d7acd026c4cddee1ecb930e027f622195c1ea7.
The WASM is 1,198,564 bytes (297 fewer), SHA256
fe816d4504944baaecd240aefb2c204d40bb7c18ab203738a0a1221b74e4e776.
Existing structural inspection passes: 59 function imports, 1,309 defined
functions, 22 exports including all 11 speech methods, fixed 1,162-entry table,
unshared 64/512 MiB memory, no implicit start. The generated stack global moved
from 5,923,760 to 5,923,408; the linker recipe still allocates a 5 MiB stack.
The original inspector's exact old-address assertion failed, as preserved in
generated-inspection.json. Its local copy changes only the two address literals;
all other inspections pass. This is byte/JS parsing, not instruction validation.

The original recipe, adapter, token helper, model, notices and provenance remain
unchanged. Only the accepted reservation guard and bounded numeric allocation
diagnostic patches changed native source. The failed reservation/request size is
still unmeasured. This is not a working transcription claim.

Runtime03 reuses the accepted runtime02 client, worker, observer, host limits,
RSS monitor, cleanup and all 23 acceptance cases. The copied runner changes only
the receipt directory and four attempt/profile/journal/result suffixes to 03.
The preflight changes only its receipt path, candidate module path and stack
inspector import. Candidate identities select this exact WASM and build source.
The model and JavaScript stay unchanged; the changed manifest isolates its cache.
All original runtime01/02 markers and raw failure records remain untouched.

The checkpoint pins these source copies, their actual runtime dependencies,
artifacts and build receipts. Fresh --verify-inputs checks those pins and all
17 served assets without starting a browser. Each new JavaScript file parses.
No new harness or acceptance expansion was added; existing inert checks apply
to the unchanged control logic. Runtime execution requires a separate explicit
exclusive grant and the exact checkpoint SHA in ISSUE201_PROTOCOL_SHA256:

    DEVELOPER_DIR=/Library/Developer/CommandLineTools ISSUE201_EXCLUSIVE_SLOT=1 ISSUE201_PROTOCOL_SHA256=<checkpoint SHA> node scripts/issue201/whispercpp-reservation-run/run-lab.mjs --run

The runner preserves the original timing, RSS and cleanup caps, stops at the
first failure and consumes a new exclusive runtime-attempt-03.json marker.
There is no automatic retry. The measured result will determine the next
bounded implementation decision; speech remains unavailable until qualified.
