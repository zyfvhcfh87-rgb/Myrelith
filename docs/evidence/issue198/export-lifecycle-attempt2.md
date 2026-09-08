# Lifecycle attempt 2: reviewed acceptance passed

**PASS for the explicitly reviewed pre-encode/mean-quality/lifecycle criteria.**
One authorized run tested exact clean source
`6bfa373c62b01bb312ed92b62f368f5417512ac3` and exited 0. Recorded start/end:
2026-09-08 22:15:15.290Z–22:16:05.796Z. No source changes occurred during the run.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue198/run-resource-gate.mjs --segment export-lifecycle --expected-sha 6bfa373c62b01bb312ed92b62f368f5417512ac3 --output .tmp/issue198-6bfa373-export-lifecycle-attempt2
```

All three **complete → cancel at 60 → complete retry** cycles passed: six
300-frame exports and three cancellations at exactly 60 frames, each at actual
progress `60/301`. There were 1,980 production source requests, composites,
added frames and opened/closed leases. All nine attempts settled within their
existing bounds, preserved project/history, and passed original sink, media,
lease, readback, canvas and grading-owner checks.

**27/27 actual pre-encode checks had maximum RGB difference 0** against the
independent static oracle built from the same borrowed decoded input: four
targets per completed export, frame 0 for each cancellation. All **24 encoded
mean checks passed <= 2**. Each output retained AVC, 1280×720, exact ordinal
30 fps timestamps/durations, 10-second duration and no audio.

| Frame | Encoded maximum range across six outputs | Encoded mean range |
| --- | ---: | ---: |
| 0 | 12 | 0.200837674 |
| 127 | 17–20 | 0.068225911–0.068901910 |
| 255 | 17–19 | 0.068189019–0.068613281 |
| 299 | 17–19 | 0.077650825–0.078636068 |

The legacy maximum-12 rule still failed **18/24** encoded targets. Those
observations and the [original export failure](export-attempt1/results.md),
[independent-control failure](export-completion-attempt1.md) and
[warning-stopped lifecycle attempt](export-lifecycle-attempt1.md) remain visible.
This is not lossless encoding, a maximum-12 guarantee or all-frame pixel-quality
qualification. No extra control was encoded and no codec investigation ran.

All 1,800 ordinal output samples and 24 selected VideoFrames closed. All 105
comparison buffers released; peak 18,432,000 bytes below 64 MiB, final zero
bytes/buffers. References were cleared after every attempt. Actual observed
canvases and production owners passed their original settlement assertions.
Six exact Canvas2D performance advisories were recorded as approved nonfatal
advice; no other browser, console, evidence or cleanup problem was reported.

The native slot is released. Worker verification at 22:16:36.358725Z found
PIDs 61548, 61568, 61569, 61570, 61571 and 61573 absent by kill(0) and ps;
port 5198 refused connections (61). Context, browser, browser server and Vite
all closed. Logical owner observations do not imply exact private-codec/RSS peaks.

Original evidence remains in `.tmp/issue198-6bfa373-export-lifecycle-attempt2`:
2,215 JSON records, manifest, and six completed output MP4s totaling 12,602,767
bytes, with no partial files. Record 02208 contains final work/zero-buffer totals.
Sibling `*-command.log`, `*-preflight.json` and `*-cleanup.json` preserve command
completion and physical release. No additional matrix or packaging was added.
