# Issue #209 — Steps 13–15: A/V timing, camera and screen feasibility

Date: 2026-09-29. Chromium for Testing 151, macOS 27, Apple Silicon.
The probe (`scripts/issue209/av-probe/`) drives the **production** capture
worker, recorder, and recovery scan, then reopens each MP4 with Mediabunny.
Runner: `npx playwright test --config scripts/issue209/acceptance/playwright.config.ts av-timing`
(`ISSUE209_SCENARIOS=…`, `ISSUE209_AV=real`). Captures are deleted inside the
probe.

## Step 13 — the clock facts (why Mediabunny's live sources were not used)

- Mediabunny's `MediaStreamVideo/AudioTrackSource` "synced-zero" anchors each
  track at the main-thread `performance.now()` of its first chunk's
  **arrival**. It also silently drops samples when an encoder queue reaches 8.
  Both violate the plan: arrival lag, which reached 94 ms in Step 1, would
  become a permanent A/V offset.
- **Chromium 151 cannot transfer a `MediaStreamTrack` to a worker**
  (`DataCloneError`). A `MediaStreamTrackProcessor.readable` *is*
  transferable. The page creates the processors, the worker reads them, and
  the page keeps and stops the tracks.
- **Video and audio are stamped on different clocks.** Video frames from a
  camera and from tab capture carry system tick time (≈ 99,500 s, i.e.
  uptime). Audio chunks carry page `performance.now()` time: real QuadCast
  audio arrives 4.1–4.5 ms after its stamp, fake audio 0.1–1.4 ms.
  `captureStream()` canvas frames use page time. Treating the stamps as one
  clock made the first file silently drop all audio.
- **Exact bridge:** a `<video>` playing a clone of the track reports each
  presented frame's `captureTime` on page time
  (`requestVideoFrameCallback`). Its intervals match the processor stamps
  frame for frame: 49.5 ms and 58.5 ms. `stamp − captureTime` is constant to
  0.1 ms (99,523,693,600 / 693,500 / 693,500 µs).
  `domain/avClockBridge` finds that constant from pairwise differences, and
  requires ≥ 5 agreeing pairs within ±0.5 ms. `app/avClockCalibration` runs it
  before recording, for 0.6–4 s: screens only emit frames on change. If no
  capture times arrive, it falls back to an arrival-based estimate, and the
  panel warns the take's lip sync is estimated.
- **Clock rule:** video output time = (stamp − bridge) − base. Audio output
  time comes from its exact sample count. Its capture stamp is compared with
  that sample clock: jitter within ±40 ms is measured only; a lost-input gap is
  padded with silence (≤ 1 s, else fault). Negative drift beyond tolerance is
  reported, never hidden. The base is the first video frame after audio
  starts. Earlier audio is trimmed and later audio gets leading silence.
  Everything is integer µs or samples (`domain/avCaptureClock`).

## Measured results (production worker)

| Scenario (devices) | Result |
| --- | --- |
| Camera + mic, 10 s (Chromium fake camera 1280×720@20, fake mic 44.1 kHz) | Bridge `capture-time`, 23 pairs, 0.2 ms spread. H.264 + AAC both start at 0. Audio sample clock vs capture stamps **max 0.10–0.11 ms**. 200 frames, no drops. Page heap flat (11.6–11.7 MiB). |
| Camera, worker terminated at 6 s | `recover` kept 3 complete fragments, discarded 0 torn bytes. Reopens as 4.05 s video + 4.02 s audio, both from 0. |
| Tab capture + tab audio flash/beep sync, 10 s (real tab, headed) | Bridge 8 pairs, 0.2 ms. **10/10 flashes and beeps paired; audio 66.3 ms after picture (spread 7.7 ms).** This is a stable constant, not drift: Chromium's tab-audio capture stamp latency. It is preserved as recorded and documented (about 2 frames); users can slip the clip. |
| Static tab, 15 s, no audio | About 2 fps (frames only on change). 29 frames, clean file, heap flat. |
| Tab + microphone | Both tracks from 0, drift max 0.11 ms. |
| Tab + tab audio, worker terminated | 2 complete fragments recovered, both tracks. |
| Real camera | **Not available**: the MacBook camera does not enumerate (lid closed with an external display); Continuity Camera enumerates but delivers 0 frames. |
| Real whole screen / window | **Blocked by the OS**: Chrome for Testing lacks macOS Screen Recording permission (`NotReadableError: Could not start video source`). Changing that system setting is the user's choice. Tab capture needs no OS permission. |

Headless Chromium produces no tab-audio output to mirror (peak 0); a headed
run captures it (peak 0.5). `suppressLocalAudioPlayback` keeps captured tab
audio off the speakers. Display audio defaults to echo cancellation, noise
suppression and AGC **on**; the product turns them off for recording.

## Go / no-go

- **Shared A/V writer (Step 16): GO.** Timestamps come from the capture clock
  via a measured bridge. Writes are bounded (the StreamTarget writes
  synchronously into one sync handle, with a flush every ≥ 1 MiB and at stop).
  Encoder backpressure is awaited per sample. Held pre-roll audio is ≤ 1 s.
  A crash keeps every complete fragment.
- **Camera (Step 14): GO for the product path**, qualified. The same path is
  proven with Chromium's camera device. Physical camera lip sync is
  unqualified on this host (no usable camera). Run
  `ISSUE209_AV=real ISSUE209_SCENARIOS=camera` with a camera available.
- **Screen (Step 15): GO** for browser tabs (with or without tab audio, or with
  a microphone). Whole-screen and window capture use the same path but are
  unverified here (OS permission). The UI names the macOS setting when the
  system blocks capture.
- **No-go: display audio + microphone together.** A mix would put audio on a
  third (WebAudio render) clock that is not proven. The UI offers one audio
  source per take.
- Mediabunny `MediaStream*TrackSource`: not used (arrival-time anchoring).
