# Audio signal flow

Shared live-playback and export mix contract. Issue #189 owns clip
automation, the track/master mixer, versioned audio-effect descriptors,
shared EQ/compressor/limiter DSP, derived loudness, and built-in presets.
The stage order below does not change.

```
decode
  → fold-down to stereo
  → clip volume / balance (static or integer-frame keys)
  → clip fades / crossfades
  → clip audio effects            [Slice 3–4]
  → track mute / solo
  → track gain / pan              [Slice 2]
  → track audio effects           [Slice 3–4]
  → sum
  → master gain / pan / mute      [Slice 2]
  → master audio effects          [Slice 3–4]
  → meters
  → loudness (derived, off-line)  [Slice 5]
  → output
```

## Clip automation (schema 16)

- Keys live on `Clip.animation` as `'volume'` and `'balance'`.
- Static `clip.volume` (0..2) and `clip.audio.balance` (-1..1) remain the
  fallback when no track exists.
- Keys are clip-local integer frames. Sample-rate evaluation interpolates
  with the same hold / linear / cubic-bezier easing as visual animation.
- Fades and crossfade envelopes multiply **after** automation.
- Audio clips may carry only volume and balance tracks. Video clips may
  carry those too (video-track crossfade audio uses the video clip).
- A static volume of 0 still contributes if a volume key rises above 0.

Meters and loudness analysis never write gain. Playback and export must
call the same `clipAudioGainsAtLocalFrame` helper.

## Track and master mixer (schema 17)

- `Track.volume` (0..2, default 1) and `Track.balance` (-1..1, default 0)
  are constant per lane. Mute and solo stay on the existing track flags
  and `audibleTracks` rule.
- `TimelineDoc.masterAudio` is `{ volume, balance, muted }` with the same
  gain ranges. Master mute silences the summed mix; it does not change
  track mute/solo.
- Track gain/pan multiply after clip envelopes, before the sum. Master
  gain/pan/mute multiply after the sum, then the mix clamps.
- The mixer strip is docked to the timeline. Per-strip meters read the
  10 Hz `audioMeterStore` only.

## Audio effect descriptors (schema 18)

- `AudioEffectDescriptor` is `{ id, type, version, enabled, params }` on
  `Clip.audioEffects`, `Track.audioEffects`, and
  `TimelineDoc.masterAudio.audioEffects`. It never lives on `Clip.effects`.
- `domain/audioEffectStack.ts` is the registry. Unknown types and future
  versions are preserved, reported, and bypassed. Invalid params and
  disabled entries are the same. Both live playback and export probe
  `js-stereo-block`; Inspector reads the app-owned status projection.
- Version-1 types `builtin.eq`, `builtin.compressor`, and `builtin.limiter`
  share one JS stereo block processor for live playback and export. Ready
  stages run in authored order; missing capability / unknown / invalid
  entries stay preserved and bypassed.
- Inspector cards expose bypass, reorder, reset, remove, and built-in
  Voice / Music / Podcast presets. Reset is refused for unknown types.

## Loudness (derived)

- A cancellable scan mixes the program through the same export mixer.
- UI reports integrated LUFS and true peak. Incomplete coverage cannot
  claim complete. Normalize writes an ordinary master-volume change.
