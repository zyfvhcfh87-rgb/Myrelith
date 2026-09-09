# Cooperative cancellation runtime07 result

Source b051d8b23e209125655fed9006b3a44d8410cda9, protocol
b9cab56866d04e41984b20c5d9d52e786106bb4f4622cc33b8e9777e26349114.
The single granted attempt started at 2026-09-09T09:05:26.839Z with runner
73045 and exited 1: 18 cases passed; the long workload failed; four offline,
reopen and removal cases remain unrun. No automatic retry occurred.

All four cancellation/project-replacement checks captured a retiring owner
before acknowledgement, then cooperative zero before the next job. Disposal
took 46.7ms during model-load, 9ms during preparation, 5718.7ms during inference,
and 5696.9ms after project replacement. Pending requests rejected promptly;
the resource owner remained retained while native work drained.

The observed resident-memory failure from runtime06 did not recur. There were
419 samples, baseline 286,965,760B, peak 1,172,373,504B and delta 885,407,744B,
under the unchanged 1 GiB incremental ceiling. Maximum sample/active-epoch gap
was 110ms; no resident/cadence violation was recorded. This qualifies only the
observed work, not the remaining long/offline workload.

The long case failed after 17.297s with exact
`Core inference--944; cooperativeZero=true`. Windows 0–30s and 25–55s each
produced five valid chunks. The next full 30-second window, 50–80s, failed the
native source-coverage check. This is not limited to the one-second fixture.
No complete job result was returned, and no timestamp was clipped or fabricated.
The terminal per-job cleanup was cooperative-error with an observed zero ledger.
Final runner cache cleanup remained unavailable after emergency browser close.

English WER remained 0.058823529411764705 twice; French was 0.4. Silence,
safe short-source rejection, cache and corrupt-input checks passed. The long
coverage failure and unrun offline/removal cases prevent an overall GO.

Independent release at 2026-09-09T09:06:29.122451Z confirmed runner 73045 and
browser PIDs 73075, 73076, 73077, 73078 absent, port 5201 refused (61), and
profile07 absent. No owned awake helper or exclusive slot remains. Five exact
raw outcome records are archived with identities in raw-records.json; earlier
source, failure evidence, model and generated artifacts remain unchanged.
