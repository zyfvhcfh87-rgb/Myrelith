# SDK 6.0.8 tagged-release provenance correction

The same verified compiler archive is retained. Its release uses
**`DEPS.tagged-release`**, whereas the initial source preparation incorrectly
used the rolling `DEPS` file at the same commit. This is a correction to our
component-source attribution and version expectations, with no new archive,
compiler fallback, disabled identity check, or resource-limit change.

## Observed version stop

The supervisor approved the preload correction in a9221df for bounded version
checks only. Python3.13.3, Node24.19.0, CMake4.4.3 and Ninja1.13.2 matched. Clang
returned successfully but reported **24.0.0git /4bfd08c2d769736841ae4f5705d76fa6daa39027**;
the driver stopped because its old expectation was c0125a7. Binaryen and
Emscripten version commands did not run. Exact five PID/process groups88176–88180
were verified gone at2026-09-08T17:21:44Z. No configure/compile/WASM/inference
occurred. The original Node option failure and subsequent LLVM stop remain saved.

## Official source chain

1. The pinned [release commit9d70dbe](https://chromium.googlesource.com/emscripten-releases/+/9d70dbe8860ccdd3595f6e6065d94bfb543ae955)
   identifies SDK6.0.8 and changes only `DEPS.tagged-release`. Its commit metadata
   identifies source snapshot1aa74b7a00d9a0ac2542e2bbb2f4d4a3633f1092.
2. The exact [tagged-release file](https://chromium.googlesource.com/emscripten-releases/+/9d70dbe8860ccdd3595f6e6065d94bfb543ae955/DEPS.tagged-release)
   is5547bytes, SHA-256`c432603d34cfb31d8e84be556ae5474ccaa0edbccff0059dbf25b19ba11d0744`,
   Git blob`23a31f3971b7321e576fe02a4723a38897429ff7`. Its entire content from
   `vars =` onward equals the [original source snapshot's DEPS](https://chromium.googlesource.com/emscripten-releases/+/1aa74b7a00d9a0ac2542e2bbb2f4d4a3633f1092/DEPS).
3. The pinned [release-info.py](https://chromium.googlesource.com/emscripten-releases/+/9d70dbe8860ccdd3595f6e6065d94bfb543ae955/src/release-info.py)
   `GetDeps` explicitly selects the tagged file when the release commit modifies
   it. Its existing upstream regression covers that distinction.
4. The pinned [build.py](https://chromium.googlesource.com/emscripten-releases/+/9d70dbe8860ccdd3595f6e6065d94bfb543ae955/src/build.py)
   selects LTO release behavior from that modification; `SyncReleaseDeps` copies
   the tagged snapshot over `DEPS` before synchronizing dependencies. Its archive
   function names the ARM package `wasm-binaries-arm64`, and its upload path uses
   the builder/release revision through [cloud.py](https://chromium.googlesource.com/emscripten-releases/+/9d70dbe8860ccdd3595f6e6065d94bfb543ae955/src/cloud.py).
   These scripts were read as text only. None of their sync/build/upload hooks ran.

Seven fetched source files were checked against exact Git blob identities in the
pinned root/src trees. Complete fetched bytes, receipts, commit metadata and
source text are preserved in `official-records.zip`, with direct inert copies of
the key build/release-info sources. This is an evidence-backed source attribution;
it is not a reproducible build or publisher-signature claim.

| Component | Rolling DEPS assumption, preserved | Tagged release6.0.8 |
| --- | --- | --- |
| Emscripten | aeb67926e7de656da38bc807d83050af93578758 | aeb67926e7de656da38bc807d83050af93578758 |
| LLVM | c0125a7bf833b6cf0d5b4a085b63094e0893c85a | 4bfd08c2d769736841ae4f5705d76fa6daa39027 |
| Binaryen | 8d546dc4aea1c3e81e77643f1ed0dea1a649d21d | 89a81ef9b72ef1c677be6be89178d19598e5760f |

The actual Clang output matches the tagged LLVM revision. Binaryen's previously
recorded static string `132 (version_132-16-g89a81ef9b)` matches the tagged
Binaryen commit, independently resolved through official commit metadata; actual
Binaryen `--version` remains pending. The bundle remains273,726,956bytes,
SHA-256`63ec9acba14b67a925f7da9730395c84ce6ca1f5412ebcc4149b40fc43228385`.
All eight archive/model identities are unchanged.

## Corrected records and unchanged source proofs

The active assets manifest now distinguishes the release snapshot from retained
rolling revisions. Its LLVM/Binaryen source URLs and component revisions use the
exact tagged commits. Both exact notices were refetched with preserved receipts:
[LLVM license](https://raw.githubusercontent.com/llvm/llvm-project/4bfd08c2d769736841ae4f5705d76fa6daa39027/LICENSE.TXT)
remains15141bytes /SHA8d85c105…, and [Binaryen license](https://raw.githubusercontent.com/WebAssembly/binaryen/89a81ef9b72ef1c677be6be89178d19598e5760f/LICENSE)
remains11535bytes /SHA64c0d024…. These are byte-identical to the already retained
notices; no linked-runtime notice qualification is inferred before building.
The prior complete assets manifest is preserved in `previous-assets.json.gz`.

**Emscripten stays at the same aeb67926 revision.** The accepted shell, preamble
and settings source bytes were compared again with the actual extracted bundle:
all three match their d8a1ff4 decoded hashes exactly. Loader filename resolution,
supplied-byte behavior and explicit preprocessor branches therefore retain their
original assumptions. The C adapter, token guard, five upstream patched-file
identities and CMake recipe are unchanged. `loader-proof-unchanged.json` records
that comparison; no generated loader has yet been produced or tested.

The private driver now expects the exact tagged LLVM commit and exact Binaryen
version stamp. A separate exclusive `--resume-tagged-version-checks` marker
preserves the prior stop and permits only the known predecessor record. That
source correction has not executed. It uses the accepted ordinary preload,
rejecting cross-compile emulator, private directories and two-job build limit.
No tool installation, SDK activation, host setting or agreement changed.

## Validation and open gate

55/55 source/VM checks pass. The read-only asset verifier checks eight unchanged
assets plus24 saved evidence files and all167 model tensors. The official source
Git blob checks, copied dependency body, matching notice texts and unchanged
loader proof bytes are recorded in the source checkpoint. The Python driver
parses without execution; focused JS lint is clean. Caption59c9401 remains
independently accepted and no caption files changed in this correction.

Remaining steps require the supervisor's gate: complete the corrected bounded
tool versions, then the one authorized compile-only attempt when its exclusive
slot is granted. Generated-loader/import/export/memory/options/hash/notice review
must precede any WASM execution grant. Speech remains NO-GO and all original
failed runtime evidence and resource caps remain unchanged.

See [`whispercpp-toolchain-provenance/checkpoint.json`](whispercpp-toolchain-provenance/checkpoint.json).
