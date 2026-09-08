# Modal visibility measurement correction

The a7207ca run completed the 1280×720 controls case with native font selection
explicitly UNVERIFIED, then failed the first Roll/crawl dialog control visibility
check. The two narrow cases did not run. Raw failure:
`/private/tmp/issue200-keyboard-a7207ca-01`; all 15 captured processes and port 5200
were released at 21:40:06.680388 UTC. Browser/runner cleanup had no errors.

The retained screenshot shows Start frame fully visible and focused. Its rectangle
is x383/y382.328125, 253×21, inside the modal client x361/y179.28125, 558×361.
The diagnostic incorrectly continued clipping against the Inspector behind the
modal, producing x761/y179.28125, 158×139.71875. This is a measurement error.
The [CSS top-layer rendering model](https://drafts.csswg.org/css-position-4/#top-layer)
specifies that ancestor overflow and opacity do not affect a top-layer element.

The passive client now stops clipping and paint ancestry at the actual `dialog:modal`
boundary and records its identity. It retains the modal's own client scrollport,
internal clipping ancestors, viewport bounds, original 1 px containment tolerance,
focus indicators and all contrast predicates. Ordinary Inspector clipping is
unchanged. A genuinely clipped control inside the dialog still fails. No product
layout, test-case action, font qualification, timeout, retry or cleanup change.

The source guard pins a7207ca and permits only the passive client to differ under
source/test paths. TypeScript, focused lint, guard syntax and the existing focused
predicate/architecture tests validate the source correction. Native dialog/narrow
acceptance remains pending the next shared slot; no new acceptance gate is added.
