# Issue 199 — freeze accepted dense-capture source for one large run

Accepted product source is `1537d5e23ebf223c51f269f1e1a5f6a902ecaa0e`, containing
the exact three-file patch reviewed by the parent, 64 focused tests plus 17
runner checks, lint and the granted passing production build.

This follow-up changes only the executing source identity, diagnostic source
labels, protocol identity metadata and hash manifests. Reversing those identity
string substitutions reproduces the previously reviewed observation module
byte-for-byte. Every large action, native capture assertion, 1,024-key selection,
512-glyph budget and other limit stays unchanged.

The prior 242-source and 58-checkpoint manifests are retained in
`dense-capture-repin/`. Exactly three product paths changed from 75b89ef; 239
remained identical. All fixture and generator bytes remain intact, including the
supplemental b33 generation provenance and the playback fixture's historical
generation identity. No fixture regeneration or other segment is included.

The parent conditionally granted one unchanged large segment after this metadata
freeze is committed, clean source and all hashes are verified, and the exact SHA
is recorded before launch. The native runner retains its standard internal build
preflight. No native result is claimed by this source checkpoint; prior large
failure and earlier gestures/editing results keep their recorded source identities.
