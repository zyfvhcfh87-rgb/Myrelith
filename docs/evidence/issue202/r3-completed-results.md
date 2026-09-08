# Corrected R3: completed readback and retained 4K deadline no-go

The single granted completion-correction run is finished and its slot released.
**The bounded 1080p preview stage passes; the measured 4K preview configuration
fails the frozen deadline envelope.** This result does not promote a full
managed renderer or HDR product path. Run 1 remains unchanged, with its
finish-only preview completion claims still unqualified.

## Exact run and environment

Starting/completion commit: `cd47ab73b2027a5f59be062dae2f1efb26fd22e0`.
Runner SHA256: `561a0621ca819a6f84750435c37691fa66df675ef79ee883ab1c85524939cf9c`.
[Raw corrected result](r3-completed-run-1.json) SHA256:
`250e58426d16ffc3e29bd668f4913bd122f0187e4290b4483654f042d524801c`.
Started 2026-09-08 11:33:29.909 UTC; completed 11:34:28.015 UTC;
controller elapsed 57,835.5 ms. All 109 checked source identities match.

CDP reports `HeadlessChrome/151.0.7922.34` and revision
`@782af9cb30a53f54487e5d2e44738645a8ec457c`, matching the
[version-pinned source audit](r3-completion-source-audit.json). Backend is
ANGLE/SwiftShader driver 5.0.0. Requested additional flag remains `--mute-audio`;
full command-line disclosure remains unavailable. Native Apple GPU performance,
physical HDR presentation and other browser/OS combinations are unqualified.
The compatibility user-agent string is not physical CPU/OS evidence.

Twenty workers were created and terminated, with zero active and zero owned
API-resource ledger at every terminal job. Ten completed start/draw/stop cycles,
five cancellation jobs and context-loss rejection/fresh-owner retry completed.
No timeout, forced termination, warning or error occurred; console contains two
Vite debug entries. Browser/server close was awaited before process exit, and
port 5202 had no listener afterward. The slot was released before this audit.

## Completed preview timing

The corrected owner reads one charged RGBA8 pixel from the final framebuffer
before a preview frame returns. Setup includes an initial returned composition
after both uploads; it remains separate from the 30 warm-up/120 planned measured
frames. The topology, equations, fixtures, thresholds and baseline are unchanged.
These are worker-stage completion and synthetic 30 fps schedule observations,
not physical presentation or audio-master playback. Per-frame decode/upload and
the complete editor pipeline are not included.

| Size / repetition | Baseline p95 (ms) | Candidate p95 (ms) | Candidate measured frames | Candidate deadline misses | Decision |
| --- | --- | --- | --- | --- | --- |
| 1080p / 0 | 10.5 | 7.9 | 120 | 0 | Pass, necessary resident stage only |
| 1080p / 1 | 11.2 | 10.4 | 120 | 0 | Pass, necessary resident stage only |
| 1080p / 2 | 10.1 | 10.6 | 120 | 0 | Pass, necessary resident stage only |
| 4K / 0 | 24.0 | **Not computed** | 79 | 2 | **Absolute no-go certificate** |
| 4K / 1 | 23.9 | 27.5 | 120 | 0 | This repetition passes |
| 4K / 2 | 23.1 | 27.8 | 120 | 1 | This repetition passes |

There are **1,399 measured timing rows**, eleven complete runs and one bounded
early stop. The protocol requires all three repetitions to pass; two later
passes do not override the first 4K failure. No repeat was made to obtain a
different outcome. Baseline deadline misses are zero in all repetitions.

The failing row preserves `absoluteDecision=no-go-certificate`, while its
paired ratio preserves `decision=unqualified-incomplete-pair` and `ratio=null`.
These answer different questions. Two misses already exceed 1% of the planned
120 frames even if every unmeasured frame would succeed; no complete p50/p95 is
invented. A summary must not replace the absolute failure with the incomplete
ratio's unqualified status.

The exact missed frames explain the limit of the inference:

| Frame | Draw/completion duration | Start delay against schedule | Deadline overrun |
| --- | --- | --- | --- |
| 77 | 27.5 ms | 6.0333 ms | 0.2000 ms |
| 78 | 27.3 ms | 6.3000 ms | 0.2667 ms |

All recorded durations in that partial run are ≤28.2 ms. The failed condition is
the recorded synthetic schedule, including delayed starts; it is not proof
that the shader intrinsically needs more than 33.33 ms or that every 4K/native
GPU configuration is incapable. The fixed miss-rate rule is retained exactly.

## Setup, memory, correctness and lifecycle

Completed candidate setup is 137.9 / 134.7 / 130.7 ms at 1080p and
333.5 / 343.4 / 339.2 ms at 4K. Its separately recorded submission-only setup is
69.6 / 67.7 / 68.5 ms and 243.3 / 248.3 / 245.3 ms. This separation avoids
counting pending initial upload as completed setup. Baseline setup is
2.5 / 2.7 / 2.9 ms and 9.6 / 8.9 / 7.9 ms.

The preview probe is four bytes and fits the original allowance. Declared
candidate preview peaks remain 58,552,356 bytes at 1080p and 233,226,276 at 4K;
the setup tile determines the peak before the probe is allocated. Baseline
peaks are 49,766,400 and 199,065,600 bytes. The 256 MiB known-image ceiling is
unchanged. Browser/driver duplication, native process memory, GC timing and
immediate physical reclamation are unmeasured.

Tiny Float32/RGBA16F readback passes the original 40 independent cases and
another 40 on the fresh owner after context loss. Maximum continuous view error
is 0.24179671793365287 code, alpha error 0.00022157300420166948, working RGB
error 0.00044314600840333895. This qualifies the fixed 8×1 fixture; the full-size
checker image is not independently compared pixel-by-pixel.

Every corrected lifecycle preview draw returns through the one-pixel readback.
The ten start/draw/stop cycles finish with zero owned ledgers. Five export-stage
cancellation acknowledgements are 9.8 / 9.7 / 9.8 / 9.3 / 9.6 ms, below 250 ms,
with one target frame returned and zero owned ledger each. Their setup uses
one initial completed frame with the existing full readback. Context loss
rejects the old owner; the fresh owner's 40 comparisons pass. Delete calls,
worker termination and awaited browser teardown remain distinct from native
reclamation or a long-running leak qualification.

No full export timing pair was repeated. The [original run's full readback
timing](r3-run-1-results.md) remains separate evidence: candidate p95 8.0–8.1 ms
at 1080p and 31.0–32.3 ms at 4K, below its fixed absolute/paired stage limits.
No codec or media-file export was performed by either R3 experiment.

## Audit and consequence

[verify-r3-completed.mjs](verify-r3-completed.mjs) checks all 109 source entries
against immutable `cd47ab7` Git objects, runtime revision, raw source identities,
all 1,399 samples, eleven complete p95s, the exact 79-frame failure certificate,
five finite paired ratios/one incomplete pair, 80 numeric comparisons and all
terminal ledgers. Its [derived analysis](r3-completed-analysis-1.json) retains
the absolute 4K no-go independently from the unqualified ratio. Run 1's hash is
also checked; its original values and qualification defect remain unchanged.

The [R4 decision](final-decision.md) combines this bounded result with the
unchanged scope precision failure, P3 transfer no-go, codec/metadata evidence,
SDR preservation and unsupported/unmeasured platform boundaries. No production
source, dependency, schema, ABI, UI, artistic defaults or SDR behavior changed.
