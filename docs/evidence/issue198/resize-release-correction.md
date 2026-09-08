# Issue #198 resize-before-release correction

The parent ran the four bounded Chromium tests on clean integration
`f9945c44f75a4818bc939d8b6e63c09db353e669`. Rectangle, Bezier and open-path checks
passed; the ellipse cancellation assertion at browser spec line 113 failed.
After a temporary drag, changing the viewport to 1280×720 and immediately
releasing the pointer committed mask x=0.26034482758620686 instead of preserving
x=0.2. This is an actionable ordering defect, not a baseline or flake claim.
The worker consumed the exact integration as merge `c427ca1` before this fix.

The gesture pinned its initial CSS viewport but checked layout changes only when
the resize/scroll observer delivered a callback. Pointer-up could use the old
mapping and commit before that callback. The correction shares one live canvas/
panel CSS measurement and exact geometry comparison across the static handles
and open-path authoring. Pointer start pins the live measurement. Pointer update,
queued preview and release compare it again synchronously; any difference or
hidden canvas cancels through the existing owned cleanup path. Width, height,
canvas position and panel origin all participate. No backing-store/DPR math is
introduced, and the app's currentness/reentrant ownership guards are unchanged.

Open-path Add, Remove and Close also check live geometry against the first point's
pinned viewport, so delayed observer delivery cannot commit that stale draft.
Before the first point, layout may settle; pointer normalization reads the actual
canvas dimensions. Later equal-valued measurements do not invalidate by object
identity alone.

Nine deterministic regressions change geometry without dispatching any resize,
scroll or observer notification. They cover size/position/panel/hidden-canvas
changes before pointer-up, queued preview and further movement, open-path Add and
Close, and first-point layout settling before notification. Cancellation clears
temporary preview and retains the exact project, empty undo history and existing
redo branch. Existing cancellation, ownership and UI tests remain intact.

Validation used `DEVELOPER_DIR=/Library/Developer/CommandLineTools` and Vitest
`NODE_OPTIONS=--no-experimental-webstorage`:

```
npm test -- src/ui/MaskOverlayControls.test.tsx src/app/maskEditingController.test.ts src/ui/Preview.test.tsx src/test/architecture.test.ts --maxWorkers=2
npm run build
npm run lint
git diff --check
```

**78 tests in four files plus 17 repository runner checks passed**. Build/typecheck
and lint passed; build retains the existing large-chunk advisory. Source/logs are
retained under `.tmp/issue198-resize-correction/`, including a copy of the parent's
original failure log. The parent's full failure screenshot/context/trace remain
in its integration worktree under
`.tmp/playwright-issue198/issue-198-static-mask-elli-6b7a4-maller-letterboxed-monitors-chromium/`.

The original browser assertion is unchanged. This source correction has not been
browser-tested; exact committed review and a new exclusive-slot grant are needed.
No worker browser/full/performance run or path/tracking feature promotion was
included in this correction gate.
