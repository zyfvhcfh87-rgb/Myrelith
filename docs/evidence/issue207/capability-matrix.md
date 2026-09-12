# Issue #207 capability matrix

Direct and fallback paths are separate. **U** means unmeasured, not
impossible. Firefox and Safari are Issue #208.

Legend: `ready` / `limited` / `unsupported` / `error` / `n/a` / `U`.

## Hosts

| Host | Browser | OS | GPU/CPU | `crossOriginIsolated` | HEVC | AV1 |
|---|---|---|---|---|---|---|
| Issue #19 closeout | Chrome 150 / Edge 150 | Windows | AMD Ryzen 9 5900X | no | ready (observation) | ready (observation) |
| This research run | HeadlessChrome 151.0.7922.34 | Linux x86_64, 4 logical CPUs, 16 GiB `deviceMemory` | Playwright Chromium; GPU blob in `measured-run.json` | **false** | **false** | **true** |
| Firefox | Firefox | — | — | U | U | U |
| Safari / WebKit | Safari | — | — | U | U | U |

## Direct vs fallback (import)

| Candidate / family | Direct (native `canDecode` + sample seek) | Fallback (reviewed local family) | Export (independent) |
|---|---|---|---|
| WAVE PCM | ready; integer-frame samples closed | none | #204 WAV delivery is a different path |
| MP3 | ready; samples closed | none | not a classic pair |
| FLAC | ready; samples closed | none | not a classic pair |
| OGG Vorbis | `canDecode` true; sample seek on the 1s silent fixture returned no samples | none | not an export pair |
| AVC+AAC in MP4/MOV | ready; A/V timestamps within one frame; cancel disposed the Input | none | MP4+AVC+AAC; this host's AAC *encoder* probe was unsupported |
| AVC+AAC in MPEG-TS | named and `canDecode` true; **sample seek returned no samples** on this 1s fixture | none | do not advertise MPEG-TS playback |
| VP8/VP9/AV1 + Opus | ready; A/V within one frame | none | VP9/AV1 allow-listed; VP8 is not an export pair |
| HEVC | **false** on this Linux headless host; AAC audio still decoded | **no** software fallback ships | explicit HEVC profile; encoder unsupported here |
| ProRes | direct `canDecode` false | after `registerProresDecoder`, `canDecode` true and sample seek ready | none |
| AC-3 / E-AC-3 | direct false | after `registerAc3Decoder`, `canDecode` true; sample seek on this fixture returned no samples | none; encoder unwired; `ac-3` encoder unsupported |
| MPEG-2 video | omitted from MPEG-TS tracks | none; paper no-go | n/a |
| DTS | Matroska audio track with `codec: null` | none; paper no-go | n/a |
| MXF / DNx | unread container | none; paper no-go | n/a |
| BRAW / R3D / HAP | unread | none; paper no-go | n/a |
| HLS `.m3u8` Blob | fail-closed (`PathedSource` required) | n/a | keep local-first |

Machine-readable rows, packet timestamps, owned-sample teardown, and encoder
`isConfigSupported` rows are in [measured-run.md](measured-run.md).
