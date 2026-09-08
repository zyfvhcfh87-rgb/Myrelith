# G4 prepared-export correction

Both diagnostic export calls now use the public prepared-export owner used by
ExportDialog. The plain `startExport` policy remains unchanged. Preparation
classifies the fixture's two disabled `plugin:missing/future` descriptors as
invalid because type validation precedes toggle handling. The parent authorized
reviewing exactly these two unchanged version-99 descriptors through canonical
`approveReviewedBlockers`; enabled, additional or changed payloads fail. This
does not install, trust or execute a plugin. Approved ready snapshots retain the
reviewed blocker facts; their one-use token carries approval.

The facade consumes the ready token before actual export preflight. Its owner
closes in finally, including preparation, execution and evidence failures, and
disposes document subscriptions. Only an actual start-stage font/fallback error
can satisfy the missing-font predicate. The temporary font variant restores its
original project in finally. Both paths write bounded data-only lifecycle facts
to `prepared-exports.json`, without tokens. Encoded bytes still reach the existing
preservation step before decode. All original fixture, output predicates and
deadlines remain unchanged; no native ExportDialog interaction is claimed.

Validation: 28 tests in three focused files plus the 17 canonical runner checks
pass. Ten new tests use the real owner, generation controller, prepared facade,
attempt controller and export preflight, with media/encoder dependencies stubbed.
They cover exact fixture review, three blocker drift cases, one-shot consumption,
strict font refusal before Blob/encoder work, operational/preparation/evidence
failures and cleanup-error distinction. TypeScript app and diagnostic checks,
lint, Node syntax and diff checks pass. No native run or production build ran.

Reproduce from this worktree with `NODE_OPTIONS=--no-experimental-webstorage`:

```sh
npm test -- --run src/test/issue199G4PreparedExport.test.ts src/app/pluginPreparedExportOwner.test.ts src/app/pluginPreparedExportController.test.ts
node node_modules/typescript/bin/tsc -b --pretty false
node node_modules/typescript/bin/tsc -p scripts/issue199/g4/tsconfig.json --pretty false
npm run lint
```

Untouched local logs are `.tmp/issue199/g4-prepared-{focused,types,lint}-final.log`.
Earlier native failure evidence remains accepted at
`b9a8caa3e0397f7da4eb3cf0ef5ef0c91f07edb3`; no repeat audit was performed.
This source checkpoint precedes the requested reviewed integration merge and
the new exclusive grant needed to finish actual G4 export/decode/cleanup.
