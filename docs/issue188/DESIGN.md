# Issue 188 grafted design

> Historical constant-rate slice. This contract produced PR #213. The final
> variable-rate and 0x behavior is specified by [RAMP_DESIGN.md](RAMP_DESIGN.md),
> which supersedes this file wherever this file says ramps or freezes mute.

Fill in `not implemented` bodies against this file. If a body needs a parameter this file does not name, stop and change this file.

Base: candidate A. Grafts and rejections: `SYNTHESIS.md`.
Algorithm and license: `../AUDIO_TIME_STRETCH_RESEARCH.md`.

## Usage

An editor sets a 25% step between 25% and 400%. Preview and export play the same pitch-stable audio. Exact 100% stays on today's decode path. This historical slice left variable ramps and 0% freezes silent; `RAMP_DESIGN.md` completes those cases.

Callers import the plan from `audioMixPlan` and the stretcher from `pipeline/audioStretch`. They do not import WSOLA knobs, `AudioBuffer`, `AudioContext`, or WASM types from domain.

### Mix planner

`createTimelineAudioMixPlan` is still the only audible-contributor builder.

```ts
const policy = sourceTimeAudioPolicy(clip)
if (policy.status === 'muted') {
  mutedClips.push({ clipId: clip.id, trackId: track.id, reason: policy.reason })
  continue
}
// envelopes may widen the draft window
if (policy.kind === 'direct') {
  plans.set(clip.id, finishDirectContributor(draft, clip))
} else {
  plans.set(clip.id, finishStretchedContributor(draft, clip, policy.rate))
}
```

`status === 'supported'` still means the clip belongs in `clips`. `outputMediaAssetIds` and export preflight keep that check.

`finishDirectContributor` is today's 1x phase math. It never constructs a descriptor.

`finishStretchedContributor` runs after envelopes. It writes `stretch` from `sourceTicksAtTimelineOffset` at the planned local window. A 2x outgoing handle that grows three timeline frames consumes six source frames.

### Playback and export

Both branch once with `isStretchedAudioClipPlan`. The 1x branch is the current function body. The stretch branch folds decoded PCM to stereo, rechunks to 4,096 frames, pulls timeline PCM from one session, then applies today's gain, fades, envelopes, and clock or sample-grid placement.

Do not set `AudioBufferSourceNode.playbackRate`.

### Inspector

`TimingInspectorSection` and `AudioInspectorSection` call `clipAudioPresentation(clip)`, the same way Timing already calls `sourceTimeAudioPolicy`.

## Types

```ts
declare const constantAudioStretchRate: unique symbol

export type ConstantAudioStretchRate = Readonly<SourceTimeRate> & {
  readonly [constantAudioStretchRate]: true
}

export type SourceTimeAudioPolicy =
  | { status: 'supported'; kind: 'direct' }
  | { status: 'supported'; kind: 'stretched'; rate: ConstantAudioStretchRate }
  | {
      status: 'muted'
      reason:
        | 'invalid-speed-curve'
        | 'speed-ramp-audio-unsupported'
        | 'freeze-audio-silence'
        | 'sub-frame-origin-audio-unsupported'
    }

export type StretchQualityBand = 'nominal' | 'edge'

export type ClipAudioPresentation =
  | { state: 'ready'; kind: 'direct' }
  | { state: 'ready'; kind: 'stretched'; rate: ConstantAudioStretchRate; quality: 'nominal' }
  | { state: 'fallback'; kind: 'stretched'; rate: ConstantAudioStretchRate; quality: 'edge' }
  | { state: 'silence'; reason: Extract<SourceTimeAudioPolicy, { status: 'muted' }>['reason'] }

export interface ConstantRateAudioStretch {
  readonly rate: ConstantAudioStretchRate
  readonly sourceStartTicks: number
  readonly sourceEndTicks: number
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
```

`constant-speed-audio-unsupported` is deleted.

Classification order:

1. Invalid speed curve → `invalid-speed-curve`.
2. Integer-origin 1x, including an all-1x curve → `direct`.
3. Constant stretch compatible → `stretched`. Empty or missing curve with a canonical non-unity rate, **or** a valid curve whose every point is the same canonical non-unity positive rate. Tick origin may be sub-frame.
4. Valid curve with two different positive rates → `speed-ramp-audio-unsupported`.
5. Valid curve that contains any 0/1 hold → `freeze-audio-silence`.
6. 1x map that fails only the integer-origin test → `sub-frame-origin-audio-unsupported`.

`stretchQualityBand(rate)` is `nominal` when `3/4 ≤ rate ≤ 3/2` by cross-multiplication. Every other accepted step is `edge`. `fallback` still plays.

`createConstantRateAudioStretch` rejects unity, zero, and unordered ticks. Then the WSOLA loop trusts the descriptor.

`sourceTicksToSeconds(ticks, frameRate)` is decoder-boundary float seconds. `audioSampleFromSourceTicks(ticks, frameRate, audioSampleRate)` is the document sample grid. Half-sample ties move away from zero.

On a stretched plan, `sourceStartFrame` / `sourceEndFrame` are the decode envelope (floor of start ticks, ceil of end ticks). Exact phase lives in `stretch`.

## Pipeline session

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

export const AUDIO_STRETCH_MAX_OUTPUT_SAMPLES = 96_000

export function audioStretchSourceLeadSamples(sampleRate: number): number

export function wsolaTimeConstants(sampleRate: number): {
  windowSamples: number
  outputHopSamples: number
  searchSamples: number
}

export function createConstantRateAudioStretcher(args: {
  stretch: ConstantRateAudioStretch
  sampleRate: number
  outputStartSample: number
}): ConstantRateAudioStretcher
```

`pipeline/audioStretch.ts` is first-party TypeScript WSOLA after Verhelst and Roelands, 1993. Cite that paper in the file header as the method, not as vendored source. No stretch npm package. Stereo planes only. Fold 1–32 channels first with the existing helper. Search on mid. Same lag on both ears. Deterministic. No RNG.

`createConstantRateAudioStretcher` trusts `stretch` as already constructed. It rejects a sample rate outside 44100, 48000, and 96000, a non-safe-integer sample rate, and a negative or non-safe-integer `outputStartSample`. It allocates stereo scratch once. Hop phase starts from `outputStartSample`. The first grain uses the exact mapped source sample and does not search.

`wsolaTimeConstants` is exported for tests. Window 21 + 1/3 ms Hann. Output hop 5 + 1/3 ms. Search ±10 + 2/3 ms. At 48 kHz that is 1024 / 256 / ±512. Snap the output hop to a multiple of 4 so `outputHop * rate.num / rate.den` is an integer for every 25% step. At 44.1 kHz and 96 kHz, round to the nearest legal hop, then set `window = 4 * hop` and `search = 2 * hop`.

`audioStretchSourceLeadSamples` is one window plus search, from those constants.

`readNewSource` is append-only. The session never asks to rewind. It owns lookback, hop phase, and the overlap-add tail.

`pull` rejects a count below 1, a non-integer, a count above `AUDIO_STRETCH_MAX_OUTPUT_SAMPLES`, and a pull after `close`. It demands two finite planes of the requested source length. Input hop is `outputHop * rate.numerator / rate.denominator`. Each later grain searches ±search on mid `(L+R)/2` with AMDF. The lowest offset wins a tie. The same lag is applied to left and right. Hann overlap-add writes the output. Normalize by overlap-add weight. Return a new `StereoPcm` of exactly `outputSampleCount`. Do not alias input. Extra flush is trimmed. A short result fails.

`close` releases scratch and refuses later `pull`. A second `close` is a no-op.

Hosts rechunk folded source to 4,096 stereo frames before `pull`. At most eight overlapping stretch sessions. Export rejects a ninth before opening a sink. Live marks the denied clip `unavailable` and writes silence for that window. `audioStretchMaximumPcmWorkingBytes` accounts the maximum 4× input/output planes, rechunk, and persistent arrays below a 5 MiB per-session allowance; the eight-session aggregate allowance is 40 MiB. This file does not open decoders or apply gain.

A new session from clip start plus the same pull sizes and source bytes must be bit-identical. Live remake on re-prime is the existing restart. Mid-clip live start may use a declared source lead. Grain mismatch with export is a measured concession, not a documented feature. Export from sample 0 is the quality reference.

## Bounds

| Axis | Bound |
| --- | --- |
| Quality, nominal | 0.75x to 1.5x. Speech and music stay intelligible. |
| Quality, edge | 0.25x, 0.50x, and 1.75x to 4x. Grain or slap is accepted. Pitch stays put. No formant correction. |
| Algorithm lookback | One window plus search. About 32 ms at 48 kHz. Not added to `AudioContext` delay. |
| Live I/O | Existing 0.75 s lookahead. Worst extra source is 4x × 0.75 s plus lead. |
| Rate | Constant branded 25% steps, 0.25x to 4x, not 1x, not 0x. |
| Sample rates | 44100, 48000, 96000. |
| Channels | Exactly two planes after fold-down. |
| Pull cap | 96,000 output samples. |
| Rechunk | 4,096 stereo frames. |
| Persistent workspace | 60,416 bytes (~59 KiB) at 48 kHz; 120,832 bytes (~118 KiB) at 96 kHz for both source planes, Hann, overlap rings, reference/index, and search planes. |
| Concurrency | 8 sessions; 5 MiB/session and 40 MiB aggregate working allowance. |
| Parity gate | Same PCM fixture through live-mode and export-mode adapters is byte-equal before gain. Duration matches the scheduled sample count. Extra flush is trimmed. A short result fails. Pitch error on a steady tone ≤ 10 cents. |

Window 21 + 1/3 ms Hann. Output hop 5 + 1/3 ms. Search ±10 + 2/3 ms. At 48 kHz that is 1024 / 256 / ±512. Snap hop so `outputHop * rate.num / rate.den` is an integer for every 25% step.

## Module map

```
ui/inspector/*  →  clipAudioPresentation
        ↓
domain/sourceTimeMap.ts     policy, quality band, sourceTicksToSeconds, audioSampleFromSourceTicks
domain/audioMixPlan.ts      contributor union, descriptor factory
domain/crossfadePlan.ts     muted partners only → retimed-audio-unsupported
domain/selectors.ts         status === 'supported' includes stretch
        ↓
pipeline/audioStretch.ts    WSOLA session
pipeline/playback-audio.ts  direct or stretch, then schedule
pipeline/export-audio.ts    direct or stretch wrapper
```

Call chain for a 2x clip is mix plan, stretcher, host.

## Out of this slice

- Variable-rate or reverse stretch.
- Held-tone freeze.
- Sub-frame 1x without a descriptor.
- Preview `playbackRate`.
- Formant repair, AI voice, cloud offload.
- A second mix plan.
- Sharing one session across live and export.
- Rubber Band, SoundTouchJS, Signalsmith WASM.
