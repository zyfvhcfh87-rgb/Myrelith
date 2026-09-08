# Issue #201: run-01 prerequisite corrections

Date: 2026-09-08. Run 01's raw evidence and invalid/aborted classifications are
preserved in commit `1ca9fa8375deba65bc2c192d85ab9fbe1cc77649` and
[LAB_RUN_01.md](LAB_RUN_01.md). These are harness corrections for a future
reviewed run, not successful model-execution evidence.

- **Exact local lookup.** The worker now uses one tested map containing each
  manifest file's exact pinned URL, absolute same-origin local URL, observed
  `/models/<id>/<file>` form, and model-relative form. Other model IDs, files,
  queries and `resolve/main` URLs remain unmapped. No basename fallback or
  remote-network permission was introduced. Pinned SDK source confirms local
  paths are checked before remote cache keys and do not carry a revision; the
  parent-verified cache/manifest remains the revision and digest authority.
- **Structured prerequisites.** Worker errors now identify initialization,
  transcription or disposal plus their phase. Parent-side worker import/message/
  phase-deadline errors before readiness are also initialization failures. The
  actual controller preserves these codes/phases in events and rejected errors.
- **Stop at the first loader failure.** The runner clears per-case worker events,
  captures the first initialization failure, cancels/drains that case and stops
  before another case. It saves the raw failure and all earlier request/memory/
  cache evidence through its normal finally path. Phase-cancellation waits also
  wake when their job fails or completes, reporting an unobserved phase instead
  of waiting for an impossible stage.
- **Intended-stage proof.** Corrupt-audio acceptance now requires an observed
  ready event with a model owner, a structured transcription error at decode
  setup, and a terminated worker. An unrelated exception cannot pass that case.
- **Explicit completeness.** The runner checks a frozen list of all 23 case
  names. Missing/aborted cases produce `failed-incomplete`; failed, duplicate or
  unexpected cases and recorded problems cannot produce a passed status. The
  process exits nonzero for an incomplete assessment. Automatic lab acceptance
  remains separate from a reviewed production/model enablement decision.
- **Failure-path cleanup.** Finally records model removal, cache state and owner
  state before closing the browser/server. It checks zero owners, the expected
  missing-model result and absence of model/staging caches. A one-second cleanup
  observation timeout or already-closed browser is explicitly unverified; forced
  closure is never described as successful cooperative cache cleanup.

Validation:

```sh
node --experimental-vm-modules --test scripts/issue201/lab-review.test.mjs
```

**14/14 tests pass**, including the prior nine review regressions plus exact
cache aliases/revision rejection, actual-controller typed initialization and
retry, worker-module startup failure, intended decode-stage proof and overall
incomplete/failure classification. All lab modules pass `node --check`; lint and
diff checks pass. Node emits the documented experimental VM warning. No full
suite, browser or inference rerun occurred for these corrections.

The model, selected runtime bytes, manifest SHA-256
`ee3043df0f8d04d895fb1c2c90a32c905c733e4ae53bbfd2516798db8d6582dd`, fixture hashes,
and accuracy/work/timing/memory/cache thresholds remain unchanged. A new exact
source review and exclusive slot are required before rerunning the lab.
