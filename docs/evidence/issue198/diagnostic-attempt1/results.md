# Issue 198 immutable diagnostic attempt 1: setup failure

The single approved diagnostic at clean source
`12449aafa3c5a84bf44f3071cc14a5b954b2880a` failed during the first immutable
video fetch with `Immutable input response extent differs`. It exited with
code 1 before decoding, pixel allocation, candidate comparison or production
composition. No retry ran. The original export remains failed/incomplete at
frame 127; this diagnostic supplies no new pixel evidence or fault attribution.

The exact command is retained in raw record 00000 and [command.log](command.log):

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools node scripts/issue198/run-export-diagnostic.mjs --expected-sha 12449aafa3c5a84bf44f3071cc14a5b954b2880a --output /Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue198/.tmp/issue198-12449aa-diagnostic-attempt1
```

Recorded start through evidence closure was
2026-09-08T20:37:58.368Z–20:37:58.931Z, 563 ms. The browser failure record reports
8.1 ms since diagnostic start. These are failed setup timings, not performance
measurements. Chromium 151.0.7922.34 reported software SwiftShader.

| Observation | Result |
| --- | ---: |
| Ordinal and sparse sample requests | 0 |
| Actual production source requests | 0 |
| Production composites and candidate comparisons | 0 |
| RGBA arrays, admitted bytes and peak bytes | 0 |
| Requests served by the immutable video handler | 0 |
| Browser warning/error/page-error reports | 0 |

Host size/hash verification of both saved MP4 files completed before launch.
Both exact file sizes and hashes were checked again after failure. Browser
verification did not reach response-body allocation or hash checking; the first
response passed `response.ok` but failed the Content-Length check. Its actual
status, headers and body were not recorded. [source-diagnosis.md](source-diagnosis.md)
documents the confirmed middleware-order defect and the limits of this evidence.

Context, browser connection, browser server and Vite each closed normally.
The driver recorded no alive captured descendants and a released port.
[worker-cleanup.json](worker-cleanup.json) independently verified at
20:38:37.499201 UTC that runner 31490, awake 31510, browser processes
31511/31512/31513/31515 and captured transient ps processes 31522/31547 were
absent using both kill(pid, 0) and ps. Port 5198 refused connection with code 61.
No parent cleanup confirmation is included in this package.

[raw-evidence.tar.gz](raw-evidence.tar.gz) contains the ten exact numbered JSON
records and their original manifest, all eleven members verified against the
unchanged raw directory. The records total 11,967 bytes. The 1,349-byte manifest
has SHA-256 `9a451a1bd39f5de43991e2d47a068eddfaee662c26e979446506bd1b76c6c47e`.
The archive is 3,349 bytes with SHA-256
`c880f3bd2e08607ad6a312e5f3545ad19434ad7f131106114733152b92d94d0f`.
Record 00004 is the browser failure, 00005 the zero-work/zero-array release,
00006 the host failure, 00008 teardown and 00009 successful evidence closure.
No durable-store fallback or partial binary remained.

[audit.json](audit.json) records hash verification, exact counts, unchanged
input identities and cleanup. [artifact-index.json](artifact-index.json) pins
the review package. The raw directory remains
`/Users/razvan-constantinbotezatu/Documents/Codex/Myrelith/.worktrees/issue198/.tmp/issue198-12449aa-diagnostic-attempt1`.

Evidence packaging made no diagnostic or production source correction, native
retry, decode, encode, export, build or tolerance change. Production and
architecture remain exactly accepted `d9759917d202c39b1faa0df91ea90adad3603218`.
A routing correction, regression evidence and exact committed source review
must precede any separate native diagnostic grant.
