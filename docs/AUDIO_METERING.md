# Playback audio metering

Issue #66 adds objective playback-level feedback without creating another
playback clock, mixer, or export-gain path.

## Ownership and data flow

`pipeline/playback-audio.ts` owns two 256-sample `AnalyserNode` windows inside
the existing master Web Audio graph. The channel path is:

`master gain -> stereo splitter -> L/R analysers -> stereo merger -> output`

The analysers do not schedule playback. `AudioContext.currentTime` remains the
master clock, and `PlaybackEngine` continues deriving integer timeline frames
from the audio session anchor.

`app/transportController.ts` samples the session diagnostics every 100 ms
(10 Hz), applies the meter ballistics, and publishes one serializable snapshot
to `state/audioMeterStore.ts`. React reads that store only. There is no
audio-rate React subscription and the meter loop never advances playback.

## Scale and ballistics

- Sample peak is measured independently for left and right; master is the
  greater channel peak. Stereo RMS remains available to existing diagnostics.
- Mixer strips add the same peak/ballistics per audio track after that
  track's fader and pan, before the master bus. React reads
  `audioMeterStore.trackReadouts`; it never samples Web Audio itself.
- The display floor is -60 dBFS, the overload boundary is 0 dBFS, and the
  display ceiling is +6 dBFS.
- Attack is immediate. Release is 18 dB per second.
- A raw peak at or above 0 dBFS holds the affected overload indicator for two
  seconds and latches the warning until explicit reset.
- Reset changes feedback only. It does not alter clip volume, playback gain, or
  export gain.

Reference fixture: for L `[0, 0.5, -1, 0.25]` and R
`[0.25, -0.25, 0.5, -0.5]`, channel peaks are `1` and `0.5`, master peak is
`1`, and stereo RMS is `sqrt(1.9375 / 8)`.

## Lifecycle semantics

- Paused/stopped: level and hold return to the floor; a latched overload stays
  visible until reset.
- Priming: the UI reports that playback levels are being prepared.
- No audible clip at/after the playhead: unavailable; no meter timer runs.
- Decode, AudioContext, or diagnostics failure: unavailable. Video-clock
  fallback behavior remains unchanged.
- Seek/scrub, stop, playback supersession, project close, and audio-device
  change cancel the old timer before stopping its session. A generation and
  session identity check prevents late callbacks from publishing stale data.
- Project close/disposal removes the device listener and resets levels,
  overload state, sequencing, and sample metadata.

## Accessibility

Left, right, and master are ordinary `role="meter"` values with names, bounds,
and a stable dBFS text alternative. The live region announces status changes
only; it does not announce 10 Hz numeric updates. Overload reset is a native
button, so it works with keyboard and assistive technology without a custom
gesture.
