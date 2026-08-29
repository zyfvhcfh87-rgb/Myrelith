# Candidate B rationale

## Problem

Myrelith currently has one direct audio plan. Its contributors assume a 1x relationship between timeline frames and source frames. Constant non-1x clips are omitted, which keeps preview and export aligned but mutes common edits. The new path must preserve pitch, scheduled duration, gain policy, the audio master clock, and bounded cleanup. It must also keep exact 1x clips on the current path. The hard design question is where stretch geometry belongs without teaching the direct mixer or the domain model about a third-party algorithm.

## Usage (caller's view)

Playback and export each build two plans from the same document. They pass the pair to one pipeline join.

```ts
const plans = {
  direct: createTimelineAudioMixPlan(doc, sourceBounds),
  stretched: createTimelineAudioStretchPlan(doc, sourceBounds),
}

const contributors = createTimelineAudioPcmContributors({
  doc,
  plans,
  mode: 'live',
  onStretchStatus,
})
```

Export changes only `mode` and resource ownership. Asset preflight calls `timelineAudioPcmAssetIds(plans)`. No caller chooses SoundTouch options, handles interleaved buffers, or coordinates a worklet with a separate export algorithm.

## Shape

`SourceTimeAudioPolicy` becomes a three-case union. `direct` means exact 1x with an integer source origin. `stretch` carries a branded constant non-1x rate. `silence` carries one authored reason. This split prevents the direct planner from calling a stretch-eligible clip muted, and it prevents exact 1x from entering the stretch plan, per `principle-type-system-discipline`.

`TimelineAudioMixPlan.clips` stays direct-only. `TimelineAudioStretchPlan.clips` stores a nested `TimelineAudioMixWindow`, exact source-tick bounds, and a branded constant rate. The nested value keeps gain, fade, envelope, and output-window invariants separate from source consumption. `audioMixPlan.ts` remains the authority for mix rules. `audioStretchPlan.ts` owns only constant-rate mapping, per `principle-model-the-domain`.

`timelineAudioMixWindowForClip` is the shared deep operation. It resolves enablement, volume, balance, fades, linked crossfade handles, and envelopes. Both planners use that result. This avoids a second crossfade policy without exposing its stages to callers. The helper earns its boundary because it hides a body of mix knowledge, per `principle-minimize-reader-load`.

The pipeline receives both plans and constructs a private direct-or-stretched contributor union. This is the only join. Playback and export then differ in scheduling and lifecycle, not in stretch algorithm. `pcmTimeStretch.ts` is the only module that imports `@soundtouchjs/core`. Domain and UI code see no package types, per `principle-boundary-discipline`.

The adapter processes canonical stereo PCM with pitch fixed at 1 and tempo set from the domain rate. Both live and export use that adapter. Live schedules its output through ordinary `AudioBufferSourceNode` nodes at 1x. The audio clock remains the playback clock.

The first implementation pins the MPL-2.0 `@soundtouchjs/core` 2.1.1 package. It ships no WebAssembly and no audio-worklet package. Fixed input, output, memory, concurrency, and latency limits guard the JavaScript path. A later WebAssembly implementation needs a separate review. The package choice stays private, so that review need not change domain types or caller usage.

This is a deep interface. Callers provide two immutable plans and receive contributors. The boundary hides policy classification, crossfade window planning, tick-to-sample conversion, SoundTouch buffers, output accounting, admission, and mode-specific failure behavior. Callers still choose live or export because unavailable stretch has a different terminal effect. Live reports silence. Export blocks finalization.

The design starts with the plan types and the fixed PCM contract before adding algorithm logic, per `principle-foundational-thinking`.

## Synthesis decision

pending arena pick

## Tradeoffs accepted

- We accept two domain plans in exchange for keeping the proven 1x plan free of rate fields and stretch overhead.
- We accept one pipeline join in exchange for keeping package and runtime details out of `domain/`.
- We accept a branded TypeScript rate that can be defeated by an explicit cast in exchange for compile-time exclusion in ordinary code.
- We accept an 8 MiB stretch budget and an explicit resource-limit result in exchange for a finite live-memory bound.
- We accept live silence after a stretch runtime failure in exchange for keeping playback responsive and reasoned. Export fails instead of writing a misleading final file.
- We accept audible artifacts at 0.25x and 4x in exchange for covering the complete authored constant-rate range with one algorithm. The quality gate can still reject the package if measured results miss the declared limits.
- We accept linked crossfade work inside the plan slice in exchange for one mix-window authority. Dropping crossfades would make fade behavior depend on retime status.
- We accept an MPL-2.0 runtime dependency and its notice and source obligations in exchange for avoiding GPL terms and a new first-party DSP implementation.

## Alternatives considered

- Add an optional rate to `TimelineAudioClipPlan`. This makes one broad plan, but every direct caller must learn stretch states and exact 1x loses structural bypass. The interface hides less because rate checks spread into playback, export, asset preflight, and tests.
- Replace both plans with one new contributor union in `domain/`. This gives callers one value, but it rewrites the stable 1x contract and makes algorithm-driven work the organizing concept for all audio. Candidate B keeps the new capability additive and joins it where PCM processing starts.
- Stretch decoded clips to cached temporary audio before playback or export. This hides DSP from the mixers, but it adds cache provenance, invalidation, storage, and progress policy. It also delays first playback and duplicates finite-file ownership. The interface is larger than the first slice needs.
- Use `AudioBufferSourceNode.playbackRate` for live and SoundTouch for export. This is smaller code, but it exposes two algorithms and gives users different pitch and timing. It violates the shared-algorithm requirement.
- Use Rubber Band for both paths. Its GPL terms or commercial grant become a product-wide distribution decision. The algorithm may hide DSP complexity, but the license cost is outside this issue's allowed shape.

## Open questions and risks

- Can `@soundtouchjs/core` 2.1.1 run with fixed circular buffers without retaining more than the 1 MiB per-session allowance?
- Does the pinned package keep p95 processing below 8 ms per 4,096 stereo frames on the minimum browser test machine at every admitted rate?
- Do speech, percussion, and sustained-music fixtures meet the block-boundary and pitch gates at both 0.25x and 4x?
- Does the package flush enough samples to meet the exact scheduled output count without padding?
- Should live runtime failure silence only the failed clip, or should it stop the complete playback session after publishing the reason?
- Should export reject before opening the sink when static admission already exceeds eight overlapping stretch contributors?
- Does the existing crossfade source-bounds resolver admit constant non-1x audio handles after it switches from frame bounds to exact tick bounds?
- Does the MPL distribution review require a vendored source archive, or is the pinned upstream source offer plus package contents sufficient for Myrelith's release format?

## Next implementation step

Write policy and plan tests for direct, constant non-1x, ramp, freeze, invalid curve, sub-frame origin, fade, and linked-crossfade cases before importing `@soundtouchjs/core`.
