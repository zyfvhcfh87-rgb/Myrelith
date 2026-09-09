# whisper.cpp private build preparation — stopped before compilation

The six previously verified build archives were extracted privately after source
checkpoint `d8a1ff4460aabee0df5113d731a2698ed5777012`, on the accepted integrated
renderer HEAD `4d4a6c2534cf25b8db3ec653f564b38cf2a67b6e`. Extraction and configuration
were authorized separately from the supervisor's later exclusive build-only
slot. That slot was released at **2026-09-08T16:48:47Z** after both observed tool
PIDs/process groups were verified gone. The configure/build attempt never began.

## Verified extraction

`extract-verified.py` hashes and inventories all six archives before creating a
fresh output directory. It admits only regular files, directories and confined
relative symlinks; rejects absolute/traversal paths, duplicate/case collisions,
non-directory ancestors, missing/cyclic/escaping links and special files; caps
60,000 entries, 3 GiB aggregate and 256 MiB per file. It writes ordinary files
exclusively before creating links, strips ownership/special permission metadata,
then rehashes every regular file and resolves every link. No archive installer,
activation hook, user profile or global SDK configuration ran.

The output is `.tmp/issue201-whispercpp-build` under this worktree: **41,729
entries / 2,104,027,449 regular-file bytes**. The model and emsdk installer archive
were not extracted or executed. The complete compressed inventory records all
member paths, sizes, hashes, safe modes and symlink targets; its decoded bytes are
11,515,286, SHA-256 `f31fa5defa181a94390bfd3b98e2f9afd0bc9ef6feee8fc08730043690dcde60`.
All 8 asset and 23 source-evidence identities reverified before extraction.

The five patched upstream source files were staged only after exact before/after
SHA checks. The accepted adapter, token header and CMake recipe were copied
unchanged; all 13 files from the accepted loader-source checkpoint still match.

## First preparation failure and proposed correction

The private Python binary reports **3.13.3**. The following pinned Node version
command failed with exit 9:

```text
node --no-expose-wasm --version
node: bad option: --no-expose-wasm
```

The option was introduced by this new private preparation driver as an execution
barrier. This failure is not an adapter compilation or runtime result. Preparation
stopped immediately; Node's version and all subsequent tool versions remain
unconfirmed by execution. The exact command, output, PID, process group, timings,
private configuration and environment are retained. No Xcode agreement or host
setting was changed. One initial unqualified git read hit the existing Xcode
license selection; subsequent reads used the already established Command Line
Tools directory.

The proposed source correction replaces that unsupported V8 option with Node's
ordinary `--require` preload mechanism. `deny-wasm.cjs` installs a non-configurable
property that throws on reading or replacing `WebAssembly`. The private driver
also sets a rejecting CMake cross-compiling emulator. These are build guards;
the preload is not claimed as a security sandbox for arbitrary malicious Node
programs or separate VM realms. Toolchain compiler/loader source review remains
necessary. Compiler JavaScript can process inert bytes; compiled output must
never be instantiated during this gate.

The proposed `--resume-version-checks` action is limited to this exact pre-build
failure, preserves original logs/configuration, checks staged source identities,
and uses distinct correction logs plus an exclusive attempt marker. **It has not
run.** The accepted toolchain, adapter, token guard and build recipe are unchanged.
Private environment paths contain all caches/temp/Python bytecode; compilation
would use two Ninja jobs and one internal Emscripten/Binaryen job per command,
180-second configure
and 600-second compile/link deadlines, verbose logs and process-group cleanup.
CMake downloads are disabled and proxy destinations reject external access;
these settings are not described as an independent OS network sandbox.

## Additional unresolved tool provenance

A read-only binary string scan found this string in the extracted `wasm-opt`
executable at offset **9,795,402**:

```text
132 (version_132-16-g89a81ef9b)
```

The exact pinned build DEPS instead names Binaryen
`8d546dc4aea1c3e81e77643f1ed0dea1a649d21d`. The archive hash remains exactly
`63ec9acba14b67a925f7da9730395c84ce6ca1f5412ebcc4149b40fc43228385`.
The string alone does not prove which source tree produced the executable, but
it is an unresolved provenance discrepancy. No toolchain swap, ignored version
check or accepted binary identity is inferred. Actual version output and source
provenance must be reconciled before accepting a build; the driver retains its
strict expected-commit check.

## Validation and remaining gate

**55/55 source/VM checks pass**, including three preload/configuration regressions
and the unchanged 52 accepted checks. The VM receives no WebAssembly API; the
new checks prove access, construction attempts, assignment, deletion and property
replacement reject. Focused JS lint has no warnings. Both Python helpers parse
without execution. No frontend code changed, so the previously documented
279-test renderer synchronization/build/lint result was not repeated.

No configure, C/C++ compile/link, WASM instantiation, inference, browser/native
acceptance, full suite or production dependency promotion occurred. There are
**no generated runtime artifacts** to qualify: generated loader review,
imports/exports, nonshared 512 MiB maximum memory, raw/gzip hashes, exact linked
notices, compiled token proof and all runtime gates remain open.

Machine-readable records and exact logs are in
[`whispercpp-build-preparation/checkpoint.json`](whispercpp-build-preparation/checkpoint.json).
The original ORT run failures and resource limits remain unchanged.
