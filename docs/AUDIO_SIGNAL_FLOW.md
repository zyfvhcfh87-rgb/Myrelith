# Audio signal flow

Shared live-playback and export mix contract. Issue #189 Slice 1 owns
clip volume/balance automation. Later slices fill the labeled stages
below without reordering the ones that already exist.

```
decode
  → fold-down to stereo
  → clip volume / balance (static or integer-frame keys)
  → clip fades / crossfades
  → clip audio effects            [later]
  → track mute / solo
  → track gain / pan              [later]
  → track audio effects           [later]
  → sum
  → master gain / pan / mute      [later]
  → master audio effects          [later]
  → meters
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
