# Issue 199 — dense-capture fix passes the large segment

The one granted large-document run passed all four checkpoints at clean harness
HEAD `4fd79339aa6913ae34e0bdbcffd767aa1fbe8243`, executing the accepted product
`1537d5e23ebf223c51f269f1e1a5f6a902ecaa0e`. The original supplemental fixture
retains generation identity `b33b7531027979b8886f5db979d57cd96b96175d`.
All 242 product and 71 checkpoint hashes matched before launch and after release.
The clean full SHA was recorded before launch. Only the reviewed product-identity
metadata changed from the preceding large harness; native actions, capture
assertion, fixtures, 1,024-key selection and all limits remained exact.

The run lasted 12.221 seconds, 2026-09-08T19:26:49.451Z–19:27:01.672Z. Its
standard internal production-build preflight passed, following the separately
granted standalone validation build. Existing chunk-size advisories are retained.
Chromium 151.0.7922.34 ran headless and muted with SwiftShader, a private profile,
production preview at localhost 5199 and command-scoped `caffeinate -is`.

## Observed acceptance

All four checkpoints passed with zero console warnings/errors or page errors:

- Production launcher identity.
- The 100,000-key document opened through the real portable-file UI. Exact
  navigation selected 1,024 scalar keys; select-all above 4,096 was refused.
  Ten transient playhead updates preserved project/history/clipboard references.
- Changed filters, native vertical scrolling, pinned exact focus and the scalar
  curve stayed within structural bounds, including curve controls at 720 pixels.
  The previously failing native drag retained pointer capture after four native
  moves, kept preview active and preserved project/history/clipboard references.
  Release added exactly one history entry with all 1,024 keys still selected;
  undo restored the original project reference.
- The 1,280-lane fixture retained exact focus at frame 1,000,000 while scrolling,
  revealed frame -100, and exposed the distant empty owner past frame 9,000,000
  with a safe integer origin.

The native release assertion checks history and selection count; it does not
compare every moved key frame. The component regression separately checks all
1,024 moved key frames. Undo checks project identity, without asserting restored
selection. The step-03 screenshot occurs after undo and shows 1,014 selected
keys; it is not a screenshot of the held preview or a selection-restoration pass.

Across 17 structural observations at widths 720 and 1440, maxima were 14 mounted
rows, 504 glyphs including ghosts and 255 curve samples, with no horizontal page
overflow. The held dense preview had 259 total glyphs, including 131 ghosts;
the limit stayed 512. These checks qualify the observed Animation controls and
structure, not complete responsive layout or media rendering.

Raw wall times include automation and settling: portable open 945.745 ms;
first dock/index/render 375.695 ms; changed filters 57.507/55.760/55.291 ms;
native wheel 54.170 ms; dense preview 240.518 ms; release 160.466 ms;
many-owner open 211.335 ms and first dock 91.347 ms. No performance threshold,
pure-index time, heap, hardware-GPU or cross-attempt speedup claim is made.
The production browser has no public index-build counter; exact no-rebuild
counts remain component evidence.

## Evidence and release

Raw evidence remains at:

`/private/tmp/issue199-continuation/2026-09-08T19-26-49.451Z-large/`

It contains five screenshots, four step DOM snapshots, the complete result,
source/build/process/timing records, logs, a validated trace ZIP and the preserved
private profile. `artifacts.json` hashes all 19 raw top-level files, without a
recursive profile hash claim. `large-attempt2/evidence-copies.json` maps 14 exact
JSON or normalized text copies to raw and copied hashes. The exact result is
138,966 bytes, SHA-256
`1437127a1904e686ea8c27ab2eb2154112cb95367c9c51e70e0c0e1223c30a29`.
Worker inspected `step-03.png` and `many-lanes-far-owner.png`; no all-images review
is claimed. The sole dialog was the exact permitted unsaved-project confirmation
when departing the private dense fixture.

**Slot released at 19:27:01.634Z.** Context closed, preview exited 143, no fallback
signals were used, and no owned native process or port listener remained.
Independent verification at 19:28:04.623Z confirmed all seven IDs absent:
preview 10686, Chromium 10688/10689/10690/10691, runner 10614 and scoped awake
helper 10625; port 5199, private-profile processes and matching awake commands
were absent. The wrapper snapshot occurred after completion and was empty.
Helper 10625 is sourced from its `pmset` creation record at 19:26:49Z; no live
helper start-time snapshot was captured. No actual sleep/wake transition occurred
in the run window, and no persistent power/display setting changed. All source
and checkpoint hashes matched with a clean tree. The parent independently
verified the five recorded native PIDs, runner and port at 19:28:57.775Z.

This evidence qualifies only the large segment on product 1537d5e. Earlier
34/34 gestures and 13/13 editing acceptance remain on product 75b89ef; prior
failed attempts are preserved. There was no additional native run, full suite,
export, performance run or integration sync. Parent review, integration and the
remaining mixed pixel/PCM and title-helper/five-preview-owner gates remain open.
