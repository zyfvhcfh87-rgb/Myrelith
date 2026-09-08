# Schema 22 and mask integration

The orchestrator reviewed schema foundation f555a043074ca8e8f54cb312a1372d061fd881eb
and mask authoring a4bb578d2d7e1f0b6a8763667979bb4a8a18a8c8, previously integrated
as 32324c38bbfc0a3cda94f4fd1263a942bc691df1. This merge resolves the new shared
store admission name in commitMaskEdit and shares the complete app file preflight
through portableProjectEditError. The mask controller retains its existing exact
project, generation, sequence, selection, playhead and reentrant-session guards;
its final store action retains sequence admission and one-entry history.

The actual 9,999,999 / 10,000,000-character legacy-file matrix now includes a
static mask and verifies that a growing mask edit rejects before clearing a
populated redo branch. Ordinary equal-length edits and exact undo/redo remain
covered. All four combinations of file size and legacy scalar presence pass.

Independent foundation validation passed 42 files / 499 tests and 17 repository
runner checks. Integration validation passed 49 files / 682 tests and 17 runner
checks, build/typecheck, lint and diff hygiene. The matrix is the foundation's
schema22-focused-files.txt plus maskGeometry, maskPathEdit, maskEditingController,
MaskOverlayControls, Preview, transportStore and previewController tests, with
maxWorkers=2, DEVELOPER_DIR=/Library/Developer/CommandLineTools and
NODE_OPTIONS=--no-experimental-webstorage. Build retains the existing Vite chunk
size advisory.

The first integration attempt passed 662 tests and failed six UI assertions:
the old mask UI fixture omitted its media descriptor, so the new real portable
preflight correctly refused its commits. Adding the existing canonical descriptor
fixture corrected all six without changing production admission or assertions.
The controller fixture also supplies explicit source ticks for its capacity
case. An initially listed nonexistent maskEditing.test.ts filter was corrected
to maskGeometry.test.ts; all 49 final paths were checked to exist. The final count
above is the actual runner result, not the requested filter count.

Exact logs are retained locally in /private/tmp/schema22-mask-integration-*.
The earlier four-flow mask browser result qualifies ef5c191, before this merge.
Combined browser revalidation, full suite, export parity and measured performance
remain separate gates. No issue is complete and no publication is included.

## Combined browser attempt on f9945c4

The four quiet Chromium checks ran on clean f9945c44f75a4818bc939d8b6e63c09db353e669.
Rectangle, Bezier and open-authoring passed; ellipse resize cancellation failed
at tests/browser/issue-198-static-mask.spec.ts:113. A viewport resize followed
immediately by pointer release committed x=0.26034482758620686 instead of
preserving x=0.2. This is an actionable integration finding, not a qualified
baseline failure or a passing gate. The mask owner is fixing the ordering so
commit cannot precede cancellation merely because resize delivery is delayed.

The 12.8-second run log remains at /private/tmp/schema22-mask-integration-browser.log;
the failed screenshot, trace and context are retained under the integration
worktree's .tmp/playwright-issue198 directory. Scoped process/listener inspection
confirmed no Chromium/Playwright/Vite process or 5198 listener after the run.
