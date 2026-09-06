# Gate 3: spatial effects and blend modes

Accepted locally on 2026-09-06. The first measurement is preserved in
`pixel-candidate-measurements.json`; subsequent browser runs attach separate
reports with source hashes instead of overwriting that evidence. The limits
were committed in `pixel-effects-preregister.md` before implementation/timing.

## Durable and pixel contracts

All five new descriptors are version 1, source-layer and post-composite safe.
Numeric parameters are animatable, with their registry bounds enforced before
execution. Unknown parameter keys and unsupported descriptor versions retain
the existing preservation/bypass behavior. Default stacks are exact identity.
Pixel execution uses straight RGBA8 with alpha-weighted sRGB neighborhoods;
these are intentionally not linear-light filters. Outputs round to the nearest
integer and clamp to RGBA8. All effects stay within the project canvas.

| Descriptor | Bounds and exact behavior |
| --- | --- |
| `builtin.box-blur` | Radius 0–32 project pixels, default 0. Separable uniform box, clamped edge samples. Sum alpha-weighted channels, divide by alpha, quantize after each axis. Zero resulting alpha has zero RGB. |
| `builtin.sharpen` | Amount 0–2, default 0. Alpha-weighted center/left/right/up/down mean; output `C + amount * (C - mean)`, preserving center alpha. Edges clamp. Transparent centers clear RGB. |
| `builtin.vignette` | Strength 0–1 (default 0), clear radius 0–0.99 (0.5), softness 0.01–1 (0.5). Pixel-center coordinates normalize each axis to −1…1; distance is `sqrt((x²+y²)/2)`. With `t = clamp((distance-radius)/softness)`, multiply channels by `1-strength*t²*(3-2*t)`. Alpha is unchanged. |
| `builtin.drop-shadow` | Radius 0–32 (8), offsets −64…64 (8 each), opacity 0–1 (0), RGB hex color (black). Blur original alpha with zero edge padding, rounding horizontal alpha to RGBA8; translate, multiply opacity, then composite the source over that colored coverage. No hidden source RGB enters the shadow. |
| `builtin.outline` | Width 0–32 (0), opacity 0–1 (1), RGB hex color (black). Square max-alpha dilation with zero edge padding. Background coverage is `max(0, dilatedAlpha-sourceAlpha)*opacity`; composite the source over that coverage. This is a square silhouette, not a Euclidean-distance stroke. |

Radius and offsets round separately after scaling by output/project dimensions.
Reduced preview sharpen uses bilinear one-project-pixel cross samples: neighbor
weights are the axis scale and the center weight is `5-2*sx-2*sy`. Preview is
bounded at project size; original-resolution export uses the exact one-pixel
cross. Vignette is normalized to the output dimensions. Crop and transform
browser utilities reset the existing canonical fields through the atomic
attribute operation; no competing geometry descriptor is introduced.

The new blend modes use the existing sRGB/alpha oracle: darken is `min(b,s)`,
lighten `max(b,s)`, difference `abs(b-s)`, exclusion `b+s-2*b*s`. Unsupported
Canvas setters and thrown probes preserve the source-over fallback.

## Evidence and limits

Independent full-image reference implementations test streaming blur, sharpen,
shadow and outline, including single-row/column images, large radii, partial
alpha and hidden RGB. Blur of `[red opaque, blue transparent, blue transparent]`
at radius 1 is exactly `[255,0,0,170; 255,0,0,85; 0,0,0,0]`. A 3×3 white vignette
at strength 1, radius 0, softness 1 has corner `[66,66,66,128]` when that corner
starts at alpha 128; the center stays white. Identity is byte-exact, including
hidden RGB, and allocates no algorithm scratch.

All 36 preregistered Chromium timing rows passed. Maximum single-effect p95 was
27.7 ms at 720p, 30.4 ms at 1080p and 125.8 ms at 4K. Eight maximum-radius blurs
took 108.8/241.6/983.5 ms; the five-effect plus three byte-echo stage microbenchmark
took 56.5/123.8/491.8 ms. These are host measurements for bounded offline work
and scaled preview, not full-resolution real-time playback guarantees.

Largest algorithm scratch at 4K was 810,372 bytes for outline, below 1 MiB.
Blur keeps one RGBA line, sharpen three rows, shadow an alpha ring and column
sums, and outline monotonic alpha deques. Scratch becomes unreachable on return;
there is no persistent cache or full-frame spatial-effect clone. The optional
pixel-visit counters describe bounded processing passes, not exact instruction
counts. Caller readbacks, Canvas storage and transactional plugin buffers are
additional: the mixed microbenchmark can hold caller, working, input and output
RGBA arrays. It does not measure the plugin sandbox or establish bus admission.

215 focused tests across 11 files and all 17 repository runner checks pass,
as do build/typecheck and lint. Six muted Chromium acceptance tests pass:
the previous attribute/preset flows, all five spatial effects through the real
compositor (RGBA tolerance 2), eight blends with alpha/opacity, new-mode text and
same/mixed transitions, and a locally installed audited invert plugin followed
by vignette. That stack saves/applies as a preset and exports through the real
prepared plugin path; reopening the encoded MP4 differs by at most 8 RGBA code
values, the separately declared lossy-codec tolerance. Pixel readback contexts
now request `willReadFrequently` where repeated processing needs it. Narrow
Inspector content is bounded and long plugin labels wrap.

Full-suite acceptance and track/master ordering/resource proof remain pending.
