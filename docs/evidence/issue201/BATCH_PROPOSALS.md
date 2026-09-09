# Issue #201 pure caption batch proposals

`captionBatch.ts` implements selected/following/all scopes using stable cue IDs,
with atomic shift, rational stretch, explicit frame/text split plans, adjacent
touching merge, bounded literal replacement and locale-independent Unicode case
mapping. It returns rejected, unchanged or a fully caption-validated candidate.
No history, currentness check or project mutation lives in this pure module.

Timing uses integer frames; signed BigInt floor/ceil handles both sides of a
stretch anchor. Invalid frame ranges, overlaps, selections, split plans, reserved
IDs, expanded text or incompatible merge intent reject before a candidate is
exposed. The project-wide reserved identity set is a required caller argument;
the planner adds every current-document caption identity locally. The future
app boundary must derive that set from every sequence and revalidate before Apply.

No-op results retain exact document identity; successful candidates retain
unaffected tracks/items and preserve additional immutable cue fields. Supported
track/cue override combinations must agree before merge. Unknown descriptors and
other future metadata use conservative reference compatibility so they cannot
be silently discarded. Complete schema24 provenance compatibility and preset
fallback equivalence still require their reviewed integration; this conservative
proposal boundary may reject equivalent but separately represented intent.

Previews retain at most100 rows and10 before/after items per row, with exact
omitted counts even for a large merge. Reading speed counts Unicode code points,
including spaces and excluding newline characters;17CPS is a configurable
advisory, not a universal quality/accessibility guarantee.

Validation: eight focused caption files /138 tests and17 repository runner
checks passed. Build/typecheck and lint passed, with the Vite chunk advisory.
An initial TypeScript never-return narrowing issue and a mistaken test count
for one emoji/newline example were corrected. The implementation counted five
characters correctly; the test originally expected six. No full-suite or browser
claim is made. App currentness, whole-project and32MiB retained admission, single
undoable Apply and accessible editor preview remain required follow-up work.
