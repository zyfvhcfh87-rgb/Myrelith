# Tracking browser gate: second run and presentation synchronization

The parent accepted the three-locator correction
`48f24ecdcf9b11283a6066a7c1917d61cd310e03`, with product source still
`c0bce34d45400d537b583fb79c75cb95da05ba20`, and granted a fresh exclusive
seven-flow run. The worker verified clean source, unchanged original five tests
and configuration, and an empty 5198 listener before launch. No schema24 sync
or source mutation occurred during the run.

## Preserved result

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools npx playwright test --config playwright.issue198.config.ts --output=.tmp/issue198-48f24ec/playwright --max-failures=1
```

One muted headless Chromium, one worker, strict port5198, no retries and the
original assertions were retained. The run exited1 after24.7s: **five pass,
one fails, one does not run**.

| Flow | Result |
| --- | --- |
| Rectangle temporary pixels/history/undo | Pass,2.6s |
| Bezier pointer/numeric/keyboard editing | Pass,2.8s |
| Ellipse resize cancellation and smaller monitor | Pass,2.6s |
| Open path and explicit closure | Pass,2.7s |
| Held path pixels/direct editing/history | Pass,3.3s |
| Forward point/save/reopen/export | Fails after9.8s at original line142: restored pixel equality |
| Backward box | Did not run after the first failure |

This time the new point flow reached real frame0 point selection and production
analysis:18 accepted samples, stop at frame18, scheduler/decoder/worker idle,
nonmutating preview, a dark masked sample, and range exit/reentry all passed.
After unchecking preview, the exact restored RGBA assertion timed out after the
unchanged5s limit: expected `[47,14,40,255]`, received `[49,15,29,255]`.
Apply, undo/redo, Save/Open/relink and decoded export were **not reached** in
this flow. No tracking browser acceptance is claimed.

## Confirmed test gap and bounded correction

The original `seek` waited only for the transport store's integer frame. It did
not wait for the requested image to finish rendering and pass the presentation
boundary. Its luminance check accepted any sufficiently bright source sample,
so that check could not establish the frame of the saved reference pixel.

The preserved trace places seek wrapper completion at19320.582ms and reference
capture at19330.005–19334.097ms: roughly9–13ms later. The original trace contains
no Program presentation observer. This proves the missing synchronization; it
does **not** prove which image supplied the reference or establish that the
pixel mismatch was exclusively a test defect. A rerun with qualified
presentations is still required, with the original pixel assertions intact.

The new test-only helper observes the existing
`subscribePreviewRenderDiagnostics` API. Production publishes that diagnostic
after `afterPresentationBoundary`, guarded by render/bridge/presentation
generation. The helper never requests a render, replaces a renderer or changes
product state. It subscribes before importing the source and removes the
subscription after each test.

Before each visual mutation, the helper arms an expected frame. Store actions
mark `performance.now()` immediately before mutation; native UI actions mark
at document capture of click/change, before React handles the action and after
locator scrolling/actionability. The wait requires a successful `drawn`
post-paint event requested at or after that watermark, the expected frame and
the current effective document/project generation/media maps/canvas identity
and dimensions. Connected-source waits additionally require the source clip in
drawn IDs and no missing clips; the explicit offline-open wait permits missing
media. Passive store subscriptions timestamp relevant identity changes; a late
old request cannot be qualified against identities that changed before its
post-paint callback. Those subscriptions are also disposed after each test.
The helper allows10s for a presentation; the original5s pixel polling
limits and every numeric/pixel assertion remain unchanged.

Only a same-frame seek may reuse a presentation already observed before its
mutation watermark, and only while all those visual identities remain equal.
Preview toggles, Apply, undo/redo, Open, relink and attachment-mode cleanup
require a fresh presentation. Initial source picking is also preceded by a
qualified frame0 seek. Raw last128 presentation diagnostics are attached to
each new test's result, including failures, and the observer is disposed.

Only the two new tracking flows and their helper change. Production, encoded
fixture, configuration, original five flows, tracking counts, geometry,
restored pixel equality and export thresholds are unchanged. There are no
blind sleeps. This correction requires parent review and a fresh slot.

## Artifact inspection and teardown

All originals remain under `.tmp/issue198-48f24ec/`: browser.log; complete
failure screenshot, accessibility context and trace under `playwright/`; six
original mask screenshots; native process/listener snapshots; and teardown.txt.
`reference-pixel-trace-events.json` preserves the extracted timing records.
`trace-problems.json` contains zero console warning/error or pageError events;
the failed flow did not reach its final console assertion. The five completed
flows did. Shell output contains only NO_COLOR/FORCE_COLOR notices besides the
test failure.

All seven produced screenshots were inspected. Desktop rectangle, inverted
Bezier, open draft and held triangle controls are visible with separate Program
canvas and editing dock. The768px ellipse and closed-path views show crowded
global header/sequence controls and clipped lower panel content; complete small
workspace qualification is not claimed. The failed tracking screenshot shows
the real texture, unchecked preview,18 samples/frames0–17,99.5% minimum and99.8%
mean confidence, stop frame18 and enabled Apply. It has no error overlay, and
does not qualify Apply/export.

The captured owned native PIDs were63447,63474,63475,63501,63502,63503,63511,
63512,63513,63548,63549. All were absent from the post-run process table. No
matching browser/server descendants or5198 listener remained. The worker
explicitly released the slot; the parent independently verified5198 clear.
No rerun occurred after that release.

## Correction checks and remaining gates

Final project TypeScript build (`npx tsc -b`, including browser tests), lint,
seven-flow discovery and diff hygiene pass. Logs are
`.tmp/issue198-48f24ec/presentation-{typecheck,lint,test-list}.log`.
These checks do not establish browser acceptance. The product's earlier324
focused tests plus17 runner/build/lint evidence remains attributable to
c0bce34; no product suite was repeated for this test-only correction.

Tracking browser acceptance, backward box, portable reopen/export, native file
handles, resource authority integration, repeated export/resource/performance
work, full suite/audit and final issue acceptance remain open. The later
resource proposal and small proof tests remain ignored staging and are not
imported by this run or correction.
