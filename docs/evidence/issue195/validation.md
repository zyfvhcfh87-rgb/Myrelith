# Issue #195 local validation, 2026-09-05

Research only. User implementation approval is pending. Starting commit:
`3653c9a14cb6371321bbda909cd4a576e365657a`. Node 26.8.1; locked dependencies.

| Command or check | Observed result |
|---|---|
| `npm run qa:issue195:check` | Dedicated TypeScript check and 4/4 decision tests pass |
| `npm run build` | TypeScript + Vite pass; 4,971 transformed modules; existing large-chunk advisory |
| `npm run lint` | Pass |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| `node --test scripts/performance/run-benchmark.test.mjs` | 17/17 pass |
| `npm test -- --maxWorkers=4` | 283 passing files, 1 failing file; 3,946 passing cases, 1 failing case |
| Production exclusion | 35 built JavaScript files contain none of the lab's distinctive markers |
| Import boundary | New architecture test passes in the full suite |
| `git diff --check` | Pass |
| Durable foreground projection | 52 rows; 24 passing wall rows; all 32 admitted rows have observed terminal zero |
| Final native lifecycle | 12 observations, no console errors; includes negative initial-hidden admission evidence |

The one remaining failure is unchanged plugin startup:

```text
src/app/pluginAppController.test.ts
  threads lifecycle evidence through production composition and closes bounded export ownership
PluginInstallControllerError: Plugin execution is unavailable until reviewed normal startup is active
code: safe-mode
```

To distinguish this from the research change, an isolated archive of the
starting commit was created under `.tmp/issue195/baseline`, with the same
installed dependencies linked locally. Both trees ran:

```sh
npm test -- src/app/pluginAppController.test.ts --maxWorkers=1
```

Both produced **23 passing / 1 failing** cases, with the identical test and
`safe-mode` error (1.24 seconds each). No production runtime file differs from
the starting commit in this research change. The full suite is not claimed green;
this pre-existing plugin failure is outside Issue #195's product scope.

An earlier default-concurrency full test run overlapped build/browser setup and
failed 12/3,947 cases across five files. With bounded concurrency, eleven of
those failures disappeared; the plugin failure above remained and reproduced
on the original tree. The canonical runner stops after a Vitest failure, so its
17 Node checks were also run independently and passed. No tests were skipped,
marked expected-failure, or loosened to obtain these results.

The foreground performance matrix ran before these build/test jobs. Native
lifecycle corrections are fault-only observations, not timing benchmarks. The
broader Chromium regression suite was not rerun; the earlier Issue #194 report
records its own eight baseline failures separately.

Raw local logs, retained under `.tmp/issue195/`:
`tests-concurrent-failed.log`, `tests.log`, `plugin-current.log`,
`plugin-baseline.log`, `build.log`, `runner-checks.log`, `research-check.log`.
The durable adjacent JSON files retain measured decisions and terminal ledgers;
they are compact projections with hashes of their corresponding raw artifacts.
