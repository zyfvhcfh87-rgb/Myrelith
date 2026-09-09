# Title keyboard focus — scoped scroll-padding correction

Source checkpoint for supervisor review. The original failed run and lossless
archive remain committed at `f3af949fa05636fde39e12f4b4ad22807e4c709f`; see
[first keyboard failure](keyboard-first-failure.md). No corrected native run or
production build has been performed, and the earlier native grant is exhausted.

## Retained cause and smallest source change

At 1280×720, native Tab scrolling exposed the safe-guide checkbox inside the
Inspector's visible region, but the associated inline label box extended below it:

| Box | Top | Bottom |
| --- | ---: | ---: |
| Visible Inspector region | 101 | 319 |
| Focused checkbox | 305.171875 | 318.171875 |
| Associated label | 306.171875 | 321.171875 |

The 2.171875 px overflow exceeds the original 1 px containment tolerance. Native
focus and the checkbox's own bounds passed. The retained PNG shows the label at
the lower edge; this does not establish absent accessible text or total visual
unreadability. The outer Inspector, not its long inner content element, performed
the automatic scroll (`scrollTop=2142` versus zero).

`src/ui/titleEditor.css` adds one rule:

```css
.area-inspector:has(.title-inspector) { scroll-padding-block: 0.5rem; }
```

This reserves block-axis space in the actual scroll container while it contains
title authoring controls. It changes neither the surrounding workspace dimensions
nor the label, checkbox, project, history or frame values. The relative spacing
provides room for the label and outline without fitting the rule to the measured
fractional overflow. It requires no focus handler or programmatic scrolling.

W3C's [CSS scroll-padding technique](https://www.w3.org/WAI/WCAG22/Techniques/css/C43)
uses the same native keyboard-focus scrolling mechanism to keep obscured content
visible. Applying it to this title-bearing scroll container is the source-level
correction; the unchanged native case must establish its actual browser result.

## Regression and unchanged native contract

The new pure regression uses the exact retained rectangles and requires the
checkbox to pass while its label fails. It prevents checkbox visibility from
waiving the label's original containment rule. It does not simulate browser layout
or claim the CSS correction is natively verified.

All native case bodies, client observations, geometry/contrast predicates, keyboard
input, fixed fixture, viewports, timeouts, retry/failure caps, config and runner are
byte-identical to tested `b2fc657040e34643a77ea5b5d0cf18b6cdc4d8a8`. The source guard
now pins that executed checkpoint and allows only `src/ui/titleEditor.css` and the
pure diagnostic test to differ under production/test paths. It still freezes HEAD
and every tracked file, including the guard itself, after the correction commit.

## Completed source checks and remaining gate

Before the user-requested pause, four focused suites passed **46 tests in 3.03 s**:
title authoring, overlay controls, diagnostic predicates and architecture. App and
diagnostic TypeScript, lint, guard syntax and diff checks passed. The resumed diff
matches the preserved three-file correction; no product source changed after those
checks. The [validation manifest](keyboard-focus-correction-validation/manifest.json)
records the raw logs, retained geometry, correction hashes and unchanged native-file
hashes. All archived members are independently verified.

The final review boundary is the clean committed correction and its new complete
source manifest. The supervisor must grant production build and the next native
slot separately. The later run retains four cases, 1280×720/720×800, 60 seconds per
case, 600-second owned runner, zero retries, first-failure stop, all artifacts and
explicit all-PID/port release. Safe guides, later font status, dialogs and the
narrow cases remain unqualified until they actually execute successfully.
