# Shared caption layout and export source foundation

The staged caption diagnostics and reachable-export planner now use the accepted
renderer integration's existing pure calculations. `textLayoutMetrics` owns the
same line height, inner size,512-line ceiling and historical one-line minimum.
Both painter call sites use it; wrapping, cache keys, document ownership,
64-entry/8 MiB limits and cleanup remain unchanged. All legacy caption paint
inputs and position calculations are unchanged.

The title export check's disjoint range admission moved verbatim, apart from
names/types, into `sequenceFrameCoverage.ts`. Both title and caption export
checks share it. Each caller retains its contributor rules; repeated source
visits subtract previous coverage without filling gaps. The new caption planner
binary-searches sorted cues and sweeps intersecting start/end boundaries with
at most8active cues, including changes in stacking geometry. Hidden/audio lanes,
dormant sequences, trimmed-out captions and unvisited gaps do not block output.
Unknown reachable style intent blocks; historical origin alone does not.

Caption layout diagnostics measure at most one line beyond the painter capacity,
report line-box clipping and too-wide codepoints, and reject invalid measurements.
Their scope is nominal line boxes, not actual glyph/outline/shadow extents.
Color diagnostics compute only an opaque foreground/background pair. Transparent
text or disabled/translucent backgrounds are unmeasured; changing video pixels
are not examined. The4.5ratio is an advisory with no display-size exemption or
accessibility/conformance claim. Style painter resolution, UI diagnostics and
burned-in export preflight wiring remain the next G3 work; these new modules are
not presented as a completed user flow.

Validation produced **103passes and1failure across9files**. The31new pure checks
pass, including bounded layout, contrast cases and a20,000-cue trimmed child.
Existing title composition/render proof, legacy caption inputs, text wrapping,
renderer and architecture checks pass. Production typecheck/build and lint pass;
the existing Vite large-chunk advisory remains. No new browser or pixel acceptance
is claimed by the arithmetic extraction.

The failure is `src/test/titleCanvasDiagnostic.test.ts`: its existing diagnostic
fixture hashes differ. An exact tracked snapshot of34fe949, before this helper
diff, reproduces the same failure. A separate disposable probe changes only the
cloned fixtures' schemaVersion from24back to23 and reproduces all18stored hashes.
The failure therefore predates this diff and is a schema24 integration fixture
qualification issue, not evidence of changed renderer pixels. It remains open
for coordinated integration handling; historical fixture pins were not rewritten.
The affected suite is **not** reported green.

Exact logs, baseline source identities and the inert clone-only probe are in
[`caption-shared-layout/checkpoint.json`](caption-shared-layout/checkpoint.json).
Speech source, private recipe/configuration and all runtime gates are unchanged.
