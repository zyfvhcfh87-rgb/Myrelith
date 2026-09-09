# Issue #199 — standalone crop admission certificate

Date: 2026-09-08. Parent: accepted combined foundation
`9fa4bb7b388afad69da4eb39214e1976c5c641ad`.
This gate awaits supervisor review before crop runtime promotion.

## Delivered boundary

`src/domain/cropAnimationCertificate.ts` proves crop validity over an inclusive
integer-frame range or returns `invalid-input`, `unsafe-crop` with a witness
frame, or `proof-budget`. Budget failure means unproven. Neither failure nor
success changes the authored candidate. `certifyCropAnimations` applies the
aggregate work budget and never returns partial project approval.

The API consumes typed immutable candidate data after a structural boundary;
it is not an arbitrary-object/JSON parser. It validates bounded integer frames,
static crop, all four lane counts before walking payloads, strictly ordered
unique keys, scalar values and easing. Optional source ticks use the existing
scalar validator. No property vocabulary, schema field, serializer, store,
renderer, UI, worker or runtime caller is enabled by this gate.

The scalar bisection loop is mechanically factored into
`solveAnimationBezierParameter`. The evaluator calls the same loop then the
same cubic-coordinate expression. No iteration, comparison, operation order,
clamp or exact-key short-circuit changes. The mask adapter now imports its
frame bound from `MAX_KEYFRAME_FRAME`, as requested by the supervisor.

## Numerical argument

This is a source-level argument for the implementation below, supported by
regression and exhaustive finite tests. It is not a machine-checked proof.

The arithmetic premise is ECMAScript binary64 Number arithmetic with rounding
to nearest, ties to even; add, subtract, multiply and divide return the rounded
operation result. See the primary specification for
[Number representation and operations](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-ecmascript-language-types-number-type),
[multiply](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-multiply),
[divide](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-divide)
and [add](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-add)
(checked 2026-09-08). The enclosure and decision-tree reasoning that follows
is derived here from the actual repository source, not claimed by that source.

1. **Partition and progress.** Start/end and keys lie within ±1e9. The union
   of all key frames cuts the requested integers into disjoint intervals; a
   cut starts a new interval and the previous interval ends at cut minus one.
   Thus one interval never crosses a key or hold discontinuity in any lane.
   Before/after a lane's endpoints the evaluator returns the exact held value.
   Inside a segment, frame differences and the positive denominator are exact
   integers at most 2e9. Correctly rounded division is nondecreasing, so every
   computed progress lies between the computed endpoint progresses in [0,1].

2. **Actual bisection parameter order.** For fixed controls, each node in the
   24-level bisection tree compares a deterministic computed X coordinate to
   progress. Take p1 <= p2. At the first differing branch p1 can only go left
   while p2 goes right: `X(mid) < p` is monotone in p. Every final midpoint in
   that left subtree is below every final midpoint in the right subtree. If
   they never differ, results are equal. All endpoints/midpoints are exact
   dyadics at this depth. Therefore the *implemented* solver parameter is
   nondecreasing, even without assuming monotonicity of rounded X coordinates
   across separate nodes. Calling the same solver at progress bounds encloses
   all actual parameters. No ideal inverse or fixed-bisection error estimate
   substitutes for the actual answer.

3. **Every rounded cubic operation is enclosed.** Each interval addition and
   subtraction uses its extremal endpoints; multiplication takes the extrema
   of all four corner products. The result expands outward by one adjacent
   binary64 value at each end using DataView bit stepping, including subnormal
   values and signed zero. A rounded extremal result expanded this way encloses
   the exact extremum and every rounded interior result. By induction over the
   expression tree, the result encloses the actual polynomial evaluation. The
   certificate uses precisely the canonical left-associated expression:
   `3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t`, with `u = 1-t`. It does not assume the
   computed Y coordinate is monotone or substitute an algebraic simplification.
   All admitted inputs and intermediate enclosures are small and finite; a
   nonfinite enclosure would be refused, never certified.

4. **Exact track semantics.** Linear progress uses its rounded endpoint bounds.
   The value enclosure follows `left + (right-left)*eased`; `right-left` is
   computed once with the same Number subtraction as the scalar evaluator.
   An exact left key is included separately and interior proof starts at the
   next integer. The right key starts the next partition. This preserves the
   existing cubic primitive's tiny endpoint approximation without applying it
   to exact authored keys. Hold, static, endpoint-held and equal-value segments
   are exact point intervals. Any signed-zero difference in the equal-value
   shortcut is numerically identical for crop validation.

5. **Coupled admission and subdivision.** Each edge interval must be finite and
   within [0,0.99]. Rounded Number addition is nondecreasing in both operands,
   so adding the two upper bounds encloses the actual validator's rounded sum.
   A rounded upper sum <=0.99 suffices for each opposing pair. There is no
   permissive epsilon or clamp. If an interval cannot be certified, it is split
   into disjoint integer halves. At a singleton the unchanged canonical scalar
   evaluator and `cropInsetsValidationError` check the actual values. Acceptance
   follows only when every partition has been certified or reduced to valid
   singletons. Exhaustion cannot be mistaken for approval.

One representable step above 0.49 still rounds with 0.5 to exactly 0.99; that
pair is valid under the existing validator. Two steps exceed it. Tests preserve
this precise boundary rather than imposing a stricter real-arithmetic rule.

## Work and memory bounds

- Four scalar lanes, each at most 1,024 keys, share existing scalar bounds.
  Every lane's count is checked before any key payload traversal. Validation
  and cut construction walk at most 4,096 keys per clip.
- At most 4,097 cut starts and initial pending intervals are retained. Each
  binary subdivision adds at most one pending sibling. Integer ranges have
  at most 2,000,000,001 positions and depth at most 31, so the live stack is
  bounded by 4,128 entries; it never stores a duration-sized frame array.
- At most 16,384 interval visits per clip; each does four bounded binary key
  lookups and at most eight 24-step solver calls. Singleton evaluation uses
  the already validated scalar path. Callers can lower but cannot raise caps.
- Whole-project proof has at most 1,048,576 interval visits and 100,000 key
  visits, including retained keys outside the requested range. Repeated lane
  references still consume work budget. The latter is a proof-traversal cap,
  not a new wire-schema policy. It prevents cheap interval proofs from hiding
  unbounded aggregate key scans. Inputs longer than the minimum possible
  remaining work are refused before request payload access.
- One eight-byte scratch DataView per active clip proof; all state is local.
  No persistent cache, browser resource, worker, timer or input mutation.

Dependency overestimation can refuse a safe curve at the budget cap, especially
an opposing pair that remains exactly on the boundary for a long range. This
is an intentional bounded-rejection contract, not a claim of completeness or
an excuse to loosen 0.99. Constant equality and holds avoid this overestimation.

## Validation

- Canonical focused matrix: **18 files / 178 Vitest tests**, plus **17/17 runner
  checks**, maxWorkers=1. This includes the certificate, unchanged scalar and
  source-time fixtures, path/geometry foundation, clip/effect operations, store,
  Inspector, composition, audio/plugin consumers and architecture.
- The scalar fixture still matches **900 exact bit patterns** from frozen
  master `ce91074`; the timing fixture still matches **36 complete outcomes**.
- Certificate tests cover 450 complete small-timeline cases (all 16 cubic
  control corners plus hold/linear and five edge values including subnormal
  and boundary values), and 250 deterministic mixed four-lane cases. Every
  integer frame is independently evaluated by the canonical scalar authority.
  Accepted cases have no invalid integer; unsafe results identify an actual
  invalid integer. These finite tests corroborate implementation, not replace
  the argument above.
- Huge signed-range tests cover static boundary equality, constant cubic,
  holds, opposing linear movement and all 16 extreme cubic control combinations.
  Safe moving fixtures certify with fewer than 300 visits across two billion
  frames. Tests also cover exact hold/key seams, unsafe interior with legal
  endpoints, preflight before oversized payload getters, deterministic budget
  rejection, aggregate exhaustion and immutable input.
- Typecheck/production build and lint passed. The existing Vite chunk-size
  advisory remains. Source import inspection and built-message inspection
  confirm the standalone proof has no runtime consumer. Timeline remains 21.
- Initial test attempt failed because its expected one-step sum was wrong:
  `0.5 + nextAbove(0.49)` equals 0.99. The corrected test checks both that valid
  rounded pair and the two-step invalid pair. Product logic did not change in
  response. The first failure log is retained.

Logs: [focused matrix](crop-certificate-tests.log),
[initial test failure](crop-certificate-tests-first.log),
[build](crop-certificate-build.log), [lint](crop-certificate-lint.log),
[scope and source hashes](crop-certificate-scope.log).

No full-suite, browser, performance, runtime crop, export or issue-completion
acceptance is claimed. Fractional/sample-time crop evaluation is outside this
integer-geometry proof; any future use there needs its own admission contract.
Any cached result must bind the exact immutable crop, all four tracks and the
complete consumed range, including crossfade handles. Cache invalidation and
actual transaction/serializer integration remain later reviewed work.

## Next authorized gate

After this proof commit, the supervisor authorizes merging exact combined
foundation `b0e43ed449719fe3e424a46cd97d384b6a11cf1a` (includes accepted #200
`381836fa3b45d83f7b7c1f932413b6ac067a154a`) and schema22 implementation. Crop
runtime promotion remains separately gated on review of this numerical proof.
Schema22 must retain absent new collections/implicit v1 scalars without growing
legacy encoding, enforce semantic target uniqueness, preserve bounded future
intent and plugin values without inventing legacy provenance, and prove actual
10m-character serializer/store/undo boundaries. Stop at committed Gate1 for
review before batch operations or UI.
