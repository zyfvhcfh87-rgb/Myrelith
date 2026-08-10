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

## Registry and failure rules

`domain/effectStack.ts` owns the registry, defaults, validation, migration,
capabilities, and ordered Canvas2D evaluation. Resolution is deterministic:

1. unknown type or version → report `unsupported`, preserve and bypass;
2. invalid registered parameters → report `invalid`, preserve and bypass;
3. disabled descriptor → report `disabled`, preserve and bypass;
4. missing renderer capability → report `unsupported`, preserve and bypass;
5. otherwise → report `ready` and emit its operation in authored order.

Inspector status text exposes these outcomes. Reorder, bypass, and remove remain
available for opaque descriptors, so unsupported data is never stranded.

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
effects need no intermediate surface. Text and crossfade legs reuse the same
caller-owned bounded surfaces already required for isolation; every borrow is
cleared in `finally`, and decoded frames retain their existing single owner.

## Editing and history

Pure domain operations add, enable/bypass, patch parameters, reorder, reset, and
remove descriptors. Every successful store action commits exactly one immutable
document snapshot; rejected and idempotent operations commit none. Reset changes
only registered parameters and retains unknown forward-compatible keys.

The Inspector uses native tabs, labels, checkboxes, ranges, and buttons. Arrow,
Home, and End keys move across tabs; every stack action has an explicit
screen-reader label and native keyboard activation.
