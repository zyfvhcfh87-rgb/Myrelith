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

## Built-in color adjustment

`builtin.color-adjust` version 1 has three numeric parameters:

| Parameter | Range | Default | Canvas2D mapping |
| --- | ---: | ---: | --- |
| Exposure | -4…4 stops | 0 | `brightness(2 ** exposure)` |
| Contrast | -1…1 | 0 | `contrast(1 + contrast)` |
| Saturation | -1…1 | 0 | `saturate(1 + saturation)` |

Filters concatenate top-to-bottom in authored order. They operate in the
browser's Canvas2D sRGB filter model on the source layer before clip opacity and
destination blending. Preview, scrub/seek, and export consume the same video
composition plan and `pipeline/render.ts` compositor, so no second effect
implementation exists.

An empty or wholly bypassed stack does not write Canvas filter state. Media
effects need no intermediate surface. Procedural text paints its complete
background/outline/fill layer unfiltered into the existing leg surface, then
filters the single destination `drawImage` before opacity/blend. Text and
crossfade legs reuse the same caller-owned bounded surfaces already required
for isolation; every borrow is cleared in `finally`, and decoded frames retain
their existing single owner.

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
