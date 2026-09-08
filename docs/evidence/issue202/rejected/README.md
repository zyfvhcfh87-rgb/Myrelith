# Provisional reference correction before candidate creation

The first Decimal-only scope reference represented exact 4,000-nit luminance
slightly below 4,000. Its capped bin still happened to be correct, but finite
Decimal rounding is unsuitable as the authority for exact rational bin edges.
Manual anchor inspection caught that limitation before the JS candidate existed
or ran. The provisional oracle source and output are retained
here; its golden SHA-256 was
`db7bc95f5279cc43404ea70514204ee910f2af12133c39647fe734c1f712789b`.

The accepted reference uses Python `Fraction` for these rational input pixels
and exact bin classification, converting only the reported continuous values
to Decimal. It introduces no epsilon and does not adjust values to candidate
output. This strengthens the exact oracle without changing the candidate
threshold or observed bins. The first Fraction-based generation attempt rejected
the `99.999/203` spelling; explicit decimal-numerator division fixed it before
any revised golden was written or any candidate comparison ran.
To reproduce the rejected run, copy the retained `.py.txt` to an isolated
temporary directory as `oracle.py`, copy `../inputs-v1.json` beside it, and use
the documented CLT Python command with `--freeze`. No existing goldens need
to be overwritten.
