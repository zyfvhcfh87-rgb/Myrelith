# Issue #201: pre-inference harness review fixes

Date: 2026-09-08. The orchestrator accepted the source/artifact direction at
`48cfcb82558258f5bcf9c1e9982a446ce70c7ed7` but withheld inference approval pending
the following fixes. That commit and its original evidence remain intact.

1. **Retiring owner admission.** The controller previously cleared `owner` before
   idle model disposal completed. It now retains the owner and a shared cleanup
   promise until acknowledgement or termination. All competing cancel/install/
   transcription paths await that drain; operation generations reject superseded
   requests. A failed disposal post terminates before admission is released.
2. **Exact source timing.** The worker no longer accepts a 20 ms segment overshoot
   or a 0.1 ms requested-source overshoot. The pure shared validator marks all
   overshoots/missing/invalid/order violations visibly untimed and preserves their
   original endpoints. Source coverage compares finite values directly without
   a media-time allowance. The separate sample-position grid check does not
   authorize increasing the requested source interval.
3. **Executable URL closure.** The runner and server now check GET plus the exact
   frozen served URL set, with one explicit favicon exception. Unknown same-origin
   paths, extra queries, external origins and other methods fail. Worker-only
   optional model probes remain explicit local misses and events.
4. **Prompt resident-limit stop.** The sampler marks the first observed breach,
   cancels the job, waits at most 100 ms for that cancellation, and closes the
   browser. No following case starts; partial results and the memory sample that
   triggered the stop are saved. This does not convert sampled RSS into an exact
   peak-memory or native allocation guarantee.

`node --experimental-vm-modules --test scripts/issue201/lab-review.test.mjs`
passes **7 tests**. Three evaluate the actual unmodified `lab-client.mjs` source
with fake browser resources: deferred idle disposal plus competing new jobs and
installation; active cancellation and late result rejection; and forced idle
deadline cleanup. They prove at most one live worker/model reservation, shared
drain behavior and stale promise rejection without inference. Other tests cover
exact end/one-over/missing/ordered timestamps, source coverage, result aggregate
bounds, exact request closure and the incremental resident threshold predicate.

The memory-stop wiring itself and native runtime cleanup still require the
exclusive browser experiment; a predicate unit test is not that evidence.
Node reports its expected experimental VM-module warning. No full suite, browser
or inference test was run, and no speech product enablement is implied.
