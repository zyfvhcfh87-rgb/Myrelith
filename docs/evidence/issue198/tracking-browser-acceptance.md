# Tracking browser result at 2b3dbd7

All seven focused browser flows passed, exit 0, in 26.8 seconds. This is the
first complete pass of the registered tracking protocol. The parent accepted
this focused functional gate after independent evidence review. Resource
implementation, the performance/retention matrix, generic animation integration
and whole-issue acceptance remain open.

## Frozen source and command

- Tested source: `2b3dbd7281909777c558766279729af21ac89611`, branch `codex/issue198`.
- Product: `c0bce34d45400d537b583fb79c75cb95da05ba20`. Preflight verified no changes
  to product source, Playwright configuration or the original five tests.
- Source was clean at native preflight and teardown. The parent reviewed and
  explicitly granted this one run after accepting the offline UI observer fix.
- One muted headless Chromium, one worker, no retries, strict port 5198,
  stop at the first failure. No parallel browser/performance/full-suite work
  was launched by this worker. Private worktree dependencies were used.

Workdir: `/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue198`.
Native preflight used fail-fast `set -e`, checked exact SHA/cleanliness, unchanged
product/configuration/original tests, and process/port state before this command:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools npx playwright test --config playwright.issue198.config.ts --output=.tmp/issue198-2b3dbd7/playwright --max-failures=1
```

The command's complete stdout/stderr is preserved at
`.tmp/issue198-2b3dbd7/browser.log`; the execution session subsequently returned
exit 0. The full log is reproduced below without shortening its test output:

```text
[WebServer] (node:79680) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
[WebServer] (Use `node --trace-warnings ...` to show where the warning was created)

Running 7 tests using 1 worker

(node:79681) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
(Use `node --trace-warnings ...` to show where the warning was created)
  ✓  1 [chromium] › tests/browser/issue-198-static-mask.spec.ts:40:1 › Program rectangle drag updates real pixels temporarily and commits once, with undo/redo and safe Escape (2.6s)
  ✓  2 [chromium] › tests/browser/issue-198-static-mask.spec.ts:70:1 › Bezier points offer pointer, numeric and keyboard edits plus bounded insertion/deletion (2.8s)
  ✓  3 [chromium] › tests/browser/issue-198-static-mask.spec.ts:106:1 › ellipse editor cancels on resize and stays usable across desktop and smaller letterboxed monitors (2.6s)
  ✓  4 [chromium] › tests/browser/issue-198-static-mask.spec.ts:145:1 › open path points stay temporary until explicit closure and cancel safely across resize (2.7s)
  ✓  5 [chromium] › tests/browser/issue-198-static-mask.spec.ts:187:1 › held path keys preserve fallback, change Program pixels at the key and support direct edits and undo (2.8s)
  ✓  6 [chromium] › tests/browser/issue-198-tracking.spec.ts:147:1 › real point tracking previews, applies once, saves/reopens through UI and matches decoded export (6.9s)
  ✓  7 [chromium] › tests/browser/issue-198-tracking.spec.ts:258:1 › real backward box tracking exposes size and exact replacement consent and disposes abandoned preview (5.6s)

  7 passed (26.8s)
```

## What the passing assertions establish

The unchanged original five flows again passed rectangle gestures/history/
Escape, Bezier pointer/numeric/keyboard/topology edits, ellipse resize/small
monitor handling, temporary open-path closure/cancellation, and held-path pixel
boundaries/edit/history/navigation behavior.

The point flow executed real source picking and production analysis, accepted
18 samples at frames 0–17 and reported loss at frame 18. Temporary preview kept
the saved project/history unchanged, exited and reentered the accepted range,
changed the qualified Program pixel, and restored the exact original RGBA when
disabled. Apply produced exactly x/y lanes with 18 canonical frame/tick pairs,
motion within the original 13–21 source-pixel bounds and one undo entry. Exact
project and pixel undo/redo passed; the old session could not be applied again.

Actual Save produced `Mask tracking QA.myrelith` (7,181 bytes). The test parsed
those bytes with the production parser, compared all ordinary mask tracks and
rejected runtime/cache identifiers. Projects/Open read this actual saved file,
opened with one offline asset, retained tracks and reset history. The explicit
offline wait qualified fresh frame-0 UI/data and expected 1280x720 canvas size;
Source offline was visible. Actual relink reconnected the fixture and required
a new strict connected-source presentation before Program pixel checks.

The production export controller then produced a silent AVC result; Mediabunny
decoded actual frames 0, 17 and 31. Assertions passed for 1280x720 dimensions,
duration close to 32/30 seconds (two decimal places), no audio, more than 1,000
encoded bytes, visible frame-0 RGB sum above 30 and masked frame-17/31 sums below
36. Program masked sums stayed below 8. These are the original thresholds,
unchanged by the observer corrections. No lossless/full-frame parity claim is
made. This short export does not qualify the later 300-frame retention gate.

The backward box flow selected frame 17 and analyzed to frame 0, accepted 18
samples and stopped at the clip boundary. It verified the project-axis bounds/
no-rotation disclosure, all four owned lanes with exact canonical frame/tick
pairs, reference x=0.45 and width=0.08 within the original tolerance, one Apply,
and exact project undo/redo. Fresh analysis required complete-lane replacement
consent; disabling size cleared that consent and named only Left/Top. Preview
range transitions and abandonment by changing attachment type preserved the
committed project and disposed the tracking preview.

Both tracking flows reached the scheduler/worker assertions: zero active jobs,
decoder reservations and workers; observed scheduler maxima at most one job and
one decoder; at least one worker created and equal created/terminated counts.
All seven final browser console/page-error assertions passed. The two environment
color notices above came from Node, not browser console failures.

## Retained artifacts and limits

All artifacts are under `.tmp/issue198-2b3dbd7/`. `artifact-manifest.json` records
SHA-256 and byte size for the 23 retained primary files: the full log, preflight,
native process/listener snapshots, ownership/teardown proof, power/timestamp
evidence, nine screenshots, actual portable file and Playwright pass marker.

All nine screenshots were individually inspected:

| Screenshot | Observation |
| --- | --- |
| `issue198-rectangle.png` | Visible rectangular mask, center/corner handles and gesture controls. |
| `issue198-bezier.png` | Inverted feathered Bezier result, point/control handles and numeric editor. |
| `issue198-small.png` | Ellipse and handles remain visible in the narrow letterboxed Program. |
| `issue198-open-draft.png` | Three-point temporary draft, explicit Close/Cancel controls and unchanged rectangle. |
| `issue198-open-closed-small.png` | Closed Bezier handles visible at the narrow size. |
| `issue198-path-key.png` | Held triangle, two-key disclosure and key/navigation controls. |
| `tracking-point-applied.png` | Applied mask, connected source, ordinary-key disclosure and disabled old Apply. |
| `tracking-reopened.png` | Opened project, completed relink showing one connected asset and visible source pixels. |
| `tracking-box-review.png` | Accepted range 0–17, clip-boundary stop, checked full Left/Top replacement consent, preview and Apply. |

The three tracking PNGs are inside their Playwright test output directories.
Desktop Inspector content is vertically clipped/scrollable, and the small
768px views show existing workspace toolbar crowding/overlap and lower editor/
timeline clipping. The images support these exercised controls and Program
states; they do not establish an unclipped responsive layout for the whole app.

The reporter is `list` and traces use `retain-on-failure`. Successful
`testInfo.attach({ body: ... })` JSON was **not persisted**. The output contains
no `program-presentations`, `program-presentation-check`,
`tracking-export-and-resources` or `tracking-box-resources` JSON, and no success
trace. The exact raw pixel values, encoded byte count/duration, scheduler
snapshots, presentation events and browser-console event stream therefore
cannot be independently inspected after this run. The export buffer itself was
decoded in memory and not saved. The complete pass log and exact frozen source
establish that their assertions were reached and passed; values have not been
reconstructed. The actual portable file and screenshots are independently
retained. A later resource/export gate must explicitly save its raw values to
files. No automatic rerun or harness change was made for this limitation.

The parent independently read the complete pass log and all nine PNGs, checked
the portable file's SHA-256
`fd14ba2be6d2b6c51d6f784d985463a234fe1c344351ec7b98376d3653162f42`, and verified
that its x/y lanes each contain 18 keys with canonical source ticks. Acceptance
explicitly retains the assertion-based raw-value qualification above. The parent
will integrate this source/evidence and run the focused shared-boundary checks.
Resource authority/cleanup implementation under the previously accepted proposal
is authorized only after the parent provides the accepted integration SHA for
synchronization, including real-caller migration if cleanup option 4b is used.
No native, full-suite or resource/performance run is authorized by that source
grant; those require later exact-source/protocol review and an exclusive slot.

## Sleep timeline and native release

`artifact-timestamps.json` records filesystem modification times in UTC:

| Artifact | Time on 2026-09-08 |
| --- | --- |
| Clean preflight | 16:01:37.872479 |
| During-run native snapshot | 16:01:58.415122 |
| Complete browser log | 16:02:05.015203 |
| Playwright pass marker | 16:02:05.015535 |
| Final worker teardown proof | 16:35:35.452513 |

The read-only `pmset -g log` excerpt is retained in `power-events.txt`. Its local
times are UTC+02:00: DarkWake at 18:00:10, Sleep at 18:02:31 for 360 seconds,
DarkWake at 18:08:31, Sleep at 18:09:17 for 960 seconds, DarkWake at 18:25:17,
and Sleep at 18:26:02 for 248 seconds before DarkWake at 18:30:10. Thus the
browser output/pass marker precede the first sleep after launch by about 26
seconds. The reported 26.8-second functional run was not suspended during these
recorded intervals; result recovery/cleanup inspection was delayed afterward.
This is host-timeline qualification, not a performance benchmark or a reason to
change product code, assertions or timeouts. No power settings were changed.

Native snapshots captured the runner and 10 descendants: 79619, 79653, 79654,
79680, 79681, 79682, 79690, 79691, 79692, 79723 and 79724. After exit, all 11
were absent, no matching Chromium profile/Vite process remained, port 5198 was
clear, and source was still exact clean `2b3dbd7`. This list is a captured
ancestry snapshot, not a claim to enumerate every short-lived PID ever spawned.
The parent independently checked all captured PIDs and ports 5198/5199 in
`.tmp/milestone9-orchestration/mask-2b3-parent-release.json`, reclaimed the slot
and granted it to #199. This worker also explicitly released the consumed grant.
No further native/browser run is authorized by this result.

## Prior failures remain part of the record

Each earlier run stopped at its first failure and retained its separate log,
trace/context, screenshots and native cleanup proof. None is reclassified as
a successful run. The parent reviewed each correction before a fresh grant:

- [Exact combobox locator correction](tracking-browser-run.md).
- [Qualified passive presentation and exact pixel restoration](tracking-browser-presentation.md).
- [Portable Save filename and primary-error preservation](tracking-browser-portable-name.md).
- [DOM remount versus store timestamp regression](tracking-browser-remount.md).
- [Explicit offline intrinsic-size/UI qualification](tracking-browser-offline-ui.md).

The final helper has 23 deterministic actual-helper checks, with before/after
failures and unchanged controls recorded in the last two evidence files.
Typecheck including browser tests, lint without warnings, exact seven-test
discovery and diff checks passed before this run. This evidence-only update
does not rerun those checks or infer full-suite acceptance from them.
