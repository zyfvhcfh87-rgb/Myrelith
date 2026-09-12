# Issue #207 final research decision

Issue #207 is an evidence program. An all-no-go matrix would still close it.
This run recommends **two bounded documentation/diagnostics children** and
**explicit no-go** for every new codec, container, encoder fallback, and
unrestricted FFmpeg path.

No README, export-profile, or `MediaDecoderPath` change ships here.

## Per-candidate

| Candidate | Recommendation | Child shape |
|---|---|---|
| honesty-audio | bounded child | docs, fixtures, Media Pool copy |
| mpeg-ts-mov | bounded child | docs + MPEG-TS omission diagnostics |
| mpeg2-dts | no-go | — |
| mxf-dnx | no-go | — |
| hevc-software-fallback | no-go | — |
| ac3-prores-encode | no-go | — |
| braw-r3d-hap | no-go | — |

Those two children may be filed as one "advertised vs demuxable honesty" issue
if that is easier to review. They still must not add a decoder.

## Exit criteria

- Ranking: [ranking.md](ranking.md), frozen in `scripts/issue207/ranking.mjs`.
- Matrix: [capability-matrix.md](capability-matrix.md) plus the measured run.
- Measurements: `npm run qa:issue207:research` → [measured-run.md](measured-run.md).
- Licensing: [licensing.md](licensing.md).
- Go/no-go: this page and `scripts/issue207/decision.mjs`.
- No shipping format claim in this issue.

## What remains out of scope

Firefox/Safari (#208), 10-bit/HDR (#202, already no-go), PNG/WAV/alpha WebM
delivery (#204), proxies (#70 / Slice 6 converter no-go).
