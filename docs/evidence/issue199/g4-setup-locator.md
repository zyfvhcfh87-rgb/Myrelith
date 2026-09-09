# Issue 199 — source-only project setup locator correction

The first failed mixed attempt is preserved separately in evidence-only commit
`f845e1a3a533bcae5842b44b3e10aaf72c8b3a58`. Root and worker independently verified
native release before this correction. No retry has run.

Only one expression changes in the owned G4 driver: resolution selection targets
`.project-field-resolution select` instead of exact label text `Resolution`.
It still performs native `selectOption('720')`, whose retained option is exactly
1280 × 720. Product markup, CSS, fixture, generated media, protocol, output
predicates and deadlines are unchanged.

The trace contains one full resolution-label node, including its span, select
and all four options. Its descendant label text normalizes to
`Resolution1280 × 7201920 × 10802560 × 14403840 × 2160`. The installed Playwright
label engine reads native labels through recursive elementText and compares the
normalized text exactly in strict mode. Thus the failing lookup cannot equal
`Resolution`. The new selector uses the observed existing label class and its
single select; it does not guess a replacement accessible name.

Remaining setup selectors were checked against retained DOM and current source:
Start a new project is the real button text and passed in attempt one; Project
name is its wrapping label and filled successfully; Create project is the submit
button text after editor loading completes, and is present in the failure DOM;
Commands is an explicit Toolbar aria-label. The source's horizontal720 preset is
1280 × 720. `inspection.json` retains the exact resolution node, option values,
label-text derivation and installed Playwright bundle hash.

Node syntax check, inert runner source inventory and source whitespace checks
pass. All939source paths were compared to the accepted source manifest:938are
unchanged and only execute.mjs has the one-line delta. The original manifest and
failed attempt remain untouched. `verification.json` records before/after hashes
and exact raw/copied inspection/check artifacts. No browser, export, build or
other segment ran during this correction. Parent review and a new grant remain
required before any further native observation.
