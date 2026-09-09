# Diagnostic setup: immutable route registered after Vite fallbacks

Source inspection establishes an ordering defect in the separate diagnostic
driver. This does not diagnose the earlier frame-127 export pixel failure.

At tested source `12449aafa3c5a84bf44f3071cc14a5b954b2880a`,
`scripts/issue198/run-export-diagnostic.mjs` first awaits Vite `createServer`,
then appends the immutable-video handler using `vite.middlewares.use`. The
installed Vite 8.1.2 implementation has already registered HTML fallback,
index-HTML and not-found handlers before returning that server. Appending the
video handler puts it after those terminal handlers.

Relevant installed source is `node_modules/vite/dist/node/chunks/node.js`:

- Lines 25569–25574 invoke `configureServer` hooks before internal handlers.
- Lines 25596–25602 install HTML fallback, index-HTML, not-found and error
  handlers before `createServer` returns.
- Lines 18372–18413 show SPA fallback accepting GET requests with an absent,
  empty, HTML or wildcard Accept header and rewriting an unmatched path to
  `/index.html`.

The exact installed chunk SHA-256 is
`f31ebfcbd4c87dd62d3c7d541a5a4935c48178426e1ffbe2a4661b89f27feb89`.
The repository's Vite configuration does not override the SPA app type.
The diagnostic's fetch does not specify an Accept header.

This matches the recorded failure: the immutable-video handler served zero
requests, while the first browser response passed `response.ok` and then failed
the exact Content-Length guard. SPA fallback serving an HTML response is a
supported explanation, but the response's status code, headers and body were
not saved, so their exact values cannot be reconstructed from this attempt.
The confirmed defect is the handler's placement after internal fallbacks.

The proposed correction is to install the same bounded immutable handler from
a Vite plugin's `configureServer` hook before internal handlers are installed.
The two pinned inputs, allowed GET paths, byte/hash validation, two-request
ceiling and diagnostic work/resource/deadline limits should remain unchanged.
Record bounded response status/Content-Length/Content-Type details if admission
fails, without retaining arbitrary response bodies. A meaningful regression
must exercise registration order and both exact admitted responses, plus
unknown routes, invalid methods and the third-request refusal. Any actual
server check must follow the supervisor's validation-slot instructions.

No correction or additional server/browser experiment was made during this
source-only diagnosis. Existing inert tests covered options, pinned bytes,
resource admission, statistics and stalled evidence cleanup; they did not
exercise Vite middleware integration. The corrected source and its focused
regression evidence require review before another native diagnostic grant.
