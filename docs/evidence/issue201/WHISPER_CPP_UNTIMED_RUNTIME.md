# Runtime08 proposal after the adapter-only rebuild

Reviewed adapter source: `ac2c447509946ecbab05486297e9080846e5889d`.
Its SHA-256 is `e712bcba29a711bd35118d777d15ea34545cf37173585f1dc77baf41cb21766c`.
The granted build compiled that adapter in 0.350s (PID 77260) and linked four
unchanged native archives in 21.001s (PID 77265). Both exited 0. Independent
release at 2026-09-09T09:22:32.772880Z found neither process group alive.
Exact commands, driver and logs are preserved in the adjacent build records.

The JS remains 22,350 bytes, SHA-256
`db0bda310e36278e30b9c439f2d7acd026c4cddee1ecb930e027f622195c1ea7`.
The new WASM is 1,198,548 bytes, SHA-256
`2f05c1ba7a828ba93a5ab1c7dd752f0d055360d02aa23edc9b60572424e01ef2`.
Static inspection finds unchanged 59 imports, 22 exports (11 speech), one
unshared 64/512 MiB memory, table and globals/stack. No start section exists.
Root independently accepted these identities and the static delta.
No generated factory or WASM has executed since this rebuild.

Runtime08 reuses runtime07's inputs and limits, replacing only the reviewed
worker, core protocol, candidate identity and new WASM. Its manifest is
derived by changing the adapter source commit and WASM identity; no model,
fixture, quality or resource limits change. A compact checkpoint pins these
substitutions and the new runner. Previous assets and failures stay frozen.

The same 23 cases run with fresh profile08/attempt08. English/French quality
fixtures retain strict timed output and their original WER thresholds. The
one-second fixture now must retain untimed text with no cue endpoints. The
300-second case must finish all twelve original windows, retain nonempty
text in each known speech window, distinguish timed/untimed output, and keep the known 50–80s
coverage failure untimed. Cancellation still retains ownership through
acknowledgement; offline/reload/reopen/removal and all memory checks remain.
Pure acceptance tests reject missing windows, silently dropped text, unknown
timing states, overhanging timed cues, and fabricated cues on untimed text.

One fresh explicit runtime grant is still required. The proposed command is:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage ISSUE201_EXCLUSIVE_SLOT=1 ISSUE201_PROTOCOL_SHA256=<reviewed checkpoint sha> node scripts/issue201/whispercpp-untimed-review/run-lab.mjs --run
```

No production enablement or overall GO is claimed before the complete run.
