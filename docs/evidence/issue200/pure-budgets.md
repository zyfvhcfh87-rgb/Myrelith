# Issue #200 — independent pure budget completion

Date: 2026-09-08. Parent/source integration:
`b0e43ed449719fe3e424a46cd97d384b6a11cf1a`, branch `codex/issue200`.
The orchestrator accepted G1a `381836f` and authorized this bounded completion
while #199 implements schema22. The branch fast-forwarded cleanly to the exact
accepted integration. This adds no product-phase approval or runtime wiring.

## Concrete API

`src/domain/titleBudgets.ts` adds two pure functions:

- `titlePayloadBudget({ title, titleTracks? })` accepts boundary-admitted immutable
  title/track data. It returns serialized UTF-8 bytes, track count and key count,
  or a rejection reason. Complete title JSON plus nonempty track-array JSON must
  fit **1 MiB together**. Empty and absent track arrays both add zero bytes.
- `retainedTitleDataBudget({ candidate, current, past, future, clipboards })`
  accepts expanded-owner projections for all sequences and title, element and
  key clipboard roots. It returns retained serialized-data pricing or rejection.
  It checks the candidate alongside current and both history branches before
  callers clear redo or replace clipboard ownership. It never mutates inputs.

`TitleTrackBudgetData` is only a structural key-array projection. #199 owns the
actual track declaration, value/easing/frame/source checks, semantic uniqueness,
availability, interpolation and global key accounting. The helper uses the
canonical `MAX_KEYFRAMES_PER_TRACK`; it adds no animation implementation.
Budget success alone never establishes schema validity or renderability.

Callers must retain the actual immutable payload/track/key references when
creating projections. Copying those records for measurement would lose sharing
and count independently retained data. Current project, dormant sequences,
past/future and clipboards all need complete projections. Compact legacy text
has no expanded owner entry: its existing file/text/history bounds apply.
Actual schema23 traversal must establish that coverage and exemption in tests.

## Accounting model and bounds

Per-owner admission sums the actual JSON byte sizes of the title definition and
nonempty track array. This is an explicit payload metric, not a prediction of
the enclosing project wire format. Project serialization separately checks the
existing 10,000,000-character ceiling with all real wrapper/metadata fields.
There is no fixture-derived upgrade allowance or implicit wire mutation.

Retention prices twice each JSON UTF-8 contribution. Each distinct immutable
object/array owns its braces/brackets, keys, separators and primitive field
data; shared nested objects are counted once across the complete graph. Equal
but separately allocated objects count independently. Primitive strings in
different fields are conservatively charged separately, without guessing engine
interning. This is conservative serialized-data admission, **not JavaScript heap
or browser memory**: it excludes object headers, allocator metadata, stores,
media, layout, surfaces and GPU allocations.

The total must fit **64 MiB**. Original title, track and clipboard roots are
measured with a call-local reference set and root-size cache, both discarded on
return. No persistent mutable cache or retained runtime resource is introduced.
The owning caller gets one success or one failure and retains its current state
on failure; this module cannot prune history or clear redo.

Declared bounds are checked before walking key contents: 256 tracks/title and
the canonical 1,024 keys/track. Each snapshot projection is at most 100,000
expanded owners; past plus future keep the inherited 100-history-entry bound.
Element/key clipboard projections allow up to 100,000 data roots, while the
aggregate retained-data cap also applies. Individual clipboard roots must fit
the same bounded JSON size/shape checks.

The size walker inspects descriptors without invoking getters or `toJSON`,
counts escaped/multibyte JSON accurately, rejects unsafe/non-JSON shapes and
limits depth to eight, individual strings to 20,000 code units and keys to 128.
Its entry ceiling is bounded by the 1 MiB metric and admits a legal 1,024-key
track. It does not replace or loosen `readTitleDefinition`'s stricter 4,096-entry
opaque-title boundary. No full payload string is allocated to measure it.

## Validation

The focused command ran with private dependencies and
`DEVELOPER_DIR=/Library/Developer/CommandLineTools`:

```sh
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/domain/titleBudgets.test.ts src/domain/titleElements.test.ts src/domain/documentMemory.test.ts src/test/architecture.test.ts --maxWorkers=2
NODE_OPTIONS=--no-experimental-webstorage npm run build
npm run lint
```

Final logs: [focused tests](budget-tests.log), [build/typecheck](budget-build.log),
[lint](budget-lint.log), with trailing whitespace/blank EOF lines normalized after
the first staged diff check flagged generated-log formatting.
**4 files / 39 Vitest tests and 17 runner tests passed**;
build/typecheck and lint passed. Vite retains its existing large-chunk advisory.
The new budget file contains 13 focused tests. The first pass also succeeded;
an additional count-before-scan/nesting case brought the final total to 39.

Boundary fixtures compute real JSON sizes instead of hardcoding expansion costs:

- Exact 1 MiB accepted; one byte over rejected. Adding tracks consumes the same
  per-owner allowance. A 1,024-key track is admitted; 1,025 keys or 257 tracks
  reject. Future versions and dangling targets still contribute all data.
- Escaped NULs, multibyte characters, emoji and lone surrogates match actual
  JSON UTF-8 lengths. Non-executing hostile-data and depth cases reject.
- Shared title/track/element/key records across current/history/clipboards count
  once. Separate equal copies and changed element shells incur their own costs.
- Exact 64 MiB across candidate/current/past/future/title clipboard is admitted.
  The next representable two priced bytes reject. Omitting the retained future
  branch would make that candidate pass, demonstrating why it must be counted
  before clearing redo. The helper leaves that branch and clipboard untouched.
- Legacy-only empty projections with 100 total history entries cost zero.
  This is helper evidence; production legacy projection/store proof is pending.

Architecture and committed diff checks are required with this bounded commit.
No full-suite, audit, browser, pixel, export or performance acceptance is claimed.
No exclusive heavy-validation slot was needed. Existing runtime code does not
import the helper; it is absent from the inspected production bundle.

## Dependency state and required follow-through

#199 received both the proposed and refined signatures in plain text. Schema22
remains its responsibility. G1b/schema23 waits for the committed reviewed shared
foundation; Clip, store, renderer, UI and migration files remain unchanged by
this completion. All-sequence logical-element/text/global-key counters, actual
parser/serializer/recovery/store/undo exact-boundary proofs, title upgrades and
all pixel/browser/export gates remain mandatory. Template library retention is
a separate explicit 8 MiB/100-template allowance and is not implemented here.
