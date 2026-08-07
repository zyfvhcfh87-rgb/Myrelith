# Performance benchmark artifacts

Issue #54's canonical fixture and Issue #56's bounded media-analysis scheduler
evidence, command, production-gating, cleanup, and advisory-budget
documentation live in
[`docs/PERFORMANCE.md`](../docs/PERFORMANCE.md).

`performance-artifact.schema.json` is the versioned v3 JSON Schema for both the
CLI artifact and the manual browser result, including scoped process-memory,
CDP GPU identity, and scheduler evidence. Reproducible run output is written
under the ignored `.tmp/benchmarks/` directory; benchmark results do not belong
in this tracked folder.
