# Proposed one-attempt linker correction build

The accepted source correction is `2a7f333`. Its complete checkpoint SHA is
`a0e423b220967a42586a9f4601671d5cccecb8cc8feeb9a6550d5df0ccee5386`.
The added `--resume-link-settings-build` action is ready for review; **it has
not been invoked and needs a fresh exclusive compile-only grant**.

Before any staging or tool call, its read-only verifier checks that exact
checkpoint and all source/evidence records, the original configure/build
records and raw log hashes, successful private preparation, original recipe,
adapter/header, five patched files, seven actual tool/driver inputs, private
configuration and both rejecting guards. Pinned argument/settings and loader
sources must still match the extracted SDK. This verifier has passed on the
current private inputs; `input-verification.json` records the result.

The action uses new `recipe-link-settings/` and `output-link-settings/` paths.
The first recipe, output, attempt marker, logs and result remain unchanged.
A new `link-settings-attempt.json` is created exclusively before staging;
already-existing attempt paths or prefixed logs reject. All three newly staged
source files are checked against their verified hashes before CMake starts.

Configure and compile/link retain 180/600-second limits, two Ninja jobs, one
Emscripten/Binaryen internal job, the existing isolated environment, Node guard,
rejecting cross-emulator and per-command process-group termination. New command
records/logs/results use the `link-settings-` prefix. Either staging or tool
failure consumes the attempt and stops without another try. Success records
only `built-unexecuted`, with generated artifact qualification still false.

Six tests execute the real retry control flow against temporary files and an
inert runner: separate paths/marker ordering/bounds, repeat-after-success,
configure failure/no retry, source drift before tools, verification rejection
before staging, and the real verifier's rejection of an altered checkpoint.
The complete existing 60 source/VM checks also pass. These tests do not compile
or instantiate WASM. The required positive static memory/loader/export review
from `WHISPER_CPP_LINK_SETTINGS.md` remains before any runtime decision.
