# Rationale — Candidate C

## Problem

Non-1x constant speed, ramps, and freezes mute audio in preview and export
because no pitch-safe shared algorithm exists. Video already remaps through
`SourceTimeMap`; audio does not. Today the only audio classification is
`sourceTimeAudioPolicy()` in `src/domain/sourceTimeMap.ts`, which supports
exact integer-origin 1x and mutes everything else with
`constant-speed-audio-unsupported`, `speed-ramp-audio-unsupported`, or
`invalid-speed-curve`. The contributor plan in `audioMixPlan.ts` stores
integer-frame `sourceStartFrame`/`sourceEndFrame` windows, so a sub-frame
origin mutes even at 1x. Live (`playback-audio.ts`) and export
(`export-audio.ts`) consume that plan and never read `playbackRate`.

Issue 188 requires one canonical plan and algorithm for live and export, no
preview-only `playbackRate`, an MIT-compatible algorithm with documented
provenance (no GPL Rubber Band), 0.25x–4x constant rate as the first
implemented slice, ramps as a typed hole, 0x as silence/hold, and exact 1x
bypassing stretch with zero overhead. Phase A surfaced the binding
constraints: the `domain/` → nothing dependency rule, integer-frame timeline
math with seconds only at the audio boundary, the audio-master clock, and
the existing `SourceTimeMap` tick precision (1,000,000 ticks per conformed
source frame) that the audio path should reuse rather than reinvent.

## Usage (caller's view)

The caller asks `createTimelineAudioMixPlan(doc, catalog)` for a
`TimelineAudioMixPlan` and branches on `contributor.renderKind` — one of
`identity`, `constant-stretch`, or `silence`. Live playback schedules an
`AudioBufferSourceNode.start(when, offset, duration)` for `identity`, an
injected `AudioStretcher` for `constant-stretch`, and zero samples for
`silence`. Export opens an identity reader, a stretched reader, or
zero-fills. The Inspector reads `clipAudioRateMap(clip).kind` and shows the
stretcher capability (quality/latency/license) from state. Three call sites,
one plan shape, one enum to branch on. The caller never reads
`rate.numerator === rate.denominator` and never builds a stretcher.

## Shape

The contributor carries a **tick-accurate source window**
(`sourceStartTicks`/`sourceDurationTicks`, same units as `SourceTimeMap`)
plus a **typed rate map** — a discriminated union `AudioRateMap` with
variants `identity`, `constant`, `ramp`, `freeze`, `unsupported`. The
contributor's `renderKind` is derived from the rate map and is the only
field callers branch on.

The load-bearing decisions:

- **Tick-accurate window.** Reusing `SourceTimeMap`'s tick units makes a
  sub-frame origin a representable number instead of a mute. The integer
  source-frame envelope stays derivable for asset-bound validation but is
  no longer the audio contract. Per `boundary-discipline`: the audio
  boundary is the tick, not the frame.
- **Discriminated union, not booleans.** `1x / constant / ramp / freeze /
  unsupported` are variants of one type. The "rate is 1 but we instantiated
  a stretcher" state is unrepresentable because `identity` carries no rate
  and no stretcher obligation; `constant`'s rate is non-1 by construction.
  Per `make-illegal-states-unrepresentable`.
- **1x bypass is structural.** The `identity` variant carries no stretcher;
  the schedulers pattern-match and never allocate one. Zero overhead is a
  type-level guarantee, not a comment. Per `subtract-before-you-add`: the
  stretch path is opt-in by variant, not opt-out by branch.
- **Stretcher is an injected typed capability.** `AudioStretcherFactory`
  declares `AudioStretcherCapability` with quality, latency, rate bounds,
  channel count, work budget, license, distribution, and provenance. The
  plan imports no stretcher; the pipeline injects one per surface. GPL
  Rubber Band has no factory in this module; a future GPL-2-plus entry
  would be rejected at the capability gate.
- **Ramps are a typed hole.** `AudioRateRamp` exists so the planner can
  classify a ramp and emit `silence` with `ramp-audio-not-implemented`
  rather than inventing a constant fallback. The stretcher interface has
  no ramp path; the hole is explicit and auditable.
- **0x is silence.** `AudioRateFreeze` carries nothing; the contributor's
  `renderKind` is `silence` and the mixer zero-fills the timeline window.
  Never unbounded synthesis.

Validation lives in `clipAudioRateMap` (rate classification, reusing the
existing `canonicalSourceTimeRate` 25%-step bounds) and in the stretcher
factory (rate/channel/budget checks against the declared capability). The
system deliberately does not implement ramp stretch, reverse rates, or any
GPL algorithm.

Interface depth: the public surface is `createTimelineAudioMixPlan` plus
the `renderKind` enum. All rate classification, mute-reason assignment,
freeze handling, and ramp-hole disclosure are hidden behind that. The
stretcher capability is a read-only record published through state; the UI
never imports the pipeline port. The interface is no larger than needed —
three branches, one plan, one capability record.

## Synthesis decision

Pending arena pick. This candidate's claim to the base is that it makes
the audio contract the same shape as the video contract (`SourceTimeMap`
ticks) and pushes the 1x/constant/ramp/freeze distinction into a single
discriminated union, so the mixer has one switch instead of two booleans
plus a frame precondition. Runners that keep the integer-frame window and
add a separate `playbackRate` field would be rejected by this candidate's
rationale as information leakage (the rate appears in two places) and a
shallow module (the caller still has to know `rate === 1` means bypass).

## Tradeoffs accepted

- We accept a tick-accurate source window in the plan in exchange for
  dropping the integer-frame window that `playback-audio.ts` and
  `export-audio.ts` currently consume directly. Both call sites must
  convert ticks to seconds (live) or samples (export) at the boundary;
  that conversion already exists in `export-audio.ts` via
  `audioSampleBoundary` and is a one-line helper in live.
- We accept a typed `ramp` variant that produces silence today in exchange
  for never inventing a constant fallback. Editors see an explicit
  "ramp audio not implemented" reason instead of a wrong constant rate.
- We accept a stretcher capability record that must be reviewed and pinned
  in exchange for never silently importing a GPL library. The provenance
  audit record is a required field, not optional.
- We accept that `identity` and `constant` are disjoint variants even
  though both correspond to a rational rate, in exchange for the type
  system enforcing "1x never instantiates a stretcher." A future ramp
  implementation adds a variant rather than overloading `constant`.
- We accept that reverse rates are not representable in this slice in
  exchange for shipping the constant-rate hole first, per issue 188's
  first-slice gate.

## Alternatives considered

- **Keep the integer-frame window, add a `playbackRate` field.** This is
  the today-shape plus a number. It loses because the rate appears in two
  places (the `SourceTimeMap` and the new field), the caller still has to
  know `rate === 1` means bypass, and a sub-frame origin still mutes. It is
  a point fix inside the existing shape, not a whole-shape alternative.
  Interface depth is shallow: the public surface grows by a field while
  hiding no new capability.
- **A single `stretch: { rate: number; curve?: ... } | null` field.** One
  optional object instead of a discriminated union. Loses because `null`
  conflates 1x and unsupported, and `rate: 1` is representable, so the
  "1x but we instantiated a stretcher" state is back. The union's whole
  point is to make that unrepresentable.
- **A per-segment stretch plan (list of typed segments) instead of one
  rate map per contributor.** Closer to the video `SourceTimeSpeedCurve`.
  Loses on interface depth for the first slice: the mixer would need to
  walk segments, and the ramp hole would be a per-segment silence rather
  than one contributor-level reason. The video curve already owns
  segment authoring; the audio path should classify it, not reparse it.
  This alternative is a real contender for a future ramp slice and is
  noted as an open question.

## Open questions and risks

- Is one stretcher instance per contributor acceptable for live playback,
  or does the lookahead pump need a pooled stretcher? The current live
  pump decodes short sequential windows per clip; a stretcher that needs
  warmup frames may change the lead time. Should the capability declare
  priming frames separately from `latencyFrames`?
- The first-party WSOLA quality and latency bounds must be declared, not
  hoped. Phase A notes Signalsmith Stretch's author rates quality best
  between ~0.75x and 1.5x; 0.25x and 4x are outside that band. Should the
  capability advertise a `quality` that degrades outside a comfort band,
  and should the planner surface that to the Inspector rather than
  silently picking a worse algorithm?
- The Signalsmith Stretch WASM port is new provenance work. Should this
  slice ship first-party WSOLA only and treat Signalsmith as a follow-up,
  or should the capability gate be designed now to accept either without
  reshaping the plan? This candidate assumes the latter.
- Should `freeze` zero-fill the timeline window or hold the last decoded
  sample? Issue 188 says "silence/hold." This candidate picks silence for
  the first slice because hold requires a stretcher-like state and a
  declared behavior; silence is unambiguous. The human should confirm.
- The 96 kHz → 48 kHz half-rate anti-alias path runs after the stretcher.
  Does a stretched contributor's `sourceDurationTicks` need to express a
  different relationship to the document sample grid than an identity
  contributor's? The plan currently treats both uniformly; a parity test
  should confirm.

## Next implementation step

Land `src/domain/audioStretch.ts` (types only) and the
`clipAudioRateMap`/`createTimelineAudioMixPlan` rewrite against the
existing 1x-only fixtures, so the typed rate map classifies every current
document without changing audible behavior, then wire the
`constant-stretch` scheduler to throw `not-implemented` as the explicit
hole before any stretcher body lands.
