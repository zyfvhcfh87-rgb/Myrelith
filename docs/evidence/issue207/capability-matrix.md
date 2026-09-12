# Issue #207 capability matrix

Direct and fallback paths are separate. **U** means unmeasured, not
impossible. Firefox and Safari are Issue #208.

Legend: `ready` / `limited` / `unsupported` / `error` / `n/a` / `U`.

## Hosts

| Host | Browser | OS | GPU/CPU | `crossOriginIsolated` | HEVC | AV1 |
|---|---|---|---|---|---|---|
| Issue #19 closeout | Chrome 150 / Edge 150 | Windows | AMD Ryzen 9 5900X | no | ready (observation) | ready (observation) |
| This research run | Chromium (Playwright, headless) | see `measured-run.json` | see GPU probe | expected no | observation | observation |
| Firefox | Firefox | — | — | U | U | U |
| Safari / WebKit | Safari | — | — | U | U | U |

## Direct vs fallback (import)

| Candidate / family | Direct (native `canDecode`) | Fallback (reviewed local family) | Export (independent) |
|---|---|---|---|
| WAVE PCM | Mediabunny PCM (direct, not WebCodecs) | none | #204 WAV delivery is a different path |
| MP3 | native | none | not a classic pair |
| FLAC | native | none | not a classic pair |
| OGG Vorbis | native | none | not a classic pair |
| AVC in MP4/MOV/MPEG-TS | native | none | MP4+AVC+AAC |
| VP9/Opus WebM | native | none | WebM+VP9+Opus |
| HEVC | native, host-specific | **no** software fallback ships | explicit HEVC profile only |
| ProRes | usually false | `local-prores` (~250 KiB + TurboRes) | none |
| AC-3 / E-AC-3 | usually false | `local-ac3` (~1.1 MiB FFmpeg WASM) | none; encoder unwired |
| MPEG-2 video | n/a (unnamed) | none; paper no-go | n/a |
| DTS | n/a (unnamed) | none; paper no-go | n/a |
| MXF / DNx | n/a | none; paper no-go | n/a |
| BRAW / R3D / HAP | n/a | none; paper no-go | n/a |

Exact Chromium numbers, seek, A/V sync, cancel, heap, and encoder
`isConfigSupported` rows are in [measured-run.md](measured-run.md) after
`npm run qa:issue207:research`.
