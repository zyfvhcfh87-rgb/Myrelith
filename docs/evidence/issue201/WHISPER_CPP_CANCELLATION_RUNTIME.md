# Cancellation runtime07 proposal

The source at 0df9fd53c886b55aac3ade7719038fe054873e66 was accepted after
supervisor review and independent 13/13 inert tests. This runner uses the same
runtime06 assets and complete preflight without generating another inventory.
Only the reviewed lab client and model worker are substituted. The original
manifest, model, WASM, glue, core protocol and resource limits are unchanged.

All 23 case names remain. The existing short-source rejection now requires
the worker's actual cooperative-error acknowledgement. Existing model-load,
prepare and inference cancellation cases plus project replacement capture
the immediate retiring owner and require acknowledged zero before the next
case can allocate. Other case bodies, quality/source-coverage predicates,
host deadlines, resident sampling and first-failure stop remain unchanged.
Native cancellation/resource behavior, the long workload and offline/removal
cases still need measurement. No success verdict is inferred from unit tests.

The only disposal policy change is the accepted source contract: prompt request
rejection; retain admission through the remaining current phase deadline plus
100ms; retain idle 100ms; block further speech in the page after unknown cleanup.
The 1 GiB resident delta and 512 MiB WASM heap limits remain fixed.

Fresh single-use runtime-attempt/profile/journal/result suffixes are 07. Both
runner/preflight syntax checks and the reused 17-asset inert preflight pass.
No compilation or native run was performed for this checkpoint. A separate
exclusive grant is required for the following one-attempt command:

    DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage ISSUE201_EXCLUSIVE_SLOT=1 ISSUE201_PROTOCOL_SHA256=<checkpoint SHA> node scripts/issue201/whispercpp-cancellation/run-lab.mjs --run

Earlier failed outcomes and source checkpoints remain unchanged. No automatic
retry, forced garbage collection, cooldown or relaxed acceptance is introduced.
