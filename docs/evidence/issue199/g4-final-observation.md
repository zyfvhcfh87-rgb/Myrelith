# Integrated G4: encoded output retained, two diagnostic mismatches

One granted run observed clean `b643025c1cd4e0c4284f79f8b5f2d11cc87a934b`
on 2026-09-08, 21:36:36.948–21:36:44.495 UTC. Seven checkpoints passed,
including strict missing-font refusal through canonical prepared ownership and
all six fresh Program references. The eighth checkpoint completed export and
readback, then failed the frozen average-packet-rate assertion. No retry ran.

Raw evidence remains at `/private/tmp/issue199-g4/2026-09-08T21-36-36.768Z`:
trace, screenshots, references, portable files, source files, full result,
session/preparation events and decoded facts. `g4-attempt4` preserves the actual
204,174-byte WebM and concise exact result facts. The encoded SHA-256 is
`3a0f4cd160d338721fc19067392dd72f0f32c12ce3c208b77e357f7990877174`.

Two issues need correction before G4 can pass:

- The reported average packet rate is 29.99000334221593, outside 30 ± 0.001.
  Metadata-only inspection of the saved bytes confirms exactly 30 packets,
  one-second video/container duration and every timestamp within 0.334 ms of
  its frame's expected start. The last packet has timestamp 0.967 and default
  duration 0.033333333. Mediabunny's `computePacketStats` divides 30 by their
  1.000333333-second extent. The rate assertion therefore conflicts with the
  already accepted millisecond container timestamp precision. No threshold or
  raw fact was changed.
- Raw and decoded white-glyph counts are zero at frames 14 and 15, violating
  the separate interior-text predicate. The saved frame 14 image was inspected.
  The fixture prepends its title track before V1; the canonical planner and
  renderer preserve track order, so opaque V1 covers the title in the center.
  At frames 7 and 22, text remains visible outside the media edges. This is a
  fixture stacking error; moving the title above media is the concrete fix.

Saved facts beyond the runtime assertion's short circuit meet the existing RGB
and PCM bounds: maximum RGB mean 1.042, p95 2; all 48,000 sample positions
covered, zero overlaps; early RMS [0.02207678, 3.89e-14], late
[5.07e-6, 0.06631790], gain ratio 3.003966. Both preparation owners record close.
There are 28 healthy session events and no console/page problems. These facts
do not turn the failed runtime checkpoint into a pass.

Final application admission drain and persistence settle did not run. The
pre-drain snapshots still contain the Program owner. Browser/process cleanup
completed: the independent 21:37:15.109702 UTC release receipt confirms all ten
recorded PIDs absent and port 5199 refused. The parent may reclaim the slot.
Source remains unchanged; this commit preserves evidence only.
