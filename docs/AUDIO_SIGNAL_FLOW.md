# Audio signal flow

Shared live-playback and export mix contract. Issue #189 owns clip
automation, the track/master mixer, versioned audio-effect descriptors,
shared EQ/compressor/limiter/noise-gate DSP, derived loudness, and built-in presets.
The stage order below does not change.

```
decode
  → fold-down to stereo
  → normalize onto the document sample grid
  → constant- or variable-rate stretch when the timing plan requires it
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

Live playback and export both perform sample-grid normalization before
time stretch and clip effects. Variable-rate sessions consume the same bounded
`RampedAudioStretch` descriptor and first-party WSOLA implementation on both
surfaces; live intervals use differences between absolute document sample
boundaries so fractional frame rates cannot duplicate or drop a sample.
Authored 0% holds are silence at this stage, and a whole-window freeze retains
no source Blob or decoder unless that asset also contributes video or a
structurally complete linked crossfade expands it into an audible source-time
window. Merely having a link id, a missing opposite audio partner, or a still-
silent incoming pre-roll does not retain the source. Export computes this from
one lazy O(n log n) structural transition/link index with per-track clip
lookups, resolves source capacity before cross-track conflicts, then reuses the
captured required-asset set. Source bounds remain descriptor-owned even when a
silent leg is offline; connected Blobs remain separately owned. The playback
`AudioContext` is requested at
the document rate so track/master DSP does not silently move across a browser
resampling boundary. Maximum-pull accounting covers the stereo input/output
planes, 4,096-frame rechunk, and persistent WSOLA arrays below 5 MiB/session
and 40 MiB across the admitted eight sessions.

## Clip automation (schema 16)

- Keys live on `Clip.animation` as `'volume'` and `'balance'`.
- Static `clip.volume` (0..2) and `clip.audio.balance` (-1..1) remain the
  fallback when no track exists.
- Keys are clip-local integer frames. At the decoder/audio-clock boundary,
  sample-rate evaluation uses an ephemeral fractional position with the same
  hold / linear / cubic-bezier easing as visual animation. That coordinate is
  never persisted or used for timeline geometry.
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
  disabled entries are the same. Offline clip/export DSP always owns the
  bounded JS stereo-block host; live track/master buses advertise it only
  when the actual AudioContext provides the processor stage. Inspector reads
  the app-owned projection and reports live and export readiness separately.
- Version-1 types `builtin.eq`, `builtin.compressor`, `builtin.limiter`, and
  `builtin.noise-gate` share one JS stereo block processor for live playback
  and export. Ready
  stages run in authored order; missing capability / unknown / invalid
  entries stay preserved and bypassed.
- Inspector cards expose bypass, reorder, reset, remove, and built-in
  Voice / Music / Podcast presets. Reset is refused for unknown types.

## Loudness (derived)

- A cancellable scan mixes the program through the same export mixer.
- The user explicitly selects either the full timeline or a valid timeline
  In/Out range. The completed reading retains that exact half-open frame range.
- The cancellation signal reaches asset fetch, decoder iteration, sequential
  reads, and mixer ownership; cleanup must settle before a terminal UI state.
- UI reports integrated LUFS and four-phase FIR inter-sample true peak.
  Incomplete coverage cannot claim complete. Normalize writes an ordinary
  master-volume change.
