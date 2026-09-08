# Pinned linker setting correction

The first authorized build configured successfully and stopped at the final
link: Emscripten 6.0.8 rejects `-sPTHREADS=0` because `PTHREADS` is an internal
setting. The recipe now removes that one argument. Its other settings, adapter,
token patch, loader, source/tool identities and memory limits are unchanged.
The staged private recipe and consumed build marker are preserved. **No retry
or WASM execution has occurred; speech remains NO-GO.**

## Actual failure and release

Configure PID/group 93965 exited 0 after 5.518 seconds. Ninja PID/group 94176
completed 26 translation units and five static archives, then failed its 32nd
edge at the adapter link after 8.669 seconds. `libparakeet.a` was built by the
upstream default target but is absent from the adapter's actual link inputs.
No final `myrelith-whisper.mjs` or `myrelith-whisper.wasm` was emitted.

The exact logs are retained as gzip files in `whispercpp-link-settings/`:

| Log | Decoded bytes | SHA-256 |
| --- | ---: | --- |
| configure.txt | 7,586 | 19b33712103c192c65ad8c7a9bfbd43674d09cc692c08d874e49170a55a65e42 |
| compile-link.txt | 189,748 | 66927f1d82a49cbe3785bb0227dfe618c6aae6f6a79761326c178d86df745a9d |

`build-cleanup.json` records both groups gone at 18:17:22Z and the runner/scoped
caffeinate helper absent at 18:18:25Z. The supervisor independently confirmed
physical release at 18:14:18Z. The earlier preparation/version failures remain
separate historical evidence.

## Source authority and complete setting audit

Five complete files from the exact extracted Emscripten archive are pinned in
`source-pins.json`: `tools/cmdline.py`, `tools/settings.py`, `tools/link.py`,
`src/settings.js` and `src/settings_internal.js`. Their bytes were rechecked
against the accepted extraction inventory. The archive SHA and source revision
are recorded with them; no different SDK was fetched or substituted.

`settings-source-audit.py` executes the actual pinned AST definitions for
argument parsing, the settings manager and the link compatibility/initial and
maximum memory checks. It supplies only source-table reads and diagnostic
capture dependencies; it imports no SDK module or compiler driver. Unknown
dependencies fail the probe. Python annotations are deferred so this source
probe can run under the Mac's Python 3.9 without changing function bodies.

The recorded final command reproduces the exact failure. Auditing all 37 `-s`
arguments individually rejects only `PTHREADS`; all other names are public,
with valid parsed types and values. The corrected recipe's 36 settings together
pass the selected checks with no legacy/deprecation/experimental warnings or
incompatible pair. `ENVIRONMENT=worker` parses to the list `["worker"]` in this
SDK. The complete per-setting results are in `parser-audit.json`.

The important distinction is `SettingsManager.internal_settings`, populated
from `settings_internal.js`, versus the unrelated module constant
`INTERNAL_SETTINGS`, which controls JSON serialization. `apply_user_settings`
rejects the former before assignment. Its false value does not make a setting
public. No deprecated `USE_PTHREADS` replacement is introduced.

The actual parser leaves `PTHREADS=false` and `SHARED_MEMORY=false` for this
recipe. Counterexamples prove that adding `-pthread` or `-fopenmp` enables the
internal thread setting, and `-sSHARED_MEMORY=1` changes memory intent. No such
argument occurs in the recipe or recorded compile/link commands. Upstream
`Found Threads` and libc pthread detection do not prove shared memory: the
recorded commands contain no `-pthread` or shared-memory argument, and this SDK
has a nonthreaded pthread stub path. The patched build options still disable
Whisper pthreads, GGML threading and OpenMP.

## Validation limits and the next gate

All 60 focused source/VM checks and whole-project lint pass. This includes
existing token, loader, ownership and resident-coverage regressions. The two
initial harness failures (Python annotation evaluation and an expected scalar
where this SDK returns a list) are retained. This tool-only change does not
alter the application's TypeScript or claim frontend/browser acceptance.

This source simulation is **not a complete linker run or generated-artifact
qualification**. Before runtime permission, a successful separately authorized
build must be followed by positive static checks of the binary and generated
loader: exactly one defined wasm32 memory, no imported/shared memory, an initial
1,024 pages (64 MiB), a declared maximum 8,192 pages (512 MiB), and the expected
exports/imports and supplied-byte startup path. Stack, linear growth, lack of
thread/alternate-loader code, artifact hashes and linked notices must also be
reviewed. No missing output can satisfy those checks. The model, 448-token
budget, 120-second deadline and complete-process RSS gate remain unchanged.
