# Issue #201: independent static style contract

Date: 2026-09-08. Pure envelope/resolution foundation only. No schema fields,
migrations, painter changes, stores or UI import this new module yet.

`captionStyle.ts` implements the planned versioned primitive envelope: two exact
data fields, positive safe-integer version, at most 24 parameters, 128-character
keys/string values, finite numeric values, and 4 KiB actual serialized UTF-8.
It reuses the browser-free UTF-8 byte counter rather than TextEncoder. Inspection
reads plain own data properties without invoking getters or a serialization hook;
it rejects symbols, classes, accessors, nested values and extra envelope fields.
It returns a frozen primitive copy, leaving the source intent untouched.

The closed v1 vocabulary validates the six existing generic font families,
normalized size/margins/outline bounds, booleans, horizontal/vertical alignment,
and canonical lowercase eight-digit RGBA colors. Unknown versions or unknown
parameter keys remain serializable within the bounded envelope. Their **entire
override** is unavailable; apparently recognized values from that override are
not partially applied or rewritten. Known v1 data with only known keys must pass
all value validators.

The pure combiner merges supported track values then cue values and returns
unavailable-level reports. Absent overrides produce no fabricated defaults.
Preset/layout/painter resolution is deliberately still unwired, so this foundation
does not change legacy caption pixels or claim preview/export acceptance.

The approved 2 MiB project / 32 MiB retained-intent constants are declared for the
later owner admission. This foundation does **not** claim that those aggregate
limits are already enforced across project history/clipboard/preview. Whole-owner
collection/admission remains required before schema 24 and editing integration.

Validation:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage npm test -- src/domain/captionStyle.test.ts src/domain/captionAssTime.test.ts src/domain/captionFiles.test.ts src/domain/captions.test.ts src/domain/documentMemory.test.ts src/test/architecture.test.ts --maxWorkers=1
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run build
npm run lint
```

**6 files / 86 tests and 17 repository runner checks passed**. Build/typecheck
and lint passed; Vite retains its large-chunk advisory. Cases include supported
values, unknown-version/key preservation and whole-override bypass, precedence,
non-finite/nested primitive rejection, key/value/count/UTF-8 limits, escaped JSON
growth, accessor nonexecution and null-prototype data. No browser gate is claimed.
