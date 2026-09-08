# G4 fixture stacking and packet cadence

The failed native observation remains unchanged at
`4112f92e92b29bbadaf23eef26f6b00734a7abce`. An offline pass evaluated all 53
original encoded-output assertions against its saved facts: 48 pass, five fail.
The failures are the packet-rate estimate plus absent glyphs at 14/15 and their
zero/zero coverage ratios. The exact audit is `g4-offline-predicate-audit.json`.
Final app drain and persistence settle remain unobserved; no other snapshot is
substituted for them.

The saved title X values at 14/15 are +36.4483/-36.4483. Their text boxes are
fully inside the canvas: x260.448–1092.448 / x187.552–1019.552, y281–439.
Native edits changed the rectangle's Y lane, not these text X keys. The new
real composition-plan regression failed on the old fixture because title item
0 preceded opaque media item 1. The fixture now appends the title track, and
that regression passes at all six frames. Its payload, generated motion,
font, media, native edits and all four required interior-glyph probes remain.

Saved-byte metadata confirms 30 packets with timestamp errors at most 0.334 ms,
exact one-second track/container durations and a final packet extent of
1.000333333 seconds. Mediabunny 1.50.9 computes its average rate from packet
extents; the final default duration explains the 29.9900033422 estimate. The
diagnostic now records and checks every packet timestamp against ordinal/30
within the existing 1 ms container precision, plus exactly 30 packets and
positive finite durations. Strict video/container duration bounds remain.
The average estimate is retained as evidence. Tests accept this recorded
quantization while rejecting wrong cadence, duplicate and missing packets.

Source validation passes: 20 focused tests in three files, 17 canonical runner
checks, 19 oracle/lifecycle checks, app and diagnostic TypeScript, lint, Node
syntax and diff checks. Raw logs remain under `.tmp/issue199/g4-cadence-stacking-*`;
the reproducing failure is `.tmp/issue199/g4-stacking-before.log`.
No product code, RGB/glyph/PCM/resource thresholds, six-frame selection,
deadlines, native run, build or benchmark changed or ran during this correction.
