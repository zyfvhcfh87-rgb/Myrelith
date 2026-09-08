# Short-output diagnostic build and runtime05 proposal

The accepted diagnostic source at 6d5e8d75757c10b7c9caf1b907747b76201769fb
built once: configure 60333 exited 0 in 4.119s; compile 60520 exited 0 in
30.004s. Independent release at 2026-09-08T22:11:52.356343Z found both PIDs
and process groups absent. No slot is held.

JavaScript is unchanged: 22,350 bytes, SHA256
db0bda310e36278e30b9c439f2d7acd026c4cddee1ecb930e027f622195c1ea7.
WASM is 1,198,488 bytes, SHA256
6f4f665168d8845c22b2e95930e939afde49f5922ca557e2ed0060a143846459.
Existing static inspectors pass: 59 imports, 1,309 functions, 22 exports
including 11 speech methods, fixed 1,162-entry table, unshared 64/512 MiB
memory, and no implicit start. The stack address changed from 5,923,456 to
5,923,424; the copied inspector changes only its two address literals. The
first old-address assertion is retained in generated-inspection.json. The
5 MiB stack recipe is unchanged. No generated factory or WASM has run.

Runtime05 reuses the runtime04 client, worker, observer, 23 cases, resource
limits, deadlines, first-failure stop, and cleanup. Only candidate identities,
receipt paths, and the four attempt/profile/journal/result suffixes change.
The diagnostic distinguishes count (-941), order (-942), nonpositive interval
(-943), source coverage (-944), missing text (-945), and text budget (-946)
failures without changing any acceptance predicate or cap. It identifies the
runtime04 one-second failure; it does not fix or suppress it. Earlier raw
failures remain intact.

Four scripts parse, and the existing preflight checks the checkpoint and 17
served assets without executing WASM. A separate exclusive runtime grant for
this checkpoint is required:

    DEVELOPER_DIR=/Library/Developer/CommandLineTools ISSUE201_EXCLUSIVE_SLOT=1 ISSUE201_PROTOCOL_SHA256=<checkpoint SHA> node scripts/issue201/whispercpp-short-output-run/run-lab.mjs --run

The runtime-attempt-05.json marker is single-use. No automatic retry. Speech
remains NO-GO until the unchanged acceptance passes.
