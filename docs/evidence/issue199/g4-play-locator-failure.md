# Issue 199 — second G4 attempt passed two checkpoints, then stopped at Play

The one granted attempt ran at clean source
`cbb9ad83676a5b90805fedd85e0cd70ca850652f`. The setup selector correction worked.
Two runtime checkpoints passed: generated VP9/silent-WAV fixture with canonical
2× retime, split at15 and exact undo/redo references; then native title Set key,
value entry, copy and paste. The title result records exactly three history
entries, keys at0/14/20/29 with exact local ticks and values−120 at14and20.

The third step timed out after15seconds looking for exact button name `Play`,
before native playback. The retained trace shows the existing transport button's
explicit aria-label and title are lowercase `play`; TransportBar source uses
lowercase `play`/`pause`. No harness correction or retry was made in this evidence
checkpoint. No portable reopen, mixed export, decoded pixel/PCM or final
application-admission observation was reached. Generated source bytes remained
in browser memory: the later source-file persistence step was not reached, so no
raw source or mixed export artifact is claimed.

Console/page problems are empty. Separately, step02and failure DOM/screenshots
show `Recovery copy failed` in the toolbar; step01DOM does not. The worker viewed
step02and failure images. This visible warning is retained without classifying it
as harmless or a product defect. The attempt does not qualify project recovery.
The two passed checkpoints do not mean the full mixed gate passed.

The driver ran20:45:38.105Z–20:45:57.329Z (19.224seconds). Driver cleanup released
at20:45:57.289Z; supervisor exited20:46:00.259Z without expiry or fallback signals.
Independent worker verification20:47:10.804Z confirmed all eight PIDs absent,
private-profile command absent, port5199clear, all939source hashes unchanged and
source clean. No actual pmset sleep/wake transition occurred in the run window.
The exclusive slot is released.

Driver33158, caffeinate33190, server33191 and browser33196/33197/33198/33199 have
recorded exact PID/start/command identities. Supervisor parent33144 has its
recorded PID only because the live observer arrived after completion; its absence
is verified, with no live parent start/command claim. Native cleanup is separate
from the unexecuted final media-reservation assertion.

Raw evidence remains untouched at
`/private/tmp/issue199-g4/2026-09-08T20-45-37.918Z/`: two step PNG/DOM pairs,
failure PNG/DOM, trace, full result/source hashes, supervisor, server log and
private profile. The trace passes integrity with152entries. The top-level raw
hash manifest and ten exact-JSON/normalized-text copy mappings are retained in
`g4-attempt2/`. The result hash also matches the runner's artifact pointer.
The first failed attempt remains independently preserved.

No build or other native segment ran. Parent evidence/source review and a new
explicit grant are required before any correction and retry. This source-module
diagnostic supplies no ordinary production-bundle, first-paint, mixed-export,
performance or whole G4 acceptance claim.
