# Candidate 3 — MPEG-2 video and DTS audio

**Rank:** 3
**Recommendation:** **no-go** (paper). No WASM spike.

## Demand

Issue #19 already saw MPEG-2 as Limited. Broadcast/camera transport streams and
DTS interchange remain high-friction on desktop NLEs.

## Why it cannot enter the lab as a decoder

Mediabunny 1.50.9 `VIDEO_CODECS` / `AUDIO_CODECS` do not include `mpeg2` or
`dts`. `CustomVideoDecoder.supports()` only receives that closed union. MPEG-TS
unrecognized stream types are dropped, so the file can look like "audio only"
or "no video track."

A Myrelith-only custom decoder cannot hook these ids today. Closing the gap
needs upstream Mediabunny naming and packetization, a reviewed pin/patch, or a
parallel demuxer — the last fights the single `Input` / `ALL_FORMATS` path
and defaults to no-go.

## Measurements required by the issue

Correctness, seek, A/V sync, memory, and throughput are **not applicable** until
the codec is named. Failure recovery is the observed omission / unnamed track.
Module size is not measured because no module was loaded.

Node demux (pinned 1.50.9):

- `mpeg2-aac.ts` names AAC only. MPEG-2 video (`stream_type 0x2`) is omitted,
  with Mediabunny's "not currently supported" note. The file can look like
  audio-only.
- `avc-dts.mkv` names AVC video and surfaces an audio track whose codec id is
  `null`. That is an unnamed track, not a DTS fallback hook.

## Reopen

1. Reviewed Mediabunny upgrade that names the codec and maps packets.
2. Decoder-only, locally bundled, lazy, realm-registered, budgeted, cancellable,
   license-reviewed.
3. Independent import vs export; no encoder fallback; no unrestricted FFmpeg.
4. Size near the AC-3 ~1.1 MiB reference unless a new budget is accepted.
5. LGPL/source-offer review complete for any further FFmpeg-derived WASM
   (still open for AC-3).
