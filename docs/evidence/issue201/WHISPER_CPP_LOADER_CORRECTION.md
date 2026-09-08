# Issue201: supplied-byte loader resolution correction

Source-only follow-up to763baed; the original checkpoint/history is preserved.
The supervisor found that its blanket locateFile rejection would prevent valid
startup even with verified wasmBinary. This was a source-review finding, not an
observed WASM run: build/instantiation/inference remain unauthorized and unrun.

The exact Emscripten preamble from the verified6.0.8 bundle resolves
wasmBinaryFile through findWasmBinary before calling instantiateAsync. In its
selected ES-module branch, supplying Module.locateFile causes that callback to
run unconditionally during resolution. Only later does the loader consume the
already supplied wasmBinary. Thus “locateFile was called” is not evidence of an
attempted fetch. The faulty763baed callback threw too early.

`verifiedWasmLocator` now admits only the recipe's exact generated filename,
`myrelith-whisper.wasm`, with an explicit fileName in the reviewed WASM identity.
It returns an opaque `urn:myrelith:verified-wasm:<sha256>` identifier. That lets the
pinned loader resolve the name and match its supplied-byte lookup without
granting any HTTP(S) destination. Unknown filenames, paths, queries, deferred
chunks and URLs reject. It creates no Blob URL or additional storage owner.
The protocol still checks size and SHA-256 before invoking the factory, and the
factory must receive those verified bytes via its declared wasmBinary input.
The actual built loader must be inspected to confirm that path before execution.

The recipe now explicitly disables cross-origin storage, cross-origin worker
loading, split modules, main/side modules, automatic dynamic libraries, WASM
workers, proxy threads, filesystem/fetch libraries, source-phase/ESM-WASM imports
and single-file loading. It fixes WASM=1 and asynchronous compilation. In the
pinned source, COS can access cache/network before the ordinary supplied-byte
branch, so explicitly disabling it matters independently of locateFile. No
compiler-generated JS is assumed to comply until its actual artifact is read.

Full unchanged preamble, shell and public settings text is saved as deterministic
gzip data; [loader-source-pins.json](whispercpp-preparation/loader-source-pins.json)
records both compressed and decoded sizes/hashes and exact archive member paths.
The preamble exactly matches the supervisor's independently saved copy; its
decoded SHA-256 is80b4c6f4eb894ee6eacb2474c3eb1aff878ae989045c122a93397bd4f4a1c0ba.
The earlier checkpoint already retains exact internal settings and settings.py.

Four new regressions select the reviewed preprocessor branches from that exact
preamble and execute only its path/supplied-byte control flow in a JS VM whose
WebAssembly API is undefined. The final instantiation boundary is replaced by
a byte-inspection stub; fetch and read callbacks throw. They reproduce the old
callback failure, demonstrate resolve-before-byte-consumption with zero fetch/
read fallback, reject undeclared names/missing bytes, and verify each explicit
disabled setting exists in the pinned SDK. The ordinary adapter tests also now
make their fake factory call the real locator at startup.

52 source/VM checks pass (the previous48 plus4 loader regressions), with zero
skips. Focused JS lint passes without warnings. The first regression invocation
had a test-only extraction-boundary bug: it selected the preamble's forward
declaration rather than the function body. That log is retained; exact signature
and function-body boundaries fixed it. Neither invocation compiled or executed
WASM. The original23-case native contract and all failed ORT evidence stay intact.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS='--no-experimental-webstorage --experimental-vm-modules' node --test --test-concurrency=1 scripts/issue201/whispercpp/loader-startup.test.mjs scripts/issue201/whispercpp/preparation.test.mjs scripts/issue201/lab-review.test.mjs scripts/issue201/composite-model.test.mjs
```

No build/asset-execution permission follows from these source checks. Exact
generated loader closure/imports/memory/bytes/notices, compiled token guard,
native memory/quality/timestamps/offline/lifecycle and speech promotion remain
separate outstanding gates. This follow-up supersedes the original locator
behavior and its source hashes, not the preserved source-only evidence record.
