# Candidate 6 — AC-3 or ProRes encode

**Rank:** 6
**Recommendation:** **no-go**.

## Demand

Some finishing workflows want AC-3 in the delivered file. `@mediabunny/ac3`
ships `registerAc3Encoder()`. ProRes remains decode-only in the pinned
packages.

## Why not

`ARCHITECTURE.md`: "no local encoder fallback are permitted." Issue #16
already researched and rejected optional local AAC / Opus / VP9 / AV1 /
AVC / HEVC encoders. The unused AC-3 encoder does not license a product encode
path. Product source does not import `registerAc3Encoder`.

On this research host, native encoder probes were: AVC/VP9/AV1/Opus
supported; HEVC, ProRes, AAC, and `ac-3` unsupported. No local encoder
fallback was attempted.

## Reopen

A separate architecture decision that revises the native-only export
contract, plus Issue #16 semantic, size, lifecycle, and licensing gates.
