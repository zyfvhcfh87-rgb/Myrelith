# Tracking browser gate: offline presentation and observer remount ordering

The parent accepted clean `b8c74dc2c7dccbd982f9c3804e63e7e0d1d6c356` and granted
one complete seven-flow run. Product remains
`c0bce34d45400d537b583fb79c75cb95da05ba20`. Fail-fast native preflight verified
the exact clean source, unchanged product/configuration/original five tests and
empty5198. No source edits occurred during the run.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools npx playwright test --config playwright.issue198.config.ts --output=.tmp/issue198-b8c74dc/playwright --max-failures=1
```

One muted headless Chromium, one worker, no retries and strict5198 were retained.
The run exited1 in31.8s: **five pass, one fails, one does not run**. The original
rectangle/Bezier/ellipse/open/held flows passed2.6/2.8/3.1/3.2/3.2s. The point
flow failed after15.9s at its10s presentation poll following offline Open;
backward box did not run.

## What reached the browser

The point flow again passed real frame0 selection and18-sample analysis/stop18,
idle scheduler/decoder/workers, qualified temporary/restored pixels, accepted
range exit/reentry, one Apply with exact x/y frames/ticks and motion bounds,
undo/redo, disabled old Apply, actual Save/parse and unchanged portable tracks.
The correctly named `Mask tracking QA.myrelith` is now preserved in the test's
output directory. Its actual file-input Open action succeeded.

The failure snapshot shows an opened project, an offline source row with Relink,
the Source offline Program overlay and frame00:00:00:00. Of17 recorded post-paint
diagnostics, the last is frame0/seek, requestedAt5753.300ms and
presentedAt5844.600ms, status drawn, no drawn clips and missingClipIds containing
the tracking source. This is the expected offline presentation. The observer
remained subscribed across Open. The failure came from another readiness
condition, not absence of this render result.

The original run did not attach the rejected condition, so the exact predicate
that returned false in that native run is not recoverable from those records.
The deterministic regression below confirms a concrete helper defect consistent
with the remount sequence; it does not retrospectively observe that predicate.
Post-Open history/track assertions, relink, decoded export and backward box were
not reached. No tracking browser acceptance is claimed.

## Deterministic regression before changing the helper

`scripts/issue198/presentation-probe.test.mjs` runs the actual TypeScript browser
observer in a small VM with explicit stores, native-event host, clock, canvas and
diagnostic delivery. Only browser/module hosts are substituted; the observer's
comparisons, timestamps, subscription and readiness code are unchanged. It does
not start Chromium, a decoder or a renderer.

Against unchanged b8c74dc helper source,15 cases produced13 passes and2 failures.
Both failing cases mount a new canvas, request the correct offline frame, and
deliver an unrelated transport selection notification either before or after
the valid presentation. That notification incorrectly made readiness false;
in the latter case it changed an already true result to false. The no-notification
control and all real-staleness/source/error controls passed. The original output
is preserved at `.tmp/issue198-b8c74dc/probe-before-fix.log`.

The cause is explicit: `context()` included canvas identity and dimensions, while
`lastContext` refreshed only when a store notified. After remount, a diagnostic
could capture the correct new canvas while `lastContext` still held null/the old
canvas. A later unrelated store notification then dated the earlier DOM change
as a new state mutation after the valid render request. No render was needed or
scheduled for that unrelated selection change, so the helper could wait forever.

## Test-only correction and retained qualification

Store timestamps now compare only project generation, effective document,
media maps and playhead frame. Full context checks still compare those fields
plus canvas identity and dimensions against the latest post-paint diagnostic.
The production diagnostic's existing bridge/render/presentation generations
remain authoritative for publication. Native action watermarks, fresh requests,
expected frame, drawn status, connected-source checks and restricted same-frame
reuse are unchanged. No forced render, blind sleep or product patch was added.

All15 unchanged regressions pass after this correction. They retain refusal of
late document/project-generation/preview-document/assets/descriptors/frame
changes before an older callback; canvas identity or size changes after
publication; old presentations for fresh actions; stale same-frame reuse;
missing/unrelated connected sources; wrong frames; and render errors. Every
case also verifies listener disposal. Node's runner is used directly; these
counts do not include the repository's17 Vitest runner checks.

The helper also records its last readiness reason, action/state timestamps,
expected frame, latest raw presentation, differing context fields and reuse
decision. A separate `program-presentation-check` attachment preserves this
passive evidence on the next failure or success. The existing raw presentation
array attachment and every browser assertion/timeout/fixture remain intact.

## Inspection, cleanup and final checks

All eight screenshots were inspected: six original views, point Apply/redo and
failed offline-open wait. The failed image visibly confirms the opened offline
project. Original768px views retain crowded global controls and clipped lower
panels; full responsive-workspace qualification is not claimed. The trace has
zero console warning/error or pageError events. Five original final console
checks passed; the point flow did not reach its final console assertion.

All11 ancestry-qualified PIDs73023,73057,73058,73084,73085,73086,73094,73095,
73096,73184,73185 were absent after exit. No matching Chromium profile/server or
5198 listener remained. The source was still exact clean b8c74dc. Raw preflight,
native snapshots, owned-browser-processes.json, teardown.json, complete trace,
context, screenshots, saved portable file and17 extracted diagnostics remain
under `.tmp/issue198-b8c74dc/`. The slot was explicitly released and the parent
independently verified5198 clear. No browser rerun followed.

Final15-case observer regression, TypeScript build including browser files,
lint, exact seven-flow discovery and diff hygiene pass. Logs:
`probe-after-fix.log` and `remount-{typecheck,lint,test-list}.log` in the preserved
run directory. Product/configuration/original five tests are unchanged from
c0bce34. Parent review and a fresh exclusive slot are required for another run.
Relink/export/backward box, resource integration, native handles, performance,
full suite/audit and final issue acceptance remain open.
