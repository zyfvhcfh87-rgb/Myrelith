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

## Resize correction integrated

Source e6b8b71f8d99fb70e0f2d3caabb72cc76fe58b25 and evidence-only child
08fe58cddd64df76280144406f1ca599b9dfed55 were independently reviewed. Drag,
queued preview and open-path actions now compare live canvas and panel geometry
with their captured viewport before proceeding, including before pointer-up.
Nine deterministic regressions cover geometry changes without a delivered resize
notification. Parent source checks passed four files / 78 tests and 17 runner
checks; the same affected checks pass after the merge, with build/typecheck,
lint and diff hygiene. Logs: /private/tmp/milestone9-resize-integration-*.log.

The worker's unchanged four-flow muted Chromium suite passed on clean e6b8b71
in 11.4 seconds, including the exact previously failing resize/release assertion.
The orchestrator inspected the exact log and all five retained screenshots.
Desktop and 768px editing controls remain separate from the canvas handles;
open drafts stay temporary. Browser/server teardown and slot release were
confirmed. This merge has identical product source to that tested commit; the
additional integration document retains the earlier failure above.

This resolves that specific integration finding. Full suite, animated path,
tracking, broader browser flows, export parity and measured resource gates
remain pending. No issue is declared complete by this correction.

## Held path authoring integrated

Product f923315628f9d6692de756b3d29c3b5a5bb0907f, test-only correction
13f0cfe28d2530ef8e0f504156c31b20ec809798 and browser evidence
125400767b07d3773fb3be5c2b1071adfe95d9f7 passed exact-source review.
The correction explicitly arranges frame zero in the new test; the shared
fixture starts at one. Original four tests, product code and all held-key
assertions stayed unchanged. The earlier four-pass/one-fail evidence is
preserved in issue198/held-path-authoring.md and its separate local artifacts.

All five muted Chromium checks passed in 15.5 seconds on clean13f0cfe. The
new test reached actual frame14/15 held pixels, direct control edits, undo,
key navigation and Clear/undo. All console/page assertions passed. The parent
inspected the exact log and all six screenshots, including the final two-key
triangle. Desktop mask controls remain separate from the image handles; the
small layout has pre-existing surrounding toolbar crowding and needs broader
workspace acceptance separately. Browser/server teardown and slot release were
confirmed. This merge has identical src/tests contents to the tested commit.

Independent parent and merged integration checks both pass14files275tests plus
17runner checks. Integration build/typecheck, lint and diff checks pass; the
existing Vite chunk advisory remains. Logs are retained in
/private/tmp/milestone9-held-path-integration-*.log. Tracking, title-owner
interoperation, shared timing UI, save/reopen/export/playback and measured
resource/full-suite acceptance remain pending. No entire issue is complete.
