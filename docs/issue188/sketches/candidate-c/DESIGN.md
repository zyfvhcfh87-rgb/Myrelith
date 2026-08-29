# Candidate C — tick-accurate source windows + rate map

One of several architect runners. This shape redesigns the audio
contributor as a **tick-accurate source window plus a typed rate map**, so
sub-frame origins, constant stretch, ramps, and freezes share one
structure instead of being split across an integer-frame window and a
separate boolean policy. Constant-rate 0.25x–4x is the implemented first
hole. Ramps are a typed hole, not implemented. 0x is silence/hold. Exact 1x
bypasses stretch structurally (identity variant, no stretcher instance).

Issue: https://github.com/zyfvhcfh87-rgb/Myrelith/issues/188
Phase A grounding: `docs/issue188/phase-a-grounding.md`

## Usage (caller's view)

The caller never builds a stretcher, never reads `playbackRate`, and never
mixes booleans to decide whether a clip is audible. It asks the planner
for a contributor, reads its `renderKind`, and routes to one of three
schedulers. The rate map and the source window are tick-accurate, so a
sub-frame origin is just a number, not a mute.

### Live playback (`src/pipeline/playback-audio.ts`)

```ts
import { createTimelineAudioMixPlan } from '../domain/audioMixPlan'
import type {
  AudioRenderKind,
  TimelineAudioContributor,
} from '../domain/audioMixPlan'
import type { AudioStretcherFactory } from './audioStretchPort'

function scheduleContributor(
  out: PlaybackAudioOutput,
  stretcher: AudioStretcherFactory,
  contributor: TimelineAudioContributor,
  anchorTime: number,
): void {
  switch (contributor.renderKind) {
    case 'identity':
      // 1x bypass: no stretcher instance, no stretch overhead.
      scheduleIdentityWindow(out, contributor, anchorTime)
      return
    case 'constant-stretch':
      // 0.25x–4x non-1x. Stretcher is injected; plan carries the rate.
      scheduleStretchedWindow(out, stretcher, contributor, anchorTime)
      return
    case 'silence':
      // 0x freeze, ramp-not-implemented, or unsupported. Zero samples,
      // explicit reason already recorded in the plan.
      scheduleSilenceWindow(out, contributor, anchorTime)
      return
  }
}
```

### Export (`src/pipeline/export-audio.ts`)

```ts
const plan = createTimelineAudioMixPlan(doc, catalog)
for (const contributor of plan.contributors) {
  switch (contributor.renderKind) {
    case 'identity':
      openIdentityReader(source, contributor)        // sample window from ticks
      continue
    case 'constant-stretch':
      openStretchedReader(source, stretcher, contributor)
      continue
    case 'silence':
      zeroFill(contributor.timelineStartSample, contributor.timelineEndSample)
      continue
  }
}
```

### Inspector / capability surface (`src/ui/...` via `state/`)

```ts
import { clipAudioRateMap } from '../domain/sourceTimeMap'

const rate = clipAudioRateMap(clip)
// rate.kind === 'identity' | 'constant' | 'ramp' | 'freeze' | 'unsupported'
// rate.kind === 'ramp' → Inspector shows "Audio ramp support is coming";
//   no preview-only playbackRate is offered.
// rate.kind === 'constant' → Inspector shows the 25%-step rate and the
//   stretcher capability (quality/latency/license) read from state.
```

Three call sites, one plan shape. The caller branches on a single
closed enum; it never reads `rate.numerator === rate.denominator` itself.

## Types

All new pure types live in `src/domain/audioStretch.ts` (types only, no
browser APIs, no React). The discriminated union is the load-bearing
decision: `1x / constant / ramp / freeze / unsupported` are variants, not
independent booleans.

### `AudioRateMap` — the typed rate

```ts
// src/domain/audioStretch.ts
import type { SourceTimeRate, SourceTimeSpeedCurve } from './schema'

export type AudioRenderKind =
  | 'identity'           // exact 1x, no stretcher
  | 'constant-stretch'   // 0.25x–4x non-1x, stretcher required
  | 'silence'            // 0x freeze, ramp-not-implemented, or unsupported

export type AudioRateKind =
  | 'identity'
  | 'constant'
  | 'ramp'
  | 'freeze'
  | 'unsupported'

export interface AudioRateIdentity {
  readonly kind: 'identity'
}

export interface AudioRateConstant {
  readonly kind: 'constant'
  /** Canonical 25%-step rational, 1/4..4, never 1 (that is `identity`). */
  readonly rate: SourceTimeRate
}

export interface AudioRateRamp {
  readonly kind: 'ramp'
  /**
   * The durable speed curve, in curve-space frames. The audio path does NOT
   * implement ramp stretch yet; this variant exists so the planner can
   * classify a ramp and emit `silence` with reason `ramp-audio-not-implemented`
   * instead of inventing a constant fallback.
   */
  readonly curve: SourceTimeSpeedCurve
}

export interface AudioRateFreeze {
  readonly kind: 'freeze'
  /** 0x. The contributor emits silence for the frozen timeline window. */
}

export interface AudioRateUnsupported {
  readonly kind: 'unsupported'
  readonly reason:
    | 'invalid-speed-curve'
    | 'rate-out-of-range'
    | 'ramp-audio-not-implemented'
}

export type AudioRateMap =
  | AudioRateIdentity
  | AudioRateConstant
  | AudioRateRamp
  | AudioRateFreeze
  | AudioRateUnsupported
```

`identity` and `constant` are disjoint even though both carry a rational
rate: `identity` carries no stretcher obligation and no rate field, so the
type system forbids the "rate is 1 but we instantiated a stretcher" state.
`freeze` carries nothing — it is silence, never unbounded synthesis.

### `AudioStretcherCapability` — declared, not hoped

```ts
// src/domain/audioStretch.ts
export interface AudioStretcherCapability {
  readonly algorithmId: string
  readonly provenance: AudioStretcherProvenance
  readonly quality: AudioStretchQuality
  readonly latencyFrames: number
  readonly minRate: SourceTimeRate   // inclusive
  readonly maxRate: SourceTimeRate   // inclusive
  readonly maxChannelCount: number
  readonly maxWorkSamples: number
  readonly license: AudioStretcherLicense
  readonly distribution: AudioStretcherDistribution
}

export interface AudioStretcherProvenance {
  /** 'first-party-wsola' | 'signalsmith-stretch-wasm-port' | 'none' */
  readonly source: string
  /** Upstream version pinned by the reviewed port. */
  readonly upstreamVersion: string | null
  /** Path to the reviewed provenance/audit record. */
  readonly auditRecord: string | null
}

export type AudioStretchQuality = 'broadcast' | 'preview' | 'unknown'

export type AudioStretcherLicense =
  | 'MIT'
  | 'MPL-2.0'
  | 'GPL-2-plus'
  | 'proprietary'
  | 'unlicensed'

export type AudioStretcherDistribution =
  | 'bundled'
  | 'lazy-loaded-wasm'
  | 'none'

export type AudioStretcherFailure =
  | { kind: 'rate-out-of-range'; rate: SourceTimeRate }
  | { kind: 'channel-count-exceeded'; requested: number; max: number }
  | { kind: 'work-budget-exceeded'; requested: number; max: number }
  | { kind: 'not-implemented' }
  | { kind: 'provenance-unverified' }
```

### `TimelineAudioContributor` — replaces `TimelineAudioClipPlan`

```ts
// src/domain/audioMixPlan.ts (modified)
export interface TimelineAudioContributor {
  readonly clipId: ClipId
  readonly trackId: TrackId
  readonly assetId: AssetId

  /** Timeline window in integer document frames, half-open. */
  readonly timelineStartFrame: number
  readonly timelineEndFrame: number

  /**
   * Tick-accurate source window, half-open, in the same units as
   * `SourceTimeMap.sourceStartTicks` (1,000,000 ticks per conformed source
   * frame). Sub-frame origins are representable; the stretcher consumes
   * from this exact offset. Identity contributors use it directly as the
   * PCM in-point.
   */
  readonly sourceStartTicks: number
  readonly sourceDurationTicks: number

  /** Derived from the rate map; the only field callers branch on. */
  readonly renderKind: AudioRenderKind
  /** The full rate map. Carries `ramp`/`freeze`/`unsupported` detail. */
  readonly rateMap: AudioRateMap

  readonly volume: number
  readonly balance: number
  readonly leftGain: number
  readonly rightGain: number
  readonly fadeInFrames: number
  readonly fadeOutFrames: number
  readonly envelopes: TimelineAudioEnvelope[]
}

export interface TimelineAudioMutedClip {
  clipId: ClipId
  trackId: TrackId
  reason:
    | 'invalid-speed-curve'
    | 'rate-out-of-range'
    | 'ramp-audio-not-implemented'
  /** The rate map that was classified, for Inspector disclosure. */
  rateMap: AudioRateMap
}

export interface TimelineAudioMixPlan {
  contributors: TimelineAudioContributor[]
  mutedClips: TimelineAudioMutedClip[]
}
```

`sourceStartFrame`/`sourceEndFrame` are gone. The integer source-frame
envelope is still derivable for asset-bound validation via
`sourceRangeForMap`, but the audio contributor no longer carries it as
truth.

## Function signatures

### `src/domain/sourceTimeMap.ts` (modified)

```ts
/**
 * Classify a clip's source-time map into a typed audio rate map. Replaces
 * `sourceTimeAudioPolicy`. Returns `identity` for exact 1x (including an
 * all-1x speed curve), `constant` for a non-1x 25%-step rate, `ramp` for a
 * genuine speed curve, `freeze` for 0x, and `unsupported` for invalid or
 * out-of-range input. Never returns `unsupported` for a representable
 * sub-frame origin — that is the point of the tick window.
 */
export function clipAudioRateMap(clip: Clip): AudioRateMap

/** Kept for the Inspector's existing surface; derived from `clipAudioRateMap`. */
export function sourceTimeAudioPolicy(clip: Clip): SourceTimeAudioPolicy
```

Body skeleton (logic `not implemented`):

```ts
export function clipAudioRateMap(clip: Clip): AudioRateMap {
  const map = clipSourceTimeMap(clip)
  if (sourceTimeMapHasInvalidSpeedCurve(map)) {
    return { kind: 'unsupported', reason: 'invalid-speed-curve' }
  }
  const curve = validSpeedCurve(map)
  if (curve) {
    if (curve.points.every((p) => isUnitySourceTimeRate(p.rate))) {
      return { kind: 'identity' }
    }
    if (curve.points.some((p) => p.rate.numerator === 0)) {
      // 0x freeze anywhere is silence for the whole contributor.
      return { kind: 'freeze' }
    }
    return { kind: 'ramp', curve }
  }
  if (isUnitySourceTimeRate(map.rate)) return { kind: 'identity' }
  // constant non-1x; range/step validation already enforced by canonicalSourceTimeRate.
  return { kind: 'constant', rate: map.rate }
}
```

### `src/domain/audioMixPlan.ts` (modified)

```ts
export function createTimelineAudioMixPlan(
  doc: TimelineDoc,
  catalog: SourceBoundsCatalog,
): TimelineAudioMixPlan
```

Body skeleton (logic `not implemented`):

```ts
export function createTimelineAudioMixPlan(
  doc: TimelineDoc,
  catalog: SourceBoundsCatalog,
): TimelineAudioMixPlan {
  const contributors: TimelineAudioContributor[] = []
  const mutedClips: TimelineAudioMutedClip[] = []
  for (const track of audibleTracks(doc)) {
    for (const clip of track.clips) {
      // ... existing range/volume validation ...
      const rateMap = clipAudioRateMap(clip)
      const map = clipSourceTimeMap(clip)
      const renderKind = audioRenderKindFromRateMap(rateMap)
      if (rateMap.kind === 'unsupported') {
        mutedClips.push({
          clipId: clip.id, trackId: track.id,
          reason: unsupportedReason(rateMap), rateMap,
        })
        continue
      }
      if (rateMap.kind === 'ramp') {
        // Typed hole: ramp stretch is not implemented. Emit silence with an
        // explicit muted reason; do NOT fall back to a constant rate.
        mutedClips.push({
          clipId: clip.id, trackId: track.id,
          reason: 'ramp-audio-not-implemented', rateMap,
        })
        continue
      }
      // identity | constant | freeze
      contributors.push(buildContributor(clip, track, map, rateMap, renderKind))
    }
  }
  // ... existing crossfade envelope extension, unchanged except it operates
  // on `contributors` and uses tick-accurate source windows ...
  return { contributors, mutedClips }
}

function audioRenderKindFromRateMap(rateMap: AudioRateMap): AudioRenderKind {
  switch (rateMap.kind) {
    case 'identity': return 'identity'
    case 'constant': return 'constant-stretch'
    case 'ramp': return 'silence'        // not implemented
    case 'freeze': return 'silence'
    case 'unsupported': return 'silence'
  }
}
```

### `src/pipeline/audioStretchPort.ts` (NEW — typed hole)

```ts
/**
 * pipeline/audioStretchPort.ts — injected stretcher capability.
 *
 * The plan does not import a stretcher. The pipeline injects one
 * implementation per surface (live, export). The identity variant never
 * calls this interface; the constant-stretch variant calls it with the
 * contributor's tick window and constant rate.
 */
export interface AudioStretcherFactory {
  readonly capability: AudioStretcherCapability
  /** Throws AudioStretcherFailure on rate/channel/budget violation. */
  create(input: AudioStretcherInput): AudioStretcher
}

export interface AudioStretcherInput {
  readonly sourceStartTicks: number
  readonly sourceDurationTicks: number
  readonly rate: SourceTimeRate          // constant, non-1x
  readonly channelCount: number
  readonly sampleRate: number
}

export interface AudioStretcher {
  /** Pull the next stretched window; returns 0 at end of source. */
  next(out: Float32Array[], maxSamples: number): number
  close(): void
}

// First-party WSOLA stub — body not implemented in this slice.
export class FirstPartyWsolaStretcherFactory implements AudioStretcherFactory {
  readonly capability: AudioStretcherCapability
  constructor(capability: AudioStretcherCapability) { this.capability = capability }
  create(_input: AudioStretcherInput): AudioStretcher {
    throw { kind: 'not-implemented' } satisfies AudioStretcherFailure
  }
}

// Signalsmith Stretch WASM port — provenance declared, body not implemented.
export class SignalsmithStretchWasmFactory implements AudioStretcherFactory {
  readonly capability: AudioStretcherCapability
  constructor(capability: AudioStretcherCapability) { this.capability = capability }
  create(_input: AudioStretcherInput): AudioStretcher {
    throw { kind: 'not-implemented' } satisfies AudioStretcherFailure
  }
}
```

Both factories ship with `capability.license === 'MIT'` and an
`auditRecord` path. No GPL Rubber Band factory exists in this module; a
future GPL-2-plus entry would be rejected at the capability gate, not
silently imported.

## Module map

| Module | Status | Owns |
|---|---|---|
| `src/domain/audioStretch.ts` | NEW (types only) | `AudioRateMap`, `AudioRenderKind`, `AudioStretcherCapability`, `AudioStretcherFailure` |
| `src/domain/sourceTimeMap.ts` | MODIFIED | `clipAudioRateMap(clip)`; `sourceTimeAudioPolicy` becomes a thin derived wrapper for the existing Inspector surface |
| `src/domain/audioMixPlan.ts` | MODIFIED | `TimelineAudioContributor` (replaces `TimelineAudioClipPlan`); `createTimelineAudioMixPlan` emits contributors + muted clips with typed rate maps |
| `src/pipeline/audioStretchPort.ts` | NEW (typed hole) | `AudioStretcherFactory`, `AudioStretcher`, first-party WSOLA stub, Signalsmith Stretch WASM port stub |
| `src/pipeline/playback-audio.ts` | MODIFIED call site | pattern-match on `renderKind`; identity bypass; constant-stretch uses injected stretcher; silence zero-fills |
| `src/pipeline/export-audio.ts` | MODIFIED call site | same pattern-match; sample-accurate windows derived from `sourceStartTicks`/`sourceDurationTicks` |
| `src/state/...` | MODIFIED reader | stretcher capability + provenance published as serializable facts; UI reads via state only |

Dependency direction is preserved: `domain/audioStretch.ts` imports only
`domain/schema.ts` types. `pipeline/audioStretchPort.ts` imports
`domain/audioStretch.ts` types. `ui/` reads the capability through `state/`
and never imports the pipeline port directly.

## What is not implemented in this slice

- Any stretcher body. Both factories throw `not-implemented`; the
  constant-stretch scheduler is wired but produces silence until a
  reviewed WSOLA or Signalsmith port lands. The typed hole is explicit.
- Ramp stretch. `AudioRateRamp` exists, the planner classifies it, and
  the mixer emits silence with `ramp-audio-not-implemented`. No constant
  fallback is invented.
- Reverse rates. Out of scope for issue 188; the rate map has no reverse
  variant and the planner does not synthesize one.
- The 96 kHz → 48 kHz half-rate anti-alias path is unchanged; it operates
  after the stretcher, on the mixed stereo grid.

## Invariants encoded in types

- **1x cannot instantiate a stretcher.** `identity` carries no rate and no
  stretcher obligation; the `constant` variant's rate is non-1 by
  construction (`canonicalSourceTimeRate` plus the `identity`-disjoint
  branch in `clipAudioRateMap`).
- **0x is silence, not unbounded synthesis.** `freeze` carries no source
  window obligation; the contributor's `renderKind` is `silence` and the
  mixer zero-fills the timeline window.
- **Sub-frame origins are representable.** `sourceStartTicks` is a
  `number` in the same tick units as `SourceTimeMap`; no integer-frame
  precondition gates audibility.
- **One plan feeds live and export.** Both consumers branch on
  `renderKind` from the same `TimelineAudioMixPlan`; no preview-only
  `playbackRate` exists anywhere.
- **License is a type, not a comment.** `AudioStretcherLicense` enumerates
  the allowed set; GPL-2-plus is representable only as a deliberate,
  reviewable choice, never an accidental transitive import.

