# Preserve historical title evidence across schema migration

The title diagnostic creates fixtures through the current project factory. The
caption schema update changed their timeline version from 23 to 24, so the
historical byte-identity test failed all eighteen hashes even though their
rendering inputs were unchanged. The failure reproduced on integration a072a731.

The test now hashes a disposable copy carrying the explicitly named historical
schema version. The original eighteen hashes, observed fixtures, pixel oracles,
and renderer remain unchanged. Separate cases require all generated fixtures to
use the current schema, pass title export admission, round-trip current portable
files, and migrate schema-23 files without changing any sequence/title/caption
intent. Ordinary fixture schema checks remain in place.

Validation: ten diagnostic cases and eight architecture checks pass. Typecheck,
production build, lint and diff hygiene pass. The existing large-chunk build
advisory remains. No browser rerun is needed for this test-only correction, and
no new pixel or native validation is claimed.

The original hash failure is retained in `title-diagnostic-schema/before.log`.
The first correction passed its ten diagnostic cases but the architecture check
rejected an inline historical schema literal. Naming that historical constant
explicitly separates it from ordinary current-schema fixtures; the architecture
guard itself is unchanged. That intermediate result is retained in `after.log`.
The complete final eighteen-check result and production build log are retained
alongside a hash manifest. This focused pass does not qualify the full suite.
