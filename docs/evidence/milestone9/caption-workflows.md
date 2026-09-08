# Caption workflow browser acceptance

The two focused Chromium flows in
`tests/browser/issue-201-caption-workflows.spec.ts` use canonical portable project
setup and actual visible editing, file inputs, downloads and keyboard events.
They do not qualify local transcription or native OS file pickers.

- ASS font substitution, disclosed-loss acceptance, actual SRT/VTT/ASS downloads,
  unchanged project data, released caption owners, and 390px keyboard containment
  passed at integration `39cefe6`. Original downloads and a narrow screenshot are
  retained in `.tmp/milestone9-caption-browser-02`.
- Batch selection, review/cancel, one-history-entry Apply, cue style overrides,
  appearance advisories, Undo/Redo, and actual portable Save/Open passed at
  `48d23cb` in 3.2 seconds. The mixed project preserved its expanded title and
  dormant future-version caption style. Caption owners were empty after closing
  and reopening. Evidence is in `.tmp/milestone9-caption-browser-03`.
- Both passed flows reported no browser page or console errors. The standard
  runner is muted and uses a private browser context. Its server on port 41732
  was confirmed closed after execution.

Initial attempt01 had two test assumptions corrected: the selected-option query
also counted unrelated dropdowns, and Chromium adds a native keyboard stop on
the scrollable loss disclosure. Attempt02 passed ASS/narrow coverage but waited
on the headless OS Save picker. The last attempt reused the established portable
download/file-input fixture setup; no application behavior changed for these
corrections. Original failure screenshots, traces and logs remain in the two
earlier attempt directories and `/private/tmp/milestone9-caption-browser-*.log`.

The reviewed caption integration separately passed 98 focused tests across seven
files plus the 17 canonical runner checks. Final combined engineering checks and
the separate transcription workflow are recorded by the milestone closeout.
