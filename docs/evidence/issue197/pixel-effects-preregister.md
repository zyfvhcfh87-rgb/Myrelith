# Pixel-effect candidate gate — preregistered 2026-09-06

Recorded before implementing or timing the new pixel candidates. These are
acceptance limits, not achieved measurements. The existing compositor and
plugin runtime remain the authority for stage order and ownership.

## Candidates and semantics to test

- Box blur: separable uniform kernels, radius 0–32 authored project pixels.
  Sample centers and clamp at the canvas edge. Sum alpha-weighted sRGB color
  and alpha, then unpremultiply; quantize RGBA8 after each axis. A zero radius
  is exact identity. Scale each axis radius into the preview raster.
- Sharpen: alpha-weighted local neighborhood, preserve center alpha, bounded
  amount 0–2; no hidden-RGB contribution. Zero amount is exact identity.
- Vignette: multiply sRGB channels by a bounded radial falloff; preserve alpha.
  Normalized center/ellipse coordinates make preview scale independent. Zero
  strength is exact identity.
- Drop shadow: bounded alpha-derived shadow under the source; zero opacity is
  exact identity. Offset and blur use authored project pixels. No expansion of
  the project canvas. Alpha-neighborhood work must exclude hidden RGB.
- Outline: bounded alpha-derived outer silhouette under the source. Zero width
  or opacity is exact identity. Width uses authored project pixels; clipping
  stays at the project canvas edge.

Each promoted implementation must define its exact formula, parameter bounds,
edge rule, alpha/rounding behavior, allowed stages and reference pixels in the
final evidence. Independent small-image reference computations must match
exactly where integer math permits; Canvas roundtrips may differ by at most
2 RGBA8 code values due to premultiplication. Encoded export has a separately
reported codec tolerance and cannot substitute for compositor equality.

## Timing and scratch acceptance

Use muted headless Chromium on this host and record browser/host provenance.
Use deterministic nonuniform RGBA fixtures with transparent and partial-alpha
regions at 1280×720, 1920×1080 and 3840×2160. Include both representative and
maximum admitted parameter settings, two warmups then at least ten samples.
Keep setup/reset outside the timed region; time the complete effect executor.

| Raster | Single-effect p95 ceiling | Eight-stage repeated/mixed p95 ceiling |
| --- | ---: | ---: |
| 720p | 40 ms | 320 ms |
| 1080p | 90 ms | 720 ms |
| 4K | 360 ms | 2880 ms |

These ceilings qualify bounded CPU processing for scaled preview/offline
export; they do not claim full-resolution real-time playback. Record all
samples and identities, including failures. No increasing limits after seeing
measurements. Narrow or defer a failing candidate with explicit evidence.

Additional algorithm scratch must remain at most 1 MiB per active executor at
each tested raster, independent of stack length. No full RGBA frame clone for
a spatial built-in. Expose deterministic peak scratch/work counters and prove
no retained buffers after the call or identity-path allocation. Count scratch
separately from the caller's readback and existing compositor surfaces.

Repeated and mixed built-in/plugin ordering must use the shared stage executor,
including an actual installed trusted fixture for final browser parity. A
byte-echo executor is permitted only as a labeled stage/scratch microbenchmark;
it cannot establish plugin-runtime acceptance. Count its working copy and
input/output bytes explicitly. Baseline plugin and lens allocations must not
be hidden inside a new effect's scratch claim. Gate 4 still requires the full
simultaneously live surface/array proof before any track/master schema or UI.

Blend candidates are darken, lighten, difference and exclusion. Compare every
mode with the sRGB/alpha oracle under transparent/partial/opaque inputs and
opacity; verify concrete-context rejection and exception fallback. Include
same/mixed-mode transitions and text in the shared renderer/browser checks.
