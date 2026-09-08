# Gate3 production browser observations

Supervisor approved `docs/evidence/issue199/gate3-browser-protocol.md` and granted
port5199 exclusively after accepting product source87d8032. After the entry and
handle corrections at42eb93b, the granted early rerun passed those checks but
stopped on Back-to-Timeline losing focus to BODY. That slot was released and
the separate focus correction is accepted at finalb33b753. This early harness
is now pinned to that source and242 hashes in observation-source-hashes.json.
All native assertions are unchanged. The grantedb5729c9 run passed this early
segment and released5199; evidence is in browser-gate3/early-segment-passed.md.
Do not rerun without a new grant. Ignored continuation drafts remain separate
and require their own source/protocol review before any execution.

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
