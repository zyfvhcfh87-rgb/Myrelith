# Issue #201: independent ASS time foundation

Date: 2026-09-08. Pure foundation only; no schema migration, editor wiring or
caption render behavior changes. This work uses the approved independent ASS
gate while the separate model-lab review is pending.

`src/domain/captionAssTime.ts` implements bounded ASS `h:mm:ss.cc` conversion with
BigInt and the existing caption frame ceiling. Starts floor and exclusive ends
ceil on import. Export proposes an exact result only after reconstructing both
boundaries and positive duration. An unrepresentable centisecond interval yields
an explicit coverage-expansion proposal with original/imported ranges; the caller
must separately approve that loss. Expansion past the document frame ceiling
is reported unrepresentable. Nothing mutates the source range or accepts loss.

The bounded 32-character timestamp grammar rejects negative values, malformed
components and oversized fields before conversion. Invalid integer frame ranges
and rational rates reject. Existing SRT/VTT parsing and millisecond arithmetic
are unchanged.

One initial test incorrectly expected every one-frame NTSC cue at 60000/1001 to
have two distinct centisecond boundaries. The implementation correctly returned
coverage expansion for a grid-unrepresentable interval. The test now verifies
either exact reconstruction or explicit outward coverage; it does not erase
that real format limitation. Even below 100 fps, a short cue's grid alignment
can prevent a positive-duration exact ASS representation.

Validation:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage npm test -- src/domain/captionAssTime.test.ts src/domain/captionFiles.test.ts src/domain/captions.test.ts src/test/architecture.test.ts --maxWorkers=1
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run build
npm run lint
```

**4 files / 51 tests and 17 repository runner checks passed**, including 22 new
ASS boundary cases. Build/typecheck and lint passed; Vite retains its large-chunk
advisory. Tests cover 24/25/30/50/60/100 fps, 24000/30000/60000 over 1001, 120 fps
grid expansion, frame-ceiling rejection, malformed timestamps and unsafe inputs.
The architecture check passed. No observable product path exists yet, so this
gate makes no browser/pixel or complete ASS-interchange acceptance claim.

Full ASS/style/batch integration and semantic caption persistence remain open;
schema 24 still waits for the reviewed schema 22/23 foundations.
