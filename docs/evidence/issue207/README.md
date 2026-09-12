# Issue #207 evidence

Repeatable codec/container evidence gate. Not a shipping format list.

- [Plan](../ISSUE_207_PLAN.md)
- [Ranking](ranking.md) (frozen before any decoder)
- [Inventory](inventory.md)
- [Capability matrix](capability-matrix.md)
- [Licensing](licensing.md)
- [Measured run](measured-run.md)
- [Final decision](final-decision.md)
- Candidates:
  - [Honesty audio](candidates/honesty-audio.md)
  - [MOV / MPEG-TS wrapping](candidates/mpeg-ts-mov.md)
  - [MPEG-2 / DTS](candidates/mpeg2-dts.md)
  - [MXF / DNx](candidates/mxf-dnx.md)
  - [HEVC software fallback](candidates/hevc-software-fallback.md)
  - [AC-3 / ProRes encode](candidates/ac3-prores-encode.md)
  - [BRAW / R3D / HAP](candidates/braw-r3d-hap.md)

Run `npm run qa:issue207:research` to refresh `measured-run.json` and
`measured-run.md`. Fixture bytes are never committed.
