# Source proposal: preserve text when model timing exceeds coverage

This is source-only work authorized after runtime07. No new native build,
generated artifact, runtime attempt, or production enablement is claimed.
Runtime07 remains failed/incomplete in commit
`43714d72460156f3cf920282cb46686e8e9f74ef`.

## Diagnosis

The preserved whisper.cpp source, based on upstream
`371b5a7561823ab2bb32142d2751e35e7534727b`, clears results at full-call entry
(line 6841), clears prompt history with `no_context` (6953), starts seek from
the adapter's zero offset (6891, 7033), and clears decoder KV state (7195).
Repeated-call time-origin leakage is not supported by these paths.

The timestamp filters enforce pairing, the initial timestamp limit, and
monotonicity (6317–6360), without a remaining-audio upper bound. Segment
construction adds the current internal seek to a timestamp token (7693) or
the decoder's seek delta (7744), without checking the final endpoint against
seek_end. This explains how later internal seeks can overhang even inside
a full 30-second outer window. Runtime07 recorded strict `-944` at outer
window 50–80s, but did not record its exact internal seek or offending token.
No precise-token diagnosis or reset fix is claimed.

## Contract change

The new source under `scripts/issue201/whispercpp-untimed-review` copies only
the adapter, protocol, and cancellation-aware laboratory worker that change.
Earlier source and evidence remain frozen. No upstream decoder changes.

- Native status 0 still means fully validated timed segments. The exact
  coverage predicate remains `t1 <= sample_count / 160`.
- Native status 1 means the entire window requires untimed review because
  coverage failed. Validation still scans every segment. Count, ordering,
  positive duration, text, token, deadline, and resource errors remain fatal;
  an early coverage failure cannot conceal a malformed later segment.
- Status 1 makes both timestamp getters return the unavailable sentinel for
  every segment. Text remains accessible only after complete validation.
  The protocol requires those sentinels, validates UTF-8/pointers/aggregate
  text limits, and emits `{ timing: 'unavailable', reason:
  'timestamp-coverage', text }` without segment endpoints.
- The laboratory worker retains that text, marks timing unavailable, and
  emits an empty cue list. Existing window start/end describe decoded source
  coverage only. Later windows use the same model; no retry or reload occurs.
  Standard timed output still undergoes strict source-coverage validation.
- Future product review must visibly say “Timing unavailable — review
  manually.” Untimed text cannot enter Apply without explicit user-supplied,
  freshly validated timing. Whole-window coverage is not a model cue interval.
  Overlap text is retained for review, never silently merged or discarded.

This explicitly revises the previous one-second rejection contract; it does
not relabel runs04–07 as passing or weaken the timed-cue contract. A future
long-workload check must account for every window and distinguish timed
results from untimed review. Fixed workload, memory, heap, token, quality,
cache, cancellation, and offline checks remain necessary.

## Validation and remaining gate

The actual protocol and worker execute with inert dependencies in 17 focused
tests: exact timed output; no endpoints for untimed text; malformed later
data; strict status handling; twelve mixed windows without reload; short
source; cancellation; closed ownership; deadlines; and unchanged budgets.
Targeted lint passes. The protocol tests substitute small model-format and
module fixtures; worker tests read frozen assets as bytes only. These are
not compiled C++, generated-factory, WASM, or transcription-quality tests.

Native adapter review/build, generated identity review, and one explicitly
granted runtime remain pending. The four unrun offline/removal cases and
the complete 300-second workload are still unqualified. No overall GO.
