# Issue 188 candidate A. Extend the mix plan with constant-rate stretch

First-party WSOLA behind the existing live/export mix plan. MIT with the repo. No new npm package. No Rubber Band.

Fill in `not implemented` bodies against this sketch. If a body needs a parameter this file does not name, stop and change the sketch.

## Usage

An editor sets whole-clip speed to a 25% step between 25% and 400%. Preview and export must play the same pitch-stable audio for that clip. Exact 100% stays on today's decode-and-schedule path. A 0% freeze or a speed curve stays silent, with a reason the Inspector can print.

Callers import the plan from `audioMixPlan` and the stretcher from `pipeline/audioStretch`. They do not import WSOLA knobs, `AudioBuffer`, `AudioContext`, or WASM types from domain.

### Mix planner

`createTimelineAudioMixPlan` is still the only audible-contributor builder. Policy decides membership. The planner does not call the stretcher.

```ts
const policy = sourceTimeAudioPolicy(clip)
if (policy.status === 'muted') {
  mutedClips.push({ clipId: clip.id, trackId: track.id, reason: policy.reason })
  continue
}

const draft = baseContributorFields(clip, track)
planning.set(clip.id, { draft, clip, policy })
// envelopes may widen draft.timelineStartFrame / draft.timelineEndFrame

// after envelopes
const ready = planning.get(clip.id)!
if (ready.policy.kind === 'direct') {
  plans.set(clip.id, finishDirectContributor(ready.draft, ready.clip))
} else {
  plans.set(clip.id, finishStretchedContributor(
    ready.draft,
    ready.clip,
    ready.policy.rate,
  ))
}
```

`finishDirectContributor` is today's 1x phase math. It never constructs a descriptor.

`finishStretchedContributor` runs after envelopes. It writes `stretch` from `sourceTicksAtTimelineOffset` at the planned local window. A 2x outgoing handle that grows three timeline frames consumes six source frames. The 1x `timeline + phase` formula is not used on that branch.

`status === 'supported'` still means "this clip belongs in `clips`." `selectors.outputMediaAssetIds` and `exportController` keep that check.

### Playback

`buildAudioClipPlans` keeps the discriminant. The 1x branch is the current function body. It does not create a stretcher.

```ts
const mix = createTimelineAudioMixPlan(doc, catalog)

for (const plan of mix.clips) {
  if (isStretchedAudioClipPlan(plan)) {
    const session = createConstantRateAudioStretcher({
      stretch: plan.stretch,
      sampleRate: decoded.sampleRate,
      outputStartSample: timelineSampleAt(fromFrame, plan),
    })
    const output = await session.pull(outputSampleCount, readFoldedSource)
    scheduleAsTimelinePcm(output, plan) // identity map. source times equal timeline times
    continue
  }

  scheduleDirect(plan) // today's openClip + preparedEventsForOverlap
}
```

`readFoldedSource` is playback-private. It folds with `foldDecodedFrameToStereo`, then hands `StereoPcm` to `pull`. The stretcher never sees `AudioBuffer`.

Cancel, project replacement, and `stop()` call `session.close()` next to the decoder cursor. A decode or stretch throw joins `failedClips` and warns. Same as today's source-open failure.

### Export

`TimelineAudioMixer` still walks document frames and reads 1024-sample stereo blocks. Stretched readers open the mapped source sample range, not a 1x-length range.

```ts
if (isStretchedAudioClipPlan(plan)) {
  const sourceStartSample = audioSampleFromSourceTicks(
    plan.stretch.sourceStartTicks,
    this.doc,
  )
  const sourceEndSample = audioSampleFromSourceTicks(
    plan.stretch.sourceEndTicks,
    this.doc,
  )
  const lead = audioStretchSourceLeadSamples(this.doc.audioSampleRate)
  const inner = await this.source.openClip({
    clipId: plan.clipId,
    assetId: plan.assetId,
    startSample: Math.max(0, sourceStartSample - lead),
    endSample: sourceEndSample,
    sampleRate: this.doc.audioSampleRate,
    channelCount: EXPORT_AUDIO_CHANNELS,
    ...(plan.sampleEnvelopes.length > 0 ? { requireComplete: true as const } : {}),
  })
  const session = createConstantRateAudioStretcher({
    stretch: plan.stretch,
    sampleRate: this.doc.audioSampleRate,
    outputStartSample: 0,
  })
  this.readers.set(plan.clipId, {
    plan,
    reader: wrapStretchReader(inner, session, sourceStartSample),
  })
  return
}

// current 1x openClip using audioSamplePhaseOffset
```

`wrapStretchReader.read(n)` asks the inner reader only for new source samples, then `session.pull(n, appended)`. Gain, balance, fades, and crossfade envelopes stay on the timeline sample grid. They do not move into the stretcher.

`hasAudio` stays "any audio-track clip exists." A freeze-muted clip still occupies the mix with zeros, as today.

### Inspector

Timing and Audio both print one line from the same helper. They do not rebuild policy.

```ts
const presentation = clipAudioPresentation(clip)

switch (presentation.state) {
  case 'ready':
    return presentation.kind === 'direct'
      ? 'Audio stays enabled at 100% speed.'
      : `Audio plays time-stretched at ${sourceTimeRatePercent(presentation.rate)}% so pitch stays put.`
  case 'fallback':
    return `Audio plays time-stretched at ${sourceTimeRatePercent(presentation.rate)}%. Quality is limited at this speed.`
  case 'silence':
    return silenceCopy(presentation.reason)
}
```

`silenceCopy` names the stored reason.

- `invalid-speed-curve`. Audio is muted because the stored speed curve is invalid. Video uses the preserved constant fallback.
- `speed-ramp-audio-unsupported`. Audio is muted for speed ramps until variable-rate stretch exists.
- `freeze-audio-silence`. Audio is silent for 0% freeze holds. The clip does not invent a held tone.
- `sub-frame-origin-audio-unsupported`. Audio is muted because the 100% map does not start on a whole source frame.

## Types

### Policy

`sourceTimeAudioPolicy` is still the only classifier. `supported` stays the audible set so existing `status === 'supported'` / `status === 'muted'` checks keep their meaning.

```ts
export type SourceTimeAudioPolicy =
  | { status: 'supported'; kind: 'direct' }
  | { status: 'supported'; kind: 'stretched'; rate: SourceTimeRate }
  | {
      status: 'muted'
      reason:
        | 'invalid-speed-curve'
        | 'speed-ramp-audio-unsupported'
        | 'freeze-audio-silence'
        | 'sub-frame-origin-audio-unsupported'
    }
```

`constant-speed-audio-unsupported` is deleted. A valid constant 0.25x to 4x map is `stretched`, not muted.

Classification, in this order.

1. Invalid speed curve → `invalid-speed-curve`.
2. `sourceTimeMapIsDirectAudioCompatible(map)` → `direct`. Integer-origin 1x, including an all-1x speed curve. Today's `sourceTimeMapIsAudioCompatible`.
3. `sourceTimeMapIsConstantStretchCompatible(map)` → `stretched` with `map.rate`. Empty or missing curve. Canonical rate in 0.25x to 4x. Not unity. Tick origin may be sub-frame. The descriptor carries the ticks.
4. Valid curve with any positive non-unity rate → `speed-ramp-audio-unsupported`.
5. Valid curve whose only non-unity rates are 0/1 holds → `freeze-audio-silence`.
6. 1x map that fails only the integer-origin test → `sub-frame-origin-audio-unsupported`.

A constant non-1x rate written as a speed curve stays a ramp. Whole-clip speed writes `map.rate`. That is the stretch door.

### Presentation

Derived from policy. Not stored on the plan. Single source for Inspector copy.

```ts
export type StretchQualityBand = 'nominal' | 'edge'

export type ClipAudioPresentation =
  | { state: 'ready'; kind: 'direct' }
  | { state: 'ready'; kind: 'stretched'; rate: SourceTimeRate; quality: 'nominal' }
  | { state: 'fallback'; kind: 'stretched'; rate: SourceTimeRate; quality: 'edge' }
  | { state: 'silence'; reason: Extract<SourceTimeAudioPolicy, { status: 'muted' }>['reason'] }
```

`stretchQualityBand(rate)` is `nominal` when `3/4 ≤ rate ≤ 3/2` (75%, 100%, 125%, 150%). Every other accepted step is `edge`. 100% never reaches this helper. Direct policy does.

`fallback` still plays. It is not silence. It is the declared quality bound at 0.25x, 0.50x, and 1.75x to 4x.

### Stretch descriptor

Present only on stretched contributors. 1x plans have no such field.

```ts
export interface ConstantRateAudioStretch {
  readonly rate: SourceTimeRate
  readonly sourceStartTicks: number
  readonly sourceEndTicks: number
}
```

Invariants, enforced by `createConstantRateAudioStretch` and then trusted.

- `rate` is canonical, inside 0.25x to 4x, and not unity. `isUnitySourceTimeRate(rate)` is a throw.
- `sourceStartTicks` and `sourceEndTicks` are safe non-negative integers. Start is strictly less than end.
- The tick span is the mapped source for the planned timeline window, including a valid crossfade handle.

No hop, window, search, channel, or sample-rate field. Those belong to the stretcher.

### Mix plan contributors

The 1x object matches today's `TimelineAudioClipPlan` fields. The extra field is `stretch?: never`, so a descriptor cannot be assigned.

```ts
export interface TimelineAudioClipFields {
  clipId: ClipId
  trackId: TrackId
  assetId: AssetId
  timelineStartFrame: number
  timelineEndFrame: number
  sourceStartFrame: number
  sourceEndFrame: number
  volume: number
  balance: number
  leftGain: number
  rightGain: number
  fadeInFrames: number
  fadeOutFrames: number
  envelopes: TimelineAudioEnvelope[]
}

export interface TimelineAudioDirectClipPlan extends TimelineAudioClipFields {
  stretch?: never
}

export interface TimelineAudioStretchedClipPlan extends TimelineAudioClipFields {
  stretch: ConstantRateAudioStretch
}

export type TimelineAudioClipPlan =
  | TimelineAudioDirectClipPlan
  | TimelineAudioStretchedClipPlan

export interface TimelineAudioMixPlan {
  clips: TimelineAudioClipPlan[]
  mutedClips: TimelineAudioMutedClip[]
}

export interface TimelineAudioMutedClip {
  clipId: ClipId
  trackId: TrackId
  reason: Extract<SourceTimeAudioPolicy, { status: 'muted' }>['reason']
}
```

On a stretched plan, `sourceStartFrame` / `sourceEndFrame` are the decode envelope. Floor of start ticks, ceil of end ticks, over `SOURCE_TIME_TICKS_PER_FRAME`. The planner writes both from the same tick pair. Callers that need exact phase read `stretch`.

`TimelineAudioEnvelope` is unchanged.

### Stretcher (pipeline)

No Web Audio types. Stereo float planes only.

```ts
export interface StereoPcm {
  readonly left: Float32Array
  readonly right: Float32Array
}

export interface ConstantRateAudioStretcher {
  pull(
    outputSampleCount: number,
    readNewSource: (sampleCount: number) => StereoPcm | Promise<StereoPcm>,
  ): Promise<StereoPcm>
  close(): void
}
```

`readNewSource` is append-only. The session never asks to rewind. It owns lookback, hop phase, and the overlap-add tail.

Illegal inputs throw at `create` / `pull`. The WSOLA loop does not re-validate rate or tick order.

## Function signatures

### `src/domain/sourceTimeMap.ts`

```ts
export function sourceTimeMapIsDirectAudioCompatible(map: SourceTimeMap): boolean {
  throw new Error('not implemented')
  // TODO: today's sourceTimeMapIsAudioCompatible body.
  // Integer origin and (unity rate or every curve point unity).
}

export function sourceTimeMapIsConstantStretchCompatible(map: SourceTimeMap): boolean {
  throw new Error('not implemented')
  // TODO: sourceTimeMapValidationError is null.
  // validSpeedCurve is null (empty / missing).
  // rate validates and is not unity.
}

export function sourceTimeAudioPolicy(clip: Clip): SourceTimeAudioPolicy {
  throw new Error('not implemented')
  // TODO: the six-step order in Types > Policy.
}

export function stretchQualityBand(rate: SourceTimeRate): StretchQualityBand {
  throw new Error('not implemented')
  // TODO: compare cross-multiplied 3/4 and 3/2. Do not divide.
}

export function clipAudioPresentation(clip: Clip): ClipAudioPresentation {
  throw new Error('not implemented')
  // TODO: policy → ready / fallback / silence. Derive quality from rate.
}

export function sourceTicksToSeconds(ticks: number, rate: FrameRate): number {
  throw new Error('not implemented')
  // TODO: ticks * rate.den / (SOURCE_TIME_TICKS_PER_FRAME * rate.num).
  // Decoder-boundary seconds only. Same float role as framesToSeconds.
}

export function audioSampleFromSourceTicks(
  ticks: number,
  doc: TimelineDoc,
): number {
  throw new Error('not implemented')
  // TODO: BigInt ticks * frameRate.den * audioSampleRate
  //   / (SOURCE_TIME_TICKS_PER_FRAME * frameRate.num)
  // Round half away from zero so a negative phase still cancels, matching
  // export-audio.audioSamplePhaseOffset. Move that shared rounding here if
  // the 1x path can call it without behavior change.
}
```

Delete the name `sourceTimeMapIsAudioCompatible` in the same change. Its only production caller is `sourceTimeAudioPolicy`. Ticks belong in this file, so sample mapping from ticks lives here too.

### `src/domain/audioMixPlan.ts`

```ts
export function createConstantRateAudioStretch(args: {
  rate: SourceTimeRate
  sourceStartTicks: number
  sourceEndTicks: number
}): ConstantRateAudioStretch {
  throw new Error('not implemented')
  // TODO: canonicalSourceTimeRate, reject unity, reject unordered / unsafe ticks.
}

export function isStretchedAudioClipPlan(
  plan: TimelineAudioClipPlan,
): plan is TimelineAudioStretchedClipPlan {
  throw new Error('not implemented')
  // TODO: return plan.stretch !== undefined
}

export function createTimelineAudioMixPlan(
  doc: TimelineDoc,
  catalog: SourceBoundsCatalog,
): TimelineAudioMixPlan {
  throw new Error('not implemented')
  // TODO: keep today's loop, validation, mute push, volume/enabled skip,
  // crossfade candidate / conflict pass, envelope sort, and clip sort.
  //
  // Direct branch after envelopes. Unchanged phase math.
  //   sourceStart = timelineStart + (sourceFrameAtOffset(0) - clip.timelineStart)
  //   no stretch field
  //
  // Stretched branch after envelopes.
  //   localStart = plan.timelineStartFrame - clip.timelineRange.startFrame
  //   localEnd = plan.timelineEndFrame - clip.timelineRange.startFrame
  //   startTicks = sourceTicksAtTimelineOffset(map, localStart)
  //   endTicks = sourceTicksAtTimelineOffset(map, localEnd)
  //   sourceStartFrame = floor(startTicks / TICKS)
  //   sourceEndFrame = ceil(endTicks / TICKS)
  //   stretch = createConstantRateAudioStretch({ rate, startTicks, endTicks })
}
```

`crossfadeAudioGain` is unchanged.

`crossfadePlan` keeps `retimed-audio-unsupported` only when a linked partner is `muted`. A stretched partner is `supported`, so a valid fade can open handles. Handle capacity already uses `timelineFramesWithinMappedSourceTicks`.

### `src/pipeline/audioStretch.ts` (new)

License of this file is the repo MIT license. The algorithm is first-party TypeScript WSOLA after Verhelst and Roelands, 1993. Do not import Rubber Band, SoundTouch, Signalsmith, `@soundtouchjs/*`, or any other stretch package. Do not add a dependency.

```ts
/** Reject a single pull larger than 1 s at 96 kHz (2 s at 48 kHz). */
export const AUDIO_STRETCH_MAX_OUTPUT_SAMPLES = 96_000

export function audioStretchSourceLeadSamples(sampleRate: number): number {
  throw new Error('not implemented')
  // TODO: window/2 + search, from the time constants below.
}

export function createConstantRateAudioStretcher(args: {
  stretch: ConstantRateAudioStretch
  sampleRate: number
  outputStartSample: number
}): ConstantRateAudioStretcher {
  throw new Error('not implemented')
  // TODO: validate sampleRate > 0 safe integer, outputStartSample >= 0.
  // Trust stretch (already constructed). Allocate stereo scratch once.
  // Init hop phase from outputStartSample. First grain uses the exact
  // mapped source sample. No search on that grain.
}

export function wsolaTimeConstants(sampleRate: number): {
  windowSamples: number
  outputHopSamples: number
  searchSamples: number
} {
  throw new Error('not implemented')
  // Internal to this module. Export only for tests.
  // Window 21 + 1/3 ms Hann. Output hop 5 + 1/3 ms. Search ±10 + 2/3 ms.
  // At 48 kHz that is 1024 / 256 / ±512.
  // Snap output hop to a multiple of 4 so outputHop * rate.num / rate.den
  // is an integer for every 25% step.
  // At 44.1 kHz and 96 kHz, round to the nearest legal hop, then derive
  // window = 4 * hop, search = 2 * hop.
}
```

`pull` body.

```ts
async pull(outputSampleCount, readNewSource) {
  // TODO:
  // 1. Reject outputSampleCount < 1, non-integer, or > AUDIO_STRETCH_MAX_OUTPUT_SAMPLES.
  // 2. Compute new source samples for this output, including first-pull lead.
  //    inputHop = outputHop * rate.numerator / rate.denominator.
  // 3. readNewSource(thatCount). Demand two planes of that length. Finite samples.
  // 4. For each output hop
  //      search ±search on mid = (L+R)/2 using AMDF
  //      lowest offset wins a tie
  //      apply the same lag to L and R
  //      Hann overlap-add into the output
  // 5. Normalize by the overlap-add weight so unity-gain 1x grains
  //    (tests only, 1x never ships through this session) stay near 1.
  // 6. Return a new StereoPcm of outputSampleCount. Do not alias input.
  //
  // Mid-clip live start (outputStartSample > 0) does not replay from 0.
  // Grain alignment may differ from a session that ran from the clip head.
  // Timeline duration stays exact. Export always starts at 0 and is the
  // quality reference.
}
```

`close` releases scratch arrays and refuses later `pull`. A second `close` is a no-op.

### WSOLA bounds

Declare these in the stretcher file as constants and tests. Do not put them on the mix plan.

| Axis | Bound |
| --- | --- |
| Quality, nominal | 0.75x to 1.5x. Speech and music stay intelligible. Transient smear is small. |
| Quality, edge | 0.25x, 0.50x, and 1.75x to 4x. Audible grain, echo, or slap is accepted. Pitch is still preserved. No formant correction. |
| Latency, algorithm | One window plus search of source lookback. About 32 ms at 48 kHz. Not added to `AudioContext` delay. Live still schedules against the shared audio clock. |
| Latency, live I/O | Same 0.75 s lookahead pump. Extra decode is the mapped source for that interval plus lead. Worst extra source is 4x times 0.75 s plus lead, about 3.1 s of media. |
| Rate, time | Constant `SourceTimeRate` only. 25% steps, 0.25x to 4x, not 1x, not 0x. |
| Rate, sample | `pull` uses the session sample rate. Export uses `doc.audioSampleRate` (44100, 48000, 96000). Live uses the folded decoded buffer's rate. |
| Channels | Exactly two planes. Fold 1 and 3 to 32 before `pull` with the existing fold-down. Search on mid. Same lag on both ears. |
| Memory, workspace | One stereo scratch per session. Window + 2×search + one hop. About 30 KiB at 48 kHz, 60 KiB at 96 kHz. |
| Memory, pull | One output block ≤ 96_000 stereo samples (750 KiB) plus source at 4x (about 3 MiB) plus lead. No full-clip stretched cache. |
| Concurrency | One session per audible stretched clip. Live and export never share a session or scratch. |
| Determinism | No RNG. Same session start and pull sizes and source bytes yield the same bytes. |

### `src/pipeline/playback-audio.ts`

```ts
function buildAudioClipPlans(
  doc: TimelineDoc,
  catalog: SourceBoundsCatalog = EMPTY_SOURCE_BOUNDS,
): AudioClipPlan[] {
  throw new Error('not implemented')
  // TODO: map mix.clips through framesToSeconds as today.
  // If isStretchedAudioClipPlan(plan)
  //   keep stretch
  //   set sourceStartTime/sourceEndTime equal to timelineStartTime/timelineEndTime
  //     so preparedEventsForOverlap stays 1x against post-stretch PCM
  //   store mediaStartTime = sourceTicksToSeconds(stretch.sourceStartTicks, doc.frameRate)
  //     for the decode adapter only
  // else
  //   today's sourceStartTime = framesToSeconds(sourceStartFrame)
}

function scheduleDirect(plan: DirectAudioClipPlan): void {
  throw new Error('not implemented')
  // TODO: today's openCursor / readPlanInterval / preparedEventsForOverlap.
}

async function scheduleStretched(
  plan: StretchedAudioClipPlan,
  intervalStart: number,
  intervalEnd: number,
): Promise<PreparedAudioEvent[]> {
  throw new Error('not implemented')
  // TODO: open or reuse ConstantRateAudioStretcher on this clip cursor.
  // Decode [mediaStart, mediaEnd] plus lead for this interval.
  // Fold to stereo. pull(timeline samples). Wrap as AudioBuffer privately.
  // Feed preparedEventsForOverlap with identity source times.
}
```

Do not set `AudioBufferSourceNode.playbackRate`. Do not add a preview-only path.

### `src/pipeline/export-audio.ts`

```ts
function wrapStretchReader(
  inner: ExportAudioClipReader,
  session: ConstantRateAudioStretcher,
  plannedSourceStartSample: number,
): ExportAudioClipReader {
  throw new Error('not implemented')
  // TODO: sequential read(n) → session.pull(n, inner.read).
  // Skip lead zeros or media until plannedSourceStartSample on first pull.
  // close() closes session then inner. Second close is safe.
}
```

`reconcileReaders` branches on `isStretchedAudioClipPlan` as in Usage. The 1x branch stays the current `audioSamplePhaseOffset` open.

### Inspector modules

`TimingInspectorSection` and `AudioInspectorSection` call `clipAudioPresentation`. Audio adds one note under the existing fade/balance copy. Timing replaces the `sourceTimeAudioPolicy` ternary that currently says pitch-safe stretch is unavailable.

`TransitionSeam` copy for `retimed-audio-unsupported` changes to ramps and freezes. Constant-rate stretch is no longer that reason.

## Module map

```
ui/inspector/TimingInspectorSection.tsx
ui/inspector/AudioInspectorSection.tsx
        │
        │  clipAudioPresentation
        ▼
domain/sourceTimeMap.ts     policy, compatibility, quality band, ticks→seconds
        ▲
        │  sourceTimeAudioPolicy
        │
domain/audioMixPlan.ts      contributor union, descriptor factory, mix builder
domain/crossfadePlan.ts     muted partners only → retimed-audio-unsupported
domain/selectors.ts         status === 'supported' includes stretch
        ▲
        │  TimelineAudioMixPlan
        │
pipeline/audioStretch.ts    WSOLA session, lead samples, bounds
        ▲
        │  createConstantRateAudioStretcher
        │
pipeline/playback-audio.ts  direct schedule or stretch then schedule
pipeline/export-audio.ts    direct reader or stretch wrapper
        ▲
app/exportController.ts     status === 'muted' unchanged
```

Call chain for a 2x clip during play or export is three files. Mix plan, stretcher, host. Policy runs inside the planner. Inspector is a separate two-file read. `ui/` still does not import `pipeline/`.

`ARCHITECTURE.md` paragraph that says non-1x timing audio is omitted needs a rewrite when this ships. HANDOFF should drop "pitch-safe stretch is future."

## License and distribution

The stretcher is first-party TypeScript in this repository, shipped under the existing MIT `LICENSE`. No GPL Rubber Band runtime. No paid Rubber Band grant. No MPL SoundTouchJS. No Signalsmith WASM port. `package.json` gains no stretch dependency. `THIRD_PARTY_NOTICES.md` does not change for this slice.

Issue #19 slice 6 already rejected an unbounded local WASM proxy. This design does not reopen that.

## What this sketch does not do

- Variable-rate or reverse stretch.
- Playing audio through a 0% hold.
- Sub-frame 1x without a descriptor.
- Preview `playbackRate`.
- Formant repair, AI voice, source separation, cloud offload.
- A second mix plan or a domain function named `createAudioStretchPlan`.
- Sharing one stretcher session across live and export.
