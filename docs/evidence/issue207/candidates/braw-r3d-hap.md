# Candidate 7 — BRAW, R3D, and HAP

**Rank:** 7 (NLE checkbox)
**Recommendation:** **no-go** (paper). No WASM spike.

## Demand

Desktop NLE feature lists name camera-raw and HAP families. That is checkbox
demand, not a Mediabunny hook.

## Why not

None of these names appear in Mediabunny 1.50.9 `VIDEO_CODECS` or
`ALL_FORMATS`. Same closed custom-decoder union. A `.braw` of random bytes
must fail closed as an unsupported container.

## Reopen

Upstream Mediabunny (or an accepted alternative demuxer architecture) plus the
decoder-only local-module bar. Default remains no-go.
