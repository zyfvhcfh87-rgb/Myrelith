# Tracking controller integration review

Accepted source: pure tracking `9c3cb54788f904bd1546a8e339a830166d13a463`,
app controller `05bb72b5f00f5bf26b92bd890247fe07bab0325d`, schema23 seam
`8d22cbc86539ea8ea4931f656f35e112aa4c25f0` and correction
`8cc1fe997688f541df0a19a9be41ddf5657550ed`.

The parent reviewed the complete planner, checked operation, controller, tests
and preview-owner merge. Tracking uses the admitted directional analysis and
fresh source geometry, refuses the complete proposal on crop loss, authors
ordinary mask scalar lanes and requires consent bound to complete replaced
lanes. Canonical title-owner guards exclude compact, supported and future titles.
Review previews remain separate from document/history and cover only the
accepted tracking range. Apply repeats planning, admission and currentness
before one portable edit.

Three parent reproductions failed on `8d22cbc` and are fixed by `8cc1fe9`:

- A valid project containing 100,000 keys in a dormant sequence admitted a
  preview and reported a changed Apply while retaining the original project and
  empty history. The controller now rejects a changed sequence operation when
  the project replacement helper returns the original identity. Exact 100,000
  total keys, one-over refusal and genuine no-ops are covered.
- A cleanup callback starting playback allowed the final commit. Playing and
  scrubbing are now checked after cleanup callbacks, preserving history and redo
  on refusal.
- Leaving and reentering the accepted range displaced a newer animation
  preview. Temporary range suppression now preserves the tracking owner's
  activation order; explicit disable/cancel releases it.

The parent's unchanged reproducer passes all 27 cases on corrected source.
The combined branch independently passes **16 files / 253 Vitest tests**, **17
runner checks**, build/typecheck, lint and diff hygiene. Its product, test and
dependency files match the accepted worker checkpoint exactly. Logs:
`/private/tmp/milestone9-tracking-app-tests.log`,
`/private/tmp/milestone9-tracking-app-build.log`, and
`/private/tmp/milestone9-tracking-app-lint.log`. The existing Vite chunk-size
advisory remains. Failed and corrected reproductions are retained in the issue
worktree as recorded in [the worker evidence](../issue198/tracking-attachment.md).

Inspector activation is not part of this checkpoint. Its source and dedicated
near-file-cap checks precede a separate quiet browser gate for actual tracking,
undo/redo, save/reopen, playback/export pixels and cleanup. Measured 4K resource
and final full-suite/audit acceptance remain open. The earlier five mask browser
flows do not establish tracking acceptance.
