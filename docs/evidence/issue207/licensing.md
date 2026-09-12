# Issue #207 licensing and distribution

Recorded before any proposal to bundle additional codec code.

## Already in the product

| Payload | Role | On-disk reference | License notes |
|---|---|---|---|
| Mediabunny 1.50.9 | Demux/mux + WebCodecs bridge | `mediabunny` | MPL-2.0 |
| `@mediabunny/prores` 1.50.9 | ProRes decode only | ~250 KiB bundle | MPL-2.0. Decode-only. |
| TurboRes | ProRes WASM helper | ~196 KiB | MPL-2.0. Shared-memory threads need COOP/COEP; product uses the slower path. |
| `@mediabunny/ac3` 1.50.9 | AC-3 / E-AC-3 decode | ~1.1 MiB inlined FFmpeg WASM | MPL-2.0 wrapper; FFmpeg LGPL 2.1+. Encoder exists and is **not wired**. Dolby patent review remains an open public-distribution caveat. |

Issue #19 closeout is implementation-complete, not a public-distribution legal
sign-off. LGPL static-link / relink / source-offer work for the inlined AC-3
WASM is still unfinished. Expanding FFmpeg-derived WASM multiplies that work.

## Size bar

- AC-3's ~1.1 MiB lazy audio fallback is the current "acceptable" reference.
- The rejected Issue #19 Slice 6 converter core was ~32 MiB GPL. Anything in
  that neighborhood fails the size gate unless a separate budget is accepted.
- GPL encoder cores (x264, typical `ffmpeg.wasm` builds) are incompatible with
  the current MIT app + MPL/LGPL story.

## What would require a new license review

- Any additional FFmpeg-derived WASM (including a hypothetical MPEG-2 or DTS
  decoder).
- Any GPL core.
- Runtime-downloaded WASM.
- Wiring `registerAc3Encoder()` (also an architecture / Issue #16 ban).
- Forcing cross-origin isolation for one codec (app-wide, not a codec checkbox).

Patent-unencumbered-looking codecs (Opus, VP9, AV1, FLAC) still need
native-versus-fallback and container pairing proof. They are not automatically
"add to export."
