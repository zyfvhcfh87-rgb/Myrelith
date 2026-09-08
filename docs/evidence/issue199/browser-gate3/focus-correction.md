# Gate3 source correction — return focus after deliberate Animation close

The production early rerun at exact42eb93b / harness8f3cd77 passed the corrected
entry and all six no-motion handle cases, then reproduced BODY focus after
Back to Timeline. Zoom, integer origin, clip selection and project data were
preserved. The original native assertion remains unchanged and failed evidence
is retained. No test was bypassed and no later heavy case ran.

The Animation Back button unmounted itself and its focused grid without handing
focus to a surviving control. EditorShell now owns a deliberate close callback:
cancel through the existing app facade, close the dock, then restore focus to
the stable Timeline Animation entry after React commits, with preventScroll.
The same callback covers the lazy-load failure Close button. The workspace
accepts that callback and retains its existing facade default for standalone
composition. No document-wide focus query, extra tabIndex, timer, transport
DOM reference or focus on ordinary cleanup was introduced.

Only an explicit Back/Close callback requests restoration. Project closing
clears that request without focusing the inert editor; unrelated transport
closure, playback and viewport changes do not request focus. Component checks
cover entry from Timeline and Inspector, shared viewport/clip/project truth,
project closing, direct transport closure and unrelated playback/viewport
updates. Both focused return tests failed before the fix (2failed/14skipped).

Final focused qualification: five files /71 Vitest tests plus17 runner checks,
TypeScript/Vite production build, lint and diff checks. Existing chunk-size
advisory remains. A preliminary build rejected a test-only Testing Library
locator option; that log is retained as gate3-focus-build-rejected.log. Removed
the unsupported option and reran the focused tests and build on final source.
No prior larger test matrix is being reclassified as current acceptance.

Changed product/test files are EditorShell.tsx, EditorShell.test.tsx and
AnimationWorkspace.tsx. All242 observation source hashes are recorded in
focus-correction-hashes.json; the previous accepted product is42eb93b. The
committed early runner still pins42eb93b and cannot run this changed source.
Source review, a separately committed repin and a fresh browser grant remain
required. The rest of the approved protocol remains pending; ignored
continuation drafts were not promoted or executed.
