# Issue #209 Step 1 — voiceover clock feasibility

Date: 2026-09-21. Branch: `codex/issue209`. Scope: disposable Chromium clock
probe only; no production capture or project/media code changed.

## Method

The standalone [probe](../../../scripts/issue209/clock-probe.html) requests a
real microphone from a click, connects it to a two-input `AudioWorkletNode`,
and schedules three count-in-like clicks and one target click on the **same**
48 kHz `AudioContext`. The other worklet input receives that reference signal.
The worklet reports `currentFrame`, block length, microphone RMS/peak, and
reference RMS/peak; it outputs silence. It never posts PCM or writes an audio
file. An optional low-volume reference path goes directly to the selected
speaker for an acoustic round-trip measurement. A 120 ms main-thread stall
checks whether callback delivery affects the worklet's sample count.

`app/transportController.ts` already exposes `getPlaybackClockContext()`, and
`pipeline/playback-audio.ts` returns the context-time anchor passed to the
video engine. This standalone proof uses the same shared-context scheduling
shape. Actual transport joining remains Step 8, so these measurements are not
in-app voiceover acceptance.

Host: Apple Silicon (`arm64`), macOS 27.0, Playwright Chromium for Testing
151.0.0.0. Browser permission was granted to this temporary local origin by
Playwright; the OS already allowed the test browser to use a microphone. This
step did not test Myrelith's future permission UI. The primary real input was
the USB HyperX QuadCast at 48 kHz, two channels, with echo cancellation, noise
suppression, and automatic gain control reported off. Acoustic passes selected
the built-in MacBook Pro speakers without changing the system default output.

## Measured facts

| Probe | Worklet result | Input/output and delivery |
| --- | --- | --- |
| USB mic, silent reference, 120 ms main-thread stall | 994 consecutive 128-sample blocks; 0 frame discontinuities; all four reference onsets in their scheduled render block | Track latency setting 2.666 ms; `baseLatency` 5.333 ms; `outputLatency` 13 ms. Message delivery lag peaked at 53.3 ms. |
| Built-in mic + speakers, audible reference, 120 ms stall | 984 consecutive blocks; 0 discontinuities; four aligned reference onsets | Built-in mic track was live but every measured input level was zero. No acoustic delay could be resolved from this device on this host. |
| USB mic + speakers, audible reference, 120 ms stall | 984 consecutive blocks; 0 discontinuities | Speaker `outputLatency` estimate 27 ms; acoustic correlation resolved at 50.7 ms in the first pass and 80 ms in a repeat. The repeat's message receipt interval error peaked at +94.5 ms during the stall. |
| USB mic + speakers, audible reference, no stall (two passes) | 984 consecutive blocks in each; 0 discontinuities | Acoustic correlations resolved at 77.3 and 80 ms; no-stall receipt interval errors stayed within ±0.3 ms. |
| USB mic, permission revoked during capture | 994 consecutive worklet blocks; reference clock continued | The track changed to `ended`, emitted one `ended` event before own cleanup, and its input level fell to zero. |

All recorded reference starts matched the containing 128-sample render block:
scheduled sample frames 24,000/48,000/72,000/96,000 appeared in blocks starting
23,936/48,000/71,936/96,000. Worklet block continuity is the meaningful clock
fact; main-thread message arrival is not a recording timestamp. In normal
cleanup, `track.stop()` changed `readyState` to `ended` without firing an
`ended` event, so the owner must also handle its own stop path explicitly.

The acoustic values are **round-trip** delay: browser output, speaker,
air/room path, microphone hardware and browser input. They do not isolate mic
latency. The first 50.7 ms value differs from the later 77.3–80 ms group, and
the track's 2.666 ms latency setting is only an estimate. This data cannot
justify a universal automatic voiceover shift.

## Candidate policy and decision

**Clock feasibility: GO, qualified.** Keep the worklet's integer sample-frame
positions and the playback/count-in anchor on one `AudioContext`. Step 3 must
convert those sample positions to timeline frames with exact rational math;
Step 8 must verify the actual transport join. Candidate default physical
compensation is **0 samples**, visibly uncalibrated, with a bounded signed
adjustment or later per-device calibration. Do not infer placement from wall
time, worklet message arrival, `MediaRecorder` chunks, or the reported latency
settings. The overall voiceover go/no-go remains open until Step 2 proves
bounded storage and decodable partial recovery.

Device loss should listen for the real `ended` event and check `readyState` at
await boundaries; own stop must settle independently because it emits no event.
The built-in mic's all-zero input needs explicit silent-input handling in the
product. No physical unplug or OS-wide permission change was performed.

## Reproduce

With project dependencies installed (or the ignored root `node_modules`
symlink in this worktree):

```sh
node scripts/issue209/run-clock-probe.mjs
ISSUE209_MICROPHONE='HyperX QuadCast' ISSUE209_SPEAKER='MacBook Pro Speakers' ISSUE209_STALL_MS=0 node scripts/issue209/run-clock-probe.mjs --audible
node scripts/issue209/run-clock-probe.mjs --revoke
```

The runner serves only its three local probe files, uses a fresh browser
context, and closes browser, context, stream, and audio graph after each pass.
`node --check` passed for all three scripts; `oxlint scripts/issue209` passed.
No full product build or suite was run for this research-only checkpoint.

Browser API references: [worklet sample frame](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletGlobalScope/currentFrame),
[estimated track latency](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/latency),
[estimated output latency](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency),
and [track ending](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/ended_event).
