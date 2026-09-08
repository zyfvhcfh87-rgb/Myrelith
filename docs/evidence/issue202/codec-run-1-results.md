# Three-frame codec diagnostic and retained failures

The orchestrator granted only three sequential 1024×16 synthetic VP9
diagnostics after #198 released the slot. Before running, the required cleanup
amendment was committed: a terminal copy-drain failure or nonzero owned-resource
count records failed cleanup, stops subsequent cells and triggers whole-browser
teardown. Browser close cannot skip server teardown. No configurations, source
dimensions, frame count, R3 benchmark or full suite were added to the grant.

Starting commit: `a75cc864b0815d14a93c5e1d7f8d1c90dae2f6a1`.
Starting and completion script SHA256 both:
`92c007d4797640f1737067fa495321c91d8cedb893d8696d220879c1053c99d8`.
Collection: `2026-09-08T09:52:04.363Z`. The original source remains unchanged
in [probe-codec.mjs](probe-codec.mjs); raw rows remain in
[codec-probe-1.json](codec-probe-1.json), with all three saved packets.

| Cell | Encode and limited header result | Same-browser decode result | Pixel comparison |
| --- | --- | --- | --- |
| SDR709 | One 264-byte profile2/10-bit/full-range key packet; color ID2 | One I420P10 frame, coded1088×16, supplied SDR tags returned | Failed size guard before copy |
| PQ2020 | One 264-byte profile2/10-bit/full-range key packet; color ID5 | One I420P10 frame, coded1088×16, supplied PQ tags returned | Failed size guard before copy |
| HLG2020 | One 264-byte profile2/10-bit/full-range key packet; color ID5 | One I420P10 frame, coded1088×16, supplied HLG tags returned | Failed size guard before copy |

The process exited 0 because it successfully retained all three diagnostic
rows; each row explicitly has outcome `failed` and `unexpected-decoded-size`.
No raw plane buffer was allocated or copied, so distinct decoded levels,
chroma errors, bias and maximum code error remain unknown. Do not describe this
run as three accepted pixel round trips. The forced timeout branch was not
exercised by this successful teardown and has no measured timeout guarantee.

The harness wrongly required coded dimensions to equal source visible dimensions.
[WebCodecs §9.4](https://www.w3.org/TR/webcodecs/#videoframe-interface)
permits coded size to include non-visible padding and exposes visible/display
geometry separately. The run did not capture visibleRect or display dimensions;
padding is a plausible explanation, not a measured fact about that rectangle.

The subsequent [static packet inspection](codec-packet-inspection-1.json)
adds a bounded independent key-header reader based on
[VP9 §6.2.2–6.2.4](https://storage.googleapis.com/downloads.webmproject.org/docs/vp9/vp9-bitstream-specification-v0.7-20170222-draft.pdf).
All three saved packets declare frame and render size 1024×16. This read-only
operation opened no codec or browser and did not consume another diagnostic
frame. Original packet/result hashes are checked before inspection. It
supports a harness limitation, not demonstrated codec resizing.

PQ and HLG packet bytes have identical hashes because the exact signal ramp and
VP9 color identifier are identical. Their returned transfer tags follow their
different supplied decoder configs. Neither this parser nor that observation
provides an independent PQ/HLG pixel decoder, complete mux/mastering metadata,
HDR monitor qualification, native hardware performance or lossy quality limit.

## Teardown and slot release

Each row records two frames opened/closed, one encoder opened/closed and one
decoder opened/closed: six frames and six codec instances total, zero terminal
owned resources. No terminal-copy timeout or failed-cleanup outcome occurred.
The browser/backend remained Chromium151.0.7922.34 with ANGLE/SwiftShader;
complete command-line disclosure remained unavailable. No console errors.

The command returned only after awaited browser.close and server.close.
`lsof -nP -iTCP:5202 -sTCP:LISTEN` subsequently returned no listener. The local
orchestration report marked the slot released immediately; no further browser,
encoder, decoder, timing or full-suite process is running from this experiment.
These owner counts are not measurements of native/internal memory reclamation.

## Prepared follow-up, not executed

[probe-codec-readback.mjs](probe-codec-readback.mjs) is syntax checked and
prepared for a separate explicit slot decision. It decodes only the three
saved 264-byte packets; it performs no encoding and changes no source dimensions
or codec profile. It records coded, visible and display geometry, admits only
an in-bounds, chroma-aligned visible 1024×16 rectangle, and requests allocation
and copy of that exact rectangle. It records per-plane raw mismatch counts,
unique values, maximum absolute error and mean bias against the existing ramp /
neutral chroma. It has no predeclared lossy quality pass threshold.

Bounds stay one decoder and one retained frame per cell, ≤1 MiB readback before
allocation, 10-second flush/copy/drain waits, and a stop with partial failed
rows plus browser teardown if terminal drainage/ownership is unresolved. Packet
hashes must match run1 before a browser starts. The exact committed script hash
is in `codec-run-1-manifest.json`. Running it requires a new explicit grant;
the released slot is not assumed to carry forward.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools ISSUE202_READBACK_SLOT=granted node docs/evidence/issue202/probe-codec-readback.mjs /Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue202/docs/evidence/issue202/codec-readback-1.json
```

Validation is limited to syntax/diff and source/artifact integrity checks for
this unimported research amendment. Original gate manifests/results stay
immutable: `r1-r2-manifest.json` is verified against Git snapshot `b9be925`,
while the new manifest records the codec run and follow-up sources. Existing
SDR/product/dependency hashes remain unchanged; no product build or full suite
is repeated. The complete #202 decision and R3 measurements remain open.
