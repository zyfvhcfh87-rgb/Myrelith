# Issue #207 measured run

Schema `myrelith-issue207-v1`. Host linux/x64.
Firefox and Safari cells are **U** (Issue #208). This run does not ship formats.

## Decisions

| Candidate | Recommendation |
|---|---|
| `honesty-audio` | **bounded-child** |
| `mpeg-ts-mov` | **bounded-child** |
| `mpeg2-dts` | **no-go** |
| `mxf-dnx` | **no-go** |
| `hevc-software-fallback` | **no-go** |
| `ac3-prores-encode` | **no-go** |
| `braw-r3d-hap` | **no-go** |

## Demux (Node, Mediabunny 1.50.9)

| Fixture | Format | Codecs | canDecode (Node) |
|---|---|---|---|
| `pcm-s16.wav` | WAVE | audio:pcm-s16 | true |
| `mp3.mp3` | MP3 | audio:mp3 | false |
| `flac.flac` | FLAC | audio:flac | false |
| `vorbis.ogg` | Ogg | audio:vorbis | false |
| `avc-aac.mp4` | MP4 | video:avc, audio:aac | false,false |
| `avc-aac.mov` | QuickTime File Format | video:avc, audio:aac | false,false |
| `avc-aac.ts` | MPEG Transport Stream | video:avc, audio:aac | false,false |
| `vp9-opus.webm` | WebM | video:vp9, audio:opus | false,false |
| `vp8-opus.webm` | WebM | video:vp8, audio:opus | false,false |
| `av1-opus.webm` | WebM | video:av1, audio:opus | false,false |
| `hevc-aac.mp4` | MP4 | video:hevc, audio:aac | false,false |
| `avc-ac3.mkv` | Matroska | video:avc, audio:ac3 | false,false |
| `prores.mov` | QuickTime File Format | video:prores, audio:pcm-s16 | false,true |
| `mpeg2-aac.ts` | MPEG Transport Stream | audio:aac | false |
| `avc-dts.mkv` | Matroska | video:avc, audio:null | false,false |
| `dnx-or-mpeg2.mxf` | unread | none | n/a |
| `playlist.m3u8` | fail-closed | none | n/a |
| `not-media.braw` | unread | none | n/a |

Browser lab skipped (`--node-only`). Chromium cells remain **U** until `npm run qa:issue207:research`.


## Payload sizes

- @mediabunny/ac3: 1154782 bytes primary bundle (MPL-2.0 wrapper; inlined FFmpeg LGPL 2.1+ WASM)
- @mediabunny/prores: 275151 bytes primary bundle (MPL-2.0)
- turbores: 436204 bytes primary bundle (MPL-2.0)
