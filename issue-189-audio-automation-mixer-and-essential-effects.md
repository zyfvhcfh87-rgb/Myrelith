# Issue #189 — Audio automation, mixer, and essential effects

GitHub: [zyfvhcfh87-rgb/Myrelith#189](https://github.com/zyfvhcfh87-rgb/Myrelith/issues/189)

The issue's "feasible first slice" is the whole feature. Myrelith does not ship that as one PR. This plan splits it the way #43 (keyframes), #45 (effect stack), and #71 (color) were split: one complete, gated slice at a time, with the later slices named so slice 1 does not trap the signal-flow order.

**Status:** Slices 1–6 plus the issue's bounded noise-gate option and exact-head automated/Chromium gates are complete on this branch. A user pass and separate publication authorization remain. Do not close GitHub #189 until after that pass.

The original notes below record the staged implementation. After rebasing over adjustment layers, the authoritative schema sequence is: adjustments 15, clip audio automation 16, mixer 17, and audio-effect descriptors 18. `docs/AUDIO_SIGNAL_FLOW.md` is the normative runtime contract.

## Current state

Myrelith now plays and exports through the shared automated clip, track, and master mix model.

| Implemented | Publication gate still required |
|---|---|
| Clip volume/balance automation on integer-frame keys | User pass before issue closeout |
| Track/master mixer and per-strip meters |  |
| Versioned clip/track/master audio-effect stacks |  |
| Shared EQ, compressor, limiter, and bounded noise gate |  |
| Cancellable LUFS and FIR inter-sample true peak |  |
| Voice, Music, and Podcast presets |  |

**Signal flow**

```
decode → fold-down → clip gain/pan automation → fades/crossfades → clip FX
      → track gain/pan → track FX → sum → master gain/pan/mute → master FX
      → meters / derived loudness → output
```

Clip input stages are evaluated before stateful clip DSP in both hosts. Track
and master effects follow their own gain/pan stages. Loudness reuses export
mixing, measures an explicit full-timeline or timeline-In/Out range, and owns
cancellation through fetch, decode, read, and cleanup. Inspector reports live
and export effect readiness independently.

## Binding decisions (all slices)

1. **One mix model, two hosts.** Domain owns planning and evaluation. `pipeline/export-audio.ts` and `pipeline/playback-audio.ts` consume it. No second Web Audio-only gain path, and no export-only DSP.
2. **Reuse clip animation.** Do not invent a parallel audio-keyframe type. Keys stay clip-local integer frames, same easing, same 1,024/track and 100,000/document budgets, same source-time ticks.
3. **Static fields stay the fallback.** `clip.volume` and `clip.audio.balance` remain. A missing animation track means "use the static value," same as opacity.
4. **Linear gain, not dB.** Keep 0..2 volume and -1..1 balance. Display may later show dB; storage does not change.
5. **Audio effects never go on `Clip.effects`.** That array is the visual compositor stack. Audio descriptors will be sibling lists on clip / track / master.
6. **Meters and loudness never write gain.** Analysis is derived. A separate Normalize action may author an ordinary volume change.
7. **No VST/LV2, unlimited bus graph, or cloud denoise.** Presets are ordinary replacements over the stable descriptor contract.

**Documented signal flow** (write this in `docs/AUDIO_SIGNAL_FLOW.md` in Slice 1; later stages occupy labeled empty slots):

```
decode
  → fold-down to stereo          [exists]
  → clip volume / balance keys   [Slice 1]
  → clip fades / crossfades      [exists]
  → clip audio effects           [Slice 3–4]
  → track mute/solo              [exists]
  → track gain / pan             [Slice 2]
  → track audio effects          [Slice 3–4]
  → sum
  → master gain / pan / mute     [Slice 2]
  → master audio effects         [Slice 3–4]
  → meters                       [exists; Slice 2 adds per-strip]
  → loudness (derived, off-line) [Slice 5]
  → output
```

Playback may keep using `AudioParam` curves for Slice 1 gain/pan. When clip effects land, both hosts must run the same block processor so order stays identical. Slice 1 therefore extracts a **pure** `clipAudioGainsAtSample(...)` now, even if playback still feeds those values into `setValueCurveAtTime`.

## Slice map

| Slice | Ships | Schema |
|---|---|---|
| **1** | Clip volume/balance automation, shared live/export evaluation, Inspector keys, signal-flow doc | 15 → **16** |
| 2 | Track + master gain/pan/mute, mixer strip UI, per-strip meters (10 Hz, no audio-rate React) | 16 → **17** |
| 3 | Versioned `AudioEffectDescriptor` registry, unknown preservation, capability status, bypass/reorder/reset | 17 → **18** |
| 4 | Built-in parametric EQ, compressor, limiter, and bounded noise gate. Shared block DSP. Reference fixtures within declared tolerance | no schema bump |
| 5 | Local cancellable loudness + true-peak; incomplete coverage cannot claim complete; Normalize is a separate gain edit | derived cache, not project mutation |
| 6 | Presets, only after Slice 3's contract is stable | later |

Pitch-safe constant stretch (#188) is already in this worktree. Slice 1 evaluates automation on the **timeline** sample grid, after stretch, so retimed clips keep the same clip-local keys.

---

## Slice 1 — Clip gain and pan automation

### Schema 15 → 16

Identity bump. No new clip fields. `CURRENT_TIMELINE_SCHEMA_VERSION = 16` at this slice.

`ClipAnimationProperty` gains `'volume' | 'balance'`. Portable validation already rejects unknown property names (`clipValidation.ts`), so older builds must refuse schema-16 files via the version gate rather than "unsupported animated property."

Migration `migrateClipAudioAutomation` (schema 15 → 16): bump `schemaVersion` only. Existing animation tracks are unchanged. Intentional schema-15 fixtures in `projectFile.test.ts` stay on 15 and must migrate.

Fix the stale `Clip.volume` comment in `schema.ts` to **0..2**.

### Domain evaluator

In `domain/clipAnimation.ts`:

- Add the two properties to `ANIMATABLE_CLIP_PROPERTIES`, labels, `readClipAnimationProperty`, `animationPropertyValueError` (volume 0..2, balance -1..1), and `applyAnimatedValues` (write `clip.volume` / `clip.audio.balance`).
- Relax `evaluateAnimationTrack` to accept **finite** clip-local frames, not only integers. Keys stay integers. Interpolation already uses `(frame - left.frame) / (right.frame - left.frame)` plus existing hold/linear/cubic-bezier. Visual callers keep passing integers.
- `resolveClipAnimationAtFrame` then shows playhead volume/balance in the Inspector for free.

New pure helper, used by both mixers:

```ts
clipAudioGainsAtSample(plan, sampleIndex, doc) → { volume, leftGain, rightGain }
```

Exact clip-local frame from the existing export sample grid:

```
local = (docFrame - clipStart) + (sample - sampleAt(docFrame)) / (sampleAt(docFrame+1) - sampleAt(docFrame))
volume  = evaluateAnimationTrack(volumeTrack, local, staticVolume)
balance = evaluateAnimationTrack(balanceTrack, local, staticBalance)
[left, right] = stereoBalanceGains(balance)
```

NTSC frame lengths are not a constant sample count. Do **not** divide by `sampleRate / fps`. Reuse `audioSampleBoundary` from export-audio (or lift that helper into domain if playback needs it without importing pipeline).

### Mix plan

`createTimelineAudioMixPlan`:

- Keep static `volume` / `balance` / `leftGain` / `rightGain` as the no-automation snapshot.
- Attach the clip's volume/balance animation tracks (or a cheap flag + clip id). Do not bake time-varying gain at plan time.
- Include a clip when `clipContributesAudioOutput(clip)` is true, **not** only `volume > 0`.
- `clipContributesAudioOutput`: `audio.enabled`, not text, and either static volume > 0 or a volume track with any key > 0 (mirror `clipContributesVisualOutput`).
- Use that helper in `outputMediaAssetIds`, `exportController.partialTrackConflict`, and `audioPlaybackAssetIds`.

### Export

In the existing per-sample loop (`export-audio.ts` ~713–722), replace `plan.volume * plan.leftGain/rightGain` with `clipAudioGainsAtSample`. Fades and crossfade envelopes stay as they are and **multiply after** automation (documented order).

No extra per-sample allocation: evaluate into locals, same as today's `gainAtSample`.

### Playback

- Include `clip.animation` (volume/balance tracks only is enough; including the whole animation object is simpler and correct) in `audioPlaybackPlanKey`.
- When volume or balance is animated, always build a 129-point curve for the clip gain and, if needed, the L/R balance gains — the same `PLAYBACK_EQUAL_POWER_CURVE_POINTS` budget already used for fades. Sample `clipAudioGainsAtSample` (or the time-domain equivalent) at those points, then multiply fade/crossfade. Static clips keep the current constant-gain path.
- Do not introduce an AudioWorklet in Slice 1.

Declared live/export tolerance: same as other audio gates — exact for linear/hold at integer-frame boundaries; 129-point piecewise-linear vs per-sample cubic-bezier may differ inside a curve segment. Tests lock integer-frame boundaries and a documented max abs error on a bezier ramp (state the epsilon in the test; do not hide it).

### History / Inspector / UI

- `updateClipAudioAtFrame` next to `updateClipVisualAtFrame`: if that property is already animated, upsert a key at the playhead; otherwise write the static field. One history entry. Reject playhead outside the clip for animated edits. Honor the document keyframe budget.
- `updateClipAudio` (static) stays for Reset and for clips with no volume/balance track.
- `AudioInspectorSection` reads `resolveClipAnimationAtFrame(clip, playhead)` so sliders show the live value. Commits go through `updateClipAudioAtFrame`.
- Expose `AnimationCurveEditor` for **audio clips**, filtered to `volume` and `balance`. Video clips keep the existing visual property list and also offer volume/balance (video-track crossfade audio uses the video clip's volume). Linked A/V: volume/balance edit the **audio** member, which `AudioInspectorSection` already targets.
- Keyboard and `role` patterns match the existing animation editor. No audio-rate React: transport already publishes playhead at frame rate.

### Files (Slice 1)

- `docs/AUDIO_SIGNAL_FLOW.md` (new contract)
- `ARCHITECTURE.md` — one paragraph pointing at that doc; extend the audioMixPlan bullet
- `src/domain/schema.ts`, `clipAnimation.ts`, `clipAnimation.test.ts`
- `src/domain/projectFile/projectTypes.ts`, `migrations.ts`, `clipValidation.ts`, `projectFile.test.ts`
- `src/domain/selectors.ts`, `audioMixPlan.ts` (+ tests)
- `src/domain/operations/audioText.ts` or a sibling `updateClipAudioAtFrame`; `operations/animation.ts` already accepts any `ClipAnimationProperty`
- `src/state/documentStore.ts` (+ tests)
- `src/pipeline/export-audio.ts`, `playback-audio.ts` (+ tests)
- `src/app/exportController.ts` if preflight still uses `volume <= 0`
- `src/ui/inspector/AudioInspectorSection.tsx`, `Inspector.tsx`, `AnimationCurveEditor.tsx` (+ tests)
- Mechanical `schemaVersion: 15` → `16` in current-document test fixtures; leave intentional v15 migration fixtures alone

Do **not** add track/master fields, mixer UI, effect descriptors, or loudness in this slice.

### Tests (Slice 1)

- Evaluator: integer keys, fractional sample-grid frames, hold/linear/bezier, out-of-range fallback, volume 0..2 / balance -1..1 rejection
- Split/trim/slip/retime of volume keys (reuse existing animation operation tests with the new properties)
- Mix plan: static zero volume omitted; animated 0→1 included; disabled still omitted
- Export mixer: linear ramp 0→1 over N frames, exact values at frame boundaries on the sample grid; balance left/right; fades still multiply
- Playback plan key changes when a volume key is added
- `updateClipAudioAtFrame` keys vs static; one history entry; locked track reject; budget reject
- Inspector: audio-only clip can add a volume key at playhead; undo restores static
- Project file: schema 15 without volume tracks migrates to 16; schema 16 with volume tracks round-trips; future schema 17 still rejected

### Browser gate (Slice 1)

Exclusive strict port (e.g. `42189`). Synthetic speech or tone fixture.

1. Import → drop on A1 → Inspector Volume 1.0
2. Add volume keys: clip frame 0 = 0, last frame = 1, linear
3. Play: audible fade-in; meters move; pause/seek/re-prime still clean
4. Export → reopen: fade is in the file (probe RMS of first vs last block)
5. Balance key left→right on a stereo fixture; both live and export
6. Split in the middle: left half keeps early keys, right half is shifted; one undo
7. Reload/recover preserves keys
8. Console: 0 warnings, 0 errors
9. Device change / seek still tears down the old audio session (existing ownership)

### Gate

Focused tests for the files above, then `npm test`, `npm run build`, `npm run lint`. Production audit and diff checks. Then the Chromium gate. No issue closeout until the user passes it.

---

## Completed subsequent slices

**Slice 2 — mixer.** Add `Track.volume` / `Track.balance` (defaults 1 / 0) and `TimelineDoc.masterAudio: { volume, balance, muted }`. Schema 17 identity migrate. Mix after clip envelopes, before the sum; master after the sum. UI: a mixer strip docked to the timeline (not a fourth workspace column). One fader + pan + mute/solo per audio track, plus master. Reuse track-header mute/solo. Meters: extend the existing 10 Hz `audioMeterStore` with per-track peaks; React reads the store only. Keyboard/screen-reader on native range/buttons. Usable at 720px.

**Slice 3 — descriptors.** Schema 18 adds `AudioEffectDescriptor` (`id`, `type`, `version`, `enabled`, `params`) on clip, track, and master. Registry in `domain/audioEffectStack.ts` mirrors `effectStack.ts`: unknown preserve, invalid/unsupported/disabled status, capability probe per host (playback AudioContext vs export). Inspector cards expose bypass, reorder, and reset.

**Slice 4 — DSP.** Built-in parametric EQ, compressor, limiter, and bounded stereo-linked noise gate are version-1 types. Pure block processors use fixed work per block with no per-sample allocation. Export mixer and playback both call them in the same stage order. Missing capability / future descriptor / cancel / failure keep authored intent and an exact status.

**Slice 5 — loudness.** Cancellable derived job (pattern from motion-analysis / video scopes). Explicit measurement range. Incomplete coverage cannot claim complete. UI reports LUFS + true peak. Normalize is a separate action that writes ordinary gain. Never mutate because a scan ran.

**Slice 6 — presets** after Slice 3 is stable.

**Out of scope forever for #189:** VST/LV2, unlimited buses, recording/comping, cloud denoise, silent gain mutation.

## Risks

- Mechanical schema-14 fixture update will fail a first full test run if any current document is missed. Fix fixtures only; do not rewrite legacy migration cases.
- Video-track crossfade audio uses the **video clip's** volume. Automating volume on a linked A/V pair must edit the audio member for timeline audio and, separately, the video member only if we expose it. Inspector already routes the Audio section to `audioClip`. Video animation dropdown should label Volume/Balance clearly so it is not confused with opacity.
- 129-point playback curves vs per-sample export: lock boundary samples, declare interior epsilon.
- `evaluateAnimationTrack` relaxation must not change visual integer results (existing clipAnimation tests).
