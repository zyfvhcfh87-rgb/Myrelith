# Issue #207 demand ranking

**Recorded before any decoder, encoder, or production-format change.**
Frozen in `scripts/issue207/ranking.mjs` at `2026-09-12T00:00:00Z`.

There is no in-app analytics ([PRIVACY.md](../../PRIVACY.md)). Ranking uses
comparison research, the Issue #19 Limited/Unsupported matrix, camera/phone/pro
interchange practice, and advertised-versus-demuxed honesty.

## Rubric (highest friction first)

1. Professional camera / finishing interchange still failing after ProRes/AC-3
   (DNx, MXF, MPEG-2 camera/TS, DTS).
2. Everyday audio files Mediabunny already names but product copy under-describes
   (WAVE, MP3, FLAC, OGG).
3. Phone/screen-capture families already native-gated (HEVC, AAC) — documentation,
   not new WASM.
4. Desktop-NLE checkbox codecs with no Mediabunny name (BRAW, R3D, HAP).

## Ranked experiments

| Rank | Id | Rubric | Experiment | Default |
|---:|---|---|---|---|
| 1 | `honesty-audio` | everyday-audio | WAVE PCM, MP3, FLAC, OGG Vorbis honesty | bounded docs child if demux names them |
| 2 | `mpeg-ts-mov` | pro-interchange | MOV / MPEG-TS wrapping already-named codecs | bounded docs/diagnostics child if named |
| 3 | `mpeg2-dts` | pro-interchange | MPEG-2 video and DTS audio | paper no-go |
| 4 | `mxf-dnx` | pro-interchange | MXF + DNxHD/HR | paper no-go |
| 5 | `hevc-software-fallback` | phone-native | WASM HEVC when native `canDecode` is false | no-go |
| 6 | `ac3-prores-encode` | pro-interchange | Wire AC-3/ProRes encode | no-go (Issue #16) |
| 7 | `braw-r3d-hap` | nle-checkbox | BRAW, R3D, HAP | paper no-go |

Authority: `docs/OPEN_SOURCE_VIDEO_EDITOR_FEATURE_COMPARISON_RESEARCH.md`,
Issue #19 closeout and Slice 6 converter no-go, `README.md` known limitations,
pinned Mediabunny 1.50.9 `VIDEO_CODECS` / `AUDIO_CODECS` / `ALL_FORMATS`.
