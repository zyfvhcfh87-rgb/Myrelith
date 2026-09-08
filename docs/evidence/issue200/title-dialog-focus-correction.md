# Title dialog keyboard focus correction

The ca23f62 run completed the wide controls case with native font selection
UNVERIFIED, then failed Roll/crawl containment after the last control. All six
traversed controls passed corrected geometry/contrast before Tab moved focus from
Cancel (identity 78) to BODY (79), outside the modal. Raw result:
`/private/tmp/issue200-keyboard-ca23f62-01`. Result 1 completed, 1 failed, 2 unrun,
zero retries; all 15 captured processes/5200 released at 21:50:01.329274 UTC.

Both title dialogs now use the same small boundary-Tab handler, following the
existing application-dialog pattern. Tab from the last available control focuses
the first; Shift+Tab from the first focuses the last. Disabled, hidden, inert and
non-tabbable controls are excluded. Interior navigation and native Escape remain
unchanged. This affects Roll/crawl, template capture and the template library.
The existing component suite checks both wraps for all three modes, interior Tab,
Escape and unchanged project/past/future; no general dialog framework was added.

The requested offline review also found Direction's closed ArrowDown operation
would invoke the suppressed Mac popup. The native gate instead presses `r` from
verified up to cycle to the next Roll option, retaining the exact down assertion
and all preview/history/cancellation requirements. Chromium's native
[typeahead handler](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/forms/html_select_element.cc)
uses prefix matching and first-character cycling. Installed-browser confirmation
remains required. As explicitly directed, if typeahead still leaves Direction up,
require unchanged focus/project/history, annotate that selection UNVERIFIED and
continue every remaining focus/preview/cancellation check. Unexpected selection or
state change still fails. No synthetic selection or further popup investigation.
Other remaining assumptions were checked: dynamic controls are re-read, all three
dialogs share the fix, actual opener focus restoration is unchanged, internal
scrolling uses corrected modal ancestry, and destination track is only traversed.

Focused source checks passed 25 tests plus 17 runner checks, app TypeScript and
focused lint. The first draft test used a wrong builtin label; its retained log is
`/private/tmp/issue200-title-dialog-focus-tests.log`; the corrected source result is
`/private/tmp/issue200-title-dialog-focus-tests-final.log`. The existing native
font-menu segment remains explicitly UNVERIFIED. No browser retry, production
rebuild, full suite or additional gate was run during this source correction.
