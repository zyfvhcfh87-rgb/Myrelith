# Issue #201 speech run 04: memory ceiling still exceeded

Date: 2026-09-08. **Candidate04 is NO-GO under the unchanged memory gate.**
One explicitly granted run used clean `d1ea1245075c7ac1bbaedaba8f7368989021d742`
and manifest SHA-256
`4aebb4adbd8c0a00615065f4dd3c0d1da5259e2daf5a37f71489e0c5732470e7`.
No runtime, model, fixture, threshold, baseline or in-run setting changed.

Untouched [lab-run-04-results.json](lab-run-04-results.json): 82,594 bytes,
SHA-256 `bf19cdcfa9c68f59799588dc14e8b646df88c068cc6aa003c029619c6972c60d`.
The raw record binds Chromium 151.0.7922.34, arm64, single-thread WASM, session
options, actual encoder-fetch policy and six source file hashes.

## First encoder call and measured stop

Eight initial no-model/acquisition/cache/local-file/capacity cases passed. Model
initialization completed in 370.2 ms. English preparation reached inference with
46 acquired and 46 closed native samples, zero live samples, 374,720 PCM bytes,
one model and one input owner, and zero completed windows.

The actual `encoder-fetch-start` event records call 1 requesting only
`last_hidden_state`, omitting `encoder_attentions.0` through `.3`. There is no
`encoder-fetch-complete` event. The fixed resident guard stopped this first call
before it returned; no transcript or inference window completed. This proves the
adapter was reached with the reviewed selection, not a completed output-copy
saving or lower native allocation. Sampled peaks from separate guarded failures
must not be advertised as a reliable performance improvement.

Eight complete Chromium process RSS samples, maximum gap 253 ms:

| Measurement | Bytes |
| --- | ---: |
| Idle baseline | 271,794,176 |
| Last sample before breach | 1,242,103,808 |
| Triggering sampled absolute peak | 1,371,209,728 |
| Triggering incremental peak | **1,099,415,552** |
| Frozen incremental ceiling | **1,073,741,824** |
| Excess above ceiling | **25,673,728** |

The browser/renderer/GPU/network totals are complete for every recorded sample;
an inter-sample peak could be higher. The active worker was force-terminated
(recorded 0.1 ms), explicitly `cooperativeZero: false`. Chromium closed 41 ms
after the triggering sample. The failed case records `Worker terminated:
resident-ceiling`; the raw stop reason independently preserves the cause.

## Incomplete acceptance and teardown

Acceptance is `failed-incomplete`: 9 of 23 case results, 8 pass, 1 fail and 14
missing. Quality, timestamps, minimum/long workloads, later cancellation phases,
project replacement and fresh offline inference remain unqualified.
`memoryAssessment` stays null because the suite did not finish; the resident
threshold itself demonstrably failed. No fallback or second run occurred.

Emergency browser closure prevented cooperative cache clearing. The raw
`finalCleanup` remains unavailable, with a corresponding problem. After runner
exit, process inspection found no owned runner or Chromium processes (recorded
browser PID 7532), and port 5201 had no listener. Only this runner-created private
profile `profile-1788866529270` was then removed: 109 regular files / 138,077,022
bytes. [lab-run-04-teardown.json](lab-run-04-teardown.json) records its absence.
This is filesystem teardown, not proof that the application Remove model action
passed. Prior raw evidence, model fixtures and user profiles remain untouched.

The exclusive slot was released after teardown. Mandatory speech acceptance
remains unresolved. Any further native execution needs a new evidence-backed,
frozen candidate, review and a fresh grant. Independent ASS/batch work continues.
