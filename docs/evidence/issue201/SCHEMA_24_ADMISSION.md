# Schema 24 caption persistence and admission

Review checkpoint, 2026-09-08. Built on the reviewed schema22/23 checkpoint
4340f9675ad56aa320f2498cf107fd55f8819568 (merge f94d3ac) and accepted explicit
shadow contract f32da76. This checkpoint stops before the painter/UI gate.

## Durable data

Timeline schema24 adds optional track/cue `style` and `origin`; project format8
is unchanged. Schema23 migration only increments the version. Omitted style and
origin stay omitted. No painter, preset geometry, shared text wrapping or shadow
parameters change here.

`captionIntent.ts` now owns the original style envelope bounds shared with origin:
24 primitive keys, 128-character keys/strings, finite numbers, 4096 serialized
UTF-8 bytes per descriptor. Ordinary own data only: no accessors, classes,
symbols, nested resources or toJSON execution. Checked copies are frozen. Unknown
versions or keys remain whole and unavailable; apparently known fields are not
partially interpreted. Serialization copies both descriptor levels, including
dormant sequences. Full-file validation and live sequence admission reject
malformed known fields and aggregate intent over 2 MiB per project.

Origin version1 is complete, not a partial patch. Track params are runId, modelId,
modelRevision, manifestDigest, runtimeVersion, language, sourceAssetId,
sourceFingerprintAlgorithm, sourceFingerprintDigest, sourceSampleRate,
sourceStartSample, sourceSampleCount and targetFrameOffset. Cue params are runId,
sourceStartSample and sourceSampleCount. A model revision is an immutable
40-hex upstream commit or `composite:<64-hex manifest digest>`; the latter must
match manifestDigest. This supports the separately reviewed explicit local
composite without claiming one upstream revision for all files. Model ID is a
bounded repository identity. Digests are lowercase SHA-256; rates, samples and
offsets are safe integers, sample endpoints must remain exact. The fingerprint
algorithm is explicit sampled/full SHA-256. Known cue origins require a track
run and a contained source span. Unavailable parent/cue origins are preserved
without interpreting an unknown relationship. Historical source assets need not
remain connected or present in the media catalog.

Manual text/timing changes and splits retain historical origin. Compatible known
merges preserve one run and the union of historical source sample coverage. This
is historical coverage, not newly estimated word timing or accuracy. Opaque
origins/styles can merge only when their complete primitive descriptors match
(including after reopen); different or mixed origins reject. Single and batch
merge use the same authority. Duplicate sequences remap caption entity IDs while
preserving style/origin and historical run identity. Caption ID allocation checks
every sequence and entity category, including dormant owners; retry loops are
bounded. Split store actions also reject an already reserved project ID.

## Retained owners and one Apply

`captionIntentBudget.ts` counts every style/origin occurrence in current project,
complete candidate, all past/future snapshots and registered app owners. No
shared-reference deduplication is assumed. The 32 MiB cap is checked before redo
clearing or owner replacement. Owner replacement temporarily charges both the
old and proposed owner. Rejection preserves both history branches and the old
review/owner. Undo/redo validates retained payload and its destination; it moves
an existing snapshot rather than inventing a second candidate occurrence.

`CaptionEditSession` pins whole project identity, replacement generation and
active sequence. It owns a captured project, one proposed project and bounded
copied before/after rows; every held occurrence is registered in the state
ledger. A new project does not erase that ledger while an asynchronous import or
review still holds old data. Apply, cancel or dispose releases the actual owner.
The later UI must dispose the returned session when its dialog closes. There is
no caption clipboard feature at this checkpoint; the same registry admits any
future app-owned clipboard occurrences before capture.

Prepare accepts caption-only document changes, validates the whole candidate and
complete media/collection file, and retains a bounded review. Batch scope remains
stable IDs. Replaced/no-op reviews cannot apply an old proposal. Apply repeats
currentness, complete current file serialization and store retention before one
history mutation. A changed media descriptor can therefore invalidate an earlier
valid preview. Style edits copy checked input; they do not mutate shared values.

The existing SRT/VTT import controller now uses this whole-project path and a
bounded full-project ID pool. It no longer reports success when the store refuses
a mutation. Parsed ASS imports can prepare one new lane with an exact loss report
and explicit acceptance before Apply; malformed/font-decision results create no
lane and release ownership. SRT/VTT download rejects new style/origin loss unless
explicitly accepted. Existing legacy preset-only export remains unchanged. This
checkpoint exposes those app contracts, not new UI controls. ASS export from raw
legacy presets awaits the shared resolver/painter gate; the accepted pure full-
resolved ASS exporter remains unchanged.

## Validation scope

Focused tests cover schema23 omission, known/future round-trip, immutable copies,
origin ranges/composite identity, single/batch merge, split/duplicate/reopen,
project-wide identity reservation, exact 2 MiB and 32 MiB boundaries (one byte
over rejects), complete real dormant/history/clipboard occurrences, capture
pressure, redo preservation, stale project/generation/navigation, no-op review
invalidation, Apply after media-envelope growth, explicit ASS loss acceptance,
and plain subtitle style/origin loss. Real near-limit portable files exercise the
10,000,000-character authority; these are not active-document projections.

Validation: 17 focused Vitest files / 311 tests, all 17 bundled runner checks,
build/typecheck and lint pass. Vite retains its existing large-chunk advisory.
An initial test command
omitted DEVELOPER_DIR, so two bundled runner checks hit the host Xcode license
prompt; the command is rerun with the existing Command Line Tools directory.
No agreement or host license setting was changed.

No production UI, browser pixel, accessibility, styled preview/export parity,
full-suite or speech qualification is claimed here. Rich-style preview fallback
and burned-in export availability remain required at the following painter/UI
phase; do not treat this intermediate schema checkpoint as release-ready. No
speech model/runtime dependency, graph or laboratory harness changes are included.
