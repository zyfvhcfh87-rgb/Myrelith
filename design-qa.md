# WebCut landing redesign — design QA

## Comparison target

- Source visual truth: the user-selected Soft Studio launcher mock supplied during design exploration.
- Browser-rendered implementation: `qa/landing-desktop-pass3.png`.
- Full-view comparison: `qa/landing-comparison-pass2.png`.
- Focused hero comparison: `qa/landing-hero-comparison-pass2.png`.
- Responsive evidence: `qa/landing-720-pass1.png` and `qa/landing-mobile-pass1.png`.
- State: launcher home with the browser's real local recovery library. The source mock contains two illustrative recent projects; the implementation intentionally retains the real ProjectLibrary projection and therefore shows the available recovery copies instead of inventing recent-project data.

## Normalization

- Source pixels: 1536 × 1058.
- Implementation pixels: 1440 × 1024.
- Browser CSS viewport: 1440 × 1024 at device density 1; screenshot pixels match CSS pixels.
- The source was proportionally downsampled to 1440 × 992 and centered on a 1440 × 1024 dark panel. The implementation was kept at its native 1440 × 1024 capture. Both panels were placed side by side without changing their internal aspect ratios.

## Findings

No actionable P0, P1, or P2 differences remain.

### Required fidelity surfaces

- Fonts and typography: the system/Segoe UI stack matches the mock's practical humanist sans-serif character. Display weight, line-height, three-line wrap, blue final line, button labels, and small supporting copy preserve the target hierarchy. The handwritten caption uses the available Segoe Script/Bradley Hand fallback and remains readable without being treated as functional UI.
- Spacing and layout rhythm: the final desktop hero is 530px tall and the project library begins at y=638, restoring the mock's above-the-fold balance. Buttons remain 68px high on desktop and 60px on narrow layouts. The image overlap, section divider, library spacing, and rounded rows retain the selected composition. No horizontal overflow was present at 1440, 720, or 390 CSS pixels.
- Colors and visual tokens: the implementation maps the soft navy base, warm off-white type, cornflower primary action, sage privacy cue, and warm recovery action without introducing editor-like chrome or decorative gradients.
- Image quality and asset fidelity: all five visible photographic assets are source-sized WebP images generated for this direction. They are sharp, consistently color-graded, and use `object-fit: cover` with stable aspect ratios. The main traveler is smaller and the coast slightly cooler than the source mock, but the subject, mood, crop hierarchy, and three-frame story remain aligned; this is acceptable P3 variation.
- Copy and content: the hero, CTA, capability, local-first, legal, recent/recovery, and safety-copy language is coherent and product-accurate. Dynamic project names, timestamps, and recovery counts remain source-backed rather than copied from mock data.
- Icons: Phosphor's rounded outline icons provide one consistent family for project creation, folder open, trust, arrows, and overflow controls; optical weight and alignment match the selected direction.
- Responsiveness and accessibility: 720 × 800 and 390 × 844 captures preserve the hierarchy, 60px action targets, readable wrapping, and zero page-level horizontal overflow. Decorative project artwork has empty alt text; the meaningful hero image has descriptive alt text. Focus styles, semantic headings, buttons, link targets, and reduced-motion behavior remain present.

## Comparison history

1. The first browser pass found a P2 primary-CTA wrap at 1440px. The hero column gap was reduced and the action label was kept on one line. The next pass measured the label at 19.1875px inside a 68px button, confirming the fix.
2. The first full comparison found a P2 vertical-rhythm mismatch: the 610px hero pushed the project library about 80px lower than the source. Hero padding and story height were reduced while preserving the photo overlap.
3. Browser pass 3 and full/focused comparison pass 2 show a 530px hero, project library beginning at y=638, one-line CTA text, matching hierarchy, and no remaining P0/P1/P2 mismatch.

## Primary interactions and runtime evidence

- `Start a new project` opened the existing `Set up your canvas` screen.
- `Back` returned to the redesigned launcher.
- `Open a project` opened the existing `Reconnect your work` screen.
- The second `Back` returned to the redesigned launcher.
- Browser console check after the interaction sequence: zero warnings and zero errors.
- Browser layout checks: document `scrollWidth` equaled `clientWidth` at 1440, 720, and 390 CSS pixels.

## Follow-up polish

- P3: a future source-backed thumbnail projection could replace the current decorative library artwork. The existing ProjectLibrary state intentionally exposes no source-media preview, so this change would require a separately reviewed persistence/product contract rather than a launcher-only shortcut.
- P3: the subtle blue paper backdrop behind the source mock's hero collage was omitted to keep every visible asset real and avoid decorative CSS/div art. The current composition remains balanced without it.

## Implementation checklist

- [x] Match the selected no-editor Soft Studio hierarchy and palette.
- [x] Preserve real launcher controllers and dynamic library content.
- [x] Use real raster assets and a consistent icon library.
- [x] Verify desktop and narrow responsive layouts.
- [x] Verify primary launcher interactions and console output.
- [x] Resolve all P0/P1/P2 design-QA findings.

## Selected canvas and editor overhaul

### References and rendered evidence

- Canvas reference: the user-selected canvas setup mock (1487 x 1058).
- Canvas implementation: `qa/design-overhaul/setup-implementation.png` (1488 x 1058).
- Canvas side-by-side: `qa/design-overhaul/setup-comparison.png`.
- Editor reference: the user-selected populated editor mock (1487 x 1058).
- Editor implementation: `qa/design-overhaul/editor-inspector-implementation.png` (1488 x 1058).
- Editor side-by-side: `qa/design-overhaul/editor-comparison.png`.

### Browser states and interactions

- Canvas setup was checked with Horizontal 16:9, 1920 x 1080, 30 fps, and 48 kHz selected. The four canvas-shape controls are real radio buttons, and the project-name/select/create/back flow remains wired to the existing controllers.
- Editor QA used three genuinely imported coast PNGs and one genuinely created text overlay. No staged editor clips, audio waveforms, or pretend controls were added to make the implementation resemble the concept art.
- Media import, Add text, Transform/Crop/Animation tab selection, and the Inspector tab keyboard contract (Arrow Left/Right, Home, and End) were exercised in Chromium.
- Exact 1488 x 1058 checks had no horizontal overflow and zero console warnings or errors on both screens.
- Responsive checks at 1024 x 900 and 820 x 900 also had no horizontal overflow.

### Comparison history

1. The first setup capture used a mismatched viewport; the comparison was repeated at the reference viewport and the page hierarchy, divider, form rhythm, CTA placement, and footer now align closely.
2. The editor pass tightened the shell proportions, three-column media grid, monitor controls, Inspector summary/tabs, and timeline density while retaining WebCut's real application states.
3. The reference editor's populated coast timeline is concept content. The implementation deliberately uses available real state, so the remaining content-state difference is not a visual defect or a promise of nonexistent functionality.
4. No P0, P1, or P2 visual mismatch remains. P3 variation is limited to real imported media/text state versus the reference's staged project content.

### Validation

- `npm test -- --run`: 105 files, 1806 tests passed.
- `npm run build`: passed; Vite retained its existing large-chunk advisory.
- `npm run lint`: passed.
- `git diff --check`: passed; Git reported only line-ending conversion notices.
- `npm audit --omit=dev --audit-level=high`: passed with zero production vulnerabilities. The full development-tree audit still reports the upstream `undici` advisory.

## Browser annotation: Add Text tool placement

- Source instruction: browser comment marker 1 on the editor's header-level `Add text` action at 1916 x 1248; move the action beside the left editing tools and render it as a compact T.
- Rendered evidence: `qa/design-overhaul/editor-add-text-toolbar.png` at 1916 x 1248.
- The header action is absent, and the accessible `Add text` button is inside `.transport-tools` beside the five editing tools.
- The visible control uses the existing Phosphor text-T icon, retains the `Add text` title and accessible name, and keeps the same dialog behavior.
- Chromium interaction check: the control opened the real Add Text dialog, closing the dialog restored focus to the T control, the page had no horizontal overflow, and the console had zero warnings or errors.
- Focused validation: 3 test files / 17 tests passed; build, lint, and diff-check passed.
- No remaining P0, P1, or P2 mismatch was found for the requested annotation.

final result: passed
