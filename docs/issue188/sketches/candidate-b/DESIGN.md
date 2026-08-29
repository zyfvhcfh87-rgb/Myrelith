# Candidate B: parallel direct-mix and stretch plans

## Caller's usage

Playback builds the existing direct plan and the new stretch plan from the same immutable document. The pipeline joins them once. `AudioBufferSourceNode.playbackRate` remains `1`.

```ts
const plans: TimelineAudioPcmPlans = {
  direct: createTimelineAudioMixPlan(doc, sourceBounds),
  stretched: createTimelineAudioStretchPlan(doc, sourceBounds),
}

const contributors = createTimelineAudioPcmContributors({
  doc,
  plans,
  mode: 'live',
  onStretchStatus,
})

const session = await startTimelineAudioPlayback(
  context,
  doc,
  fromFrame,
  resolveAsset,
  { contributors },
)
```

Export uses the same plan pair and the same PCM stretch factory. Export owns fresh decoder and stretch sessions.

```ts
const plans: TimelineAudioPcmPlans = {
  direct: createTimelineAudioMixPlan(doc, sourceBounds),
  stretched: createTimelineAudioStretchPlan(doc, sourceBounds),
}

const contributors = createTimelineAudioPcmContributors({
  doc,
  plans,
  mode: 'export',
  onStretchStatus,
})

const mixer = new TimelineAudioMixer(doc, mediaSource, contributors)
try {
  await writeTimelineAudio(mixer, writeBlock)
} finally {
  await mixer.close()
}
```

Asset preflight reads both contributor sets. Intentional silence never acquires media.

```ts
const plans: TimelineAudioPcmPlans = {
  direct: createTimelineAudioMixPlan(doc, sourceBounds),
  stretched: createTimelineAudioStretchPlan(doc, sourceBounds),
}

const requiredAudioAssets = timelineAudioPcmAssetIds(plans)
```

## Domain types

`TimelineAudioMixPlan.clips` remains the exact 1x path. A constant non-1x clip appears only in `TimelineAudioStretchPlan.clips`. An exact 1x clip cannot satisfy `ConstantAudioStretchRate`.

```ts
import type {
  AssetId,
  ClipId,
  SourceTimeRate,
  TrackId,
} from './schema'
import type {
  TimelineAudioEnvelope,
  TimelineAudioMutedClip,
} from './audioMixPlan'

declare const constantAudioStretchRate: unique symbol

export type ConstantAudioStretchRate = Readonly<SourceTimeRate> & {
  readonly [constantAudioStretchRate]: true
}

export interface TimelineAudioMixControls {
  readonly volume: number
  readonly balance: number
  readonly leftGain: number
  readonly rightGain: number
  readonly fadeInFrames: number
  readonly fadeOutFrames: number
  readonly envelopes: readonly TimelineAudioEnvelope[]
}

export interface TimelineAudioMixWindow extends TimelineAudioMixControls {
  readonly timelineStartFrame: number
  readonly timelineEndFrame: number
}

export interface TimelineAudioStretchClipPlan {
  readonly clipId: ClipId
  readonly trackId: TrackId
  readonly assetId: AssetId
  readonly sourceStartTicks: number
  readonly sourceEndTicks: number
  readonly rate: ConstantAudioStretchRate
  readonly mix: TimelineAudioMixWindow
}

export interface TimelineAudioStretchPlan {
  readonly clips: readonly TimelineAudioStretchClipPlan[]
}

export type SourceTimeAudioPolicy =
  | { readonly status: 'direct' }
  | {
      readonly status: 'stretch'
      readonly rate: ConstantAudioStretchRate
    }
  | {
      readonly status: 'silence'
      readonly reason: TimelineAudioSilenceReason
    }

export type TimelineAudioSilenceReason =
  | 'invalid-speed-curve'
  | 'speed-ramp-audio-unsupported'
  | 'freeze-audio-silence'
  | 'subframe-unity-audio-unsupported'
```

`TimelineAudioMutedClip.reason` becomes `TimelineAudioSilenceReason`. The direct planner records only `status: 'silence'` clips in `mutedClips`. It skips `status: 'stretch'` clips without calling them muted. The stretch planner accepts only `status: 'stretch'`.

The policy treats an empty curve and a curve whose points all have one positive rate as constant. A constant 1x curve is `direct`. A constant non-1x curve is `stretch`. A curve with two different positive rates is `speed-ramp-audio-unsupported`. Any valid curve that contains 0x is `freeze-audio-silence`. Invalid curve data fails first with `invalid-speed-curve`.

The planner derives `sourceStartTicks` and `sourceEndTicks` from `mix.timelineStartFrame` and `mix.timelineEndFrame`, including an available linked crossfade handle. It never rounds these values to source frames. The mix window remains nested so stretch input geometry cannot be mistaken for gain or envelope policy.

## Pipeline types

The pipeline converts both plans into one private contributor union. Domain code does not name SoundTouch, JavaScript, WebAssembly, Web Audio, or workers.

```ts
export interface TimelineAudioPcmPlans {
  readonly direct: TimelineAudioMixPlan
  readonly stretched: TimelineAudioStretchPlan
}

export type TimelineAudioPcmContributor =
  | {
      readonly kind: 'direct'
      readonly plan: TimelineAudioClipPlan
    }
  | {
      readonly kind: 'stretched'
      readonly plan: TimelineAudioStretchClipPlan
    }

export type AudioStretchRuntimeStatus =
  | {
      readonly status: 'ready'
      readonly clipId: ClipId
      readonly quality: 'balanced-v1'
    }
  | {
      readonly status: 'unavailable'
      readonly clipId: ClipId
      readonly reason:
        | 'stretch-engine-unavailable'
        | 'stretch-resource-limit'
        | 'stretch-latency-limit'
        | 'stretch-sample-rate-unsupported'
        | 'stretch-invalid-output'
    }

export interface StereoPcmChunk {
  readonly startSample: number
  readonly frameCount: number
  readonly channels: readonly [Float32Array, Float32Array]
}

export interface PcmTimeStretchRequest {
  readonly clipId: ClipId
  readonly sampleRate: 44_100 | 48_000 | 96_000
  readonly rate: ConstantAudioStretchRate
  readonly expectedOutputFrames: number
}

export interface PcmTimeStretchSession {
  push(input: StereoPcmChunk): readonly StereoPcmChunk[]
  finish(): readonly StereoPcmChunk[]
  close(): void
}
```

`finish()` may trim surplus algorithm output to `expectedOutputFrames`. It must not pad a short result. A short result is `stretch-invalid-output`. Live reports the clip unavailable and schedules intentional silence for the remainder. Export fails before mux finalization. Both paths expose the same reason.

## Function signatures

```ts
// domain/sourceTimeMap.ts
export function sourceTimeAudioPolicy(
  clip: Clip,
): SourceTimeAudioPolicy {
  throw new Error('not implemented')
}

// domain/audioMixPlan.ts
export function createTimelineAudioMixPlan(
  doc: TimelineDoc,
  catalog: SourceBoundsCatalog,
): TimelineAudioMixPlan {
  throw new Error('not implemented')
}

export function timelineAudioMixWindowForClip(
  doc: TimelineDoc,
  trackId: TrackId,
  clipId: ClipId,
  catalog: SourceBoundsCatalog,
): TimelineAudioMixWindow | null {
  throw new Error('not implemented')
}

// domain/audioStretchPlan.ts
export function createTimelineAudioStretchPlan(
  doc: TimelineDoc,
  catalog: SourceBoundsCatalog,
): TimelineAudioStretchPlan {
  throw new Error('not implemented')
}

// pipeline/timelineAudioPcm.ts
export function createTimelineAudioPcmContributors(
  request: {
    readonly doc: TimelineDoc
    readonly plans: TimelineAudioPcmPlans
    readonly mode: 'live' | 'export'
    readonly onStretchStatus: (status: AudioStretchRuntimeStatus) => void
  },
): readonly TimelineAudioPcmContributor[] {
  throw new Error('not implemented')
}

export function timelineAudioPcmAssetIds(
  plans: TimelineAudioPcmPlans,
): readonly AssetId[] {
  throw new Error('not implemented')
}

// pipeline/pcmTimeStretch.ts
export function createPcmTimeStretchSession(
  request: PcmTimeStretchRequest,
): PcmTimeStretchSession {
  throw new Error('not implemented')
}
```

The implementation must use exhaustive switches for `SourceTimeAudioPolicy` and `TimelineAudioPcmContributor`. No caller may infer a case from an empty array.

## Module map

`src/domain/sourceTimeMap.ts`

Classifies a timed clip as `direct`, `stretch`, or `silence`. It validates the existing rational rate vocabulary. It constructs the branded non-1x rate. It remains pure and license-agnostic.

`src/domain/audioMixPlan.ts`

Keeps `TimelineAudioMixPlan.clips` direct-only. It owns volume, balance, fade, output-window, and crossfade-envelope invariants. Its `timelineAudioMixWindowForClip` function resolves the complete mix window once for either planner. It records intentional silence reasons in `mutedClips`.

`src/domain/audioStretchPlan.ts`

Owns constant-rate stretch geometry. It calls `timelineAudioMixWindowForClip`, then converts that output window into exact source-tick bounds and a non-1x rate. It does not own gain curves, runtime capacity, package choice, or PCM buffers.

`src/pipeline/timelineAudioPcm.ts`

Is the sole join between the two plans. It rejects duplicate clip ids across plans, sorts contributors by timeline, track, and clip, computes required assets, and admits at most eight overlapping stretch contributors. Live gives excess contributors a deterministic resource-limit status. Export rejects the full plan before opening a sink. The module maps later stretch failure to live silence or an export error. These checks make it a policy boundary, not a pass-through wrapper.

`src/pipeline/pcmTimeStretch.ts`

Is the only module that imports `@soundtouchjs/core`. It adapts stereo `Float32Array` PCM to the package's private interleaved buffers. It owns construction, flush, exact output accounting, and cleanup. No SoundTouch type crosses this file.

`src/pipeline/playback-audio.ts`

Consumes `TimelineAudioPcmContributor`. The direct branch keeps the current scheduling path. The stretched branch folds decoded input to stereo, processes PCM, and schedules the resulting `AudioBuffer` at 1x against the existing audio-clock anchor.

`src/pipeline/export-audio.ts`

Consumes the same contributor union. The stretched branch folds decoded input to stereo and passes it through `createPcmTimeStretchSession` before the existing gain, envelope, sum, clamp, resample, encode, and mux stages.

## Algorithm and distribution contract

The first slice pins `@soundtouchjs/core` 2.1.1. The package is MPL-2.0, ESM-only, and has no runtime dependencies. Its core package supports custom and offline PCM pipelines. The design does not use `@soundtouchjs/audio-worklet`.

The adapter sets tempo from `ConstantAudioStretchRate` and leaves pitch at 1. It processes decoded PCM in both live and export. It never sets a media element or `AudioBufferSourceNode.playbackRate`.

Myrelith remains MIT. Distribution must retain the MPL-2.0 license, add the pinned package and source URL to `THIRD_PARTY_NOTICES.md`, and make the corresponding MPL source available. Any edit to an MPL-covered package file remains MPL-2.0. Myrelith adapter files remain MIT.

No WebAssembly file ships in this slice. No runtime download or dynamic algorithm selection exists. A later WASM backend requires a separate provenance, license, byte-size, fixed-memory, cancellation, and browser-parity review. It must pass the same PCM contract before it can replace the JavaScript implementation.

## Declared operating bounds

- Rates are the existing positive 25-percent rational steps from 0.25x through 4x, excluding exact 1x.
- Input is decoded PCM at 44.1, 48, or 96 kHz. The adapter accepts exactly two channels after the canonical 1 to 32 channel fold-down.
- One `push` accepts at most 4,096 stereo frames.
- One session may retain at most 32,768 input frames and 32,768 output frames. Adapter-owned PCM is therefore at most 512 KiB. Package bookkeeping and overlap state receive a separate 512 KiB allowance.
- The pipeline admits at most eight simultaneous stretch sessions. The total stretch working-memory ceiling is 8 MiB. Stable timeline, track, and clip ordering decides live admission. Export rejects any interval that needs a ninth session.
- Live algorithmic priming must stay at or below 150 ms at 48 kHz. One 4,096-frame `push` must complete within 8 ms at p95 on the project's minimum browser test machine. A miss receives `stretch-latency-limit`; the first slice does not hide it behind `playbackRate`.
- The existing 750 ms playback lookahead stays the scheduling bound. Stretch processing does not become a clock.
- Playback and export rechunk decoded stereo PCM into the same 4,096-frame sequence before stretching. Decoder packet boundaries cannot select different SoundTouch output.
- Export output length must equal the scheduled timeline sample count. Extra flush output is trimmed. Missing output fails.
- The quality preset is `balanced-v1`. It uses the pinned core defaults after the implementation gate records the exact sequence, seek-window, overlap, and interpolation settings. The gate must reject the preset if steady-tone pitch error exceeds 10 cents, duration differs by one sample, output contains a non-finite sample, or speech and music fixtures show a discontinuity at a 4,096-frame block boundary.
- The release notes must state that 0.25x and 4x can produce audible transient and phasing artifacts. Pitch preservation does not imply transparent quality at the extremes.

The memory and latency numbers are acceptance limits, not claims about the package. If the pinned package cannot run inside fixed circular buffers and these limits, this candidate fails the implementation gate.

## Unsupported behavior

- Exact 1x always uses `TimelineAudioMixPlan.clips`. It never constructs a stretch session.
- A positive variable-rate curve is intentional silence with `speed-ramp-audio-unsupported`.
- Any 0x section is intentional silence with `freeze-audio-silence`. The implementation does not repeat, synthesize, or stretch one sample indefinitely.
- A malformed curve is intentional silence with `invalid-speed-curve`.
- Exact 1x with a sub-frame source origin remains intentional silence with `subframe-unity-audio-unsupported`. Supporting it belongs to a separate direct-reader change.
- Reverse audio, formant editing, source separation, cloud processing, and AI voice processing remain absent.

## Implementation TODO

1. Add policy tests that prove the three-way classification and prove exact 1x cannot construct `ConstantAudioStretchRate`.
2. Add plan tests for trim, split, all-constant curves, crossfade handles, fades, and sub-frame non-1x source starts.
3. Build `pcmTimeStretch.ts` against fixed buffers. Record package-retained bytes and block timing before playback or export integration.
4. Run the same PCM fixture through live-mode and export-mode adapters. Assert byte-equal stretched PCM before gain and scheduling.
5. Integrate playback, then export, without changing the direct branch.
6. Add cancellation and teardown tests for open decoder and stretch sessions.
7. Update dependency notices only after the quality, memory, latency, and license gates pass.
