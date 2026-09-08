# Shared pixel-work admission and plugin cleanup

Status: implementation source gate; parent review required before resource or
performance qualification. The accepted seven-flow functional browser evidence
still belongs to `2b3dbd7281909777c558766279729af21ac89611`; this source has not
received a new browser/native/performance run.

Base: accepted parent `c723be65e1252971c418d5dfad2e875cbb4d16c5`, merged locally
as `55305afd9e97b6f3b53a0870a3bc0bd711abcbfa`. Four existing preview owners remain.

## Problem and resulting behavior

A plain Bezier mask previously received zero additional pixel-work allowance
unless grading happened to be present. Four 4K compositor surfaces plus two
4K lens surfaces, a mask readback and feather scratch total 273,715,200 bytes,
above the existing 268,435,456-byte ceiling. The shared gate now counts this
work before provider/readback allocation and reports preview failure or aborts
finite export. It preserves authored data, effect order and selected quality.

The identical full 4K mask without lens surfaces remains admissible at
207,360,000 bytes; a 1920×1080 lens source with 4K output remains admissible at
223,948,800 bytes. A small clipped Bezier reserves its actual clipped region.
Export retains the existing additional output readback allowance independently
of the mask-stage readback; these numbers are logical owned-buffer accounting,
not measured native memory.

## Shared authorities and real lifetimes

| Authority | Responsibility |
| --- | --- |
| `domain/maskPixelWork.ts` | Existing bounded cubic flattening and clipped raster region, used by both allocator and budget. No raster formula changed. |
| `domain/spatialEffectPixels.ts` | Spatial scratch layout shared by actual line/ring allocations and the budget. |
| `domain/pixelWorkBudget.ts` | Named readback, working, input/result, inside/distance, spatial and grading components, plus their co-live peak. |
| `domain/videoPixelWorkBudget.ts` | All flattened frame stacks, and conservative document possibilities including held paths and supported animated parameter growth. |
| `domain/renderSurfaceBudget.ts` | Existing dimension/pixel caps and inclusive 256 MiB aggregate, with actual lens high-water and export allowance. |
| `pipeline/render.ts` | Preflight before surfaces, source requests or readback; retained grading cache from earlier frames also counts. |
| `pipeline/lensRemapWebgl.ts` | Scoped frame reservation pins output dimensions, counts existing lens storage, then checks actual new source dimensions before backend rendering. |
| `app/previewController.ts` | Reserves stored/project/temporary document possibilities before dispatch; publishes only current render failures to existing Preview state/UI. |

A plain ordered pixel call retains its mask arrays across later spatial stages,
so their bytes add. A stack containing active grading runs built-ins through
separate calls and may take the independent scratch maximum. Grading in another
clip does not change that first stack's lifetime. The grading cache persists
across stacks and frames. Plugin stacks additionally retain their transactional
working copy, but each fresh request/result ends at its own stage.

The parent independently reproduced three Program reservation gaps: static
identity to animated box blur, outline and drop shadow. Document reservation
now expands supported spatial parameter possibilities before static identity
filtering. Bounds come from the canonical registration, including negative
shadow offsets. Actual frame budgets still use actual resolved values. Tests
also cover already-active growth, expanded title effects and adjustments; the
latter keep item-local frames without source ticks. Other supported scalar
identity-to-active stages reserve readback even when their static pixel stage
is empty. Unsupported descriptors remain preserved.

## Ownership migration and asynchronous configuration

The canonical plugin stage validates exact whole-ArrayBuffer ownership, copies
the result and wipes it in `finally`, including cancellation and invalid-output
paths. It also wipes an attached input copy and tolerates transferred/detached
input. Export and render-worker frame-wide result Sets were both removed. The
worker RPC boundary still wipes malformed, superseded and late host replies.
Actual export/controller producer tests cover distinct output and input cleanup;
canonical export tests now execute the real stage plan instead of retaining raw
executor outputs in injected fake compositors.

Worker document/profile changes can supersede an async frame immediately, but
canvas resizing waits behind its serialized composite cleanup. Lazy transition
surfaces use the borrowed scratch dimensions. Retained lens/cache bytes are
checked before resize. Aspect swaps clear the old height before growing width,
avoiding a transient new-width by old-height backing. Lens-owner failure
publication does not attempt a competing resize that could mask the first error.

## Focused validation

`npm test -- <18 affected test files> --maxWorkers=2`, with
`DEVELOPER_DIR=/Library/Developer/CommandLineTools` and
`NODE_OPTIONS=--no-experimental-webstorage`: **406 tests / 18 files passed in
4.26 s**, followed by **17 Node runner checks passed**, exit 0. Includes the
architecture guard, unchanged mask pixels, animation, bus, real compositor/lens,
stage/export/worker ownership, Program and UI tests.

`npx tsc -b`, `npm run lint`, `git diff --check` and the slot-authorized
`caffeinate -i npm run build` pass. Production build transformed 5,067 modules
and finished Vite in 341 ms, exit 0, with the existing >500 kB chunk-size advisory.
The scoped awake process ended with the command; the build slot was explicitly
released. Logs reside in the owned worktree `.tmp/issue198-resource-*` files.

Earlier failures are preserved, not classified as unrelated baseline failures:

- Actual old cleanup source: 5 failed / 10 passed before the fix; first new
  cleanup gate: 132 passed / 3 files.
- Parent unchanged spatial reproduction: 3 failures before correction; all
  3 passed afterward in 398 ms. The parent-owned reproduction was not edited.
- Initial integration: wrong new test import, fake backends missing the actual
  `retainedBytes` method, and an old color-only bus assertion demanding spatial
  scratch. These were corrected to actual interfaces/work.
- New adjustment fixtures incorrectly carried source ticks; two provider tests
  expected different text from the preserved lens failure; one cleanup fixture
  assumed ordinary missing-source errors abort instead of the established
  missing-clip behavior. It now injects an actual canvas failure after admission
  and proves reservation release before retry. Its source-fetch expectation was
  corrected to the actual order. No pixel/threshold assertion was relaxed.
- Typecheck caught a new test assigning a readonly dependency; the test now
  supplies an immutable dependency override.

No whole-suite, native heap, GPU/encoder queue, raster matrix, export stress or
new browser qualification is implied. The proposed next gate is in
[the resource/performance protocol](resource-performance-protocol.md).
