# Tracking browser gate: qualified pixels and portable download name

The parent accepted presentation correction
`9d5128337b5df95b1a8e45ea496ca390f65a324e` after reviewing the complete helper,
tests, evidence and production diagnostic generations. Product remains
`c0bce34d45400d537b583fb79c75cb95da05ba20`. This records the next bounded run
and a test-only portable filename correction; browser acceptance remains open.

## Startup failure preserved separately

The first launch attempt used the default sandbox. Native `ps` was denied;
the shell lacked fail-fast handling and then attempted Playwright, whose Vite
server failed to bind127.0.0.1:5198 with EPERM. No tests or Chromium ran.
The original log and native cleanup evidence remain in
`.tmp/issue198-9d51283/`. Escalated read-only inspection confirmed Vite PID70402
absent, no matching processes and no5198 listener. The slot was released.

The parent reviewed that startup failure, independently confirmed the port clear
and renewed the same exact seven-flow grant with scoped native/server/browser
permissions. A fail-fast preflight verified clean9d51283, unchanged product,
configuration and original five flows, and an empty port. No source mutation
occurred during the run. The actual run used separate artifacts:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools npx playwright test --config playwright.issue198.config.ts --output=.tmp/issue198-9d51283-native/playwright --max-failures=1
```

One muted headless Chromium, one worker, no retries and strict5198 were retained.
The run exited1 after approximately1.8minutes: **five pass, one fails, one does
not run**. Original rectangle/Bezier/ellipse/open/held flows passed in
2.6/3.3/3.1/3.2/3.2seconds. The point test reached its90s deadline; the backward
box flow did not run.

## Reached assertions and exact failure

The point flow passed actual frame0 selection; real18-sample analysis/stop18;
idle scheduler/decoder/workers; nonmutating preview; qualified frame17 pixels;
range exit/reentry; exact restored RGBA after preview disable; Apply with only
x/y,18 canonical keyframes/source ticks and the original motion bounds; one
history step; disabled old Apply; exact undo/project/pixel restoration and redo.
It then passed actual Save download, suggested `.myrelith` filename, production
parse, identical saved tracks and absence of runtime/cache identifiers.

It failed while waiting to click `Open with 1 offline`, before any offline-open
presentation wait. The saved accessibility snapshot and failure PNG instead
show an alert rejecting the extensionless filename
`1faa3058-6440-42b2-852e-671c0c7c110f` and a disabled `Open project` button. The
expected offline-open action was absent because no valid candidate was loaded.

The test passed `download.path()` directly to the file input. That path names
Playwright's temporary stored download with a UUID basename, rather than the
portable filename offered by Save. The production
`readProjectCandidateFile` extension guard correctly rejects this name before
reading it. The previously checked suggested filename did not rename that
temporary file. This is a confirmed file-input fixture defect, not an app
extension-validation defect or a presentation timeout.

The correction calls `download.saveAs(testInfo.outputPath(downloadName))`, where
`downloadName` is the actual suggested filename and still must match `.myrelith`.
It reads and reopens those actual downloaded bytes through the same production
parser and file-input UI, while preserving the portable file as a run artifact.
It does not synthesize serialization, rename the source media or bypass the
extension guard. All pixel/numeric/track/export assertions remain unchanged.

The test deadline also made the helper's `finally` evaluate fail with a closed
target, obscuring the original action timeout. Cleanup now preserves an existing
action/poll error if cleanup also fails; without an original error, cleanup
failure still surfaces. The test afterEach continues to dispose observers and
attach diagnostics. No product code, renderer, configuration, encoded fixture,
original five flows, assertions or timeout limits change.

## Artifacts, inspection and cleanup

The native run directory preserves complete browser.log, preflight.json,
process/listener snapshots, teardown.json and original Playwright trace/context.
All **eight** screenshots were inspected: six original mask views, the point
Apply/redo checkpoint, and failed Open. The applied shot shows ordinary-mask
confirmation and disabled old Apply. The failed shot visibly shows the UUID
extension error and disabled Open project. Narrow768px original views retain
crowded global controls and lower panel clipping; whole-workspace responsive
acceptance is not claimed.

The trace contains16 raw post-paint diagnostics, extracted unchanged as
`program-presentations.json`, including fresh frame17 presentations across the
preview/history operations. `trace-problems.json` records zero console
warning/error or pageError events. The five original flows passed their final
console checks; the point flow did not reach its final console assertion.
Shell output contains only NO_COLOR/FORCE_COLOR notices besides the test failure.

Native ownership was qualified by actual ancestry from runner70681, separately
from the first broad text match that also captured the observer's own processes.
`owned-browser-processes.json` records the11 real runner/server/worker/Chromium
PIDs:70681,70715,70716,70742,70743,70744,70752,70753,70754,70783,70784. All were
absent after exit, with no remaining matching browser profile/server or5198
listener. Clean source was reverified. The worker explicitly released the slot;
the parent independently confirmed cleanup and assigned the next slot to#200.
No rerun occurred after release.

Final TypeScript build (`npx tsc -b`, including browser files), lint, exactly
seven-flow discovery and diff hygiene pass for the correction. Logs are
`.tmp/issue198-9d51283-native/portable-name-{typecheck,lint,test-list}.log`.
An initial cleanup form emitted a no-unsafe-finally lint warning; separating
failure cleanup from successful cleanup removed it without suppressing the rule.
That original output remains in `portable-name-first-lint.log`.
Production and original five tests are unchanged fromc0bce34. Parent review and
a fresh exclusive slot are required before rerun. Offline Open, relink, decoded
export and backward box remain unexecuted; native handles, resource integration,
performance/full-suite/audit and whole-issue acceptance remain open.
