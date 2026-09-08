# Bounded speech support: runtime06 proposal

Runtime05 measured the one-second fixture's exact native source-coverage
rejection (-944). On the user's wrap-up instruction, the supervisor explicitly
accepted strict rejection of this input as a disclosed support limitation.
The issue requires useful bounded output and safe ownership; successful
transcription of every one-second input is not a requirement. Runtime04 and
runtime05 retain their original failed success expectations and raw evidence.

This proposal changes only that case's expectation. It requires the exact
`Core inference--944; cooperativeZero=true` transcription/infer error, no
returned result or window/completion event, zero audio owners with all acquired
samples closed, unchanged laboratory project generation, and idle state with
no worker/acquisition owner. It explicitly distinguishes acknowledged native
zero from the parent's `terminated-error` cleanup, which does not claim a
cooperative worker ledger. This lab has no production document; document and
undo-history preservation must also be checked in the app integration.

The eventual app must explain that the model produced timestamps outside the
selected audio, no captions were added, and a longer selection may help. It
must not claim that every short clip is unsupported or guarantee that retrying
will succeed. No output is clipped or fabricated.

All remaining original cancellation, project-replacement, 300-second, offline,
cache and model-removal checks remain unchanged. All 23 names, thresholds,
RSS sampling, deadlines, first-failure stop and cleanup stay intact. Runtime06
uses fresh attempt/profile/journal/result suffixes and receipt paths. Only the
runner and preflight are copied; the existing candidate, inspectors, client,
worker, observer, manifest and generated artifacts are reused unchanged:

- Source candidate: 37ed007e6cdb0b38fa2ea78ed492f353bc000e00.
- WASM SHA256: 6f4f665168d8845c22b2e95930e939afde49f5922ca557e2ed0060a143846459.
- Canonical manifest SHA256: 81c2257db49af4fab3b61b9e21191609b24b24c51f85cd0113c3f77907843c8f.

No native-source changes or compilation were performed. Both scripts parse;
the existing 17-asset preflight is inert. An exclusive grant for the new
checkpoint is required before the single runtime06 attempt:

    DEVELOPER_DIR=/Library/Developer/CommandLineTools ISSUE201_EXCLUSIVE_SLOT=1 ISSUE201_PROTOCOL_SHA256=<checkpoint SHA> node scripts/issue201/whispercpp-bounded-support-run/run-lab.mjs --run

There is no automatic retry or overall speech GO before the remaining checks.
