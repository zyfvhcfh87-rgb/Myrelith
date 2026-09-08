# Accepted scoped fallback first-paint result

One unchanged run of `b7a097707ca1c5bfadc8ba047e9596daf320fcc2` passed its single
six-checkpoint test, with no failures/skips/retries. Started
2026-09-08T19:54:08.141Z; report duration 9,159.422 ms. One private muted headless
Chromium worker at 1280×720 on port 5200, under the reviewed 60-second test and
600-second runner bounds. The 1,445-file source manifest verified before/after:
`8314f35ad1b2edb8215fb445b57ccb1d779149bbd8b3c57d2e059bff31ec1b4b`.
The supervisor independently audited and accepted this scoped result.

## Observed behavior and exact limits

The new canvas had identity 4 and project generation 4 throughout the reopened
observations. Its fallback notice appeared at browser performance time 3631.8 ms.
The original-boundary raw capture at 3675.2 ms still had the initial **300×150**
buffer, with every RGBA byte zero. It was preserved as diagnostic evidence, not
compared with a differently sized settled reference. Worker completion followed at
3736.8 ms, then the generation-checked presentation opportunity at 3740.4 ms.
The subsequent capture at 3776.8 ms was **1920×1080** and exactly matched the
serif glyph reference. The same canvas remained exact at the final checkpoint.

No corrective seek, remount, quality change, extra reopen or retry occurred.
This run demonstrates a blank early capture followed by correct automatic
rendering. It supports the proposed readiness explanation but does not establish
the exact cause of the historical G3 PNG. These instrumented event times are
descriptive observations, not a latency benchmark or performance acceptance.

All five required settled comparisons passed with **zero differing RGBA bytes**
and zero maximum delta: initial generic, unavailable/empty control, UI fallback,
reopened presented and reopened stable. Independent offline comparisons checked
41,472,000 raw bytes, plus exact presented/stable equality. All five full glyph
masks were recomputed from retained reference/empty buffers: 19,702 changed pixels
for the initial generic control and 15,186 for each serif control. Two blank
buffers cannot satisfy this proof. Requested/actual production context attributes,
reference cleanup and expected text-line facts also pass.

The unavailable font retains its literal intent and strict title-eligibility
reason; the actual UI-selected fallback retains both `Missing G3 Face` and `serif`
through exact portable reopen and passes the production eligibility predicate.
This is same-runtime pixel evidence. It proves neither platform-independent font
bytes/complete glyph coverage nor encoded-file equivalence.

## Complete artifacts, visual review and cleanup

The 82-event ledger has no drops, observer issues or pending waits. Browser warning,
console-error, page-error and cleanup-error arrays are empty through explicit page
close. Project leave returned ready/home/idle; observer subscriptions, timers,
listeners and raw buffers returned to zero. Raw process stdout separately retains
the Node color-environment advisories.

All 81 reported attachments exist. The success trace is retained and its 172 ZIP
members pass CRC validation. All 154 original artifact files / 10,072,798 bytes
match the runner manifest. There are 46 PNG copies with nine distinct image hashes;
every distinct image was viewed. Initial and serif text, unavailable blank, early
reopen blank, later rendered text and empty controls agree with the raw results.
The seven page screenshots retain the existing surrounding workspace clipping;
this gate does not claim whole-workspace layout acceptance.

All ten runner-observed identities plus outer shell 20922 and awake guard 20938
exited naturally. Fresh complete process tables and lsof at 19:54:56.077116Z found
all twelve recorded PIDs absent, no private browser executable and port 5200 clear.
The slot was released immediately after this verification. Root independently
confirmed physical release at 19:56:02.952Z. No deadline, forced termination,
observer/query/cleanup error or incomplete stdout occurred.

## Durable evidence

[Lossless evidence bundle](first-paint-b7a0977-evidence.tar.gz): 7,323,397 bytes,
178 members including its manifest; all 177 member hashes verified. Archive SHA256:
`e78abc7bc3f9105aae4c1042b4e5f15c27dfde00fbf6ecde911fd23df9ba9452`.
The adjacent JSON records archive identity and qualifications. The bundle preserves
the raw run, full success trace, original manifest, source snapshot, outer and
fresh release records, independent parent receipts, offline byte/mask audit and
complete visual identity review. Originals remain under
`/private/tmp/issue200-first-paint-b7a0977-01` and its sibling outer/archive paths.

This is an evidence-only checkpoint. Production and the executed diagnostic remain
unchanged. No correction, rerun, sync, build, encoded export or additional G4 run
follows it. Shared key/encoded checks remain coordinated with #199; remaining
title accessibility and final engineering obligations retain their separate gates.
