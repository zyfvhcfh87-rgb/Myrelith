# Title first-paint diagnostic integration

Reviewed source and evidence `f8e7370188c32607050bf399981eee22bcce6690` merged onto `21c5931f5cc20eb2b9f1a68d34e4b873a6b97230` on 2026-09-08. All 911 pre-existing `src` file hashes remain identical; the only added `src` files are the two diagnostic tests. Production behavior is unchanged.

The accepted issue-branch browser run passed one test with six checkpoints. Its early notice capture preceded canvas presentation; the five settled controls matched their reference RGBA exactly. This establishes this run's sequence, not the cause of an older screenshot. The supervisor independently verified the 154 raw artifacts, five RGBA comparisons (41,472,000 bytes), ledger, archived hashes, and process/listener release. Three representative screenshots were inspected directly; the worker inspected all unique images. See [the detailed result](../issue200/first-paint-results.md).

On the combined worktree, the three selected diagnostic/architecture suites passed all 24 tests plus the canonical runner's 17 checks. Production typecheck/build and lint passed. The complete staged diff from `ce91074c276ca6892a74addb7dd673b9a19c7eeb` passes whitespace validation. Build retains its informational large-chunk warning. Readable logs are whitespace-normalized; the exact original streams and both hash sets are retained in [the evidence folder](title-firstpaint-integration/manifest.json).

No combined browser rerun was necessary for this diagnostic-only merge. Shared Animation/export, title keyboard access, and final full integration checks remain open.
