# Schema23 title ownership integration

Source ecc9db13ebc81c409dd774b538ae63a5012d40a8 was fully reviewed across
portable validation/migration, actual title ownership, explicit compact upgrade,
identity allocation/copy/split, fixed-local lifecycle timing and media exclusion.
The parent independently passed12files134tests plus17runner checks.

Merged into the held-mask integration without conflicts. The shared mask path
status now uses the canonical isProceduralTitleClip predicate. Two integration
regressions cover supported and opaque future title owners: existing mask path
keys stay inactive and unchanged, and Set/Remove/Clear/direct path edits reject
before mutation. Expanded outer opacity remains available; title geometry lives
on elements. No additional schema or alternate title parser was introduced.

The combined checks pass15files180tests plus17runner checks, build/typecheck,
lint and diff hygiene. Logs: /private/tmp/milestone9-schema23-integration-*.log.
The existing Vite chunk advisory remains. The real10m portable file/recovery,
exact-fit/one-over upgrade, combined1MiB title/track and64MiB retained ownership
cases are included. This is owner/migration acceptance only. Rendering, fonts,
authoring/templates, browser/export parity and final full-suite work remain open.

The pending accepted #199 atomic editor will compose isProceduralTitleClip and
readTitleClipElement into its app-owned title adapter. Schema24 caption ownership
may follow this accepted schema23 boundary; it must preserve the exact file cap.
