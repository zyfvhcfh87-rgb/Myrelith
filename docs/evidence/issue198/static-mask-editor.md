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
The corrected exact commit `758ee9c6edafea72216aa55d8879d79a1905d09d`
then passed **all three Chromium tests in 8.9s** using the same command and slot.
The test process exited 0. No console/page errors or framework overlays were
reported; shell-only NO_COLOR/FORCE_COLOR notices are retained in the log.
The local server and browser processes stopped and port 5198 had no listener
before the exclusive slot was released.

Final log and inspected screenshots are preserved under
`.tmp/issue198-758ee9c/`: `issue198-browser-758ee9c.log`,
`issue198-rectangle.png`, `issue198-bezier.png`, and `issue198-small.png`.
Rectangle outline/handles match the rendered mask; original clip transform
handles no longer compete. Bezier numeric/pointer edits visibly change the
inverted feathered region, and the fractional-coordinate submit regression
passes with one history step and an unchanged sibling coordinate.

Screenshot qualification: at 768px the bottom toolbar overlaps the lower
ellipse corner handles. CSS coordinate alignment, keyboard edits and Inspector
numeric alternatives passed, but unobstructed pointer access to every handle
at that narrow layout is not established. This is a remaining layout concern
for the orchestrator's UI review; the three passing checks do not erase it.
The static slice is ready for review, not final issue acceptance. No claim is
made for animated path wires, source tracking, export/reopen or 4K timing.

## Required narrow-layout follow-up

The orchestrator required pointer access before accepting the UI gate. The
follow-up gives Program a stable flex wrapper and places mask controls in a
separate scrollable dock below its manipulation panel. The dock is capped at
45% of the available height. It cannot cover handles; the remaining panel uses
the existing canvas CSS measurement, quality publication and ResizeObserver
cancellation. React portals keep ephemeral gesture/point ownership in the same
component. The transferred canvas stays mounted when opening/closing controls.

A focused Preview test checks the separate dock and stable canvas identity.
53 focused tests plus 17 runner checks pass; build/typecheck and lint passed.
The browser follow-up adds native hit testing and a real lower-right pointer
resize at 768px, asserting larger width/height, one history entry, exact undo
and a screenshot. This corrected layout awaits its committed Chromium run.
