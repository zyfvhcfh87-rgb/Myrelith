# Candidate 5 — software decode fallback for native-but-spotty HEVC

**Rank:** 5
**Recommendation:** **no-go**.

## Demand

Phone capture is often HEVC. Hosts without a hardware decoder report unsupported.
Issue #19 treats HEVC as a host observation, not a hard-coded promise. That is
already the correct capability model.

## Why not a WASM fallback

There is no reviewed Mediabunny HEVC fallback family. Shipping one would be a
new payload, must not substitute a different export codec, and is not
justified by demand evidence (no analytics). Native `canDecode()` already
gates import. Auto never selects HEVC on export.

## Reopen

Proven demand on hosts whose native HEVC `canDecode` is false; a pinned,
license-reviewed, lazy decoder under the AC-3 size neighborhood unless a new
budget is accepted; export remains native-only.
