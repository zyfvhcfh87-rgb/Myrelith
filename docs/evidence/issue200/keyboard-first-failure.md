# First keyboard run — safe-guide label bounds

One unchanged run of `b2fc657040e34643a77ea5b5d0cf18b6cdc4d8a8` stopped on its
first failure: **0 complete cases passed, 1 failed, 3 unrun, zero retries**. Started
2026-09-08T20:51:45.024Z; report duration 6.295792 seconds, failed case 5.166 seconds.
The first case was controls/status at 1280×720. It failed the original full-label
containment predicate at `keyboard.gate.ts:90`, before activating safe guides.

## What the retained geometry establishes

| Observed item | Vertical bounds in CSS pixels |
| --- | --- |
| Visible Inspector scroll region | 101 → 319 |
| Focused native checkbox | 305.171875 → 318.171875 |
| Associated inline label box | 306.171875 → 321.171875 |

The checkbox itself is fully visible and keyboard focused. Its label box extends
**2.171875 px** below the scrollport, exceeding the unchanged 1 px containment
tolerance. Native Tab had scrolled the outer Inspector to `scrollTop=2142`; the
inner content scroller remained at zero. Horizontal content bounds were valid.
The final PNG shows the checkbox's focus indicator and label at the lower edge.
This is a full-label geometry failure, not evidence that the checkbox was
unreachable, its accessible name absent, or all visible label text unreadable.

All 13 distinct PNGs were viewed, including native auto outlines and the canvas
Move/Resize focus indicators. Computed contrast values and raw style/background
evidence are retained; no pixel-exact native focus-ring certification is claimed.
Surrounding workspace observations remain separate for supervisor disposition.

## Qualified partial evidence and cleanup

Before the failure, 15 exact state snapshots independently verify seven accepted
edits: add, reorder, delete, numeric Enter, one-pixel move, Shift ten-pixel move,
and two-pixel width resize. Selection, numeric blur and Escape preserve full
project/history; Undo restores the exact pre-resize project and one redo entry.
There were 161 actual Tab steps and 233 observed trusted keydowns, with no synthetic
events or truncation. These are partial observations, not a passed complete case.
Safe-guide activation, later missing/fallback status and all three remaining
dialog/narrow cases did not run.

All browser warning/error/page-error and cleanup-error arrays are empty. All 26
session observations are healthy; no events dropped, no observer issues, and all
three observer subscriptions/listeners were released. Project leave and explicit
page close completed. The runner had no timeout, forced native termination,
observer/cleanup error or incomplete stdout. The outer awake guard was stopped
after runner completion, with its expected wait status 143.

Fresh complete process tables and lsof at 2026-09-08T20:52:42.235211Z found all 14
native/runner/outer/awake PIDs absent, no private browser executable and port 5200
clear. The slot was immediately released in the worker report. The supervisor
independently confirmed release; its receipt is included. The same 1,784-file
source guard verified before and after the run.

## Preserved evidence

[Lossless failure bundle](keyboard-b2fc657-first-failure.tar.gz): 14,232,339 bytes,
62 members / 61 independently verified member hashes. Archive SHA256:
`0225123bee0251948b1bb7992dda7d899537353f02ea1b540e2ea51c21ca6c50`.
The [companion metadata](keyboard-b2fc657-first-failure.sha256.json) records identity.
All 40 original artifacts / 17,631,866 bytes match their manifest. All 30 reported
attachments exist, and the retained trace's 294 ZIP members pass CRC validation.
There are 27 PNG copies / 13 distinct images. The bundle also preserves offline
assertion/visual audits, image identity groups, source snapshots and release receipts.
Originals remain at `/private/tmp/issue200-keyboard-b2fc657-01` and sibling paths.

This commit preserves evidence only. The supervisor authorized source diagnosis
and a minimal title focus/layout correction, with the original predicates and
viewports retained. No correction or native retry is included in this result.
