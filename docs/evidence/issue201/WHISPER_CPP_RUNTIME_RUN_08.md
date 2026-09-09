# Runtime08: long review completes; offline page reload fails

Source `3a0650051c343a28dcc6dba8033872b48749a0c5`, protocol
`19bf7e1080260a1b5eea9d461b44e0a6b56074bad460a7c9cec49f433d8ad5ad`.
The single granted attempt started 2026-09-09T09:29:23.063Z with runner
79781 and exited 1: 20 cases pass, offline-page-reload fails, persistent
browser reopen and model removal remain unrun. No automatic retry occurred.

The complete 300-second workload passed in 66.689s. All twelve original
windows retained nonempty text: eight timed windows with 40 timed cues and
four whole-window untimed review results. Source ranges 50–80s, 100–130s,
125–155s and 175–205s have text with no cue endpoints. Their coverage is not
caption timing; manual timing remains necessary before Apply. Overlap text
remains present for review. Later windows reuse the same model. All 2,784
acquired audio samples closed; maximum owned PCM was 3,840,000B. The long
job's model then acknowledged zero in 2.3ms.

The one-second fixture now returned 11 characters of explicit untimed text
with no timed cues. Ordinary English WER remained 0.058823529411764705 twice;
French remained 0.4, with strictly valid timed output. Digital silence,
cache/acquisition/corrupt-input checks and all cooperative cancellation and
project-replacement cases passed. The loaded application also transcribed
English offline using a fresh worker and then cooperatively released it.

Observed RSS: baseline 287,899,648B, peak 1,191,444,480B, delta 903,544,832B,
under the unchanged 1 GiB ceiling. There were 942 samples; maximum sample
gap was 108ms and maximum active-epoch gap 113ms. No memory/cadence failure
was recorded. This qualifies the observed work, not the unrun cases.

Offline page reload failed at navigation with `net::ERR_INTERNET_DISCONNECTED`.
No overall GO or offline application-shell reload claim follows. Final
runner model/cache cleanup was unavailable after emergency browser close;
filesystem profile removal is not an application Remove-model pass.

Independent release at 2026-09-09T09:32:21.954933Z confirmed PIDs 79781,
79810–79813 and 81122 absent, port 5201 refused (61), and profile08 absent.
No owned awake helper or exclusive slot remains. The initial sandboxed
prelaunch socket probe was denied (EPERM 1); successful runner binding and
independent postlaunch lsof established port ownership, not a prelaunch
availability check. Exact attempt, journal, final outcome, release and outer
log are archived with their identities in the adjacent raw-records.json.
