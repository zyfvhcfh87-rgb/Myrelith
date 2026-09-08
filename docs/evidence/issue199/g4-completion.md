# Issue 199: corrected mixed G4 passed

All nine checkpoints passed in one granted run at clean
`705f07135ec30681ccc9593b41045dd378498698`, on 2026-09-08 from
21:57:26.284 to 21:57:34.716 UTC. The run exercised canonical retime/split and
undo, native title Set/value/copy/paste, muted playback, exact portable reopen
and relink, 1440/720 layout and focus, strict missing-font refusal, fresh Program
references, actual export/decode, and final media/persistence cleanup.

The actual 270,303-byte WebM contains VP9 at 1280×720 and stereo Opus, with
exactly 30 video packets and one-second video/container durations. Every packet
timestamp is within 0.334 ms of its expected 30 fps position. All six decoded
frames satisfy the unchanged RGB and glyph predicates, including visible text
at 14/15 and empty boundary frames. Maximum RGB mean error is 1.061 and p95 is 2.
The representative decoded frame 14 was visually inspected.

Decoded PCM covers all 48,000 sample positions with zero overlap. Early RMS is
[0.02207678, 3.89e-14], late RMS [5.07e-6, 0.06631790], and the gain ratio is
3.003966. Both prepared-export owners record terminal close. Final admission
contains zero essential/monitor owners, decoder slots and surface bytes, with
no blockers. Persistence settle reaches idle with 28 error-free session events;
there are no console/page problems.

Independent release at 21:57:56.382965 UTC confirms all ten recorded PIDs absent
and port 5199 refused. Raw evidence remains at
`/private/tmp/issue199-g4/2026-09-08T21-57-26.097Z`, including trace, screenshots,
references, source/portable files and full result. `g4-completion/` retains the
actual encoded bytes, exact decoded/preparation/final-admission facts, release
receipt and concise summary. No archive or repeated audit was added.

This is the accepted source-module Chromium diagnostic scope, not a production
bundle, OS Save-picker, cross-platform raster or new performance claim. Earlier
failures remain preserved. The previously accepted Gate 3 segments and focused
source validation remain separate evidence; consolidated final milestone
tests/build/lint/integration are owned by the parent task.
