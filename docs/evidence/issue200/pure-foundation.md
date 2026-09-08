# Issue #200 — G1a pure title foundation

Date: 2026-09-08. Parent: `1e23f14bc4aeebeeb26f10d0847abb6a30d7ecb9`.
Branch: `codex/issue200`; original baseline: `ce91074c276ca6892a74addb7dd673b9a19c7eeb`.
Scope approved by the orchestrator after review of the amended G0 commit:
independent pure title types, static validation and scalar adapters with tests.
The implementation is in `src/domain/titleElements.ts`; its focused test file
is `src/domain/titleElements.test.ts`. The orchestrator accepted its exact commit
`381836fa3b45d83f7b7c1f932413b6ac067a154a` after independent checks. Combined
foundation `b0e43ed449719fe3e424a46cd97d384b6a11cf1a` was then fast-forwarded into
this branch. See [independent budget completion](pure-budgets.md); G1b still
depends on the separately reviewed shared schema22 implementation.

## Concrete API for #199

| Export | Contract |
| --- | --- |
| `TitleElement` | Readonly supported v1 text, rectangle or ellipse discriminated union. |
| `readTitleElement(unknown)` | `supported` with a defensive data copy; `unsupported` with preserved bounded future intent; or `invalid` with a reason. |
| `readTitleDefinition(unknown)` | Validates the entire bounded envelope, 1–16 ordered v1 elements, unique element IDs and aggregate known text. A supported v1 container may contain unsupported elements. |
| `titleElementValidationError` / `titleDefinitionValidationError` | Return a reason only for invalid input. `null` means admissible data, including unsupported future intent; it does not imply renderability. |
| `TITLE_ANIMATION_PROPERTIES` | Frozen 13-property vocabulary from the reviewed plan. |
| `titleAnimationPropertySpec(element, propertyVersion, property)` | Available per-kind bounds, units, step, version and exact authored fallback, or an unavailable reason. Text box minima account for static padding. |
| `readTitleAnimationProperty(element, propertyVersion, property)` | Reads the exact authored scalar or returns unavailable. |
| `applyTitleAnimationValues(element, values)` | Returns one immutable resolved element or rejects the entire batch. Duplicate properties are rejected regardless of version before values are interpreted. |
| `titleFontValidationError` / `resolveTitleFont` | Validate literal family intent and report explicit generic/fallback or unavailable status without probing or fetching fonts. |

The scalar adapters consume supported, boundary-parsed `TitleElement` data.
They do not reparse the entire envelope on each frame. For example:

```ts
const parsed = readTitleElement(candidate)
if (parsed.status === 'supported') {
  const property = titleAnimationPropertySpec(parsed.element, 1, 'position-x')
  if (property.status === 'available') {
    // The shared animation authority resolves keys using this authored fallback.
    const resolvedValue = property.fallback
    const result = applyTitleAnimationValues(parsed.element, [
      { propertyVersion: 1, property: property.spec.property, value: resolvedValue },
    ])
    // Consume result.element only when result.status is 'applied'.
  }
}
```

`step` is editing metadata; readers and apply never quantize a value. For text,
`box-width` and `box-height` have `min = max(16, 2 * paddingPx)` and
`minExclusive = (2 * paddingPx >= 16)`. A width equal to twice the padding is
invalid. A batch that changes opacity and then supplies invalid box geometry
returns only rejection and leaves the authored input unchanged. Empty or
unchanged valid batches retain the original reference.

#199 must enforce semantic `(elementId, property)` track uniqueness across all
property versions at its owning boundary, before calling these per-element
adapters. A lone future property version remains preserved and unavailable;
these adapters do not create, discard, evaluate or serialize tracks. They do
not implement interpolation, easing, source ticks or temporal editing.

## Boundary and compatibility behavior

Supported text retains the existing `TextProps` style fields and validator;
font intent is a separate family/fallback pair. The pure reader preserves
empty/Unicode/control-character content, fractional values, zero scale,
anchors, crop and flips when valid. This is data compatibility evidence only;
legacy painter and pixel parity remain later gates.

Both shape kinds share bounded box/fill/outline fields. Current known versions
have strict fields and finite geometry. Unknown versions/kinds have a complete
minimum element header and remain opaque; future definitions require a valid
version and bounded JSON. Their finite numeric payload is not interpreted as
current geometry. Unknown objects are retained by reference and must be treated
as immutable by consumers; unsupported output must never be cast to v1.

The common envelope bounds serialized UTF-8 JSON to 1 MiB, nesting to eight
levels, total entries to 4,096 and individual strings to 20,000 code units.
Known v1 titles additionally limit total text to 80,000 code units, including
disabled text, and element IDs remain unique across supported/future elements.
Descriptor inspection rejects accessors without invoking them, hidden/symbol
fields, cycles, sparse/extended arrays, nonplain objects, non-JSON values,
unsafe keys and excessive envelopes. Escaped and multibyte content count by
their serialized UTF-8 size, not the original string length.

Font resolution implements the approved compatibility slice: six supported
generic families return `platform-generic`; unknown named intent returns
`unavailable` until a supported generic fallback is explicit. Resolution retains
the requested name and honors a persisted fallback without automatic upgrades.
This is an intent decision only, with no claim of cross-platform font-byte or
pixel identity. Actual main/worker/export status and parity await G2.

No existing `Clip`, `TextProps`, animation, schema/migration, store, renderer,
UI or package file changes in this gate. Existing runtime modules do not import
the new file. The production bundle contains none of its inspected identifiers
or unique messages. Timeline schema stays 21 and project format stays 8.

## Checks

Commands ran in the issue200 worktree with
`DEVELOPER_DIR=/Library/Developer/CommandLineTools` and private dependencies.

```sh
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/domain/titleElements.test.ts src/domain/textOverlay.test.ts src/domain/textLayout.test.ts src/test/architecture.test.ts --maxWorkers=2
NODE_OPTIONS=--no-experimental-webstorage npm run build
npm run lint
git diff --check
```

- Focused result: **4 files / 30 Vitest tests passed**, followed by **17 canonical
  runner tests passed**, exit 0. The new title file has 16 tests. These cover
  hostile/future boundaries, exact style preservation, fonts, every scalar
  mapping, fractional values, padding coupling and mixed-version duplicates.
- Build: TypeScript and production Vite build passed. Vite emitted the existing
  large-chunk advisory; this pure module is not in the runtime import graph.
- Lint: passed without warnings after fixing an intentional sparse-array fixture
  to construct its hole without a lint-warning literal.
- Initial typecheck found a literal-inferred default numeric bound and an
  insufficiently narrowed test assertion. Explicit numeric parameter types and
  a discriminated-result-compatible assertion fixed both; final build passed.
- Architecture tests passed. Repository/bundle searches found no new module
  imports or its unique runtime strings. Diff whitespace check passed.

No full-suite, production audit, browser, pixel, export or performance acceptance
was run or claimed for this independent pure gate. No exclusive validation slot
was needed. Those issue completion gates remain mandatory.

## Next gate obligations

After API review, #199 may consume the pure foundation in timeline schema 22.
G1b then introduces title ownership as schema 23 only after that shared foundation
is approved. It must implement actual all-sequence/track/retained-data accounting
and the real parser/serializer/store/undo boundary tests in the amended plan.
The pure 1 MiB title envelope does not yet count external animation tracks.

Unused new collections and implicit legacy-v1 metadata must remain omitted on
save. Compact legacy text keeps its inherited 10,000,000-character serialized
snapshot ceiling, 10,000,000-character project text budget and 100-history-entry
bound. The proposed 64 MiB retained expanded-title quota is not implemented here
and must not be applied retroactively to ordinary legacy edits. The measured
386-character upgrade projection is fixture evidence, never a runtime constant.

All unchecked issue #200 product acceptance criteria remain open.
