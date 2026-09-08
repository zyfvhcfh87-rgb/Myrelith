# App-owned caption review and field editing

This source checkpoint prepares caption authoring without connecting the new UI
components yet. It is separate from speech diagnostics and changes no speech
source, assets, schema, painter or export behavior. Full G3 browser, responsive,
pixel/export and production-build acceptance remain pending.

CaptionReviewController owns the pending CaptionEditSession while the editor is
subscribed. Its snapshot contains only bounded text summaries and an Apply
revision. Project replacement, generation changes, active-sequence navigation,
last unsubscribe, explicit cancel and failed reentrant publication dispose the
held session. StrictMode-style unsubscribe/resubscribe starts empty. Invalid
preparation preserves a valid old review; no-op preparation clears it. Replacing
a review invalidates its old Apply revision and releases its candidate. Apply
uses the existing exact captured-project/generation check and complete fresh
portable-project/history admission, then commits once. No parallel edit path or
UI-held project/descriptor copy is introduced.

Field edits validate one closed v1 field and value even for empty selections.
They preserve the remaining distinct cue fields across mixed selections. Null
removes only that field to restore inheritance. Explicit empty descriptors remain
distinct from absent overrides. Existing no-op descriptors preserve document,
cue, history and redo identity. Unknown bounded descriptors remain whole and
uninterpreted; a field edit rejects them until an explicit replacement/removal.

Style reviews show target, before and after supported values, inherited track
settings and preset, including a track-default edit on an empty track. Number
labels use the actual canvas-relative units. A whole-style removal differs visibly
from an explicit empty descriptor. Replacing/removing unavailable overrides adds
an exact loss count and an acceptance requirement. Before that acceptance, Apply
returns an explanation and preserves the pending review/history. Raw unknown keys,
values, versions and provenance are never copied into these UI summaries. Undo
restores the original stored intent after an accepted replacement.

Style and text previews share a total100-row limit. Each style row has four
strings capped at2,000 characters; only the first100 changed owners are described
and the omitted count is explicit. Text previews retain the existing100 rows /
10 cue items per side and shorten displayed cue text to240 characters. Original
cue preview descriptor copies remain charged to the existing retained-owner
ledger; style descriptions contain no descriptor payload.

The optional midpoint split generator uses the same exported scope-selection
authority as the pure batch planner. It places each split at the integer middle
frame and nearest valid whitespace boundary, reserves new identities through the
whole-project session, and sends explicit plans through normal batch review.
A cue without two frames/two words rejects the entire proposal. It does not guess
missing text or apply an edit automatically. Existing manual cue actions remain.

Validation:8 focused suites /124 tests,17 existing runner checks, `tsc -b`, and
whole-project lint pass. This covers actual cue/track snapshots, mixed fields,
inheritance, opaque loss, bounded omitted rows, one-edit undo, exact no-op
identity and the existing reentrant admission tests. The first style-preview
run's55 passes/1 failure is retained: its older test expected opaque removal to
Apply without the newly required loss acceptance; the test now verifies both
rejection before acceptance and successful accepted Apply. This was an own
behavior-expectation update, not a baseline issue. Earlier controller checkpoints
and final logs are retained. No production build or browser session ran here;
all heavy work remains scheduled through the supervisor's exclusive slot.
