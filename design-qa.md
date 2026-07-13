# Design QA — Project launch and resume

## Reference and intent

- Source: user-provided 1553 × 880 launch wireframe attached to the Slice 3 task.
- Reference viewport: 1553 × 880.
- Implementation keeps the reference's large centered frame, title near the
  top, and two side-by-side project actions. Colors, type, spacing, focus
  treatment, and control styling use WebCut's existing dark editor language.
- The extra supporting copy is functional: it distinguishes configurable
  creation from portable-project validation and media relinking.

## States checked in Chrome

- Home at 1553 × 880, compared directly with the source in one stacked image.
- New Project with 4K, 60 fps, and 96 kHz selected and activated.
- Resume with a validated 1440p60 `.webcut`, one missing source, one ready
  source, and the final activated editor/media-pool state.
- Narrow Home at 390 × 844; cards stack without clipping or horizontal scroll.
- Keyboard-facing semantics: one H1 per launch state, labelled fields, status
  and alert regions, visible focus rings, and disabled controls while work is
  pending.

## Findings and fixes

- The first desktop pass centered the whole content group too low compared with
  the wireframe. The Home frame now matches the reference's 620 px centered
  footprint and top-aligns its content, bringing the title/action baselines in
  line with the source.
- No clipped content, stretched assets, stray placeholders, unreadable text,
  or broken responsive states remain in the checked flows.
- Chrome console after Create and full project-file/media Resume: zero warnings
  and zero errors.

final result: passed

## Slice 4 persistence QA

- Desktop Chrome at the normal 2560 x 1271 viewport: a new project entered the
  editor as **Unsaved changes** with the project identity and
  Projects/Save/Save As/Export controls visible.
- The saved-project Resume surface validated a 1920 x 1080, 30 fps, 48 kHz
  `.webcut`, activated its two video tracks plus one audio track, and showed
  the expected read-only resumed-project state.
- At 1280 x 720, the project name/status and Projects/Save/Save As/Export
  controls stayed inside the toolbar with no document or toolbar overflow.
- Dirty Projects navigation raised Chrome's native confirmation. Clean
  navigation returned directly to Home.
- The OS-owned Save picker cannot be completed through the Chrome extension
  test surface. Handle adoption, write/close/abort behavior, debouncing, edits
  during a write, cancellation, honest download fallback, unload ownership,
  stale session completion, save quiescence, blocked closing-time edits, and
  ordered editor teardown are covered by focused Vitest regressions. The final
  picker-first Save and quiesced Projects teardown corrections were made after
  the Chrome session was finalized, so those two paths are not claimed as
  manual browser verification.
- Final Chrome console: zero warnings and zero errors.

Slice 4 result: passed
