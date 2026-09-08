# Caption owner admission under synchronous store callbacks

The parent review of 86fc308 reproduced a mismatch: retainCaptionOwners publishes
a new owner array and synchronously notifies subscribers. A subscriber could
replace the project before prepareDocument's following pin check. That check
threw while the session still held the old candidate/review and the ledger
charged the new owners. Schema24 was not accepted at that checkpoint.

CaptionEditSession now uses one guarded owner-admission helper. After successful
registration it rechecks the pinned project/generation/sequence and session life.
Any stale check or subscriber exception disposes the actual captured project,
candidate, review and reserved IDs, then releases its owner. A returned budget
rejection publishes nothing and preserves the old review/ledger. Constructor
capture uses the same guard. No-op reduction holds the guard across release and
recapture, rechecks immediately after release, and cleans up if a subscriber
interrupts either step. Nested prepare, no-op and Apply cannot overwrite an
in-progress admission. Disposal stays allowed and causes the outer operation to
fail its fresh pin check.

The correction does not restore an external subscriber's project or history;
it cleans only its own stale owner. Unrelated failed mutations and redo/history
semantics remain unchanged. The parent ignored reproducer was run unchanged and
passes. Fifteen real-store tests cover project replacement, same-project reload
generation, active sequence navigation, disposal, throwing subscribers, nested
style/no-op/Apply, and interruptions during no-op owner reduction. They assert
both removal of held session references and matching ledger cleanup, plus
preservation of the external/current project and history branches.

Validation: 18 focused files / 326 tests, all17 bundled runner checks,
build/typecheck and lint pass. The existing Vite chunk advisory remains. This is a separate
caption correction; the independently prepared candidate05 lab source is not part
of this commit. Painter/UI and speech execution remain behind their review gates.
