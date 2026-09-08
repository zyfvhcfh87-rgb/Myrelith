# Preserved first-run sources

`candidate-run-1.mjs` and `compare-run-1.mjs` are byte-for-byte source snapshots
for `../numerical-result-1.json`; its original hashes still identify them.
They are historical evidence, not runnable entry points from this directory.

Review found that the first candidate defaulted a missing source alpha to 1,
despite its proposed fail-closed interpretation policy. The current candidate
rejects missing/null alpha. The runner also now rejects a malformed scope result
shape instead of checking only discrete-value mismatches. Neither change alters
the frozen equations, fixtures, limits, or the numerical output on the admitted
fixtures. A fresh result file retains the original float16 scope failure.

`metadata-probe-run-1.mjs` preserves the source hash in the first metadata result.
The current script adds result-specific names and exclusive creation for binary
artifacts, so a future invocation cannot overwrite the first run's evidence.
No parsing, muxing or expected values changed; that filesystem guard was syntax
checked, and the first run was not repeated just to exercise an unchanged mux.
