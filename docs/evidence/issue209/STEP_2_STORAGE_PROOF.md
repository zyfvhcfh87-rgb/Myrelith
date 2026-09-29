# Issue #209 Step 2 — recording store feasibility

Date: 2026-09-21. Branch: `codex/issue209`. Scope: disposable Chromium OPFS
probe only; no production capture, media import, or project code changed.

## Method

The [standalone probe](../../../scripts/issue209/run-storage-probe.mjs) serves a
local page and dedicated worker to a temporary persistent Chromium profile.
The worker writes 48 kHz mono PCM16 into an OPFS WAV with a sync access handle.
It accepts at most 16 KiB per transferred batch; the page refuses a fifth
batch when 64 KiB is awaiting acknowledgements. A 256 KiB cadence flushes
audio, writes and flushes one of two alternating 32-byte checkpoint records,
then repairs/flushes the 44-byte WAV header. Each record has version, sequence,
PCM byte length, marker, and checksum. Recovery chooses the newest valid record
whose length fits the physical file, truncates an uncommitted tail, reconstructs
the WAV header, and flushes it. If both records are invalid, recovery must fail
closed; the probe never guesses how many trailing samples are good.

The runner uses deterministic synthetic PCM, not microphone audio. It kills a
worker and reloads its page for one take; for another it kills the whole
Chromium process with `SIGKILL`, then opens the same temporary profile and
origin. It injects a short write, a `QuotaExceededError`, a corrupt header,
and a damaged newest checkpoint record. Actual disk quota is not exhausted.
The probe deletes all seven WAV/checkpoint pairs and its temporary profile.

Host: Apple Silicon (`arm64`), macOS 27.0, Playwright Chromium for Testing
151.0.7922.34, headless; temporary localhost origin. Browser's initial
`navigator.storage.estimate()` reported 10,240 MiB quota and less than 1 MiB
usage for this new profile. That estimate is advisory and is not a durability
or free-space guarantee.

## Results

| Scenario | Measured result |
| --- | --- |
| Bounded write / overrun | Four 16 KiB transfers reached exactly 65,536 bytes in flight. Fifth offer returned `BackpressureOverrun` without queueing. 4,194,304 PCM bytes became a 4,194,348-byte WAV; `decodeAudioData` decoded 2,097,152 mono frames at 48 kHz. |
| Worker termination and page reload | A flushed 262,144-byte checkpoint survived. Recovery truncated physical 278,572 bytes to 262,188 and decoded 131,072 frames. A corrupted WAV header was reconstructed from the journal. |
| Browser process kill and reopen | Same 262,144-byte checkpoint survived `SIGKILL` and reopening the profile. The 16,384-byte uncommitted tail was removed; resulting WAV decoded 131,072 frames. This is process-crash evidence, not power-loss evidence. |
| Torn newest checkpoint | After two checkpoints (524,288 PCM bytes), corruption of the newest record caused recovery to select the older 262,144-byte record. The file truncated from 524,332 to 262,188 bytes and decoded. |
| Short write / quota | Injected write returned 8,192/16,384; the writer detected it. Injected `QuotaExceededError` was reported distinctly. Both takes reopened from the prior checkpoint and decoded. Real quota exhaustion remains untested. |
| Full candidate duration | Streamed 345,600,000 zero PCM bytes (60 minutes at 48 kHz mono PCM16) in 16 KiB transfers. File size was 345,600,044 bytes, WAV header length matched, peak pending payload was 16 KiB in this sequential pass, and the next 2-byte offer returned `TakeLimitExceeded`. Only the 44-byte header was read for this large file; its entire duration was not decoded or played. The approximately 1.68 s write time reflects this synthetic local cache/profile and is not a real-time performance guarantee. |
| Cleanup | All seven draft pairs removed; no leftover probe file remained. |

The recording path allocates at most 64 KiB of outstanding transferred PCM
payload plus small headers and metadata; it does not build a whole-take Blob or
PCM array. This is a **queue bound**, not an instrumented total browser heap
measurement. The small-fixture `decodeAudioData` check intentionally reads a
whole 4 MiB WAV and decoded PCM for QA; production validation must avoid doing
that for the full-duration take. The 60-minute streaming pass used only a
header/size check, so its long-file decoder compatibility remains to be proven
in the implementation and acceptance steps.

## Locked candidate and decision

**Voiceover storage: GO, qualified.** With Step 1's clock GO, the voiceover
feasibility gate can proceed to Step 3 when requested. Use one original WAV
and a separate two-slot checkpoint journal in a dedicated recordings area.
Flush data before journal, journal before header; validate lengths/checksums
and repair/truncate on recovery. A corrupted newest slot sacrifices at most
one checkpoint interval; at 48 kHz PCM16, 256 KiB represents about 2.73 s.
Recovered audio must be visibly marked interrupted and offered for explicit
keep/discard, never silently imported.

Candidate caps: **48 kHz mono PCM16, 16 KiB batch, 64 KiB outstanding,
256 KiB checkpoint interval, 60 minutes and 512 MiB hard per take including
staging/header**. At exactly 60 minutes, the WAV is 345,600,044 bytes
(approximately 329.59 MiB), well below 512 MiB. Enforce both duration and
byte cap in production, preflight storage with an advisory estimate, and stop
on actual failures. Do not extrapolate the synthetic throughput to a real
microphone session or claim that a flush survives power loss. Step 5 must test
the production journal I/O and terminal failure paths; Steps 6 and 12 must
test real-time input, browser suspension, decoding, and retained originals.
No fallback to unbounded memory recording is authorized.

## Reproduce

With project dependencies installed:

```sh
node scripts/issue209/run-storage-probe.mjs
node --check scripts/issue209/storage-probe-worker.js
node --check scripts/issue209/storage-probe.mjs
node --check scripts/issue209/run-storage-probe.mjs
./node_modules/.bin/oxlint scripts/issue209
```

This research checkpoint did not run the full product build or test suite;
there were no product source edits. Browser API references:
[OPFS sync handles](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle),
[worker access and flush](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system),
and [Chromium process information](https://chromedevtools.github.io/devtools-protocol/tot/SystemInfo/).
