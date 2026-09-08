# Issue #201 speech run 03: fixed resident-memory ceiling exceeded

Date: 2026-09-08. **Candidate 03 is NO-GO under the unchanged memory gate.**
The approved exclusive run used clean `cf1442d699ee7b60062633c55f30ddadb69ac487`,
whose lab source is identical to reviewed `4e8d9db`, and manifest SHA-256
`22504ec7552baeb4adc6c024a4d6ce65306730a1cbf366dd343719636faa07f3`.
No runtime/model/fixture, case, threshold or in-run configuration change occurred.

Untouched [lab-run-03-results.json](lab-run-03-results.json): 93,231 bytes,
SHA-256 `6f93d8ead5fcd3ddae0c50a6db6d3ee85ea222912dd334034771e95690ef1e95`.
It records Chromium 151.0.7922.34, arm64, single-thread WASM, exact session options,
source hashes, network/cache events and complete process RSS observations.

## Progress and measured failure

The eight initial no-model/acquisition/cache/local-file/capacity checks passed.
The model initialized in 365.3 ms with the explicit QDQ fusion setting, avoiding
run 02's initialization error on this attempt. The first 5.855-second English
source reached decode, preparation and inference. At the inference boundary the
ledger showed one model and one input owner, zero live sample owners, 46 acquired
and 46 closed native audio samples, 374,720 PCM bytes and zero completed windows.
This qualifies that particular initialization and preparation path only.

Eight complete Chromium process RSS samples were recorded (maximum gap 254 ms):

| Measurement | Bytes |
| --- | ---: |
| Idle baseline | 272,941,056 |
| Last sample before breach | 1,254,506,496 |
| Triggering sampled absolute peak | 1,390,755,840 |
| Triggering incremental peak | **1,117,814,784** |
| Frozen incremental ceiling | **1,073,741,824** |

The observed incremental usage exceeds the ceiling by 44,072,960 bytes. These
are complete relevant browser/renderer/GPU/network process totals, not model
payload arithmetic or instrumented WASM allocations. Sampling may miss a higher
inter-sample peak. The baseline and threshold were not changed after observing
the failure; earlier acquisition/cache activity remains part of this frozen run.

The guard immediately cancelled and terminated the active worker (recorded
0.1 ms controller cleanup), then closed the browser 41 ms after the triggering
sample. This is forced cleanup, explicitly `cooperativeZero: false`. There is
no completed transcript, timestamp result, completed inference window or closed
inference residual measurement. The raw first case reports the interrupted
Playwright evaluation, while `stopReason` preserves the causal resident breach.

## Incomplete checks and teardown

Overall acceptance is `failed-incomplete`: 9 of 23 cases have results, 8 passed,
1 failed and 14 explicitly missing. The automatic guard prevented any further
cases or alternate configuration. Quality, silence, minimum/long-work, later
phase cancellation, project replacement and fresh offline execution remain
unqualified. `memoryAssessment` is null because the full suite did not finish;
the separately recorded resident breach is an actual failed threshold.

Emergency browser closure prevented cooperative application cache removal.
The raw result preserves `finalCleanup.status: unavailable` and a corresponding
problem; it is not rewritten into a passing cleanup check. After the runner
exited, process inspection confirmed no owned runner/browser and no listener on
5201. The worker then deleted only the verified runner-created private profile
`profile-1788864717587`, which contained 107 regular files / 137,935,346 bytes.
[lab-run-03-teardown.json](lab-run-03-teardown.json) records this filesystem
teardown and confirmed profile absence. It removes that disposable profile's
persisted cache without claiming the application's Remove model action passed.
No user browser profile, model fixture or prior raw evidence was deleted.

The exclusive slot was released after teardown. No retry or new candidate is
authorized by the expired grant. Speech remains an unresolved mandatory issue
criterion. A next candidate would need evidence-backed source/configuration
changes, new frozen provenance, review and a fresh slot; caption-only progress
does not make issue #201 complete.
