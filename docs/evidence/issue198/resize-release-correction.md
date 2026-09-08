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

## Exact-source browser revalidation

After parent source acceptance and independent 78 tests/four files plus 17 runner
checks, the parent granted an exclusive slot for clean product source
`e6b8b71f8d99fb70e0f2d3caabb72cc76fe58b25`. The unchanged browser suite ran with
strict port 5198, one muted headless Chromium worker and the silent local 720p PNG:

```
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run test:browser -- --config=playwright.issue198.config.ts
```

**4/4 checks passed in 11.4 seconds**: rectangle 2.6s, Bezier 2.8s, ellipse 2.6s
and open authoring 2.7s. The original immediate viewport-change/pointer-up
cancellation assertion passed unchanged. The same ellipse check also exercised
the 768px lower-right handle through native pointer hit testing, one resize
history entry and exact undo. No browser/page console errors were reported;
the log contains only the existing NO_COLOR/FORCE_COLOR notices.

Exact log and all five screenshots are retained in `.tmp/issue198-e6b8b71/`:
`issue198-browser-e6b8b71.log`, `issue198-rectangle.png`, `issue198-bezier.png`,
`issue198-small.png`, `issue198-open-draft.png` and
`issue198-open-closed-small.png`. Every screenshot was inspected. The dock remains
separate from canvas handles at desktop and 768px; the open outline remains
separate from the unchanged rendered mask, and closed geometry remains visible
after resize cancellation. Smaller controls scroll within their own dock.

Playwright exited successfully. A subsequent listener check found no process on
5198 and a process check found no matching Chromium/Playwright/Vite test process.
The slot was explicitly released to the parent. The original failing integration
log, screenshot, context and trace remain preserved separately above.

This run qualifies only these four bounded Chromium flows on exact e6b8b71.
No broader/full/performance run or path/tracking feature promotion was included.
