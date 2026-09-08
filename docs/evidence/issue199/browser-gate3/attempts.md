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
No further browser run occurred after attempt2; the exclusive slot remains
released. Entry547adc9 plus the containing handle-fix commit need source review
and a new rerun grant before any observable acceptance can proceed.
