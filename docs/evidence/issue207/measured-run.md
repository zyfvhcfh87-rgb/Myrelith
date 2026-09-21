# Issue #207 measured run

Schema `myrelith-issue207-v1`. Host linux/x64.
Firefox and Safari cells are **U** (Issue #208). `publicSupportClaim` is **false**. This run does not ship formats.

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

## Chromium decode / encode

Host: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.7922.34 Safari/537.36`. Isolated: false. HEVC observation: false. AV1 observation: true. Firefox/Safari: **U**.

| Fixture | Direct decode | Notes |
|---|---|---|
| `pcm-s16.wav` | ready | WAVE |
| `mp3.mp3` | ready | MP3 |
| `flac.flac` | ready | FLAC |
| `vorbis.ogg` | limited (audio-seek) | Ogg |
| `avc-aac.mp4` | ready | MP4 |
| `avc-aac.mov` | ready | QuickTime File Format |
| `avc-aac.ts` | limited (video-seek, audio-seek) | MPEG Transport Stream |
| `vp9-opus.webm` | ready | WebM |
| `vp8-opus.webm` | ready | WebM |
| `av1-opus.webm` | ready | WebM |
| `hevc-aac.mp4` | limited (video-undecodable) | MP4 |
| `avc-ac3.mkv` | limited (audio-undecodable) | Matroska |
| `prores.mov` | limited (video-undecodable) | QuickTime File Format |
| `mpeg2-aac.ts` | limited (audio-seek) | MPEG Transport Stream |
| `avc-dts.mkv` | limited (audio-undecodable) | Matroska |
| `playlist.m3u8` | unsupported | TypeError: HLS inputs require `InputOptions.source` to be a PathedSource or a ref to one. |

## Correctness, seek, throughput, memory

Correctness checks the first closed sequential sample against the fixture: solid `#315b7d` for video, near-silence for `anullsrc` audio. Random-access seek is `getSample` at frames 0 and 15. Sequential decode walks up to one second and closes every sample before the next. JS heap is a coarse Chromium sample; native/GPU RSS stays **unmeasured**. Filmstrip and waveform stay out of this lab because they live in the production graph.

| Fixture | Random seek | Sequential | Correctness | Throughput | JS heap delta | Peak owned RGBA |
|---|---|---|---|---|---:|---:|
| `pcm-s16.wav` | no-video / ok | v no-video; a 24 closed | v n/a; a near silence (peak 0) | v no-video; a 24 packets in 2.0 ms | 2183672 | 0 |
| `mp3.mp3` | no-video / ok | v no-video; a 42 closed | v n/a; a near silence (peak 0) | v no-video; a 42 packets in 2.6 ms | 802672 | 0 |
| `flac.flac` | no-video / ok | v no-video; a 10 closed | v n/a; a near silence (peak 0) | v no-video; a 10 packets in 1.3 ms | -1869484 | 0 |
| `vorbis.ogg` | no-video / miss | v no-video; a 48 closed | v n/a; a near silence (peak 0) | v no-video; a 48 packets in 2.7 ms | 664476 | 0 |
| `avc-aac.mp4` | ok / ok | v 30 closed; a 47 closed | v color 45,89,125 matches fixture; a near silence (peak 0) | v 30 frames in 3.9 ms; a 47 packets in 2.4 ms | -243272 | 230400 |
| `avc-aac.mov` | ok / ok | v 30 closed; a 47 closed | v color 45,89,125 matches fixture; a near silence (peak 0) | v 30 frames in 2.6 ms; a 47 packets in 2.3 ms | 806776 | 230400 |
| `avc-aac.ts` | miss / miss | v 0 closed; a 0 closed | v n/a; a n/a | v 0 frames in 2.9 ms; a 0 packets in 2.1 ms | -42980 | 0 |
| `vp9-opus.webm` | ok / ok | v 30 closed; a 51 closed | v color 49,92,125 matches fixture; a near silence (peak 2.0345869483764863e-34) | v 30 frames in 3.1 ms; a 51 packets in 2.3 ms | 1013184 | 230400 |
| `vp8-opus.webm` | ok / ok | v 30 closed; a 51 closed | v color 45,89,125 matches fixture; a near silence (peak 2.0345869483764863e-34) | v 30 frames in 3.5 ms; a 51 packets in 2.3 ms | -670004 | 230400 |
| `av1-opus.webm` | ok / ok | v 30 closed; a 51 closed | v color 45,89,125 matches fixture; a near silence (peak 2.0345869483764863e-34) | v 30 frames in 3.6 ms; a 51 packets in 2.3 ms | 839276 | 230400 |
| `hevc-aac.mp4` | not-decodable / ok | v not-decodable; a 47 closed | v n/a; a near silence (peak 0) | v not-decodable; a 47 packets in 2.7 ms | -946340 | 0 |
| `avc-ac3.mkv` | ok / not-decodable | v 30 closed; a not-decodable | v color 45,89,125 matches fixture; a n/a | v 30 frames in 2.8 ms; a not-decodable | 1097812 | 230400 |
| `prores.mov` | not-decodable / ok | v not-decodable; a 30 closed | v n/a; a near silence (peak 0) | v not-decodable; a 30 packets in 1.2 ms | 852444 | 0 |
| `mpeg2-aac.ts` | no-video / miss | v no-video; a 0 closed | v n/a; a n/a | v no-video; a 0 packets in 2.2 ms | 978016 | 0 |
| `avc-dts.mkv` | ok / not-decodable | v 30 closed; a not-decodable | v color 45,89,125 matches fixture; a n/a | v 30 frames in 2.6 ms; a not-decodable | -869648 | 230400 |
| `playlist.m3u8` | miss / miss | v n/a; a n/a | v n/a; a n/a | v n/a; a n/a | 17512 | n/a |

## A/V sync

Timestamp pairs compare independently decoded samples. The audio-clock rows start a muted `AudioContext`, derive an integer frame from `currentTime`, and fetch that video sample. That is not product playback.

| Fixture | Sample timestamps | Audio clock |
|---|---|---|
| `pcm-s16.wav` | n/a (no-video) | not requested |
| `mp3.mp3` | n/a (no-video) | not requested |
| `flac.flac` | n/a (no-video) | not requested |
| `vorbis.ogg` | n/a (no-video) | not requested |
| `avc-aac.mp4` | within one frame | frame 3 within one frame |
| `avc-aac.mov` | within one frame | frame 3 within one frame |
| `avc-aac.ts` | outside one frame | not requested |
| `vp9-opus.webm` | within one frame | frame 3 within one frame |
| `vp8-opus.webm` | within one frame | not requested |
| `av1-opus.webm` | within one frame | not requested |
| `hevc-aac.mp4` | n/a (not-decodable) | not requested |
| `avc-ac3.mkv` | n/a (not-decodable) | not requested |
| `prores.mov` | n/a (not-decodable) | not requested |
| `mpeg2-aac.ts` | n/a (no-video) | not requested |
| `avc-dts.mkv` | n/a (not-decodable) | not requested |
| `playlist.m3u8` | n/a | not requested |

## Failure recovery

Open-cancel disposes the Input while `getTracks()` is still pending. Decode-cancel closes the first sequential sample, disposes the Input, and then pulls again. Owned samples must return to zero.
- Open cancel `avc-aac.mp4`: {"rejected":true,"disposed":true,"error":"InputDisposedError: Input has been disposed."}
- Decode cancel `avc-aac.mp4`: {"rejected":true,"disposed":true,"ownedAfter":0,"error":"InputDisposedError: Input has been disposed.","started":true}
- Decode cancel `pcm-s16.wav`: {"rejected":true,"disposed":true,"ownedAfter":0,"error":"InputDisposedError: Input has been disposed.","started":true}

### Existing fallback path (already shipped, not a new format)

- ProRes direct `canDecode`: false; after `registerProresDecoder`: true; random-access seek: true; sequential: 30 closed; color: color 49,91,124 matches fixture
- AC-3 direct `canDecode`: false; after `registerAc3Decoder`: true; random-access seek: false; sequential: 32 closed; audio: near silence (peak 0.000001942074050020892)
- Encoder registration attempted: false
- Register call: 0.2000000000698492 ms. First ProRes fallback measure: 25.199999999953434 ms. First AC-3 fallback measure: 50.09999999997672 ms. Those durations include demux and decode, not a separate WASM compile timer.

### Native encoder probes

- video `avc`: supported
- video `vp9`: supported
- video `av1`: supported
- video `hevc`: unsupported
- video `prores`: unsupported
- audio `aac`: unsupported
- audio `opus`: supported
- audio `ac3`: unsupported

## Payload sizes

- @mediabunny/ac3: 1154782 bytes at `node_modules/@mediabunny/ac3/dist/bundles/mediabunny-ac3.js` (MPL-2.0 wrapper; inlined FFmpeg LGPL 2.1+ WASM)
- @mediabunny/prores: 275151 bytes at `node_modules/@mediabunny/prores/dist/bundles/mediabunny-prores.js` (MPL-2.0)
- turbores: 200453 bytes at `node_modules/turbores/dist/turbores.js` (MPL-2.0)

## Left unmeasured on purpose

- Firefox and Safari (Issue #208).
- Product filmstrip, waveform, and audio-master playback. This lab does not import the production graph.
- Native decoder RSS and GPU memory. Known RGBA above is the closed sample's display size, not process RSS.
- MPEG-2, DTS, DNx, MXF, BRAW, R3D, HAP, and any WASM encoder. No spike ran.
