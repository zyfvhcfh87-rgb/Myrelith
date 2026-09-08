# Issue 199 — corrected gestures stopped at mode cancellation

Evidence only. The one granted gestures segment ran at clean
`7e7cfade097446c6f68219919fac838a8134f664`, product
`b33b7531027979b8886f5db979d57cd96b96175d`, on 2026-09-08 from
16:55:53.229Z to 16:56:04.537Z. It used the unchanged reviewed runner, a fresh
private profile, muted headless Chromium 151.0.7922.34 / SwiftShader, and scoped
`caffeinate -is`. **Eight checkpoints passed; mode cancellation then failed and
stopped the run. This is not a complete gestures or Gate 3 pass.**

## Reached acceptance

- Production launcher and canonical mixed fixture with native clip selection.
- Native key 40→49 movement: admitted preview without history, exactly one
  release commit, exact undo/redo/undo.
- Native Bézier handle 1 and handle 2 edits: preview, one commit and exact undo.
- Native key Escape cancellation with unchanged document/history/clipboard.
- Corrected key capture-loss cancellation, with actual trusted event proof.
- Native Back-to-Timeline/close cancellation.

The corrected capture-loss case recorded pointer 1 / gesture 5: trusted
`gotpointercapture` at sequence 61 on the captured key element; release cleared
pending capture; the following native move while held produced trusted
`lostpointercapture` at sequence 66 on that same element and `pointermove` at 67.
Both events had buttons 1. Preview was cleared and exact document/history/
clipboard identity checks passed before and after mouseup. This qualifies the
key capture-loss case only; handle capture-loss cases were not reached.

## First failure

`native key cancellation: mode` failed at observations line 265 with
`Cancellation left an animation preview; true !== false`. The native keyboard
activation changed the view to Curve; the inspected failure screenshot shows
Curve selected and drawn. State retained past 0 / future 1, focused local key 40,
preview true, and owner `animation-gesture`.

Failure diagnostics contain pointer 1 / gesture 7, trusted input, the original
`g` key element disconnected and capture false. Event 99 is a trusted
`lostpointercapture` with buttons 1 and `sameTarget: false`; its target has no
element tag. Full events and state remain available for review. This differs
from the first attempt, which lacked actual lost-event evidence. No product or
harness correction is included in this evidence checkpoint.

Console/page problems remained empty. Later key cancellations, handle
cancellations, sibling restoration and project departure did not run. Editing,
large documents, export and full-suite work remain separately gated.

## Preserved artifacts and release

Original directory:
`/private/tmp/issue199-continuation/2026-09-08T16-55-53.229Z-gestures/`.

All 24 original top-level artifacts are hashed in `artifacts.json`: full result
and native failure state/events, nine screenshots, eight passed DOM texts and
failure DOM, trace, production build log/hashes, console/server logs and
independent cleanup/source proof. The trace archive was checked for integrity.
The private profile is preserved without a profile-hash claim. All original
first-attempt artifacts remain untouched.

`gestures-attempt2/` contains exact JSON copies and normalized text/DOM/log copies.
`evidence-copies.json` records each committed copy hash and its original raw hash.
Text normalization removes ANSI, carriage returns and trailing/EOF whitespace;
the original files are unchanged. Screenshots and trace retain their raw paths
and byte hashes rather than being rewritten into the evidence copies.

**Runner cleanup released 5199 at 16:56:04.501Z**: context closed, owned preview
exit 143, no fallback signals, no remaining owned process or listener, and final
source/console checks passed. Independent verification at 16:57:47.269Z found
PIDs 87430/87432/87433/87434/87435 absent, runner 87305 and scoped caffeinate
87316 absent, and port 5199 clear. All 242 source and 40 checkpoint hashes still
matched the clean observed source. The slot is explicitly released.

The read-only `pmset` query found no actual sleep/wake transition during this
11.308-second run. No persistent power/display settings changed. No new source
test, build or browser run is part of this evidence-only checkpoint; the granted
attempt's build output is retained. Product and harness remain unchanged pending
result review and a separately authorized correction/rerun.
