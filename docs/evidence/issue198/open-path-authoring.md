# Issue #198 independent open-path authoring slice

The orchestrator accepted the static mask editor at `8117a9a` and authorized
this independent continuation on reviewed integration
`125a8c8c69cedb9d3435c39128f94eaf2c54215b`. Schema 22 is still owned by #199.
This slice uses the existing static mask descriptor and closure operation; no
new path collection, timing API, schema, renderer or tracking target is added.

## Authoring behavior

Draw new path opens a temporary drawing mode inside the existing mask box.
Pointer placement or numeric percentages add 3–8 points. New segments are
straight cubics; after Close, existing Bezier handles can shape their curves.
Remove last draft point changes only the draft. Close creates the closing cubic
through `closeMaskBezierDraft`, validates through the existing mask transaction,
and replaces shape/path in one undoable edit. Original geometry, feather,
inversion, identity and unrelated descriptor keys remain intact.

The 3-point minimum is specific to this point-placement UI. Existing valid
one-segment cubic masks retain their parser/editing compatibility. Seven open
segments leave room for the eighth closing segment; point-count admission
precedes traversing/copying geometry. Coordinates are finite and normalized.
Consecutive duplicate points are rejected without changing the draft.

Open geometry is a bounded immutable UI draft (at most eight points and seven
cubics). It never enters the descriptor, transport render preview, persistence,
history, clipboard or a renderer. The existing mask continues to render while
the open outline is displayed separately. Cancel/Escape, blur, pointercancel,
selection/frame/project/generation changes, hidden canvas and unmount discard
the draft. Late Close cannot write to history.

`beginMaskEdit` gains an optional end notification so long-lived UI drafts learn
about all authoritative context invalidations. It fires once after cleanup,
including commit. A new owner created during cleanup prevents an older release
from committing. The static gesture callers remain unchanged.

The authoring dock reserves 45% of the available height so point counts and
validation messages cannot resize the canvas mid-draft. Its initial layout may
settle before the first point; thereafter the actual canvas CSS viewport is
pinned and a resize cancels. The canvas remains mounted. Close/Cancel restores
focus to Draw new path.

## Focused validation and browser request

Run with `DEVELOPER_DIR=/Library/Developer/CommandLineTools` and Vitest
`NODE_OPTIONS=--no-experimental-webstorage`:

```
npm test -- src/domain/maskPathEdit.test.ts src/app/maskEditingController.test.ts src/ui/MaskOverlayControls.test.tsx src/ui/Preview.test.tsx src/app/colorGradingController.test.ts src/state/transportStore.test.ts src/app/previewController.test.ts src/test/architecture.test.ts --maxWorkers=2
npm run build
npm run lint
git diff --check
```

The focused tests cover immutable append/remove/closure, capacity before payload
inspection, invalid/duplicate coordinates, one final history entry and exact
undo/redo, no render preview while open, all cancellation routes, layout settling
before the first point, late Close, fractional numeric coordinates, and the
existing static/grading/preview ownership regressions.

Initial `031b59d` focused result: **186 tests in eight files and 17 runner checks passed**.
Build/typecheck passed (5,023 modules, existing large-chunk advisory only);
lint and diff hygiene passed. A prior smaller development focus passed 83 tests;
the later reentrant-owner and hidden-canvas cases are included in the final count.

Parent review found a distinct reentrant-startup race: canceling the previous
owner can invoke its end callback, which creates a replacement owner and preview.
The outer startup previously displaced that replacement without cleanup. Startup
now refuses to continue if cancellation installed another live owner. The new
regression verifies the replacement preview remains authoritative and usable,
only its document/transport subscriptions remain, the refused outer callback
never runs, no history changes on refusal, and final replacement commit clears
all subscriptions once. Correction validation: **187 tests in eight files plus
17 runner checks passed**, with build/typecheck, lint and diff checks green.
No browser run preceded this correction.

Browser plugin not available. The existing quiet Playwright configuration on
strict port 5198 now has four tests: the three accepted static flows plus a new
open-path flow. The new flow checks pointer/numeric placement, unchanged Program
pixels/project while open, explicit closure changing pixels with one history
entry, exact undo/redo, Escape and resize cancellation, and screenshots. It uses
only the existing silent local 720p PNG fixture and one muted headless Chromium
worker; expected runtime is under one minute.

```
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run test:browser -- --config=playwright.issue198.config.ts
```

No browser run has been made for this slice. A committed exact-source review and
exclusive slot are required before running it. No full-suite, audit, performance,
path animation, source-tracking or whole-issue completion is claimed here.
