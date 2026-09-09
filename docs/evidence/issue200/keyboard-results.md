# Title keyboard acceptance

The final targeted run at `9f3dce20909784733d4c4a445a8998d300965f6b` passed
3/3 cases with zero retries, failures or skipped cases in 26.301109 seconds:

| Case | Result | Case duration |
| --- | --- | --- |
| 1280×720 title dialogs, focus and cancellation | Passed | 6.539 s |
| 720×800 keyboard title controls and status | Passed with font-popup qualification below | 10.391 s |
| 720×800 title dialogs, focus and cancellation | Passed | 7.248 s |

The parent-directed remainder preserves the completed 1280×720 controls case
from `16e36881d550db0813be4dce1f4cc80a7b9f4284`. This is staged coverage of the
four original cases, not a claim that all four ran again on the final hash.
Native font-popup selection remains **UNVERIFIED at both widths**: headless Mac
Chromium did not open the platform popup after Space within the existing bound.
The native select retained focus and serif, with exact project/full-history
equality. No synthetic selection qualified that segment. Native Direction `r`
selection succeeded; motion preview and all following dialog checks completed.

The passing narrow case includes real keyboard selection, add/reorder/delete,
numeric Enter/Escape, move/resize alternatives, exact history/Undo, safe-guide
90%/95% geometry and status. Both dialog cases cover actual Tab/Shift+Tab order
and wrapping, geometry, labels, focus/text contrast, preview, Escape/Cancel,
exact opener focus restoration and unchanged project/history/library. Existing
functional G3 evidence supplies real Apply and local template persistence.

The corrected narrow fallback label is y=142.84375..181.84375 inside Inspector
y=131..369; its select is y=162.84375..181.84375. The unchanged full-label
predicate passes. The fallback and narrow template-library screenshots were
visually inspected. Surrounding workspace clipping retains its separately scoped
root disposition; this does not claim a general workspace accessibility audit.

Raw results, success traces, screenshots, full state/history and process receipts:
`/private/tmp/issue200-keyboard-9f3dce2-01`. Reproduce with the existing runner,
`ISSUE200_KEYBOARD_REMAINING=1`, and its recorded candidate source manifest.
The source checks before and after the run passed. Per-case page warnings,
errors, page errors and cleanup errors are empty. Session/native-key ledgers have
zero dropped records or issues; all three subscriptions were disposed in each
case, and canonical leave returned home/idle with no preview owner.

The runner exited 0 without deadline expiry, forced termination, remaining owned
processes, observer errors or cleanup errors. Fresh release at
2026-09-08T22:22:29.322442Z confirmed all 18 captured PIDs absent and port 5200
clear: 63235, 63246, 63247, 63289, 63291, 63307, 63309, 63310, 63318, 63319,
63320, 63321, 63322, 63323, 63337, 63338, 63383, 63384.

Original failures remain preserved in the preceding keyboard correction records,
including the [long route](keyboard-route-correction.md), [real narrow label
clipping](keyboard-narrow-label-correction.md), and [dialog focus
escape](title-dialog-focus-correction.md). No new tests, packaging or benchmark
were added. Parent-accepted #199 mixed encoded title/audio acceptance is reused;
the root owns consolidated engineering checks and final combined acceptance.
