# Caption schema and review admission integration

Integrated reviewed caption source13d54bcefac78f14b6b1ea38b33537345003eb21
into the previous combined checkpoint08805c570fb60f739e3414e4d76eff861cc89343.
The merge includes the previously reviewed ASS time/import/export and batch
authorities, explicit optional shadow intent, schema24 track/cue style and
historical origin, whole-project/file/history admission, and owned caption reviews.
It includes the source and preserved failure records of earlier speech research;
it enables no speech runtime or model in the application. Candidate05 remains a
separate frozen laboratory source and is not part of this merge.

The parent reproduced a synchronous subscriber replacing the project after new
review ownership was registered. The old candidate stayed retained under the new
ledger. Correction13d54bc guards capture/replacement/no-op reduction, checks
currentness after notification, and disposes stale references and ownership.
It blocks nested prepare/Apply during admission without rolling back an external
project/history change. The unchanged12-case parent reproducer now passes;
15 dedicated reentrant cases cover replacement, generation, navigation, disposal,
exceptions and nested commands. Parent source validation passed12files272tests
plus17runner checks before integration.

The first combined matrix passed403tests and failed one architecture assertion:
captionBatch.test.ts still used schema21. The parent changed only that ordinary
test fixture to CURRENT_TIMELINE_SCHEMA_VERSION. Its two affected files passed
26tests plus17runner checks. The repeated complete focused integration matrix
then passed **21files404tests plus17runner checks**. TypeScript/Vite production
build and lint pass; the existing large-chunk advisory remains. No caption
product code needed a merge correction, and the held mask/tracking/animation
file, history, retention and title-adapter checks are included in this matrix.

Logs retained in /private/tmp/milestone9-caption-integration-{tests,build,lint}.log,
-fixture-correction.log and-final-tests.log. Original failing output is preserved.

Qualification: semantic persistence and application admission only. Caption
style painting, ASS authoring UI, real pixel/encoded export acceptance, optional
transcription, full-suite/audit and final combined browser gates remain open.
The root master checkout and remote repository are unchanged.
