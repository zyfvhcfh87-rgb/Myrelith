# Initialization diagnostics — corrected executable proposal

This source checkpoint prepares attempt02 for a separate review and exclusive
runtime grant. No attempt02 marker, journal, result or browser profile exists.
No generated factory, WASM, browser, inference, compiler or production build was
executed. Speech remains NO-GO after the preserved run01 initialization abort.
Parent HEAD: 078be7be7c9e64caee554dfbc8afba15fd9badc3.

## Correction and actual wiring

The unapplied patch in 0a2260212b7846fcc7f3cdcf13cd57573fee11fa was invalid:
it produced `const result = try { ... } finally { ... }`. Applying that patch
to a disposable copy and running `node --check` reproduced the syntax error.
Its original patch and evidence remain unchanged. The earlier apply-check alone
was insufficient validation; this was our proposal defect.

The corrected patch uses a normal `let result` declaration, assigns the awaited
load result inside `try`, and publishes the bounded diagnostic snapshot in
`finally`. The existing ledger and ready message then use the original result.
The original rejection continues to the existing outer error handler. The
unchanged client records the diagnostic event before ready or error.

`whispercpp-diagnostic-runtime-source/corrected-wiring.patch` was actually applied
to a disposable copy of the exact accepted run01 worker and preflight. The
accepted observer and decoded generated JS/WASM were placed with that copy.
All twelve actual source files passed `node --check`: eight new entry files,
the two patched files, observer and generated JS. The patched worker is byte
identical to the proposed diagnostic entry's worker. Decoded JS/WASM match the
accepted generated artifacts. Syntax checking does not execute the factory.

## Bounded observation and unchanged candidate

The existing `whispercpp-diagnostic/observe-module.mjs` wraps the factory once
and the existing model allocation, load and close exports. It preserves the
module object, live heap properties, receivers, arguments, returns, original
callback forwarding and rethrown errors. It adds no native calls or retries.
It retains at most 64 records and 32,768 UTF-16 code units, at most 2,048 per
record, with explicit omitted/truncated counts. It captures stage, stderr,
onAbort argument/callback stack and caught exception stack without retaining
errors, arbitrary runtime objects or heap views.

The native C adapter still silences ordinary Whisper/GGML logging. GGML fatal
abort's direct stderr may now be observable; suppressed ordinary logger text
cannot be recovered by this proposal. Run01's generic abort does not identify
factory startup, allocation, model load or a native instruction. Attempt02 is
intended to collect that missing context, not to assert a diagnosed cause.

The separate manifest adds the observer's exact byte/hash identity and bounds.
Candidate hash and full runtime/cache identity therefore change. Generated JS
(22,350 bytes), WASM (1,198,861 bytes), model (43,537,433 bytes), Mediabunny,
fixtures and all acceptance thresholds remain exact run01 inputs. Native
64/512 MiB heap, 5 MiB stack, one thread/context, 448 whole-call tokens and
120-second work limit remain unchanged. The original 23 case bodies and all
host guards, first-failure stop, 100 ms RSS target, actual 250 ms maximum gap,
1 GiB complete-Chromium delta cap and physical cleanup rules remain unchanged.
See the pinned `WHISPER_CPP_RUNTIME_PROTOCOL.md` for their complete definition.

Preflight verifies the checkpoint and all 17 served inputs before serving
immutable byte buffers. Observer bytes are checked even when checkpoint
verification is explicitly disabled for source preparation. The original
run01 entry is untouched. The diagnostic runner uses only fresh `profile-02`,
`runtime-attempt-02.json`, `runtime-partial-02.jsonl` and
`runtime-results-02.json` in the existing private laboratory directory. Its
exclusive marker prevents a second execution. Run01's consumed marker, partial
journal and final result were rehashed against the preserved evidence copies.

## Inert validation and limits

37 checks pass across the new source/runner/client suites and existing observer
suite. They exercise the actual corrected worker with the frozen core protocol
and fake native factory/exports, showing one factory invocation, expected native
call counts, ready heap value preservation, and diagnostics preceding failures
at factory, allocation and load. The actual runner executes through inert
browser/process/filesystem/server ports, including first failure, host stalls,
incomplete RSS coverage, cleanup and marker reuse. A new check seeds run01
evidence in an in-memory filesystem and proves attempt02 leaves it unchanged.
No actual generated factory or WASM is invoked. Real model/WASM bytes are
hashed/parsed only; VM contexts disable WebAssembly and code generation.

The initial 31-pass run, expanded 32-pass/4-failure run, focused failure details,
corrected 36-pass run and final 37-pass run are retained. The four failures came
from loading the frozen protocol in the host realm while worker requests came
from a VM realm: its plain-object identity guard rejected those requests before
factory invocation. Loading the actual protocol, candidate and model-format
modules in the same VM realm corrected the harness. No frozen production/core
code changed. These were our harness failures, not native runtime findings.
Whole-project lint passes. Caption UI edits are separate and unqualified here.

Read-only verification (does not require a runtime grant):

    DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue201/whispercpp-diagnostic-run/run-lab.mjs --verify-inputs

Inert checks:

    DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS='--no-experimental-webstorage --experimental-vm-modules' node --test scripts/issue201/whispercpp-diagnostic-run/*.test.mjs scripts/issue201/whispercpp-diagnostic/observe-module.test.mjs

`--run` still requires committed pinned source, macOS, the separately granted
exclusive slot and `ISSUE201_PROTOCOL_SHA256` equal to this new checkpoint's
exact SHA-256. Environment variables do not confer authorization. No runtime
grant is assumed or consumed by this source checkpoint. Any future granted
attempt must stop at its first failure, retain raw diagnostics and resident
samples, verify physical release and return the slot before further work.
