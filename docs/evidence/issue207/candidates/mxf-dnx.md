# Candidate 4 — MXF and DNxHD/HR

**Rank:** 4
**Recommendation:** **no-go** (paper). No WASM spike.

## Demand

Finishing interchange after ProRes still names DNx in MXF.

## Why it cannot enter the lab as a decoder

MXF is not in `ALL_FORMATS`. DNxHD/HR is not in `VIDEO_CODECS`. Same closed
`supports()` union as MPEG-2. A parallel MXF demuxer would be a new pipeline
architecture, not a codec checkbox.

## Reopen

Same bar as MPEG-2/DTS: upstream name + demux mapping, decoder-only, local
lazy module, license review, no encoder fallback, no unrestricted FFmpeg.
