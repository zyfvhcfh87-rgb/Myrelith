# Tracking browser gate: first run and locator correction

The parent accepted source/protocol `c0bce34d45400d537b583fb79c75cb95da05ba20`
after independent 49 tests in three files plus 17 runner checks, then granted one
exclusive run. Worker verified that exact clean HEAD, no untracked source and an
empty 5198 listener before launch. No schema24 sync or source edits occurred
during the run. Ignored later performance staging was never imported or run.

## Original result

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools npx playwright test --config playwright.issue198.config.ts --output=.tmp/issue198-c0bce34/playwright --max-failures=1
```

The output-directory override preserves the run by SHA. `--max-failures=1`
implements the parent's instruction to stop at the first failure. The committed
seven tests, one worker, muted headless Chromium, strict5198 and no retries were
otherwise unchanged.

**Five pass, one fails, one does not run; exit1 in approximately1.8minutes.**

| Flow | Result |
| --- | --- |
| Rectangle temporary pixels/history/undo | Pass,2.7s |
| Bezier pointer/numeric/keyboard editing | Pass,2.8s |
| Ellipse resize cancellation and smaller monitor | Pass,2.6s |
| Open path and explicit closure | Pass,2.7s |
| Held path pixels/direct editing/history | Pass,3.1s |
| New forward point/save/reopen/export | Fails at setup line96 after90s: exact label lookup for Attach tracking to |
| New backward box | Did not run after stop-on-first-failure |

The new point test created/imported the real silent video and edited a rectangle
mask, then opened Animation. It did not pick a source point, analyze, preview,
Apply, Save/Open/relink or export. Those criteria remain unexecuted. The failure
must not be reported as a tracker/encoder pass or an unrelated baseline failure.

## Offline diagnosis and narrow correction

The preserved page accessibility snapshot shows the loaded Motion tracking
section, its enabled combobox named exactly `Attach tracking to` and both
`Clip transform` and `Mask effect` options. It also shows the Direction combobox.
No lazy-loading failure or page error occurred.

The pinned local Playwright implementation in
`node_modules/playwright-core/lib/coreBundle.js` explains the mismatch:
`getElementLabels` passes an implicit select's containing label through
`elementText`; that text walker concatenates descendant element text, including
the select's options. An exact `getByLabel('Attach tracking to')` therefore
does not match this nested label. The accessibility name used by the combobox
role is the intended visible label, as independently recorded in the failed
page snapshot.

The correction changes only three new-test select locators to
`getByRole('combobox', { name: ..., exact: true })`: attachment setup, Direction,
and attachment-mode cleanup. It preserves exact accessible-name targeting and
all existing assertions, source fixtures, counts, pixels, timing and timeout
limits. Original five tests and all production code are unchanged. It requires
a fresh parent review and slot before rerun.

## Preserved artifacts and inspection

All artifacts are under `.tmp/issue198-c0bce34/`: browser.log, the complete
Playwright failure trace/context/screenshot, six original mask screenshots,
captured process tables, listener output and teardown.txt. The trace's
`trace-problems.json` contains zero warning/error console or pageError events.
The new flow did not reach its final console assertion; this narrower trace
inspection is recorded separately. The five completed flows reached and passed
their console/page-error assertions. Shell output includes only the existing
NO_COLOR/FORCE_COLOR notices in addition to the test failure.

All **seven** produced screenshots were inspected: six original mask views and
the failed tracking setup. Desktop mask controls, open-path draft, held-key
triangle/status/navigation and canvas/dock separation are visible. Narrow768px
shots also show crowded/truncated global toolbar/sequence controls and part of
the lower mask dock below the visible panel; no claim of complete small-screen
workspace qualification is made. The failed tracking shot shows Animation
selected while the lower tracking controls are below the panel's current scroll.
The accessibility snapshot confirms that those controls exist and have correct
role names; the failed locator never reached scrolling/actionability.

## Terminal cleanup

Playwright exited1. Eleven owned PIDs captured during the run (runner, server,
worker and Chromium descendants) were all absent from the post-run native
process table. No matching browser/server processes remained and `lsof` showed
no5198 listener. The exact clean source was reverified. The worker explicitly
released the slot, then the parent independently confirmed5198 clear and granted
the next slot to#200. No correction or rerun occurred while the slot was held.

The source's 324 focused tests plus17 runner/build/lint evidence remains qualified
from c0bce34; production code is unchanged by this locator correction. Typecheck,
lint, diff hygiene and seven-test discovery are the appropriate correction
checks; all pass and discovery still lists exactly seven flows. Logs are
`locator-typecheck.log`, `locator-lint.log` and `locator-test-list.log` in the
preserved SHA directory. Tracking browser acceptance, native handles, repeated export/resource,
full suite/audit and performance gates remain open.
