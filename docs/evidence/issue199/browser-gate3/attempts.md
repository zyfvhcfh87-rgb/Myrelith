# Gate3 browser attempt ledger

1. Harness22548320d2e721bb9b2c940e9eaaaeb974c71f17, unchanged product87d8032,
   Chromium151.0.7922.34, SwiftShader,1440x900. Canonical mixed portable file
   validated; harness incorrectly waited for `Open project` instead of the
   observed `Open with 2 offline`. Corrected only that harness locator; no
   product assertion or Animation UI was reached. Console/pageerror collection
   empty. Result, DOM and artifact hashes retained. Browser closed, private
   preview PID55011 exited143, port5199 not listening. Failure screenshot/trace
   remain at the absolute path in attempt1-artifacts.json. This is a harness
   setup failure, not product failure or observable acceptance.

2. Harnessdd86783b6d44b65d61516f76baccf7632d9d4ba8, unchanged product87d8032,
   Chromium151.0.7922.34 / SwiftShader /1440x900. Launcher identity, real portable
   validation/open, loaded production-store discovery and absence of premature
   AnimationWorkspace requests passed. Native Animation click then failed:
   Timeline resize separator intercepts the in-flow button below the transport
   bar. Failure screenshot confirms position. This is a product regression;
   no force-click or subsequent heavy case was run. No console/page errors.
   Browser closed, preview PID55634 exited143, port5199 has no listener; captured
   PIDs55634/55636/55637/55638 are absent. Exclusive slot released. Compact,
   native input/IME, Bezier no-motion, Timeline return and the rest of the
   approved protocol were not reached. Preserve their pending status.

## Separate source correction: entry dock

Move Animation from a direct child after the full-height centered transport bar
into the existing positioned timeline-tools group. Its compact Bezier icon uses
the existing tool-button dimensions/responsive rules, with an accessible name,
expanded state and controlled panel id. No z-index bypass or global transport
layout rule changes. Regression failed on the old structure, then opens the
real lazy workspace without changing project/clip selection after the fix.
Five focused files /56 tests plus17 runner, production build/lint pass. This is
source validation; native click/layout must be reviewed and rerun on the new
source before calling the failure resolved in-browser.

Parent independently confirmed a separate no-motion Bezier handle mutation on
87d8032. It was not reached by this browser attempt. Its source fix follows in
a separate commit; all other accepted workspace contracts remain intact.

The separately committed handle correction is documented in
handle-correction.md with independent red/green proof and final source hashes.
At that checkpoint no further browser run had occurred; the exclusive slot was
released and entry547adc9 plus handle42eb93b awaited review and a fresh grant.

## Accepted corrections and early rerun

Root accepted exact42eb93b and then accepted the repinned early harness8f3cd77
with242 verified source hashes. It granted only that unchanged early segment.

3. Harness8f3cd77 / product42eb93b: sandbox-only invocation failed before any
   browser launch because loopback5199 listen returned EPERM. Server PID62750
   exited1; no steps executed. Preserve the result/server/build logs as an
   environment preflight failure, not a product result. Required loopback
   escalation was approved for the identical granted harness.

4. Harness8f3cd77 / product42eb93b / Chromium151.0.7922.34 / SwiftShader:
   real portable entry, native1440x900 Animation click, first-use lazy JS/CSS,
   desktop/720x900 layout, native input/IME containment and six no-motion clicks
   on both handles at center/+2/-2px passed. All six preserved exact project,
   undo and redo counts. The720px check resized the open dock; it does not
   independently certify a second native entry at that width. Console/page
   problems were empty. Final Back-to-Timeline check preserved exact zoom,
   origin and clip selection, then failed because focus became BODY.

   Stopped at that first product failure. No continuation/native drag/cancel,
   mapping, persistence,100000-key/performance or later gate ran. Browser closed;
   server PID62995 exited143, port5199 has no listener. Captured server/browser/
   GPU/network PIDs62750/62995/62996/62997/62998 are absent, verified separately
   with read-only ps/lsof. Slot explicitly released. Raw result, ten screenshots,
   DOM and trace remain at the paths and hashes in attempt4-artifacts.json.

The containing source correction is described in focus-correction.md. The
original native assertion and accepted harness remain unchanged; they need
reviewed repinning and a fresh grant before testing the focus fix in Chromium.

## Corrected early segment passed

5. Exact granted harnessb5729c926ae8c497a8b9ee0ad7f26a466a8565e0 /
   productb33b7531027979b8886f5db979d57cd96b96175d, all242 hashes verified,
   Chromium151.0.7922.34 / SwiftShader. All six early checkpoints passed:
   production portable entry, native1440x900 first-use lazy dock/layout,
  720x900 open-dock layout, native input/IME containment, all six both-handle
   center/+2/-2px no-motion cases, and original Back-to-Timeline assertion.
   Return focus is BUTTON/Animation; zoom11.62962962962963, origin0 and clip
   selection remain exact. Console/page problems are empty. The committed
   runner differs from the prior accepted runner only in its source pin.

   Browser closed; server PID68319 exited143; captured PIDs68319/68321/68322/
  68323 are absent and lsof confirms no5199 listener. Explicit release proof
   timestamp13:56:48.273Z. Ten screenshots, trace and raw provenance remain at
   the paths/hashes in attempt5-artifacts.json. No continuation executed.

This is only the early segment (`preflight-passed`). The large-document,
native-drag/cancellation, mapping/persistence and remaining approved protocol
still need their own reviewed continuation. See early-segment-passed.md.
