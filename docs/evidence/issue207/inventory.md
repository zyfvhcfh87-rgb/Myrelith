# Issue #207 three-layer inventory

Import and export are separate columns. Decode cells that depend on the host
are observations, not promises. HEVC and AV1 stay host-probed.

Pinned Mediabunny **1.50.9** `ALL_FORMATS`:

`HLS, MP4, QTFF (MOV), MATROSKA, WEBM, WAVE, OGG, FLAC, MP3, ADTS, MPEG_TS`

Known video ids: `avc`, `hevc`, `vp9`, `av1`, `vp8`, `prores`.
Known audio ids: `aac`, `opus`, `mp3`, `vorbis`, `flac`, `ac3`, `eac3`, plus
PCM / μ-law / A-law families.

Product decoder paths remain `native` | `local-prores` | `local-ac3`.
Classic export pairs remain MP4+AVC+AAC, WebM+VP9+Opus, WebM+AV1+Opus,
explicit MP4+HEVC+AAC. No local encoder fallback.

| Id | Kind | Demux (pinned 1.50.9) | Decode | Encode |
|---|---|---|---|---|
| avc | video | MP4 / MOV / MPEG-TS / MKV | native `canDecode` | allow-listed MP4+AVC+AAC |
| hevc | video | MP4 / MOV / MPEG-TS | native `canDecode`; never Auto | explicit MP4+HEVC+AAC |
| vp8 | video | WebM / MKV | native `canDecode` | not an export pair |
| vp9 | video | WebM / MKV | native `canDecode` | allow-listed WebM+VP9+Opus |
| av1 | video | WebM / MKV | native `canDecode` | allow-listed WebM+AV1+Opus |
| prores | video | MOV / MP4 | `local-prores` after native miss | no encoder fallback |
| aac | audio | MP4 / MOV / MPEG-TS / ADTS | native `canDecode` | allow-listed with AVC/HEVC |
| ac3 | audio | MKV / MPEG-TS | `local-ac3` after native miss | package encoder exists, not wired |
| eac3 | audio | MKV / MPEG-TS | shared AC-3 family | none |
| mp3 | audio | MP3 / MPEG-TS | native if the browser supports it | not a classic export pair |
| opus | audio | WebM / MKV / OGG | native `canDecode` | allow-listed with VP9/AV1 |
| vorbis | audio | OGG / MKV | native if the browser supports it | not an export pair |
| flac | audio | FLAC / MKV | native if the browser supports it | not a classic export pair |
| pcm-s16 | audio | WAVE | Mediabunny PCM path (no `AudioDecoder`) | Issue #204 WAV is export-only |
| mpeg-ts-unnamed | container | MPEG-TS | named AVC/HEVC/AAC/MP3/AC-3 only; others omitted | n/a |
| hls-blob | container | HLS | `BlobSource` is not a `PathedSource`; fail closed | not an import feature |
| mxf | container | **not in ALL_FORMATS** | n/a | n/a |
| mpeg2 | video | MPEG-TS / MXF / MKV | **not in VIDEO_CODECS**; TS omits the stream | n/a |
| dts | audio | MKV / TS | **not in AUDIO_CODECS** | n/a |
| dnx | video | MXF / MOV | **not in VIDEO_CODECS** | n/a |

Fill measured cells from `npm run qa:issue207:research`. The honesty gap this
issue exists to record: WAVE / MP3 / FLAC / OGG / MPEG-TS / MOV can already
become `ready` while README still speaks generically of video/audio and
MP4/WebM export.
