# Gate3 production browser observations

Supervisor approved `docs/evidence/issue199/gate3-browser-protocol.md` and granted
port5199 exclusively after accepting product source87d8032. The first product
failure stopped that run and released the slot. The bounded corrections are
committed and accepted at42eb93b; this early harness is now pinned to that exact
source with observation-source-hashes.json. A fresh slot grant is pending;
do not execute the repinned harness yet. Current queue is198 →200 →201 →199.

`prepare-browser-fixtures.mjs` calls the canonical portable serializer/parser via
Vite SSR without opening a listener. Generated fixtures and hashes are committed
before launching Chromium. They cover mixed supported/unavailable owners with
intentionally offline sources,100,000 keys and1,280 dormant lanes plus1,000 empty
owners. No fixture emits audio. No fixtures are imported by production.

`run-animation-browser.mjs` is the first sequential harness segment. It builds
unchanged production source, refuses an occupied5199, launches muted headless
Chromium with a private context, records source/build/browser/fixture provenance,
checks desktop/compact layouts and lazy requests, native input/IME, no-motion
center/+2/-2px clicks on BOTH Bezier handles and return-to-Timeline state/focus.
Console/page warnings or errors fail step acceptance and final acceptance; they
are never merely collected. Compare shared origin, zoom and clip selection
immediately before/after Back, preserving any intentional prior Fit keys change.
First failure stops the run and closes owned browser/server. All attempts write
results/screenshots/trace outside
the repo under `/private/tmp/issue199-gate3-browser/<timestamp>/`.

Read-only diagnostics discover exported Zustand stores from production modules
already requested by the application. This does not import development modules,
instrument/replace bundled code, expose a product test route, or change source.
Project setup uses the real portable-file/open UI. Input and pointer tests use
native Playwright/CDP events. Sources intentionally remain offline, so this pass
makes no decoding/render-pixel/PCM/export claim.

If this early segment passes, continue the approved remaining captured-gesture,
sibling-preview, mapping/history/save/reopen and large-document observations in
a separately pinned harness continuation. If any product assertion fails,
preserve its exact-source evidence, stop heavy validation, fix in a separate
source commit and request reviewed rerun. No timing threshold is invented.

Run with DEVELOPER_DIR=/Library/Developer/CommandLineTools:
`node scripts/issue199/run-animation-browser.mjs`.
