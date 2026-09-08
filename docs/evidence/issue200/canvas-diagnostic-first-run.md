# Original G2 observable failure (preserved)

Run2026-09-08T13:26:39Z, clean54581222b3c46208efea47f71a0d865f52778bc9,
Chromium151.0.7922.34 on macOS arm64, muted/headless one worker, no retries,
http://127.0.0.1:5200/, 1280x720. The source guard checked all778 baseline blobs
before and after. Test1 failed; the remaining five tests did not run.

First assertion: sans-serif/combining-emoji/half/worker, differingBytes6,
maximumDelta113, sameLinestrue. All396 matrix rows were computed before assertion.
Baseline HTML/current compact HTML396/396 exact; compact/Upgrade HTML396/396 exact.
Worker340/396 exact (56 differing rows, max129). Full raw export125/132 exact
(7 differing rows, max129). Every recorded line comparison matched; all396 clean
and exportClosed flags were true. Those individual facts do not pass the test.

Worker failures: crop-flip18, background12, outline-shadow12, combining-emoji8,
fractional3, caption-canary1, anchor-zero1, anchor-one1. Full7/half23/quarter26.
Export failures: six crop-flip plus fantasy/fractional. Full worker/export counters
match but no original raw bytes were retained; this cannot establish equality
between them or classify the failure as pre-existing. Same-host baseline/Upgrade
success does not qualify a baseline worker that was never run.

Warnings, errors and pageErrors each0. Separate Node NO_COLOR/FORCE_COLOR warnings
exist. The reporter's extra global error is only its maxFailures1 stop message.
URL/title/nonblank body1041chars/1280x720 bounds/zero Vite overlays were observed;
the screenshot was visually inspected and shows the launcher. Title status UI,
fallback interaction, production bridge and720x800 viewport remain unrun.

Launcher PID61338 and all nine recorded descendants exited naturally. No manual
termination was required; remaining=[] at runner exit. Fresh native verification
at2026-09-08T13:29:59Z found none of the owned PIDs and no5200 listener. Supervisor
received explicit exclusive-slot release. No correction or rerun was performed.

Original artifact directory:
`/private/tmp/issue200-g2-browser-5458122-TJ3m1S`.
Derived offline-matrix-summary.json was added beside originals; it did not modify
the matrix. These hashes preserve provenance of the key original and release files:

| Relative file | SHA-256 |
| --- | --- |
| `candidate-manifest.json` | `9c6b2b5d21aaed7cb69c29bd5283dd10b60a45e515e220ab2f7e4cd57139297d` |
| `playwright-report.json` | `ae0c2f854314b3b89f5369384883e5ccc307d331bb5fcf21c230b58a7627d191` |
| `playwright-stdout.log` | `e7ea55c5c972336ee341b0e0634561cfa482c61dc24b04256765453b0ea36a99` |
| `results/observed-unchanged-baselin-b656b-xact-pixels-and-line-breaks-chromium/legacy-pixel-matrix.json` | `c842e637dfb22dbde5885635f4f0e584fb65ebff23b83ab4a623a34000d0564a` |
| `results/observed-unchanged-baselin-b656b-xact-pixels-and-line-breaks-chromium/trace.zip` | `96f6c37c6b4db8fc5a39ded51fd170dcfd0a6c60d2112563078f69efee2a2aef` |
| `results/observed-unchanged-baselin-b656b-xact-pixels-and-line-breaks-chromium/browser-observations.json` | `5dd900280f4086a8039c9f174250215e3549914507f9c52c47a5ba6d0254fdb1` |
| `results/observed-unchanged-baselin-b656b-xact-pixels-and-line-breaks-chromium/observed-end.png` | `eb9ecfc8caa5e48b492147c8a7b5c8bd8306fae49feb18d7fb1f2450fb2fb21d` |
| `process-ownership.json` | `dbb83e975e3bb17fb5e77e88f198c8956eb911b2608be3f01ae3c0389448341e` |
| `release-verification.json` | `cb4e1a5286d6aa40b65d57663a039a9a05f44b25368e7fb9f93e8f2e3f09e447` |
