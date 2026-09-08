# Issue 199 — large run loses capture during dense preview

The one granted large segment ran at clean
`4f825bd8eaeb3a0b83e6f0f2f6092872581afc5b`, executing product
`75b89ef6b70460a03ea99ca44d888b5ec06373ec`. Its supplemental fixture generation
identity remained `b33b7531027979b8886f5db979d57cd96b96175d`; both identities were
recorded separately. All 242 product and 58 checkpoint hashes matched.

Two checkpoints passed: the production launcher and the 100,000-key cold entry,
exact 1,024-key navigation/selection, refusal above the 4,096 selection limit,
and ten playhead updates. The next checkpoint stopped at its first failed
assertion during the native 1,024-selected-key drag:

`Native pointer capture was not acquired: false !== true`

That wording checks capture after several native moves. Capture **was initially
acquired**, as the retained events show; this is not evidence of a missing native
pointer-down. Pointer 1 / gesture 1 had trusted capture event 1 on the two-key
bucket beginning at local frame 1022. Trusted held moves 2 and 3 reached the same
element. Capture-loss event 4 then targeted elsewhere; moves 5 and 6 retargeted a
rectangle and SVG. The original captured `<g>` was disconnected, capture was
false, and the animation preview remained active.

Failure state retained all 1,024 selected keys, focus 1022, zoom 0.919921875,
history lengths 0/0 and `animation-gesture` preview ownership. The preview/release
immutability assertion and post-preview glyph check were not reached. No release
commit, many-lane case or later segment was accepted. Zero console warnings,
errors or page errors were recorded.

Before the failed preview, 10 structural observations stayed within 14 rows,
504 glyphs including ghosts and 255 scalar samples, with no horizontal page
overflow. Warm filter/scroll/curve assertions occurred inside the failed
checkpoint and do not make that entire checkpoint a pass.

Raw wall times include automation and settling: portable open 943.221 ms;
first dock/index/render 867.873 ms; changed filters 54.770/64.006/72.623 ms;
native wheel 51.939 ms. These have no threshold, pure-index, heap or hardware-GPU
claim. The parent reported task 200's production-build log I/O spanning
18:57:59.794–18:58:07.334Z, overlapping this outer/build phase. Those are log-I/O
bounds, not measured compiler-exit times. This browser launched at
18:58:10.720Z and its first large checkpoint began at 18:58:11.275Z, after that
recorded log interval. No rerun is justified solely by this timing qualification.

## Evidence and release

Run: 2026-09-08T18:58:03.738Z–18:58:17.022Z. Raw evidence remains at:

`/private/tmp/issue199-continuation/2026-09-08T18-58-03.738Z-large/`

There are three screenshots, two successful DOM snapshots plus failure DOM,
full failure project/state/events, source/build/process/timing records, logs and
a valid trace ZIP. `artifacts.json` hashes 15 raw top-level files. The private
profile is preserved without a recursive hash claim. Worker and parent inspected
the failure screenshot; no all-images review is claimed.

`large-attempt1/failure-summary.json` provides the bounded failure/events/timings
view. The exact 33,412,146-byte raw `result.json` is preserved on disk and copied
into Git as lossless `result.json.gz` (640,322 bytes). Decompression was compared
byte-for-byte with the original. Its decoded SHA-256 is
`f6c5c978277183ce0b848dd1f27b27db9fa16f0835b00305f1e65ba915fb5954`.
`evidence-copies.json` maps all 12 copies and explicitly records compression or
text normalization. No full project payload was discarded or rewritten.

**Slot released at 18:58:16.984Z.** The context closed, preview exited 143, no
fallback signal was needed, no owned process remained and port 5199 was clear.
Worker verification at 18:59:47.567Z and the parent's independent check confirmed
all seven PIDs absent: preview 4538, Chromium 4540/4541/4542/4543, runner 4445 and
scoped awake helper 4456. No actual sleep/wake transition occurred, no persistent
power/display setting changed, and all source/checkpoint hashes still matched.

This checkpoint preserves evidence only. The parent authorized a source-only
regression and fix for capture ownership during dense/ghost rebucketing, while
retaining the exact 1,024-key selection and capture assertion. No product/harness
change, native rerun, export, full suite, performance run or integration sync
is part of this evidence checkpoint. Earlier accepted gestures/editing evidence
and all previous failures remain unchanged.
