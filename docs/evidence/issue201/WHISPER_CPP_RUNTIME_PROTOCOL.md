# Exact whisper.cpp laboratory protocol — source review

This checkpoint proposes one isolated runtime attempt after separate supervisor
review and an exclusive heavy-slot grant. It has not initialized the generated
factory, instantiated WASM, launched Chromium, or run inference. Speech remains
NO-GO. It adds only a separate laboratory directory and evidence; production
code, dependencies, the accepted C/build inputs and all failed ORT runs remain
unchanged. Parent generated-artifact checkpoint: 26370ca81410aaf797cf9c71f84b0928c38fa68a.

## Exact candidate

`whispercpp-runtime-source/manifest.json` binds the accepted multilingual tiny
q8_0 model, generated JS and WASM, existing Mediabunny, all five fixtures and the
original thresholds. `candidate.mjs` checks its canonical JSON SHA before use.
The model uses the existing explicit composition format with exactly one file;
this does not assert a new model composition or quantizer provenance.

| Input | Bytes | SHA-256 |
| --- | ---: | --- |
| Generated JS | 22,350 | db0bda310e36278e30b9c439f2d7acd026c4cddee1ecb930e027f622195c1ea7 |
| Generated WASM | 1,198,861 | 9df26c6b690de120e6f1fb5ce17a25ebb2b016a73f0477b24376f558ee00ce72 |
| ggml-tiny-q8_0.bin | 43,537,433 | c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca |
| Mediabunny JS | 624,835 | a7e7e14265b787de0daf23d379a8b4afa4b36b74711d71a2f5e075bff6a671a6 |

The model revision is 5359861c739e955e79d9a303bcbc70fb988958b1; its complete
bundle ID is sha256:6f4ab890b02876493211844b95d622da99199d8abb56ec54f6e37ca425091370.
Cache identity covers the canonical candidate hash, full model/source table,
runtime hashes, thresholds and sampling. A separate namespace isolates prior
candidate caches. The accepted runtime-notices ZIP and notice table are pinned.
Unknown exact quantizer provenance and lack of numerical parity remain explicit.

## Loading and ownership

Read-only preflight rehashes every source, reference, evidence record and all 16
served inputs; it parses the actual decompressed binary/glue and model format.
The server retains verified byte buffers, never rereads mutable source while
serving, and permits only the declared local GET URLs. Its CSP permits same-origin
scripts/workers and WASM compilation. Runtime assets use the original persistent
HTTP-cache policy; model acquisition uses explicit Cache Storage with provenance
headers, complete byte hashes, rollback and the unchanged 96 MiB cache budget.
Two complete model copies total 87,074,866 bytes before replacing the old cache.

The worker verifies generated JS bytes before importing the same immutable URL.
It supplies the exact WASM buffer to the unchanged accepted worker protocol,
which verifies WASM/model identity before calling the factory. Subsequent fetch
and XHR are replaced by rejecting functions. There is no blob/eval or alternate
factory path. Module imports remain bounded by the server allowlist and CSP.

The original native-audio window preparation and resampling functions are byte
identical. Every acquired AudioData closes in finally. Mono 8/16 kHz fixture
support, 30-second windows, 25-second steps and 12 windows for the 300-second
stress derivative are unchanged. The ledger charges both returned PCM and the
C-owned PCM copy against 3,840,000 bytes; preparation scratch stays 2 MiB.
Centisecond core results convert to seconds and pass the original bounded
segment checks. All-zero PCM skips inference; this is not a general VAD claim.

The accepted one-thread core keeps 64 MiB initial/512 MiB maximum unshared heap,
5 MiB stack, one context, 448 tokens for the whole call across seeks/retries and
120 seconds per call. Attempt 449 discards partial output. Logical owner counts
are not measurements of native resident memory. Core errors do not publish a
partial completion. The client binds replies to one owner/generation and records
forced termination separately from cooperative zero-resource disposal. Startup
without a first reply is bounded at 120 seconds; load/infer phases retain 120
seconds, other phases 10 seconds. Active cancellation terminates the worker;
idle disposal retains its reservation until acknowledgement or the 100 ms fallback.

## Cases and host limits

All 23 original case names, order, actions and assertions are preserved exactly,
except the browser reopen lifecycle now uses the owned launch/close helpers.
A source comparison test checks that sole substitution. English WER <= 0.20,
French WER <= 0.40, timestamp bounds, corrupt decode qualification, cache races,
local-file import, long workload, project replacement and all offline cases remain.
The frozen fixtures and thresholds compare deeply equal to the previous manifest.

| Host operation | Maximum wait |
| --- | ---: |
| Preflight and final input verification | 30 seconds each |
| Browser launch | 10 seconds internally, 12 seconds outer guard |
| Ordinary page/context setup | 10 seconds |
| Explicit cancellation phase wait | Original 120 seconds, within case time left |
| Ordinary case | 30 seconds |
| Speech/offline/corrupt-audio case | 300 seconds |
| Phase cancellation/project replacement case | 180 seconds |
| 300-second stress case | 1,800 seconds |
| Overall work | 3,600 seconds, interrupts pending case work |
| Each journal/final artifact write | 1 second |
| Sample drain | 500 ms |
| Browser close / second close after signals | 200 ms each |
| Owned signal loop | 1 second, identity rechecked before each signal |
| HTTP close / forced callback drain | 500 ms / 250 ms |
| Owned profile removal | 3 seconds |

These host guards supplement the unchanged core/window limits. Cleanup has
separate bounds after work stops. Setup CDP creation/version and sampling CDP/ps
also have explicit limits. `boundedWork` races the first stop signal so an overall
failure cannot wait for a long case's timer. Final process exit prevents unresolved
browser or filesystem promises from keeping the owned runner alive indefinitely.
A stalled OS operation or missing receipt is a failure, never evidence of release.

## Resident sampling and durable failure evidence

All candidate work, including acquisition/cache operations, runs inside a browser
epoch sampled with SystemInfo.getProcessInfo before and after each actual ps RSS
read. RSS is converted from KiB to bytes. Target cadence is 100 ms; any actual
capture/inter-sample/shutdown gap above 250 ms fails. PID churn, omitted rows,
invalid RSS, read errors and inventories that time out fail rather than dropping
processes. Available inventories, RSS rows and partial ps output remain in the
raw triggering record. The first sample above the 1 GiB complete-Chromium delta
cap fails; reopen preserves both the original baseline and the new epoch baseline.
At most 40,001 raw sample records are retained, including the triggering overflow.

Browser launch/bootstrap before candidate work and verified-absent reopen
intervals are disclosed separately; no RSS or cadence claim covers those intervals.
Every closed active epoch needs at least two complete samples and verified absence
within the 250 ms tail bound. Forced or late close fails independently.

Before work starts, exclusive files reserve runtime-attempt-01.json and
runtime-partial-01.jsonl under `.tmp/issue201-whispercpp-lab/`; profile-01 must be
newly created. A consumed marker cannot be retried or overwritten. The JSONL
journal flushes source, case starts/results, raw RSS, first failure and cleanup
receipts. Sampling initiates persistence before triggering immediate cancellation;
cleanup does not wait behind disk writes. Broken writes stop work and emit labelled
stdout fallback evidence. Final results use an exclusive flushed write, with a
labelled full JSON fallback if it fails. No evidence file or prior attempt is reset.

Cleanup signals only exact observed PID/start/command identities or executable
paths within the bundled browser cache carrying this exact owned profile token.
It rechecks identity before each signal and verifies absence afterward, including
launch failure before CDP setup. A pre-existing profile is never adopted, killed
or deleted. HTTP connections are forcibly closed after timeout; listening state
is recorded. Only the created profile is traversed/removed, without following
symlinks. Physical removal is distinct from application Remove-model acceptance.
Unverified physical/listener/profile release remains a reported failure requiring
external inspection; process exit alone is not proof of release.

## Source validation and execution gate

68 checks pass across eight source/VM suites: 26 new checks plus 42 existing
protocol, loader, build-guard, settings and actual generated-artifact checks.
New checks execute the real runner with inert browser/process/server/FS ports,
including stalled page, setup CDP, close, server close, journal and overall cases.
They cover partial inventory retention, marker reuse, pre-existing profiles,
actual 120-second proxy waits, worker seams, client startup and stale callbacks.
Worker core/decoder substitutes do not qualify native inference. Client tests
hash real model bytes but never load them into the generated factory. VM contexts
used for the new seams have WASM unavailable and code generation disabled.
Whole-project lint passes. No new production build or browser test was run.

Earlier source-authoring failures are retained: the initial host-guard test run
had 9 passes/5 failures from a missing proxy brace; its corrected 14-pass run and
subsequent expanded runs remain archived. The initial unused-import lint warning
and final clean lint are also preserved. These are own source/harness failures,
not baseline failures or native runtime findings.

Read-only reproduction, requiring no runtime grant:

    DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue201/whispercpp-lab/run-lab.mjs --verify-inputs

`--run` additionally requires committed pinned source, macOS, and both
ISSUE201_EXCLUSIVE_SLOT=1 and ISSUE201_PROTOCOL_SHA256 equal to the exact reviewed
checkpoint.json byte hash. Environment variables represent a separately granted
one-attempt authorization; setting them does not grant permission. No run command
has been invoked. The future attempt must stop on its first failure, retain all
raw evidence, verify physical release, and return the slot before any further run.
