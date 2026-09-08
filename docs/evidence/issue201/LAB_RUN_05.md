# Issue #201 speech run 05: historical encoder exceeds the memory ceiling

Date: 2026-09-08. **Candidate05 is NO-GO under the unchanged memory gate.**
One explicitly granted exclusive5201 run used clean source
`500a4834de99db221c1be47f60b01db4f52af58b`, manifest SHA-256
`c68800d6b46bcecd9bbdfe7ed8abc853bcb8cf194bbe98dc3fd39518f37c8804`, and bundle
`sha256:f480eedc77e25c9f851469714c50af263417fb2122ab48e329888a83464f3509`.
All original limits and23 cases were retained. No in-run source, asset, graph,
setting, threshold or integration change occurred; no fallback or rerun followed.

Untouched [lab-run-05-results.json](lab-run-05-results.json): **97,436 bytes**,
SHA-256 `61a151c71f8bfe0ed39d411544a3954253e4357fe60971452505ff6f7269ad16`.
The raw record binds nine source file hashes, complete selected component
identities, Chromium151.0.7922.34/arm64, single-thread WASM, runtime versions,
session settings and the historical singleton encoder contract. The read-only
preflight passed before execution and was repeated after the stopped run;
original candidate04 bytes, selected composite, runtime, notices, fixtures,
manifest and all nine source hashes remained unchanged.

## First encoder call and the measured stop

Eight initial no-model/acquisition/cache/local-file/capacity cases passed. Model
initialization completed in360.3ms and its ready event reported the selected
bundle and full per-file source table. English5.855s preparation reached
inference with46 acquired/46 closed native samples, zero live samples,
374,720PCM bytes, one model and one input owner, and zero completed windows.

The first `encoder-fetch-start` requested `last_hidden_state` and recorded an
empty omitted-output list, matching the historical singleton graph. There is
no `encoder-fetch-complete`, inference window or transcript before the resident
guard stop. The structural model comparison did not establish a lower measured
native peak. Separate guarded runs cannot establish numerical parity or a
reliable comparative memory improvement.

Eight complete Chromium process RSS samples:

| Measurement | Bytes |
| --- | ---: |
| Idle baseline | 272,433,152 |
| Last sample before breach | 1,245,921,280 |
| Triggering sampled absolute peak | 1,379,778,560 |
| Triggering incremental peak | **1,107,345,408** |
| Unchanged incremental ceiling | **1,073,741,824** |
| Excess above ceiling | **33,603,584** |

Every observation contains complete browser/renderer/GPU/network RSS totals.
The maximum observed gap is **256ms**, exceeding the grant's250ms maximum-gap
requirement. The unchanged runner schedules a250ms interval; observed timestamp
gaps are preserved and are not relabeled as meeting that requirement. This is
an additional qualification limit, independent of the demonstrated memory
failure. An inter-sample peak could be higher than the recorded peak.

The guard force-terminated the active worker in a recorded0.2ms, explicitly
`cooperativeZero: false`, and closed Chromium40ms after the triggering sample.
The failed case and independent raw stop reason both identify the resident
ceiling. No external HTTP request appears in the recorded browser request list.

## Incomplete acceptance and verified teardown

Acceptance is `failed-incomplete`:9/23 case results,8 pass,1 fail,14 missing.
Quality/timestamps, later cancellation phases, replacement, minimum/long jobs,
offline reload/reopen and Remove-model remain unqualified. `memoryAssessment`
stays null because the full suite did not finish. The raw `finalCleanup` stays
unavailable; forced shutdown is not cooperative model-cache removal.

After runner exit, successful process inspection verified all recorded Chromium
PIDs62273/62276/62274/62275, the issue201 runner and the exact private-profile
process absent. Port5201 had no listener. Only the timestamp-verified
`profile-1788874313046` was removed:111 regular files/138,007,556 bytes and no
symlinks. [lab-run-05-teardown.json](lab-run-05-teardown.json) records its absence,
post-run source/asset verification and separate filesystem-cleanup scope. Prior
profiles, model files and previous raw evidence remain untouched.

**Exclusive5201 slot released at2026-09-08T13:33:35.383Z after teardown.**
The single grant is consumed. Production speech remains NO-GO; mandatory speech
acceptance is unresolved. Any next native candidate requires fresh source
evidence/review and a separate run grant. Caption staging remains independent;
no painter/UI promotion or integration sync occurred during this run.
