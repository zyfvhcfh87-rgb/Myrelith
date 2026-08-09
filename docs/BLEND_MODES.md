# Blend mode and compositing contract

This is the normative Part 6c contract for ordinary visual clips, procedural
text, and visual crossfades. The browser-free model lives in
`src/domain/blendModes.ts`; preview and export both consume the resulting
`VideoCompositionPlan` through `pipeline/render.ts`.

## Serialized names and compatibility

- Timeline schema 9 writes one explicit `Clip.blendMode` string. The current
  allow-list is exactly `normal`, `multiply`, `screen`, and `overlay`.
- `normal` is the source-over-compatible default. Schema-8 migration adds
  `normal`, and historical in-memory clips with no field also resolve to it.
- A bounded string that is not on the allow-list is future/unsupported intent,
  not permission to substitute another artistic effect. Save, recovery, undo,
  and portable project round trips preserve it byte-for-byte while planning and
  rendering use `normal`. The Inspector shows the stored name, explains the
  fallback, and lets the user explicitly choose a supported name or Reset.

## Paint order, geometry, opacity, and clipping

1. The output begins with an opaque black source-over fill.
2. Visible video tracks paint in document array order; `tracks[0]` is the
   bottom layer. One track's active item is complete before the next begins.
3. Authored transform and normalized crop are resolved in integer-frame
   project space. Crop/clip coverage is part of the source layer: pixels
   outside it contribute no color or alpha and never affect the backdrop.
4. Clip opacity multiplies source alpha exactly once before the layer blends
   with the already accumulated backdrop. It does not change straight source
   color and is not applied again after blending.
5. Decoded media frames are already isolated source images. Procedural text is
   rendered source-over at full opacity into one cleared, transparent,
   output-sized scratch layer, including its background, outline, shadow,
   transform, and crop; that complete layer receives clip opacity and blends
   into the destination once.

## Alpha, blend functions, and color space

Inputs are straight RGBA sampled in declared Canvas2D sRGB. Blend functions
operate on non-linear sRGB channel values from 0 to 1. Composition uses
premultiplied-alpha source-over; transparent RGB never contributes. For
backdrop `Cb`, source `Cs`, backdrop alpha `ab`, and opacity-adjusted source
alpha `as`:

```text
normal:   B(Cb, Cs) = Cs
multiply: B(Cb, Cs) = Cb * Cs
screen:   B(Cb, Cs) = Cb + Cs - Cb * Cs
overlay:  B(Cb, Cs) = 2*Cb*Cs                 when Cb <= 0.5
                         1-2*(1-Cb)*(1-Cs)     otherwise

Cs' = (1-ab)*Cs + ab*B(Cb, Cs)
co  = as*Cs' + ab*(1-as)*Cb
ao  = as + ab*(1-as)
Co  = co/ao (or canonical transparent black when ao = 0)
```

Reference RGBA8 fixtures (`backdrop = 64,128,192,255`,
`source = 192,96,32,255`) are:

| Mode | Output RGBA8 |
| --- | --- |
| normal | `192,96,32,255` |
| multiply | `48,48,24,255` |
| screen | `208,176,200,255` |
| overlay | `96,97,145,255` |

The pure model and deterministic compositor fixtures are exact. Real
preview/export pixel comparisons permit at most one RGBA8 code value per
channel for browser rounding, while requiring the same plan, backend, layer
coverage, and source frames.

## Transition groups

A visual crossfade remains one isolated layer group:

1. Each complete transformed/cropped leg renders source-over into a cleared
   transparent leg surface with clip opacity applied.
2. The two premultiplied leg results are weighted by the authored transition
   envelope and added with Porter-Duff plus (`lighter`) into a cleared group
   surface. A missing leg keeps its weight; weights are never renormalized.
3. The complete group blends over lower tracks exactly once. It uses a
   non-normal mode only when both stored leg intents are the same supported
   name. Mixed modes or any unsupported name safely use `normal` for the group
   while the two clip records remain unchanged.

This prevents either transition leg from seeing the lower backdrop separately
and preserves the existing premultiplied-alpha dissolve contract.

## Capability, state, ownership, and parity

- Canvas2D maps the allow-list to `source-over`, `multiply`, `screen`, and
  `overlay`. The concrete context is probed at use time; the probe restores the
  incoming composite operation in `finally`. A rejected/throwing mode uses
  `source-over` without losing stored intent.
- `blendModeCapabilities.ts` selects Canvas2D first, then only an explicitly
  registered parity-verified WebGL implementation, then compatibility normal.
  No WebGL shader is registered in this slice because current Canvas2D covers
  the allow-list; the seam prevents an implicit or partially supported path.
- Every destination, text, leg, group, scale, and clear mutation is inside a
  save/restore `try/finally`. Text and transition scratch surfaces are borrowed
  from their preview/export owner, cleared before and after every borrowed path
  (including failures), never transferred, and never allocated per blend
  operation. Decoded frame ownership is unchanged:
  the source/lease owner releases frames after the shared compositor settles.
- Preview worker and export call the same planner and `compositeFrame`; neither
  reconstructs blend, opacity, transition, or fallback semantics.
