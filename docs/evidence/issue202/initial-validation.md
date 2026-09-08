# R0 validation

Baseline `ce91074c276ca6892a74addb7dd673b9a19c7eeb`, branch `codex/issue202`.
This gate contains research documentation and a read-only source/host inventory.
It does not complete #202's experiments or authorize HDR product changes.

## Environment observations

- Workdir, clean status, branch and SHA verified before work using
  `DEVELOPER_DIR=/Library/Developer/CommandLineTools`.
- Private `node_modules` is a directory, not a symlink. Locked Mediabunny is
  1.50.9; Playwright 1.62.1; Node v26.8.1, arm64.
- macOS 26.6.2 (25G83). Restricted `sysctl` failed to disclose model/RAM;
  hardware and opaque/native-memory qualification remain unknown.
- Playwright Chromium revision 1234 executable exists; Firefox and WebKit
  executables do not. No browser was launched in R0.
- `ffmpeg` and `ffprobe` are absent from PATH; independent encoded-fixture
  tooling remains an R1/R2 decision. No dependency or software installed.
- An initial Python invocation without `DEVELOPER_DIR` hit the existing Xcode
  license prompt. It executed no fixture work; the issue snapshot was then read
  with Node. No legal agreement was accepted or system directory changed.
- `/usr/bin/python3` works as Python 3.9.6 with the prescribed `DEVELOPER_DIR`,
  so the standard-library Decimal reference can run without an installation.

## Checks

| Command/check | Result |
| --- | --- |
| `DEVELOPER_DIR=/Library/Developer/CommandLineTools NODE_OPTIONS=--no-experimental-webstorage npm test -- src/test/architecture.test.ts src/domain/colorGrading.test.ts src/domain/colorCorrection.test.ts src/domain/blendModes.test.ts src/domain/renderSurfaceBudget.test.ts src/domain/videoScopes.test.ts --maxWorkers=2` | 6 files / 107 tests passed, then all 17 repository runner checks passed. |
| `DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run build` | TypeScript and Vite production build passed; 5,013 modules. Existing non-fatal large-chunk notice remains. |
| `DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run lint` | Passed, no reported diagnostics. |
| `DEVELOPER_DIR=/Library/Developer/CommandLineTools npm audit --omit=dev --audit-level=high` | Initial restricted attempt failed with `ENOTFOUND registry.npmjs.org`; the permitted network retry succeeded with 0 vulnerabilities. This was not an audit finding. |
| Source and documentation checks | 22 source/package SHA-256 values match; 12 static budget rows recorded; both local Markdown links resolve. No tracked production/dependency/architecture/HANDOFF/PLAN diff from baseline. |

No full suite or heavy performance run was started; those require an exclusive
slot. There is no observable product change requiring browser acceptance in
this documentary gate. R2/R3 will execute the research browser cells. Historical
baseline failures have not been inherited as current results. Diff hygiene is
checked on the staged gate before the local commit.

## Acceptance tracking

| #202 criterion | R0 status |
| --- | --- |
| Primary-source support matrix | Initial documentary/API matrix supplied; exact browser/OS/hardware support unmeasured. |
| Every color stage/default/migration | Concrete versioned candidate supplied; numerical equations and precision choices require R1 proof. No migration installed. |
| Independent oracle fixtures | Complete fixture protocol supplied; fixtures/results not yet created. |
| Resource/performance evidence | Preregistered limits and static 4K allocation rejection; no timing evidence yet. |
| Unsupported monitor/encoder/metadata behavior | Explicit research/product exclusions defined; runtime rejection/round-trip evidence pending. |
| Bounded child issues if viable | Split outline proposed; final scope depends on R1–R3. No remote issue created. |
