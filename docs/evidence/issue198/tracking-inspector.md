# Mask tracking Inspector source gate

Parent accepted the corrected controller `8cc1fe997688f541df0a19a9be41ddf5657550ed`
and integrated it at `08805c570fb60f739e3414e4d76eff861cc89343`. This subsequent
source slice activates that reviewed contract in the Inspector and adds actual
file-boundary and UI checks. No new schema, analysis service, projection math,
renderer or history authority is introduced.

## Behavior

Motion tracking offers an explicit Clip transform / Mask effect choice. The
existing transform target rules remain intact. The mask child lists enabled
supported masks on connected, visible, unlocked visual clips, with source-clip
masks first. Losing a selected mask leaves an unavailable selection; it does not
silently choose another mask. The app remains the final applicability authority.

The review identifies the exact mask and owned Left/Top or Left/Top/Width/Height
lanes, accepted project frames and samples, confidence and stop frame. Box size
discloses project-axis bounds without rotation. Replacement consent names every
owned lane, including off-range keys, and is tied to the complete reviewed
content. Changing the target, source, size mode, document or reviewed plan clears
consent and disposes the old preview. The UI sends commands to the app-owned
review; it contains no interpolation, geometry, project edits or history logic.

Preview remains temporary and is limited to accepted frames. Apply creates one
ordinary mask-key edit, clears the old session, and remains unavailable during
playback or scrubbing. The pre-Apply text explains linear interpolation between
accepted observations and endpoint hold after Apply, and directs ordinary-key
editing/removal to Animation. Generic animation workspace controls remain #199's
responsibility; `Inspector.tsx` is unchanged.

## Focused validation

On this source, `DEVELOPER_DIR=/Library/Developer/CommandLineTools` and
`NODE_OPTIONS=--no-experimental-webstorage` were used for bounded Vitest:

```sh
npm test -- src/app/maskMotionTrackingController.test.ts src/app/motionTrackingController.test.ts src/domain/maskTracking.test.ts src/domain/motionTracking.test.ts src/domain/motionTrackingOperations.test.ts src/state/transportStore.test.ts src/state/motionTrackingDocumentStore.test.ts src/app/maskEditingController.test.ts src/app/previewController.test.ts src/app/animationAdmission.test.ts src/app/animationFileBoundary.test.ts src/domain/titleOwnerLifecycle.test.ts src/domain/titleOwnership.test.ts src/app/animationEditingController.test.ts src/app/animationTitleIntegration.test.ts src/test/architecture.test.ts src/ui/MaskTrackingAttachmentEditor.test.tsx src/ui/MotionTrackingEditor.test.tsx src/ui/Inspector.test.tsx --maxWorkers=2
npm run build
npm run lint
git diff --check
npx playwright test --config playwright.issue198.config.ts --list
```

Results: **324 tests in 19 files plus 17 runner checks pass**. Build/typecheck,
lint and diff hygiene pass. Vite reports its existing large-chunk advisory.
Discovery finds exactly seven browser checks in two files; discovery launches
neither a browser nor a server and is not browser acceptance.

The five new actual UI tests cover source-mask targeting versus forbidden
self-transform, temporary preview and one Apply/undo/redo, exact replacement
consent including an off-range change, position-only box preservation of existing
size lanes, losing connected media without retargeting, and mode/unmount cleanup
without clearing a newer animation preview. Only the bounded analysis service
response is mocked in these UI tests; app review, stores, portable preflight and
history are real. The legacy eight tracking UI and 54 Inspector tests also pass.

The app regression file now has 36 tests. Its four new cases use actual valid
9,999,999- and 10,000,000-character files with shared compact-title fixture
padding. No serializer or file limit is mocked/lowered. They prove growth is
refused before preview without modifying project/history/redo; an exact-fit
attachment reaches 10,000,000, survives production serialization/parse, commits
once and supports exact undo/redo and a true no-op; and one additional character
in the media envelope after review is independently refused by fresh Apply.

Logs: `.tmp/issue198-tracking-ui-final-{tests,build,lint}.log` and
`.tmp/issue198-tracking-browser-list.log`. Earlier narrow UI/app runs passed
13+17 and 36+17 respectively. The first build found a new test using Playwright's
`exact` option with Testing Library; that test locator was corrected to an exact
name regex. The final 324-test run and build include that correction. The failed
build is preserved at `.tmp/issue198-tracking-ui-first-build.log`.

## Open gates

The [committed protocol](tracking-browser-protocol.md) and two new browser tests
exercise actual point/box analysis, preview/Apply/history, download/Open/relink,
decoded export and analysis-resource counters. They have not executed. Parent
source review and an exclusive quiet slot are required first. The five previous
mask browser flows remain unchanged. No tracking browser, native-handle,
full-suite, audit, 4K performance or repeated-export retention claim is made.
