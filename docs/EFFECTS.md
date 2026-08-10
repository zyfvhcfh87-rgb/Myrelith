# Effect stack contract

Issue #45 establishes the first durable visual-effect boundary. The contract is
deliberately small: an ordered, serializable descriptor stack plus one built-in
color adjustment proves persistence, history, capability fallback, and shared
preview/export evaluation before more effects are added.

## Durable descriptor

Each `Clip.effects` item contains exactly:

- `id`: globally unique stable instance identity;
- `type`: stable registry key;
- `version`: non-negative registry schema version;
- `enabled`: authored bypass state;
- `params`: bounded primitive JSON values.

Timeline schema 10 adds `version`. During 9→10 migration, the registry-owned
`builtin.color-adjust` descriptor advances from the reserved legacy version 0
to version 1 and receives missing defaults. Unknown types receive version 0.
Their type, enabled state, order, and complete parameter payload are preserved.
Current saves never substitute or delete unknown data.

`domain/effectBounds.ts` is the shared authority for descriptor shape and
budgets: 256 effects per clip, 10,000 per document, 256 parameters per effect,
50,000 parameters and 10,000,000 parameter-string characters per document,
plus bounded ids/types/keys, finite numeric magnitude, and 65,536 characters
per string value. Live add/parameter edits and portable validation call this
same contract. A rejected or idempotent edit returns the original document and
does not create history, so every accepted live state remains serializable.

## Registry and failure rules

`domain/effectStack.ts` owns the registry, defaults, validation, migration,
capabilities, and ordered Canvas2D evaluation. Resolution is deterministic:

1. unknown type or version → report `unsupported`, preserve and bypass;
2. invalid registered parameters → report `invalid`, preserve and bypass;
3. missing renderer capability → report `unsupported`, preserve and bypass;
4. disabled descriptor → report `disabled`, preserve and bypass;
5. otherwise → report `ready` and emit its operation in authored order.

The render worker probes the actual Program Monitor compositor context and
reports its capability through the bridge. The app projects ordered resolution
status into session state, and the Inspector only reads that projection; it
does not assume Canvas support or run another evaluator. Export probes its own
export-owned context through the shared compositor, so preview may report
unsupported even when a separate export context supports the effect (or vice
versa). Reorder, bypass, and remove remain available for opaque descriptors, so
unsupported data is never stranded.

## Built-in color correction

Issue #71 extends `builtin.color-adjust` version 1 without a timeline-schema
bump. Existing version-1 descriptors that omit `temperature` and `tint` remain
valid and interpret both as zero; round trips preserve the omission. New and
reset descriptors write all five defaults.

| Parameter | Range | Default | Operation |
| --- | ---: | ---: | --- |
| Exposure | -4 to 4 stops | 0 | multiply RGB by `2 ** exposure` |
| Contrast | -1 to 1 | 0 | scale RGB around 0.5 by `1 + contrast` |
| Saturation | -1 to 1 | 0 | scale RGB from Rec.709 luma by `1 + saturation` |
| Temperature | -1 to 1 | 0 | red gain / blue inverse gain, `2 ** (temperature * 0.5)` |
| Tint | -1 to 1 | 0 | magenta gain `2 ** (tint * 0.125)` and green gain `2 ** (-tint * 0.25)` |

An empty stack, a wholly bypassed stack, and a descriptor with all five
defaults are exact identity paths. The historical exposure/contrast/saturation
only case retains its ordered Canvas filter path. If any ready descriptor in
the stack has non-zero temperature or tint, every ready built-in color
descriptor runs in authored order through the reference pixel path so one
stack never mixes filter and pixel precision.

The pixel contract reads unpremultiplied 8-bit `ImageData` in the compositor's
display-referred sRGB context. It uses float64 JavaScript intermediates in the
table order for each descriptor, clamps RGB to `[0, 1]` after every descriptor,
and rounds to nearest 8-bit only at the end. Alpha is copied byte-for-byte.
Transparent RGB is still corrected, but unchanged zero alpha keeps it
invisible. Ordinary media/stills, complete procedural-text layers, and each
crossfade leg use the existing reusable isolation surfaces; correction happens
before clip opacity, transition weighting, and destination blend mode.

Preview, scrub/seek, and export consume the same composition plan and
`pipeline/render.ts` implementation. A context without Canvas filter or pixel
read/write support reports the exact missing capability, preserves the
descriptor, and bypasses only the unsupported operation. No presets ship in
this slice: the five bounded defaults plus existing enable, reset, reorder, and
remove controls are sufficient and avoid an unversioned preset contract.

## Video scopes

Scopes are session-only diagnostics over the completed preview composite; they
never enter `TimelineDoc`, history, recovery, or portable saves. The render
worker samples at most one 160 x 90 sRGB frame (14,400 pixels) every 250 ms,
after the frame has already been presented. It transfers that tiny sample to a
dedicated analysis worker, keeps at most one request pending, and never awaits
scope work from the render queue.

The worker produces 256-bin RGB/luma histograms, a 160 x 64 luma waveform, and
a 64 x 64 Rec.709 Cb/Cr vectorscope. Fully transparent samples are ignored;
partial alpha is premultiplied over black so the signal matches the displayed
preview background. Saturating 16-bit counters bound every result. Generation
checks discard disable/re-enable/close races. Disabling or closing shrinks and
releases the sample canvas, terminates the analysis worker, rejects pending
work, and clears UI data. Browsers without Canvas pixel access expose a visible
`Scopes unavailable` fallback instead of starting analysis.

## Editing and history

Pure domain operations add, enable/bypass, patch parameters, reorder, reset, and
remove descriptors. Every successful store action commits exactly one immutable
document snapshot; rejected and idempotent operations commit none. Reset changes
only registered parameters and retains unknown forward-compatible keys.

The Inspector uses native tabs, labels, checkboxes, ranges, and buttons. Arrow,
Home, and End keys move across tabs; every stack action has an explicit
screen-reader label and native keyboard activation. Add is disabled with a
visible/accessibly-associated reason whenever the selected clip or document
has no remaining effect budget.
