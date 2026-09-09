# Gate3 early production segment — passed, remaining flows pending

Run:2026-09-08T13:55:23.484Z. Exact granted committed harness
b5729c926ae8c497a8b9ee0ad7f26a466a8565e0; accepted product
b33b7531027979b8886f5db979d57cd96b96175d. Clean source,242 observation
source/test/configuration hashes and all three original fixture hashes matched.
Unmodified production TypeScript/Vite build; existing chunk-size advisory only.
Browser: muted headless Chromium151.0.7922.34, SwiftShader, private loopback5199.
No native GPU/media rendering/decoding/export claim.

| Reached checkpoint | Observed result |
| --- | --- |
| Real portable project entry | Canonical mixed file opened through UI with2offline sources; actual already-loaded production stores discovered |
| First-use Animation at1440x900 | Native button click succeeds; workspace JS/CSS absent before first open and requested on use;14rows/6glyphs; no document overflow |
| Open dock resized to720x900 | Grid534×244, controls184×266 inside viewport; commands/Back reachable through local scrolling; no document overflow |
| Native input/IME | Destructive/global shortcuts contained; exact project unchanged; no undo entry |
| Both Bezier handles | Six native down/up cases: each handle atcenter,+2,-2px; no movement; exact project and undo/redo counts unchanged |
| Back to Timeline | Original assertion passes; focus becomes BUTTON/Animation; zoom11.62962962962963, origin0 and clip selection preserved |

All six checkpoints passed; console warnings/errors and page errors remained
empty through final screenshot/cleanup acceptance. The first-open observation
was332.805ms including automation; this is a raw observation without a threshold
or pure-index timing claim. All visible screenshots and the trace are retained.
The720px check resized an already-open dock; it is not an independent native
entry at720px. No nonzero-origin browser case or large-document bounds is
inferred from this small fixture. Populated-redo proof remains component evidence.

Cleanup: browser.close completed; preview PID68319 exited143. Captured server,
browser,GPU and network PIDs68319/68321/68322/68323 are absent by read-only ps;
independent lsof finds no5199 listener. Explicit slot release checked at
2026-09-08T13:56:48.273Z. No unrelated process was touched.

Raw directory: /private/tmp/issue199-gate3-browser/2026-09-08T13-55-23.484Z/.
attempt5-result.json and attempt5-process-cleanup.json preserve the observations;
attempt5-artifacts.json records hashes for ten screenshots, trace and raw logs.
Earlier failed attempts remain intact. Product source and native assertions
were not changed during the run.

Result status is intentionally preflight-passed. Remaining native key/handle
drags and cancellation causes, sibling previews, filters/mapping/history/
portable save-reopen, exact far/dormant key navigation,100000-key40/512/256
bounds and raw warm measurements still need a separately reviewed/pinned
continuation and explicit slot grant. Gate4 mixed-feature pixel/PCM/export,
full suite and audit remain later. Ignored continuation drafts did not execute.
