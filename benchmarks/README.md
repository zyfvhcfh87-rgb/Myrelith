# Performance benchmark artifacts

Issues #54, #56, and #57's canonical fixture, bounded media-analysis scheduler,
local runtime telemetry, command, production-gating, cleanup, and
advisory-budget documentation live in
[`docs/PERFORMANCE.md`](../docs/PERFORMANCE.md).

`performance-artifact.schema.json` is the versioned v4 JSON Schema for both the
CLI artifact and the manual browser result, including scoped process-memory
evidence, classified document/history and worker-runtime evidence, optional
lab memory/long-animation-frame signals, CDP GPU identity, and scheduler
evidence. Reproducible run output is written
under the ignored `.tmp/benchmarks/` directory; benchmark results do not belong
in this tracked folder.
