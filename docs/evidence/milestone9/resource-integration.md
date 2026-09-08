# Shared render-resource integration

Reviewed resource source `d9759917d202c39b1faa0df91ea90adad3603218` merged into
`60a8bea6247a0a1f26e6807e700c16b43a62fcd4` without conflicts. The mask/spatial
allocation plan now counts retained grading and lens work before real allocations,
releases plugin result buffers at each stage, serializes borrowed worker resize
cleanup, and reports current preview resource failures.

Of 28 changed source/test/architecture paths, 25 remain byte-identical to the
accepted issue checkpoint. The other three preserve already accepted integration
work: caption/title textLayoutMetrics in render.ts, TitleOverlayControls in Preview,
and the title authoring/preview ownership architecture section. No manual conflict
resolution or new product behavior was needed at these seams.

Two focused runs passed 26 actual suites / 515 tests (431 plus 84), with all 17
canonical runner checks passing in each invocation. The first command listed 24
file names, of which six do not exist in this tree; it actually ran 18 suites.
Eight additional existing suites covered the title authoring/overlay, animation
preview, caption style/layout/paint and video-bus proof seams. Production build
including TypeScript and lint passed; Vite completed in 367 ms with the existing
large-chunk advisory. Staged whitespace validation passed.

This accepts local source integration and these focused checks. It does not close
Issue #198, qualify the unfinished resource matrix or failed encoded-output gate,
prove native/GPU process memory is bounded by the 256 MiB logical resource limit,
or replace final combined browser/full-suite acceptance. Existing raster, native
functional and diagnostic evidence retains its original source-specific scope.

[Evidence manifest](resource-integration/manifest.json) records readable logs and
lossless originals in raw-logs.tar.gz. No prior failed evidence was rewritten.
