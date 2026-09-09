# Deferred-logits build and runtime04 proposal

The single-line source at0eeb375d923922988aa7e82f574c32b3c4c5da59 built once:
configure55097 exit0 in4.447s; compile55644 exit0 in33.933s. Independent release
at2026-09-08T21:52:32.462103Z found both process groups absent. No slot held.

JavaScript is unchanged (22,350B, SHA256
db0bda310e36278e30b9c439f2d7acd026c4cddee1ecb930e027f622195c1ea7).
WASM is1,198,475B, SHA256
2fbfa40076f5807d3a23af65c92adf93cfcdc16dec959711b2c4258ca387548a.
Existing inspectors pass all import/export/loader/memory checks:59imports,
1,309functions,22exports including11speech methods, fixed1,162-entry table,
unshared64/512MiB memory and no implicit start. The linker stack address changed
from5,923,408 to5,923,456; the copied inspector changes only its two literals.
Its original old-address assertion is retained in the compact inspection record.
The recipe still reserves a5MiB stack. No generated factory or WASM has run.

Runtime04 reuses the exact runtime03 client, worker, observer,23cases, RSS and
deadline limits and cleanup. Only candidate identity, receipt paths and the four
attempt/profile/journal/result suffixes change. The previous model, JS, notices
and raw failures are unchanged. A new manifest identity isolates this cache.
No new harness or acceptance cases were added. Four scripts parse; the existing
preflight checks the new checkpoint and17served assets without executing WASM.

One explicit exclusive runtime grant and the checkpoint hash are required:

    DEVELOPER_DIR=/Library/Developer/CommandLineTools ISSUE201_EXCLUSIVE_SLOT=1 ISSUE201_PROTOCOL_SHA256=<checkpoint SHA> node scripts/issue201/whispercpp-deferred-logits-run/run-lab.mjs --run

The new runtime-attempt-04.json marker is single-use. Stop at first failure; no
automatic retry. Speech remains NO-GO until the unchanged acceptance passes.
