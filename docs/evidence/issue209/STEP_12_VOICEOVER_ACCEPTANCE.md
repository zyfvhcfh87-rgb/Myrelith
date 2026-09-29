# Issue #209 — Step 12 voiceover acceptance (real devices)

Date: 2026-09-29. Host: Apple Silicon, macOS 27, Playwright Chromium for
Testing 151. Microphone: USB HyperX QuadCast (default input). Outputs: wired
headphones (default) and MacBook Pro Speakers. The user consented to real
microphone capture and one explicitly audible loopback pass. Every recording
was deleted after measurement; only numbers are recorded here.

Runners (not part of `npm run test:browser`):

```text
npx playwright test --config scripts/issue209/acceptance/playwright.config.ts voiceover-quiet
npx playwright test --config scripts/issue209/acceptance/playwright.config.ts voiceover-loopback   # audible
node scripts/issue209/acceptance/run-lifecycle.mjs                                                 # one visible window
```

## Results through the product UI

| Scenario | Result |
| --- | --- |
| 20 s real take, Keep in Media Pool | 972,800 samples (20.27 s), exactly on a 30 fps frame boundary (1,600 samples/frame). File = 44 + 2 × samples bytes. Imported duration equals the sample count. Real room signal (RMS 0.005–0.007). |
| 3-minute real take, forced GC every 15 s | 180.2 s, 16.5 MiB written. **Retained JS heap flat at 51.2–52.0 MiB** (growth 0.5 MiB after the first 15 s). Nothing accumulates per take. |
| Permission revoked mid-take (`clearPermissions`) | Chromium ends the track. Review shows `source-ended` and recovers 131,072 samples (one whole 256 KiB checkpoint). |
| Real background tab (raw CDP; Playwright pins pages visible) | `visibilitychange: hidden` interrupts. Review shows `hidden` and recovers one whole checkpoint. Discard deletes the files. |
| Audible loopback: timeline clicks → MacBook speakers → QuadCast | The take succeeded under real output load. The acoustic onset was **not resolvable**: matched-filter SNR 4–8 with 20 ms 2 kHz beeps, so the mic did not hear the laptop speakers in this room setup. |

## Findings that changed the product

1. **The audio render clock skips *and* repeats quanta under real output
   load.** With real speakers active, the shared `AudioContext` delivered a
   +2.1 s skip in one run and a −128-frame repeat in another. Both previously
   failed the take as `writer-failed`. The worklet now keeps every sample on
   its exact context frame. Skips up to 0.5 s are padded with silence;
   repeated frames are not rewritten. Both are reported as a `gap` message, and
   the panel says how many ms were affected. Jumps beyond ±0.5 s still fault.
   After the fix a loopback take padded 1,280 samples (~27 ms) and finished
   normally. Unit tests drive the real worklet file in a fake
   AudioWorkletGlobalScope.
2. The `m:ss.t` elapsed label parser in the acceptance helper was wrong past
   one minute. The first "3-minute" run was really 2 minutes. It was fixed and
   rerun.

## Latency policy (decision)

The acoustic round trip could not be measured in this setup. Step 1 measured
50.7–80 ms (speakers → QuadCast), and the browser reports 2.7 ms track and
13–38 ms output latency estimates. The default therefore stays **0 ms,
labelled uncalibrated**, with a manual signed offset of ±500 ms. The offset
shifts the whole capture window, so length and placement frame are unchanged.
No automatic shift is claimed. Digital alignment of the capture window to the
selected frame is exact (Step 8 spec, plus the take landing on frame
boundaries above).

## Qualification

Real microphone capture, reopen, long-take memory, device revocation, and
background-tab interruption pass on this host. Physical speaker-to-mic latency
remains per-device and manual. Unplugging the USB microphone was not
exercised; its path is the same `ended` event as revocation.
