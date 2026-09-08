# Issue 199 — third G4 attempt stopped at the prepared-export guard

One granted run at clean `be8d2592384b75225be64e80779cbe0ebb1ee753` passed five
runtime checkpoints: canonical fixture activation and retime/split/undo; native
title key editing; muted playback with silent live audio; edited portable-file
reopen/relink with exact sequence payload and unknown-effect preservation; and
Animation layout/focus at1440and720pixels. Both widths matched document scroll
width. These passes do not close the full G4 gate.

The sixth checkpoint stopped before its intended missing-font preflight.
`startExport` rejected with “Plugin-aware export requires a prepared one-shot
attempt.” The diagnostic expected a font/fallback refusal, so it failed and stopped.
The existing export-controller guard requires prepared ownership whenever output
plugin descriptors are reachable. The fixture retains its disabled unknown plugin
descriptor. No descriptor, guard, source, tolerance or harness correction was made.
No mixed export bytes, Program reference probes, decoded pixels/PCM, final
application-admission assertion or final persistence-settle observation occurred.

The passive session record contains26events, exactly equal in the standalone file
and raw result, with no errors. It records successful recovery updates for both
the launcher document and the canonical g4 session. No captured DOM contains the
prior Recovery copy failed notice. Console/page problems are also empty. This
qualifies the observed session window only, not long-term recovery behavior.

Initial and edited portable projects, generated VP9 source video, silent WAV and
oracle WAV are preserved with exact hashes. The live source WAV is stereo48kHz
with all192000PCM payload bytes zero. This is an input-file check, not a decoded
export PCM pass. The edited portable hash matches the step result, and all source
file hashes match their recorded preparation/save metadata.

The driver ran21:18:48.739Z–21:18:54.219Z (5.480seconds). Driver cleanup released
at21:18:54.177Z; supervisor finished21:18:57.113Z without expiry or fallback
signals. Independent worker verification21:20:06.663Z found all ten recorded PIDs
absent, no live private-profile owner, port5199clear, all941source hashes unchanged
and the worktree clean. No actual pmset sleep/wake transition occurred in the run
window. The exclusive slot is released; the private profile remains as evidence.

The supervisor parent42521 has its recorded PID only because the independent
observer arrived after completion; absence was verified without a live parent
start/command claim. The driver and recorded native descendants have exact
PID/start/command identities. Native exit does not substitute for the final
application resource assertion, which was not reached.

Raw evidence is retained under
`/private/tmp/issue199-g4/2026-09-08T21-18-48.562Z/`. It includes five step PNG/DOM
pairs, failure PNG/DOM, session events, portable/source files, full result and
source hashes, supervisor, server log, trace and private profile. The trace passes
integrity with204entries. The worker viewed step05after return to Timeline.
`g4-attempt3/raw-artifacts.json` covers every top-level raw file;
`failure-summary.json` maps16exact-JSON/portable or normalized-text copies to
untouched originals, including prelaunch and independent cleanup records.
Earlier failed attempts remain preserved.

No automatic retry, product change or additional native segment ran. Parent
review is required before any correction or new grant. This source-module
attempt supplies no ordinary production-bundle, first-paint, mixed-export,
performance or whole-G4 acceptance claim.
