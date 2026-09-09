# Reservation guard — immutable source and build proposal

This prepares the two native changes accepted in principle at
4fea3baddbfb3a3427df7339a7e0d9e82e892449. Only source staging and inert driver
checks have run. No compiler, generated factory, WASM runtime or browser ran.
Compile and runtime grants remain separate. Speech is still NO-GO; this is a
diagnostic/error-propagation correction, not a working transcription claim.

## Exact source provenance and change

The original upstream revision is 371b5a7561823ab2bb32142d2751e35e7534727b.
Its accepted archive is `whisper-371b5a7.tar.gz`, 9,136,244 bytes, SHA-256
89051d8fca516a3ad1f5c2f8f9d2fccb089afbaec338fca3f8731999babc6f81.
The preceding five accepted modifications remain intact: three CMake provenance
adjustments, the public token-budget contract and its implementation in
`src/whisper.cpp`. The token helper remains the only added source file.

The complete accepted source inventory contains 1,882 files and 275 directories.
Every file was rehashed against the upstream extraction inventory or its accepted
patch output, then copied into a fresh source directory. The two additional
patches modify only `ggml/src/ggml-backend.cpp` and `ggml/src/ggml-alloc.c`:

- Check the graph reservation result and return false before graph allocation
  when reservation fails.
- Print fixed numeric stderr context when virtual-buffer metadata allocation or
  an individual backend chunk allocation fails. The existing JS observer bounds
  the retained diagnostic records and text.

Both were actually applied to this fresh source copy. The original source,
previous recipe/output, compiler intermediates and runtime01/runtime02 evidence
remain unchanged. `patch-identities.json` records exact before/after sizes and
hashes for both files and the preceding patch chain. The complete staged tree
is checked against its declared file set and rejects symlinks or extra files.

The accepted CMake recipe, adapter and token helper are byte-identical. No new
model, dependency, backend, numeric assumption or native fix is introduced.
The model, one-thread policy, 64 MiB initial / 512 MiB maximum unshared heap,
5 MiB stack, 448 whole-call tokens, 120-second work limit, JS diagnostic bounds,
RSS/cadence limits and original 23-case runtime acceptance remain unchanged.
The failure's reservation result and requested allocation size remain unmeasured;
heap exhaustion is not asserted.

## Staging and one-attempt controls

The new private root is `.tmp/issue201-whispercpp-reservation-build/`. It owns
separate source, recipe, output, logs, compiler temporary files and ancillary
caches. It reuses the accepted pinned toolchain and offline Emscripten system
cache. Source preparation creates an exclusive preparation marker and never
replaces a partial preparation. It does not configure CMake or run version checks.

The completed checkpoint pins this driver, its inert tests, all evidence and
references. Before compilation, verification checks the complete original and
patched source trees, recipe bytes, predecessor source/tool/configuration pins
and rejecting WASM/preload/emulator guards. It requires a newly granted exclusive
slot and `ISSUE201_BUILD_CHECKPOINT_SHA256` equal to this checkpoint's exact hash.
Environment variables express the separately granted authorization; they do not
grant it. Caption drafts may remain separate; no native source can drift.

An exclusive build-attempt marker is written before configure. Pre-existing
output/logs or a consumed marker prevent retries. The existing reviewed process
runner preserves raw output and PID/group receipts, caps configure at 180 seconds
and compilation/linking at 600 seconds, and stops at the first failed or unfinished
command. It permits two Ninja jobs and one internal Emscripten/Binaryen worker.
The restricted environment blocks network fallback and runtime execution. Actual
physical process release still requires independent verification after a grant.

The build will never execute its generated output. A successful compile would
still need generated JS/WASM identity, exports/memory/loader/notice review before
a separately granted runtime attempt. No existing runtime marker is reused.

## Validation

Six inert driver tests pass: missing grant, wrong checkpoint, accepted bounded
commands/environment, configure failure, consumed-marker protection and input or
prepared-source drift. Test run ports are fakes; no compiler or process runner
is invoked. Source staging copied and verified all 1,882 files, applied exactly
two patches, verified the resulting tree and copied the unchanged recipe.
Python source parses and whole-project lint passes. This is not C syntax or
runtime qualification.

Read-only verification:

    DEVELOPER_DIR=/Library/Developer/CommandLineTools PYTHONDONTWRITEBYTECODE=1 python3 scripts/issue201/whispercpp-reservation-build/build.py --verify-inputs

Inert driver checks:

    DEVELOPER_DIR=/Library/Developer/CommandLineTools PYTHONDONTWRITEBYTECODE=1 python3 scripts/issue201/whispercpp-reservation-build/build.test.py

The source preparation receipt predates the final checkpoint and records no
checkpoint hash. The compile command always verifies the completed immutable
checkpoint and prepared tree before writing its own attempt marker.
