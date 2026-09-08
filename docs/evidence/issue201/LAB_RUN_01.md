# Issue #201 speech lab run 01: loader prerequisite failure

Date: 2026-09-08. **NO-GO for speech enablement. No model inference occurred.**
The exclusive frozen run used clean `e21e7621ed07e9faee95c569617d376d915ac33e`,
whose lab files were unchanged from reviewed `b4f1942`.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools ISSUE201_EXCLUSIVE_SLOT=1 node scripts/issue201/run-speech-lab.mjs
```

The raw result is preserved unchanged in [lab-run-01-results.json](lab-run-01-results.json):
370,555 bytes, SHA-256 `9c9cfd11d34ea603d002df9ca32f7e09107683f511f8c140cf23506b40a03b1f`.
It binds source/script/manifest hashes, Chromium 151.0.7922.34, arm64 runtime
configuration, complete process samples, requests, cache facts and worker events.

## Failure and honest classification

Transformers requested `customCache.match('/models/Xenova/whisper-tiny/config.json')`.
The adapter included the absolute same-origin and model-relative forms but
omitted this leading-slash local form. The miss produced a second cache-only
probe for the model's `resolve/main/config.json` URL. The strict fetch boundary
denied the subsequent known-model local fallback, and the runtime reported a
missing config with remote models disabled. No external network request occurred.

Pinned 4.2.0 `src/utils/hub.js` confirms local cache paths use `env.localModelPath`
and revision is ignored for local requests. Identity must come from the exact
verified manifest/cache, not assuming SDK local keys contain a revision. The
correction must add only exact pinned-file aliases, preserving rejection of
other revisions, queries, files and remote-main fallback keys.

Every initialization-error ledger has zero model/input/sample/PCM/window owners.
No WASM binary request, decoded audio or inference output was produced. This
is a lab-adapter prerequisite failure, not measured model accuracy or performance.

The raw summary is 10 passed / 13 failed. Its meaning is narrower:

- Eight initial no-model/acquisition/cache/local-File/capacity cases passed.
  Cancelled writes/publication preserved the prior complete cache; digest
  corruption rejected before worker creation.
- Final remove-model/offline-no-model returned the expected missing-model status
  with zero worker/acquisition owners.
- The raw corrupt-audio pass is **invalid codec qualification**: it accepted the
  same earlier model-loader error. It must require a structured decode/job error
  after successful model initialization.
- English/French/silence/minimum-window cases failed during initialization.
  Remaining lifecycle/long-work/offline cases are unqualified or aborted; their
  failures do not establish problems in those downstream subsystems.

## Stop, cleanup and memory scope

The frozen runner continued after the fast failures, then waited for a phase
that had already failed. To preserve its in-memory report while avoiding further
long timeouts, only its verified private Chromium PID 76544 (parent lab Node
76519) received SIGTERM. The current wait ended after 90,264 ms. That intervention
is failure evidence, not a passing application cleanup test.

The parent recorded immediate closed-browser failures, ran its frozen persistent
offline-reopen case (same loader failure), removed the model cache, and exited
nonzero with JSON saved. All browser/server/cache work settled. Exact process
inspection found no live lab Node/Chromium, and port 5201 had no listener. The
slot was released; no rerun is authorized under that expired grant.

There were 368 complete process observations and zero incomplete observations;
maximum gap 258 ms. Initial RSS: **271,810,560 bytes**; peak: **784,269,312 bytes**;
delta: **512,458,752 bytes**. Final-idle after a different reopened browser:
**383,451,136 bytes**. These are pre-inference acquisition/JavaScript/browser
measurements. Successful closed-inference residuals and the long-work inference
peak do not exist, so this run does not qualify the 1 GiB inference threshold.

The next harness must stop on the first structured initialization failure, save
representative failure/cleanup evidence promptly, and avoid waiting for phases
after a job failed/completed. Overall acceptance must be incomplete/fail when
required cases never reach their intended stage. No model/runtime/asset hashes
or accuracy/timing/memory threshold changes accompany these corrections.
Compatibility, quality/timestamps, inference memory/timing, decode cancellation
and offline model initialization remain unresolved pending a new committed,
reviewed source and a fresh exclusive slot.
