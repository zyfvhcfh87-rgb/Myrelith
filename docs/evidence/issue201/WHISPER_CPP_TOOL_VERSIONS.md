# Confirmed private SDK tool versions

The supervisor accepted the exact34fe949 tagged-release correction and granted
its bounded version retry. All accepted speech driver/configuration/adapter/
recipe/header/patch-identity source files were checked byte-identical before
execution. Independently authorized caption shared-helper source work was in
progress; none of those files enters the private speech build.

All seven actual version commands passed:

| Tool | Actual version |
| --- | --- |
| Python |3.13.3 |
| Node |24.19.0 |
| CMake |4.4.3 |
| Ninja |1.13.2 |
| LLVM |24.0.0git /4bfd08c2d769736841ae4f5705d76fa6daa39027 |
| Binaryen |132 (version_132-16-g89a81ef9b) |
| Emscripten |6.0.8-git /aeb67926e7de656da38bc807d83050af93578758 |

Each invocation had a30-second deadline and its own process group. Emscripten's
verbose trace shows its source-reviewed compiler/Node version and basic sanity
checks, then the early version exit. It did not compile inputs. Node used the
accepted preload; all configuration/cache/temp/bytecode paths remain private.
The original unsupported-flag and rolling-DEPS failures remain unchanged.

At2026-09-08T17:37:15Z, all seven observed PID/process groups92014–92019 and92021
were verified gone, including surviving children in those groups. The exact
commands, outputs, exit codes, timings, hashes, prepared source/config identities
and cleanup record are in
[`whispercpp-tool-versions/checkpoint.json`](whispercpp-tool-versions/checkpoint.json).

**No CMake configure, compilation, WASM instantiation, inference or browser test
ran.** No compiler slot is held; the one compile-only attempt is queued behind
#199's exclusive browser slot. Generated loader/imports/exports/nonshared memory,
options, artifact hashes and linked notices still require actual build review
before any runtime gate. Speech remains NO-GO.
