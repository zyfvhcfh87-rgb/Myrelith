# Cooperative cancellation source checkpoint

Follow-up starts at merged master 4fc0ac8205b0a5a18b6ada754c753f9f19083cee.
Runtime06's resident-memory failure remains unchanged. This source proposal
addresses immediate terminate/recreate admission; it is not yet a measured
memory fix or permission to enable production speech.

Only the lab client and worker change, in `scripts/issue201/whispercpp-cancellation`.
The existing native module, model, protocol, generated artifacts and resource
limits are reused. No compiler, generated factory or WASM was executed.

Cancellation promptly rejects the request and marks its owner as retiring.
Retries and project replacement share that owner's cleanup promise; they
cannot allocate another worker until a matching disposal acknowledgement.
Retiring/stale jobs cannot publish results or start transcription on a late
ready message. Disposal acknowledgement remains owner-scoped across generation
changes. Sample counts must be nonnegative safe integers and equal, alongside
zero model/input/sample/PCM owners, before cleanup is acknowledged.

The worker accepts cancellation control while another message is active. It
yields to queued control messages before model loading, during preparation,
and around each inference window. After cancellation it stops before another
window/output, closes the input/iterator/samples, calls the existing native
close protocol, and acknowledges the actual ledger. Pre-load cancellation
occurs before creating the core, so zero is known without treating the empty
core's unacknowledged close as success. Already-ended native errors preserve
their exact code and cleanup result without a second close attempt.

The disposal policy changes explicitly: idle disposal retains 100ms. Active
retirement receives only the remaining current phase deadline plus 100ms,
never a fresh 120 seconds. Existing phase limits remain 120 seconds for model
loading/inference and 10 seconds for preparation/other setup. Request rejection
does not wait for this drain. A timeout, trap, malformed acknowledgement or
unknown native cleanup terminates the worker but latches speech admission
unavailable until reload; a late reply cannot reopen it. No guessed cooldown,
forced garbage collection, cap relaxation or automatic retry is introduced.

The 1 GiB incremental resident ceiling, 512 MiB WASM heap, model/cache sizes,
300-second workload, 30-second windows and 448-token limit remain unchanged.
Native zero makes ownership explicit; it does not prove physical RSS release.
The remaining measured lifecycle gate is still required. The production seam
remains the existing app media scheduler/admission authority; no production
imports or new scheduler are introduced by this checkpoint.

Thirteen inert tests execute the actual client/worker with fake native work:
prompt rejection with retained admission; retry/project replacement races;
stale replies; remaining deadlines; timeout/trap failure; malformed counts;
pre-load and in-flight load cancellation; in-flight inference draining with
no subsequent output/window; preparation cleanup; unchanged twelve-window
work; and acknowledged versus unacknowledged native errors. All pass. Targeted
lint and diff checks pass. These tests do not qualify native memory or timing.

    DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS='--no-experimental-webstorage --experimental-vm-modules' node --test --test-concurrency=2 scripts/issue201/whispercpp-cancellation/client.test.mjs scripts/issue201/whispercpp-cancellation/worker.test.mjs

The next measured runner must reuse runtime06's cases and frozen assets,
route only these two replacement modules, and expect the new acknowledged
terminal cleanup in the existing short-source rejection case. Source review
and an explicit exclusive runtime grant remain required before measurement.
