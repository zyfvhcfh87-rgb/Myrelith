# Issue #198 held-path authoring source gate

This slice starts from accepted integration
`6888fd8f60973f026dce5c5ad1d8badb66963bc3`, after the resize correction and its
four unchanged Chromium checks were accepted. It consumes schema 22's existing
path collection, shared resolver, source timing, traversal and retention APIs.
No schema, alternate renderer, tracker or duplicate timing/budget owner is added.

## Authored behavior

Animate mask path creates a held key with the current resolved path at the
clip-local integer playhead. Explicit Set adds or replaces that frame. Once a
path track exists, Program point/control/topology edits, new-path Close and the
raw Inspector path field write its playhead key while leaving the saved static
fallback intact. Other scalar edits retain their canonical behavior and can
commit together with the path in one transaction. A failure cannot leave only
the path or only the scalar portion committed.

The Inspector shows key count, held semantics, Previous/Next in-clip key
navigation, Remove at playhead and Clear path keys. Removing the last key or
clearing restores the saved static fallback. Keys outside the clip remain
preserved, participate in budgets and are removed by explicit Clear; the shared
#199 timing editor remains the owner of moving/duplicating/pasting key times.
Numeric curve interpolation is not offered for path strings.

Rectangle/ellipse shapes keep dormant keys. New-path Close can reactivate that
lane and writes its held value even if the new path happens to equal the dormant
static fallback. Text path animation remains unavailable. Future value versions,
future types, malformed known paths and scalar intent owning the same path
parameter remain preserved and visibly unavailable; they cannot be silently
edited or cleared as supported v1 geometry. Unrelated scalar/title/path metadata
and immutable sibling track objects are retained.

The app's existing mask session now accepts an explicit path-key command through
the same exact project/generation/sequence/full-selection/frame/reentrant-owner
guard and cleanup path as pointer commits. Temporary animated documents do not
enter history. Final admission uses `portableProjectEditError` with the complete
media envelope, then the existing store transaction repeats shared project and
history/clipboard retention admission before clearing redo.

Path keys use target `clipSourceTimeMap`/`sourceTicksAtTimelineOffset`, never legacy
range or seconds-derived ticks. Existing 256-key track, document aggregate,
4,096 project path-key, value-character, portable-file and retained-history
limits remain authoritative. The value adapter validates a new path and shares
the existing prepared-path cache with resolution/status, exposing that existing
cache function rather than introducing another retained cache.

The raw path field discards typed drafts on project/frame changes and Escape.
Its original context is checked again before blur commit, so a stale typed value
cannot land on a later frame. The earlier live CSS geometry checks and all
resize/cancellation/reentrant cleanup guards remain in place.

## Focused evidence

Run with `DEVELOPER_DIR=/Library/Developer/CommandLineTools` and Vitest
`NODE_OPTIONS=--no-experimental-webstorage`:

```
npm test -- src/domain/maskPathEditing.test.ts src/domain/maskPathAnimation.test.ts src/domain/animationFoundation.test.ts src/domain/animationLifecycle.test.ts src/app/maskEditingController.test.ts src/app/animationFileBoundary.test.ts src/app/animationAdmission.test.ts src/ui/MaskOverlayControls.test.tsx src/ui/MaskPathAnimation.test.tsx src/ui/Inspector.test.tsx src/ui/Preview.test.tsx src/state/transportStore.test.ts src/app/previewController.test.ts src/test/architecture.test.ts --maxWorkers=2
npm run build
npm run lint
git diff --check
```

**275 tests in 14 files plus 17 repository runner checks passed.** This includes
actual temporary animated preview, one-entry history, exact undo/redo, portable
serialization/parsing, a 4,096-key project refusing the actual mask command while
retaining populated redo, typed/dormant/future/malformed targeting, target ticks,
track capacity, fallback restoration, Inspector controls and typed-draft
cancellation. The existing shared lifecycle and real 9,999,999/10,000,000-character
file matrix also passed. Build/typecheck and lint passed; only the existing Vite
large-chunk advisory remains.

Initial validation failures are retained rather than described as prior success:
one test changed a legacy source range but left its canonical source map at zero;
it now changes the canonical map and independently expects 210,000,000 target
ticks. The older Inspector fixture omitted a media descriptor, then initially
supplied a video-only descriptor for an audio-track clip. It now supplies the
matching audio/video descriptor required by real portable admission. No
production preflight or test assertion was weakened. An initial unused parameter
build error was resolved while adding the typed-draft frame guard.

Logs remain under `.tmp/issue198-path-*`, including the initial failed runs,
Inspector diagnostic, final focus/build/lint and browser test listing.

## Requested browser gate and qualification

The unchanged four mask flows plus one new held-path flow are prepared in the
existing quiet Playwright spec. `playwright test --list` discovered all five
without starting a browser or server. The new flow checks actual Program pixels
before/at the held key, source ticks and static fallback, direct control editing
at an existing key, exact undo, key navigation, Clear and undo, and a screenshot.

```
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run test:browser -- --config=playwright.issue198.config.ts
```

Request exact committed source review before an exclusive slot: strict port
5198, one muted headless Chromium worker, existing silent local 720p PNG, five
bounded tests, expected under one minute. Browser plugin not available; repository
Playwright is configured. No full-suite or performance run was made for this slice.

## First browser run and fixture correction

Parent accepted product source `f923315628f9d6692de756b3d29c3b5a5bb0907f` after
independent 275 tests/14 files plus 17 runner checks and granted the five-test run.
On that exact clean source the original four checks passed, but the new held-path
test failed at its key-frame assertion: **4/5 checks passed in 15.7 seconds**.
It expected `[[0, 0], [15, 15000000]]` but observed
`[[1, 1000000], [15, 15000000]]`.

Inspection confirmed `issue-196-grading-fixtures.ts:25` explicitly starts the
playhead at frame 1. The product honored that frame; this new test had assumed
zero without arranging it. The correction explicitly seeks and asserts frame
zero before creating the first key. Both original key/tick expectations and all
remaining pixel/history assertions stay unchanged. No production source changes.

Exact log, five original-flow screenshots and complete failure trace/context/
screenshot are retained in `.tmp/issue198-f923315/`. All six available screenshots
were inspected: the original layouts remain consistent and the failure image
shows the authored triangular mask and two held keys. The intended final
`issue198-path-key.png` was not reached. The original four tests reported no
console/page errors; inspection of the failed test's trace found no warning/error
console or pageError events. Its final in-test error assertion was not reached.

The run ended before testing the frame14/15 held pixel boundary, direct control
edit, navigation and Clear/undo, so those remain unqualified in Chromium.
Playwright exited and no port5198 listener or matching Chromium/Playwright/Vite
test process remained. The slot was explicitly released. No rerun occurred;
the committed fixture correction requires review and another exclusive grant.

The accepted tracking contract is still a separate implementation gate. Its
canonical architecture amendment has not been promoted here. Shared timing-editor
integration, actual save/reopen UI and export/playback parity, tracking acceptance,
full suite/audit and measured 4K performance/retention remain outstanding. Whole
issue completion is not claimed.
