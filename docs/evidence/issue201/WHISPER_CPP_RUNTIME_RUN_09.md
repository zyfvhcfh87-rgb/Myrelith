# Runtime09: all 23 bounded speech cases pass

Source `f1df79b81bc3ab047f4985a243d66649e74b4b5c`, protocol
`85cf484046b376c879d76b55a560ec5e3d7f5e418d4daf4fb83f1812f269fa2b`.
The single granted run exited 0. All 23 cases passed; no missing cases,
unexpected cases, recorded problems or stop reason. No retry occurred.

The 300-second workload completed in 67.115s, with all twelve windows:
eight timed windows / forty timed cues, four explicit untimed text windows.
No endpoint is supplied for those untimed windows; manual timing remains
necessary before Apply. All 2,784 acquired audio samples closed and PCM
stayed within 3,840,000B. English WER was 0.058823529411764705 twice; French
was 0.4. The one-second speech fixture remained untimed, while digital
silence produced no text. This repeated-speech workload is not natural
long-form accuracy evidence.

Cancellation and project replacement retained their owner until cooperative
cleanup. Drain durations were 50ms during model load, 5.2ms during preparation,
5790.3ms during inference and 5827.8ms after project replacement. Pending
requests reject promptly; native drain time is separate from user cancellation.

Offline page reload again required an app connection. Persistent browser
reopen happened to navigate from its HTTP cache, explicitly recorded without
claiming offline navigation support. Both cases restored app-file access with
model downloads prohibited, retained exactly the same verified model cache
identity/provenance, then transcribed offline using a fresh worker. Model
removal passed: no model cache remained, offline inference reported no local
model, and no worker/acquisition began. Final cleanup was verified with zero
owners and storage usage 0; only an empty registry cache remained.

Observed RSS baseline was 272,351,232B and peak 1,212,547,072B; delta
940,195,840B remained below the unchanged 1 GiB ceiling. All 1,010 samples
qualified, with maximum sample/active-epoch gap 108ms and no memory/cadence
failures. Browser launch and the verified-absent interval between browser
epochs remain outside that sampling qualification.

HeadlessChrome/151.0.7922.34 ran on Darwin arm64. This is laboratory evidence
for the exact candidate and fixtures; it does not qualify all browsers,
machines, media formats or production integration.

Independent release at 2026-09-09T09:41:33.924143Z confirmed PIDs 83473,
83502–83505, 84929 and 84965–84968 absent, port 5201 refused (61), profile09
absent, and no owned awake helper. The exclusive slot is released. Exact raw
outcome/journal/attempt/release/prelaunch/outer records are archived beside
this note. Earlier failures and the explicit offline support revision remain
unchanged. See [the current model decision](MODEL_DECISION.md) for the bounded
GO approved by the supervisor before production wiring.
