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

## Focused validation and browser evidence

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
worker.

```
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run test:browser -- --config=playwright.issue198.config.ts
```

After source-level acceptance and an explicit exclusive-slot grant, the command
above ran on clean product source
`ef5c191bf7db65c0ce9adb7b6243b9882f59ea41`: **4/4 Chromium checks passed in
12.2 seconds**. Rectangle, Bezier, ellipse/responsive and open-path checks took
2.6, 2.8, 2.6 and 3.2 seconds respectively. This was the first browser run for
open-path authoring; it had no failed test. No page or browser console errors
were reported. The log contains only the shell's existing NO_COLOR/FORCE_COLOR
notices.

Exact-source artifacts are retained in `.tmp/issue198-ef5c191/`:

- `issue198-browser-ef5c191.log`
- `issue198-open-draft.png` and `issue198-open-closed-small.png`
- `issue198-rectangle.png`, `issue198-bezier.png` and `issue198-small.png`

All five screenshots were inspected. The open draft remains separate from the
rendered rectangle, with the point controls readable in their reserved dock.
After Close and resize cancellation, the closed Bezier handles remain in the
canvas and the dock remains below it. At 768px the dock scrolls within its own
area; it does not cover the lower canvas handles. The static ellipse test also
exercised the real lower-right pointer handle at this width, including undo.

Playwright completed and closed its browser/server. A subsequent listener check
found no process on port 5198; a process check found no matching test Chromium,
Playwright or Vite process. The exclusive slot was released to the orchestrator.
Prior static failures and superseded screenshot evidence remain documented in
`static-mask-editor.md`; they are not overwritten by this run.

This evidence qualifies only the four bounded Chromium flows on the exact source
above. No full-suite, audit, performance, path animation, source-tracking or
whole-issue completion is claimed here.
