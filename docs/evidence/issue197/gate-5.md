# Gate 5: production video buses

Accepted locally on 2026-09-06. Timeline schema 20 migrates to schema 21 with
empty track/master video effect arrays; outer project format remains 7. Static
stacks share descriptor validation, global identity and effect budgets with
clips, including dormant sequences and sequence duplication. Unknown and
wrong-stage descriptors roundtrip without gaining execution authority.

The shared immutable plan carries sequence id, child-local integer frame and
instance path. Production composition borrows existing leg/group surfaces in
the order established in Gate 4. Media/text opacity and transition mixing
precede track processing; adjustment items retain their existing stage; child
captions/master finish before the enclosing track; root captions precede master.
Empty tracks remain transparent and multicam coverage gaps remain opaque black.
Only registered post-composite stages with explicit opaque-input preservation
are eligible. Geometry, lens, mask/chroma and current plugins remain clip-only.

The bus readback and maximum dimension-scaled algorithm scratch enter Program's
high-water reservation before dispatch and exact lens source/output admission
before remapping. The 256 MiB render ceiling is unchanged. Existing separate
codec/plugin/native ownership limits remain separate; this is not a bound on
the entire browser process. Bus pixel/readback failures fail closed and borrowed
pixels are cleared in `finally`; no additional persistent canvas is introduced.

The Inspector offers static parameters, bypass, order, reset/remove, and the
shared preset browser for the selected video track or sequence master. Mask,
chroma and plugin choices explain their bus restriction. Editing uses one
whole-project history commit and generation checks; rejected edits preserve
redo. Native Chromium verifies undo/redo, fresh preset ids, portable roundtrip,
actual autosave/recovery and narrow-panel controls. The in-app browser also
exercised native master insertion and parameter editing.

## Evidence

- 306 focused Vitest tests in ten files and all 17 repository runner checks.
  Architecture checks pass, including updating current-schema fixtures while
  retaining explicit historical migration fixtures.
- Build/typecheck and lint pass; build retains the existing chunk-size advisory.
- Eight muted headless Chromium checks pass together in 34.7 seconds.
- `production-nested-buses.json`: real WebGL2 lens correction is available;
  masks, same-mode crossfade/opacity, adjustment, screen blend, child/root
  captions, child master, enclosing track blur and root master match explicit
  child composition with maximum RGBA difference **0**. An injected bus readback
  error propagates and clears borrowed group pixels. Owners close in `finally`.
  This checks the production compositor; the depth-eight design/resource proof
  remains separately identified in Gate 4.
- `production-plugin-bus-export.json`: installed signed Audited Invert plus
  vignette/preset clip effects, track blur and master color adjustment. Actual
  six-second encoded output is 365,954 bytes. Preview mean RGBA is
  `[241,188,137,255]`; decoded output is `[240,188,136,255]` (predeclared lossy
  tolerance 8). The project is unchanged. A repeated prepared export cancels
  after progress; after joined cleanup, the admission ledger exactly matches
  before export: one Program owner, four decoder slots, 40,820,612 bytes and no
  blockers. These are app reservations, not a native-memory measurement.

An earlier overlapping-edit browser run was discarded after Vite reloads;
the accepted run held source files steady. Final project-wide acceptance is
recorded separately in Gate 6.
