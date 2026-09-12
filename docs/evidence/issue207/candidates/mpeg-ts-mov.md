# Candidate 2 — MOV / MPEG-TS wrapping already-named codecs

**Rank:** 2 (professional interchange, container reach)
**Recommendation:** **bounded child issue** for documentation and MPEG-TS
omission diagnostics if MOV/TS already name AVC+AAC. Not a new codec.

## Demand

Camera and broadcast files often arrive as MOV or MPEG-TS around codecs
Myrelith already decodes. Advertised support is MP4/WebM. MPEG-TS's demuxer
**omits unrecognized stream types** rather than reporting them as tracks, so a
generic "we open MPEG-TS" claim would be dishonest.

## Fixtures

`avc-aac.mov`, `avc-aac.ts`, `mpeg2-aac.ts` (the last proves omission of
unnamed MPEG-2 video).

## Direct vs fallback

| Container | Direct decode of named codecs | Fallback | Export |
|---|---|---|---|
| QTFF/MOV + AVC/AAC | native decode, integer-frame seek, A/V within one frame, samples closed | none | still MP4/WebM pairs; import ≠ export |
| MPEG-TS + AVC/AAC | named and `canDecode` true; **sample seek returned no samples** on the 1s fixture | none | do not advertise MPEG-TS playback |
| MPEG-TS + MPEG-2 | video omitted, not `unsupported-codec` | none | n/a |

HLS playlists on `BlobSource` remain fail-closed (local-first). That is a
property to keep, not a network-import feature.

## Child issue shape

Document container reach for named codecs. Optionally report omitted MPEG-TS
streams as a diagnostic. Do **not** claim MPEG-TS random-access decode from
this fixture. Do not add MPEG-2, remote HLS, or a second demuxer.
