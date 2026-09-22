# Issue #209 Step 6 — microphone worklet to WAV writer

Date: 2026-09-23. Branch: `codex/issue209`. Scope: worklet capture and its
bounded app bridge. A caller supplies a live audio `MediaStream`, a 48 kHz
`AudioContext`, an integer start sample frame, and a created Step 5 writer.
Permission, track ownership, transport scheduling, import, and product controls
remain in later numbered steps.

## Contract

The worklet takes one mono input and explicitly fills every output channel
with zeroes. The app bridge also connects its output through a zero-gain node.
PCM16 conversion happens on the worklet render thread with little-endian
samples. Every batch carries its first absolute `AudioContext` sample frame,
frame count, and sequence. The bridge rejects a missing or repeated sample
interval. A scheduled stop can end within a render block and flush a smaller
final batch. An input gap, missed start, or late stop is an error rather than
a silently moved recording boundary.

One batch contains at most 8,192 samples (16 KiB). The worklet has four
credits. It releases a credit only after the Step 5 writer acknowledges that
batch; the app also checks its independent 64 KiB transfer ledger. With all
four credits occupied, the next sample produces an overrun terminal event.
The bridge waits for accepted writes, stops/checkpoints the writer, and reports
the exact truncated sample interval as an interrupted result. Other faults
close the writer so its prior flushed checkpoint can be recovered.

## Chromium gate

The checked-in [browser test](../../../tests/browser/issue-209-microphone-bridge.spec.ts)
ran the production worklet, app bridge, and OPFS writer in Playwright Chromium.
It used a deterministic oscillator as a live `MediaStream` audio track so the
source could be measured without a permission prompt. The context stayed
suspended during setup, then ran at 48 kHz.

| Scenario | Observed result |
| --- | --- |
| Scheduled source and stop | Batches began at the requested integer sample frame and then at +8,192; they contained 8,192 and 3,808 samples. The result, WAV payload, and decoded mono audio each contained exactly 12,000 samples. The recorded PCM had nonzero input signal. |
| Digital output | A meter connected directly to the worklet output observed a zero peak while the WAV contained the oscillator signal. The normal destination path also has a zero-gain guard. |
| Blocked writer | With append acknowledgements held, exactly four 16 KiB batches reached 65,536 pending bytes. The worklet stopped at start +32,768 samples, sent no fifth batch, and the bridge stopped the writer once after the four accepted writes completed. |

These are real browser graph and writer observations with a synthetic source.
Physical microphone permission, hardware input behavior, device ending, and
acoustic leakage through independently played speakers are Step 7/8/12 gates.
The test meter proves digital silence on the worklet path; it does not measure
speaker-to-microphone acoustic bleed. AudioWorklet render quantum length is
read from the actual output buffer rather than assumed to be 128 frames, as
[the Web Audio process contract](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process)
requires. The absolute frame is taken from
[`currentFrame`](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletGlobalScope/currentFrame),
and the worklet communicates through its
[`MessagePort`](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/port).

Validation passed: 2 Playwright Chromium flows, 11 focused Vitest cases and
the runner's 28 Node checks, production build/typecheck, lint, and diff check.
Lint still reports five pre-existing warnings; Vite still reports its large
chunk notice. The browser test checks source-to-WAV data and writer stop; a
later keep operation must call the Step 5 `finalize()` file check explicitly.

## Reproduce and remaining gate

```sh
NODE_OPTIONS=--no-experimental-webstorage npm test -- src/app/voiceoverWavBridge.test.ts src/pipeline/voiceoverWavDraft.test.ts
npx playwright test tests/browser/issue-209-microphone-bridge.spec.ts
npm run build
npm run lint
git diff --check
```

Step 7 must own `getUserMedia()`, stop all tracks on every terminal path,
handle denial/source ending/visibility/project replacement, and retire a
late worklet or writer callback before state changes. Step 8 supplies the
shared playback/count-in anchor and proves placement of a real take.
