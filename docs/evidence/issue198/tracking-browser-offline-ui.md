# Tracking browser gate: explicit offline UI readiness

The parent independently reproduced the15 observer cases against original and
corrected source, accepted `0f19fe4043fd72cb13c695ade5a793c3c5c794c5`, and granted
one complete seven-flow run. Product remains
`c0bce34d45400d537b583fb79c75cb95da05ba20`. Fail-fast native preflight verified
clean source, unchanged product/configuration/original five flows and empty5198.
No source edits occurred during the run.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools npx playwright test --config playwright.issue198.config.ts --output=.tmp/issue198-0f19fe4/playwright --max-failures=1
```

One muted headless Chromium, one worker, no retries, strict5198 and original
assertions were retained. Exit1 after31.1s: **five pass, one fails, one does not
run**. Original rectangle/Bezier/ellipse/open/held flows passed2.6/2.8/3.1/3.2/3.1s.
Point failed15.4s into its flow, at the10s post-Open presentation poll; backward
box did not run. Earlier real point analysis, exact preview/restored pixels,
Apply/canonical keys/one history/undo/redo and actual Save/parse again passed.
Offline Open succeeded. Post-Open retained-data assertions, relink and export
were not reached. No full tracking-browser acceptance is claimed.

## Exact observed rejection

The new `program-presentation-check.json` establishes the rejected condition:

- reason `context-changed`, differing fields only `canvas.width`, `canvas.height`;
- expected frame0, actionAfter5192.100ms, stateChangedAt5192.900ms;
- fresh frame0/seek request5225.700ms, presentation5306.800ms, status drawn;
- no drawn source clips and the expected missing tracking source, reused=false.

The store/request/frame checks were current. This is distinct from the
independently reproduced and fixed DOM/store timestamp defect. The HTML
placeholder dimensions changed after the recorded presentation context.
The trace's canvas snapshots show the new element without explicit width/height
attributes, then with1280x720. They do not serialize the exact two dimension
values at the diagnostic callback; the new correction records those too.

Production `renderWorker/core.ts` sizes the transferred visible OffscreenCanvas
to the presentation profile and posts completion after drawing. Paused Auto is
full project resolution. `previewController` then waits two main-thread RAFs,
providing a rendering opportunity without observing HTML placeholder dimensions.
The HTML Standard specifies asynchronous placeholder bitmap updates on the
OffscreenCanvas agent's rendering-update steps, and default HTML dimensions of
300x150 when attributes are absent. This supports the observed delayed intrinsic
reflection; no renderer pixel defect is established by this failure.
[HTML Standard](https://html.spec.whatwg.org/multipage/canvas.html#the-offscreencanvas-interface)

## Narrow protocol correction

Offline Open is UI/retained-data acceptance, before any source-pixel comparison.
Only that call opts into `expectedOfflineCanvasSize: [1280,720]`, independently
fixed by this protocol's720 project and paused Auto policy. The helper requires
the fresh frame0 drawn result, valid action/state watermarks, same project/media/
frame/canvas identity, and current intrinsic dimensions exactly1280x720. It may
accept the initial dimension reflection after the diagnostic. Wrong dimensions,
replaced canvas and stale project/media/frame remain refused. The opened Source
offline message is asserted explicitly before retained tracks/history checks.

The option is invalid with connected-source qualification or same-frame reuse.
All default waits retain full canvas identity/dimension equality. Relink starts
a separate fresh connected-source wait, requiring the source drawn without
missing clips before any original pixel/export checks. Offline readiness cannot
be inherited by that wait. No global size-check removal, forced render, sleep,
product mutation, numeric threshold or pixel-assertion change is introduced.
Raw rejection evidence now includes observed/current/expected dimensions.

Eight added deterministic cases cover the pending expected size, wrong size,
strict default behavior, replaced canvas, stale document/media/frame, separate
fresh connected qualification, and invalid connected/reuse combinations. Against
unchanged0f helper:20 pass/3 fail of23. Corrected:23/23 pass, including all original
15 staleness and disposal cases. These are direct Node checks of the actual
helper; no browser/codec or17 Vitest runner checks are implied.

## Artifacts, inspection and cleanup

All eight screenshots were inspected: six original views, Apply/redo and opened
offline failure. The failure image shows the Source offline overlay and Relink
row. Original768px global crowding/lower-panel clipping remains qualified; no
full responsive-workspace acceptance is claimed. Trace warning/error/pageError
count is zero. Original five final console assertions passed; point did not
reach its final console assertion. Only shell NO_COLOR/FORCE_COLOR notices
accompanied the failure.

All11 ancestry-qualified PIDs76325,76386,76389,76415,76427,76428,76436,76437,
76438,76496,76497 were absent after exit. No matching browser profile/server or
5198 listener remained; exact source was still clean. The worker explicitly
released the slot and the parent independently verified cleanup. Complete raw
trace/context/screenshots/download/process evidence, extracted events/check and
canvas-snapshot-timeline.json remain in `.tmp/issue198-0f19fe4/`.

Final23-case observer checks, TypeScript including browser files, lint, exact
seven-flow discovery and diff hygiene pass. Logs are `offline-probe-before.log`,
`offline-probe-after.log` and `offline-{typecheck,lint,test-list}.log` in that
directory. Product/configuration/original five flows remain unchanged fromc0bce34.
No rerun has occurred; parent review and a fresh exclusive grant are required.
Connected relink/export/backward box, resource implementation, native handles,
performance/full suite/audit and whole-issue acceptance remain open.
