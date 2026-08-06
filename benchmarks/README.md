# Performance benchmark artifacts

Issue #54's canonical fixture, metric, command, production-gating, cleanup,
and advisory-budget documentation lives in
[`docs/PERFORMANCE.md`](../docs/PERFORMANCE.md).

`performance-artifact.schema.json` is the versioned JSON Schema for both the
CLI artifact and the manual browser result. Reproducible run output is written
under the ignored `.tmp/benchmarks/` directory; benchmark results do not belong
in this tracked folder.
