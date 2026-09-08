# G2 shared title rendering and parity protocol

Status: source checkpoint prepared for committed review before a browser-slot
grant; no browser run or G2 acceptance claimed. G3 authoring/templates remain
gated. The supervisor accepted
G1b `ecc9db1` and released G2 after the exact shared integration
`4340f9675ad56aa320f2498cf107fd55f8819568` was fast-forwarded into this branch.

## Reviewed behavior

The shared domain plan now emits ordered text/rectangle/ellipse title elements
and resolves scalar animation at exact local integer frames. Compact text and
captions keep their painter. Element opacity uses the existing group surface;
the complete title leg receives clip effects/opacity/blend before the enclosing
track bus. Element scratch finishes before that bus borrows the group. Plans
count repeated nested occurrences against 4,096 visible title elements before
layout or media/scratch acquisition. Empty/invalid title paint does not acquire
grading scratch merely because its retained descriptor names a grading effect.

Named font intent is never passed to Canvas. Unknown named fonts require an
explicit stored generic fallback; known generic aliases carry platform-dependent
status. Unavailable enabled elements and unevaluable title animation remain
visible as preview reasons and block strict export. Export preflight follows
exact consumed nested ranges, preserves gaps, and ignores supported zero-opacity
intervals. The finite exporter checks each received plan again. No font bytes,
remote service or new dependency is added.

Definition caches retain only deeply frozen graphs and freeze parsed results.
Mutable or shallow-frozen nested input is revalidated in both planning and
effect eligibility. Per-context text layout retains 64 entries / at most 8 MiB
of conservatively priced string data and 512 lines per element; document/font
intent replacement, renderer resize and completed disposal clear derived data.

The supervisor and #199 reviewed `titleEffectAnimationParameterSpec`: supported
expanded owners expose only exact registered numeric parameters accepted by
`effectSupportsSurface(effect, 'post-composite')` and
`effectAnimationParameterSpec`. Authoring and actual resolution share that
helper, with no effectStack/titleOwnership/clipAnimation import cycle. Compact
text, opaque future title controls, masks/chroma/paths and generic plugin
declarations keep their restrictions. Stored unavailable lanes are not deleted.

Two additional compatibility decisions were approved for implementation review:

- Upgrade refuses an enabled plugin descriptor with a nonempty matching lane
  whose supported v1 binding matches the effect type/descriptor version. This
  is potentially active portable intent independent of today's installed
  catalog; the reason says upgrading *could* change animation. Unknown/unbound,
  empty or disabled lanes do not cause a generic refusal.
- Upgrade also refuses an enabled exact registered source-only effect when its
  valid unbound scalar lane actually resolves away from the static fallback.
  It asks the existing evaluator, preserving its validity rules. Unknown/future,
  bound-on-builtin, out-of-bounds, empty, disabled and static-value lanes remain
  portable. Static masks stay unchanged. Both refusals preserve the compact
  clip, identity allocator, undo history and redo.

## Exclusive browser protocol requested

Run only after the supervisor grants the slot. Use private dependencies in this
worktree, muted headless Chromium, one worker and port 5200. Browser plugin not
available; this uses the repository's regular Playwright infrastructure.

Baseline source is archived unchanged from
`ce91074c276ca6892a74addb7dd673b9a19c7eeb` into
`.tmp/issue200-baseline/src`. Its actual renderer and planner are imported by the
test page in the same browser runtime. The archive is not an edited painter or
an independently reconstructed reference. `verify-g2-source.mjs` compares every
archived source blob to Git and fingerprints the candidate's tracked diff and
untracked files before and after the run. The archived source remains outside
production imports and is not committed.

```sh
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
node docs/evidence/issue200/verify-g2-source.mjs capture .tmp/issue200-g2-browser-source.json
npx --no-install playwright test --config playwright.issue200.config.ts
node docs/evidence/issue200/verify-g2-source.mjs verify .tmp/issue200-g2-browser-source.json
```

The prepared acceptance is six tests:

1. 396 rows: six generic families × 22 text/style/caption cases × Full/Half/Quarter.
   Compare unchanged baseline with current compact text, then actual Upgrade,
   real worker shared planner/compositor, and full-size finite export frames.
   Cases include empty/whitespace/CRLF, long words, combining marks, emoji, bidi,
   Japanese/Chinese/Korean/Devanagari/Thai, all weight/italic combinations,
   alignment, fractional geometry, anchors, zero scale, crop/flip/rotation,
   background, outline/shadow, opacity/blend and ordered effects.
2. 234 rows: all 13 scalar properties in coordinated three-element titles with
   hold/linear/cubic easing, ordinary/nested repeated owners and all three
   scales. Compare sequential and arbitrary seeks, a real worker realm and
   every full-resolution raw finite-export frame. Clip effects, element/clip
   opacity, track/master buses and adjustments share the same completed layer.
3. 18 production `RenderWorkerBridge` rows: actual transferred presentation
   pixels across owner replacement, Full/Half/Quarter resize and nonsequential
   seeks. Await actual worker completion and acknowledged disposal.
4. 54 compact animated-mask rows against the unchanged renderer, preserving
   pixels and refusing Upgrade. This is a renderer canary for currently portable
   retained keys; it does not assert the old baseline file parser admitted them.
5. 18 explicit-fallback rows: retain a missing family name, serialize/reopen its
   chosen generic fallback, and compare main/worker/export pixels and line breaks.
6. Real app preview at 1280×720 and 720×800: unavailable reason, explicit fallback
   through one portable history transaction, reopen, visible status and screenshots.
   This exercises rendering/status seams; G3 controls are not implemented.

All pixel comparisons require **zero differing RGBA bytes**, zero maximum delta
and identical recorded text draw/line facts where those are directly observable.
No perceptual tolerance or screenshot similarity substitutes for raw equality.
The production-worker rows observe pixels only; worker line facts come from a
separate real worker running the shared production modules. Each scratch owner
must return to zero canvases, keep at most three canvases live, and make zero
procedural source requests; finite frame leases must all close. Console errors
fail the run. Output JSON and screenshots go to `.tmp/issue200-browser`.

The finite raw-frame sink drives the real `exportTimeline` lifecycle and captures
pixels before an encoder. It does **not** prove encoded-file/codec or native media
equivalence. Encoded/reopen end-to-end export, G3 authoring/template flows, broad
full-suite acceptance and final integration performance remain later criteria.

## Current checks

The prepared source passed **18 focused files / 390 Vitest tests plus 17 runner
checks**, build/typecheck, lint and diff hygiene. This includes portable
validation of every browser fixture, actual worker lifecycle, export/preview
wiring, animation facade, render ordering/cleanup, title capacity/cache and the
production architecture guard. The built output contained no title proof or
archived-baseline harness markers. The existing Vite chunk advisory remains.
Exact logs are [focused tests](rendering-source-tests.log),
[build](rendering-source-build.log) and [lint](rendering-source-lint.log).
Published logs normalize trailing whitespace only; raw logs remain in `.tmp`.
These are focused checks, not a full-suite, dependency-audit, browser or
G2-completion claim. The owned worker report records the exact review commit;
the source guard must be recaptured against that commit before any browser run.
