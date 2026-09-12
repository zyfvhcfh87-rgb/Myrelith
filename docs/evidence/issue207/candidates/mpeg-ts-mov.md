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
| QTFF/MOV + AVC/AAC | native | none | still MP4/WebM pairs; import ≠ export |
| MPEG-TS + AVC/AAC | native if the host decodes AVC/AAC | none | same |
| MPEG-TS + MPEG-2 | video omitted, not `unsupported-codec` | none | n/a |

HLS playlists on `BlobSource` must remain fail-closed (local-first). That is
a property to keep, not a network-import feature.

## Child issue shape

Document container reach for named codecs. Optionally report omitted MPEG-TS
streams as a diagnostic. Do not add MPEG-2, remote HLS, or a second demuxer.
