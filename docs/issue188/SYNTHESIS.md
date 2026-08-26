# Issue 188 arena synthesis

Date: 2026-08-26
Issue: https://github.com/zyfvhcfh87-rgb/Myrelith/issues/188

## Pick

Base is candidate A (`sketches/candidate-a/`).

The arena cross-judge recommended A. Independent scoring agreed. B scored higher on branding, constant-curve classification, and runtime gates. Its two-plan join still fails the binding rule. One membership list feeds live, export, asset gating, and crossfade audio. Two planners plus a later join are three places that list can drift.

A future maintainer can replace AMDF, retune hops, or add a ramp variant without inventing a second contributor set. Exact 1x stays an object that cannot carry `stretch`.

Grafted contract: `DESIGN.md` in this folder.

## Grafts

From B:

- Brand the stretch rate so unity cannot be constructed.
- Classify an all-constant non-1x speed curve as stretch, not as a ramp mute. Playhead-authored 200% sections must play.
- Fixed 4,096-frame rechunk before stretch so decoder packet boundaries cannot change output.
- Admission and memory caps. At most eight overlapping stretch sessions. 8 MiB stretch working set.
- Live and export must produce byte-equal stretched PCM on the same fixture before gain.

From C:

- Tick-accurate source windows stay the stretch contract. A already stored ticks on the descriptor. Keep them. Do not revive integer-frame phase math on the stretch branch.
- Provenance is a pipeline constant plus this research note. Do not put license or WASM capability types in `domain/`.

## Rejected

From A:

- Mid-clip live versus export grain mismatch is not a permanent contract. Measure it. If speech fails the quality gate, warm from a declared lead instead of documenting the click.
- Unbounded session count. B's eight-session cap is in.
- A Zustand store whose only job is to forward `clipAudioPresentation`. Timing already calls a pure domain helper. That stays.

From B:

- Separate `createTimelineAudioStretchPlan` and a required caller-side join.
- Mode-dependent membership inside the join.
- Shipping `@soundtouchjs/core` for the first slice. MPL-2.0 is compatible. A new DSP dependency is not needed once first-party WSOLA is the algorithm.

From C:

- Parallel `renderKind` and `rateMap` fields that can disagree.
- `AudioStretcherCapability` in domain, including a representable GPL variant.
- Dual factory stubs that leave constant stretch silent.
- Signalsmith WASM. Issue #19 already rejected an unbounded local WASM proxy on provenance and memory.

## Verification

The grafted `DESIGN.md` still has one plan, one WSOLA session API, a type-level 1x bypass, distinct mute reasons for ramps and freezes, MIT-only distribution, and numeric bounds. Red-flag screen after graft:

- No second plan (B's shallow-module hit is gone).
- No domain license enum (C's leakage is gone).
- Inspector still reads a domain helper, matching today's Timing section.
- Stretch internals stay behind `createConstantRateAudioStretcher`.

## Dropouts

None. A, B, and C all produced `DESIGN.md` and `RATIONALE.md`.
