# Issue #198 static mask editor slice

This is the bounded static gesture slice authorized after integration
`9fa4bb7b388afad69da4eb39214e1976c5c641ad`. It is not final issue acceptance.
Schema 22, path key authoring/traversal, mask tracking, project reopen/export and
the 4K performance/retention gate remain pending.

## Implemented contract

- The Inspector opens one clip mask's Program handles. Rectangle and ellipse
  masks have move/corner resize controls. Closed Bezier masks additionally expose
  anchors, control points, point selection, numeric percentages, insertion and
  deletion. Arrow keys move one project pixel, Shift moves ten; Escape cancels
  an active drag or closes the editor and restores Inspector focus.
- App sessions pin immutable project identity and generation, sequence, full
  selection and primary clip, adjustment selection, mask target, integer frame,
  playback/scrub state and transport reset revision. Changes cancel immediately;
  late events cannot commit. A final recheck after clearing preview handles
  reentrant subscribers; the store independently checks the expected project.
- Pointer updates retain only the latest patch and coalesce previews to one
  animation frame. Release recomputes from its final coordinates, validates
  freshly, clears its draft and commits once. Window listeners handle capture
  failure/outside release; resize, scroll geometry changes, blur, Escape,
  pointer cancellation, capture loss and unmount discard the gesture.
- Geometry uses the canonical project-space mask descriptor and the canvas CSS
  rectangle. Device pixel ratio, source crop and clip transform never rebase
  the mask. Existing scalar lanes use the same domain operation as Inspector
  numbers and retain source time intent. No path wire collection is introduced.
- Effect document previews have explicit mask/grading ownership. Most recently
  activated live owner wins; hidden updates do not steal priority, cancellation
  restores the surviving draft. Existing text/visual preview composition remains
  after the chosen effect document. Reset clears all owners.
- Existing descriptor/parser/render limits remain authoritative. Unknown mask
  versions, disabled effects, locked/hidden tracks and out-of-clip playheads give
  an availability reason. Numeric validation, project/key limits, no-op edits
  and stale state reject before history/redo mutation.

## Focused checks

With `DEVELOPER_DIR=/Library/Developer/CommandLineTools` and
`NODE_OPTIONS=--no-experimental-webstorage`:

```
npm test -- src/app/maskEditingController.test.ts src/ui/MaskOverlayControls.test.tsx src/app/colorGradingController.test.ts src/state/transportStore.test.ts src/app/previewController.test.ts src/domain/maskGeometry.test.ts src/domain/maskPathEdit.test.ts src/test/architecture.test.ts --maxWorkers=2
npm run build
npm run lint
git diff --check
```

174 tests in eight files and 17 runner checks passed. Build/typecheck passed
(5,022 modules; existing large-chunk advisory only); lint and diff check passed.
The first development pass caught an incorrect import/test helper name and
overly exact floating-point test assertions; these were corrected before the
green run. No broader suite or baseline failure classification is claimed.

## Browser gate: initial run and correction

Browser plugin not available. The repository's Playwright runner is prepared for
quiet headless Chromium, one worker, muted audio, silent local 720p PNG fixtures,
and strict port 5198. No external windows or performance timing are requested.

```
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run test:browser -- --config=playwright.issue198.config.ts
```

Three prepared checks cover real Program pixel changes during a disposable
rectangle drag, one undoable commit/redo/Escape; Bezier pointer/keyboard/numeric
and topology edits with feather/inversion; and ellipse cancellation/responsive
CSS geometry at 1440, 1280 and 768 widths. They check URL/title/nonblank controls,
framework errors, console/page errors, screenshots and focus restoration.
The orchestrator granted an exclusive slot for clean `f6b705399b6fc30b3907279cef1cac6f71fca87d`.
The sandbox first rejected localhost port binding (`EPERM`); the approved
escalated invocation then ran all three checks: **2 passed, 1 failed in 37.6s**.
The rectangle pixel/history/Escape and ellipse responsive checks passed.
Bezier timed out on an exact label locator; its screenshot/accessibility snapshot
shows a correctly named combobox, now selected by role in the test.

Initial logs are `.tmp/issue198-browser-f6b7053.log` and
`.tmp/issue198-browser-f6b7053-authorized.log`. The initial screenshot, error
context and trace are preserved in `.tmp/playwright-issue198-f6b7053/`.
Screenshot inspection also exposed competing clip-transform handles; Program
now unmounts other manipulation overlays while a mask editor is active, using
their existing owned cleanup. Closing restores those controls.

Review caught native numeric step validation rejecting supported fractional point
percentages after a pixel move. Point inputs now use `step="any"` while retaining
domain bounds; no point quantization. The browser regression changes only X after
a keyboard-generated fractional Y and asserts unchanged Y and one history entry.
Correction checks: 52 tests in four files (mask controller, mask UI, Preview UI,
architecture) plus 17 runner checks; build/typecheck, lint and diff check passed.
The observable gate still awaits the corrected committed rerun.
