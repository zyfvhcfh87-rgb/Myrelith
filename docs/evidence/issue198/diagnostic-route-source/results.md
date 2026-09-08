# Immutable diagnostic routing correction: source gate

The diagnostic's fixed video route now registers inside Vite's
`configureServer` hook, before internal SPA and terminal handlers. Previously it
was appended after `createServer` returned and could not serve either pinned
input. The exact runtime/test diff is confined to the diagnostic driver, its
focused tests and bounded response-error details. Production code and the
accepted resource harness are unchanged.

`createDiagnosticVite` is the driver's actual registration helper. Its default
factory is Vite `createServer`; tests supply an inert factory that models the
observed Vite8.1.2 hook, fallback, post-hook and terminal-handler order. The
actual registered handler serves both synthetic byte buffers with exact
Content-Length, video/mp4 and no-store headers, rejects malformed/nonexact
paths and invalid methods, falls through for the harness page, and refuses a
third admitted request. The test never opens Vite, a browser or a socket.
This is source-level regression evidence, not actual Vite integration proof.

Before correction, the handler was extracted without changing its position
after server creation. [before-route-extraction.patch](before-route-extraction.patch)
records that extraction from the accepted driver at
`12449aafa3c5a84bf44f3071cc14a5b954b2880a`. With the same tests, the two original
option/identity cases passed and both new route cases failed in 171 ms: the
valid fetch saw no Content-Length, and an invalid-method request received the
SPA response. The test file was unchanged for the corrected run.

After moving registration into `configureServer`, all four driver cases plus
three actual stalled-evidence cleanup cases passed: seven Node tests in 186 ms.
The original eight diagnostic pixel/work/document/lease fixture checks passed
in 755 ms. Isolated TypeScript, scoped oxlint, Node syntax and diff hygiene
passed. [node-regression-logs.tar.gz](node-regression-logs.tar.gz)
retains the exact failing and passing Node logs as two verified archive members; the artifact index pins
these records and tested source files.

Response admission still checks `response.ok` and the exact original
Content-Length before body allocation, then the unchanged byte count and hash.
Its error string additionally includes the fixed requested path, response
status and Content-Length/Content-Type values capped at 128 characters each.
It never reads an inadmissible response body or adds a new evidence record.

Both real saved MP4 byte sizes and SHA-256 pins were reverified, and host/browser
pins still match. There are no new inputs, fetches, sample requests, composites,
candidate comparisons or tolerances. The two immutable GET limit, 740 public
requests, six candidates, one production composite, 64 MiB array cap and all
existing time/evidence/cleanup bounds are unchanged.

The [attempt-1 failure package](../diagnostic-attempt1/results.md) remains
unchanged. Its source commit is `12449a`; evidence commit is `32ae47a`.
[parent-release.json](parent-release.json) is the later independent root receipt
at 20:44:19.813643 UTC: all eight recorded PIDs absent, port 5198 refused and all
ten raw hashes verified. No diagnostic pixel evidence was produced in that
failed setup, and the earlier export pixel cause remains unresolved.

No additional native diagnostic, Vite server, browser, decode, encode, export
or build ran while preparing this correction. It must be reviewed at its exact
committed source before a separate native grant. The supervisor instructed the
worker to use its local report and make no further blocked upward-message
attempts.
