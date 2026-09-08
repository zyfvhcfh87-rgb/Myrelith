# whisper.cpp generated artifact review

The single corrected compile-only retry succeeded using accepted recipe
`2a7f333` and driver `3a3d126` on caption checkpoint `1af1ee5`. The artifacts
pass the static checks below and are ready for supervisor review. **The generated
factory and WebAssembly runtime have not been started. Speech remains NO-GO.**

The exclusive build slot was released at `2026-09-08T18:54:20.607493+00:00`.
Configure PID/group 2816 exited 0 in 3.986 seconds; compile/link PID/group 3015
exited 0 in 27.649 seconds. The final cleanup scan found no outer PID 2803,
either exact group, private build commands or retry driver. The earlier failed
PTHREADS build, its logs, recipe, output and consumed marker are preserved.

## Artifact identities and build evidence

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `myrelith-whisper.mjs` | 22,350 | `db0bda310e36278e30b9c439f2d7acd026c4cddee1ecb930e027f622195c1ea7` |
| `myrelith-whisper.wasm` | 1,198,861 | `9df26c6b690de120e6f1fb5ce17a25ebb2b016a73f0477b24376f558ee00ce72` |

Exact compressed artifacts, raw configure/link logs, command/attempt/result and
cleanup records, preflight, compile commands, CMake cache and Ninja graph are in
`whispercpp-generated/`. Its manifest pins both compressed and decoded bytes.
The preflight records the unrelated, uncommitted caption changes; those files
are not inputs to this standalone adapter build. Frozen speech inputs remain
unchanged. No generated artifact enters the production application or dependencies.

The build has 26 translation units, five upstream archive edges and one final
adapter link. The actual adapter link uses `libwhisper.a`, `libggml.a`,
`libggml-cpu.a` and `libggml-base.a`; the default upstream build also produced
`libparakeet.a`, but that archive is absent from the adapter link. Files for
conditionally disabled backends can still be translation units; their file
names alone do not establish enabled instructions or live linked code.

Preserved warnings include upstream CMake compatibility, generic CPU selection,
unused FetchContent CLI variables, one unused C++ template and debug messages
about absolute include paths inside the private extraction. The generic backend
and explicit WASM SIMD flags coexist. Successful compilation does not establish
runtime support or performance. Unused FetchContent variables are not evidence
of network isolation; the bounded build used the previously reviewed private
environment and guards, whose limits remain unchanged.

## Binary and JS metadata

The bounded byte reader does not use a WebAssembly engine. It reads the binary
header, section boundaries/order, plain function types, imports, function and
code counts, table/memory/global declarations and exports. It rejects an
implicit start section, non-function imports, shared or memory64 limits and
memory declarations that differ from the required profile. Its memory parsing
follows the [WebAssembly binary type encoding](https://webassembly.github.io/spec/core/binary/types.html).

The actual binary defines **one unshared wasm32 memory**, limits flag 1, initial
1,024 pages (64 MiB), maximum 8,192 pages (512 MiB), exported as `fa`. There is
no imported memory. One funcref table, exported as `sa`, has initial and maximum
1,162 entries. There are 59 function imports, 1,309 defined functions and 22
exports. The file contains no implicit binary start function; the JS factory
would explicitly call the constructor export during initialization.

The actual linker command reserves a 5 MiB stack. Complete byte inspection of
the four-byte stack getter `wa` and six-byte stack restore `va` identifies
mutable i32 global 0 as the stack pointer, initially 5,923,760. This is metadata
and helper-body evidence, not a stack overflow test or stack high-water measure.
Other function bodies are not instruction-validated by this reader.

The generated JS is parsed as data using the installed TypeScript parser. Its
only top-level statements are the async factory declaration and default export.
All 59 binary imports match the literal JS import map, callable definitions and
argument counts. Every indirect-call wrapper also matches its encoded WASM
signature and preserves the generated exception/stack handling. The full import
mapping, signatures, categories and definition texts are retained in
`glue-inspection.json`.

The imported helpers cover indirect calls/C++ exceptions, aborts, time and time
zone, synthetic environment strings, heap growth, output and file-call stubs.
All imports are supplied by the inspected local JS helpers, including the
file-call stubs. There are no socket or graphics imports or imported host memory.
The environment helper uses synthetic web-user values and browser language;
the clock helpers use Date/performance. Output helpers buffer stdout/stderr and
call the configured print handlers. `_fd_read`/`_fd_close` return 52 and
`_fd_seek` returns 70. `openat` merely stores varargs and returns undefined;
`fcntl64`/`ioctl` store varargs and return zero. **These are not uniformly
failure-returning file stubs.** Their inspected JS bodies perform no file I/O.

All eleven adapter exports match their C signatures: model/PCM allocation and
run take i32 and return i32; load, token/segment counts, close and owned count
return i32; segment text takes i32 and returns i32; segment t0/t1 take i32 and
return f64. This establishes the generated signature mapping, not runtime
adapter behavior or inference correctness.

The JS binds its memory/table to those binary exports and refreshes HEAPU8 and
HEAPF32 views after growth. Its heap maximum is 536,870,912 bytes, with linear
growth attempts of 16, 8 and 4 MiB, page-aligned and capped. No JS-created memory,
SharedArrayBuffer, Atomics, Worker creation, pthread helper, importScripts,
WebSocket, indexedDB, eval or Function constructor appears in the exact glue.
The bounded WASM memory is not a bound on browser process RSS, temporary copies,
JS buffers or the model/cache lifecycle.

## Supplied-byte loader evidence

`Module.wasmBinary` is assigned before startup. The actual generated startup
still resolves `myrelith-whisper.wasm` before calling the instantiation helper.
The accepted locator permits exactly that name and returns the opaque verified
identifier. The selected generated loader functions consume the supplied bytes
without invoking fetch/readAsync/readBinary in the source VM test.

The test evaluates only four selected loader definitions and the two relevant
startup statements. The final instantiation function is replaced with a
byte-read stub, WebAssembly is absent and VM code generation for WASM is disabled.
It does not evaluate the generated factory, createWasm, receiveInstance,
initRuntime or any WebAssembly constructor. The test uses fixture bytes, not a
successful compiled module instance. **Fetch/XHR and streaming fallbacks are
present in the real glue** when supplied bytes are absent; this is a conditional
supplied-byte-path result, not an offline-runtime or network-free-glue claim.

## Notices and source coverage

`runtime-notices.zip` preserves eleven exact entries: Emscripten LICENSE and
AUTHORS, musl COPYRIGHT, libc++/libc++abi/compiler-rt/libunwind/LLVM-libc license
texts, dlmalloc source with its embedded notice, whisper.cpp LICENSE and the
OpenAI Whisper model notice. Each SDK entry is byte-verified against the already
accepted extraction inventory; the other two match pinned preparation evidence.
The exact SDK `tools/system_libs.py` is also retained and verified as source
data, tying the named runtime archives to their library definitions.

The final link additionally names the SDK GL-getprocaddr, al, html5, stubs,
noexit, c, dlmalloc, clang_rt.builtins, c++, c++abi and sockets archives. The
notice bundle intentionally covers these inputs conservatively, including LLVM
runtime notices, rather than claiming a member-by-member dead-strip map. No
graphics or socket JS imports survive in the inspected artifact. No rebuild
was performed to obtain an extraction map. Earlier toolchain and model source,
license and quantizer-provenance limitations remain in the accepted preparation
evidence; this checkpoint does not replace them.

## Reproduce the static checks

From this worktree, these commands only read source/receipt bytes or evaluate
the bounded selected-source VM tests:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue201/whispercpp-review/verify-generated.mjs
DEVELOPER_DIR=/Library/Developer/CommandLineTools python3 scripts/issue201/whispercpp-review/verify-notices.py
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS='--no-experimental-webstorage --experimental-vm-modules' node --test scripts/issue201/whispercpp-review/generated.test.mjs
```

Seven focused tests pass, including changed/missing/shared/unbounded memory,
ABI/import/stack drift rejection, exact raw link inputs and the supplied-byte
loader. Notice/source verification and whole-project lint pass. The VM test log
retains Node's ExperimentalWarning. No production build or browser run was
repeated for these separate review scripts and evidence.

This checkpoint stops at generated-artifact static review. Initialization,
inference, whole-call token/timeout enforcement, cancellation/teardown, all
original 23 acceptance cases, quality, offline/cache behavior, complete Chromium
RSS sampling and the fixed 1 GiB incremental resident ceiling still require a
separately reviewed runner and explicit exclusive runtime grant. A later runtime
runner must bind both exact generated hashes and preserve the established model,
work, ownership and acceptance limits. No retry or runtime slot is held.
