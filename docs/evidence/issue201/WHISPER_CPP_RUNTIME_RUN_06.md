# Bounded-support runtime06 result

Source 984a0457a882e7379f7ae053c3377fe6b48f969c, checkpoint
9e4e061b82aa6a189ad88e8177712f32214d80469f0640160585570d5990712b.
The single granted attempt started at 2026-09-08T22:24:23.917Z with runner
63642 and exited 1: 18 cases passed, the 300-second case failed, and four
offline/reopen/removal cases were unrun.

The exact short-source rejection passed its approved assertions: no returned
cues, zero audio owners, unchanged lab generation, acknowledged native zero
and separately recorded worker termination. Corrupt-audio rejection and
cancellation during model-load, preparation and inference passed, as did
project replacement. English/French word error rates remain 0.058823529411764705
and 0.4; silence passed. These case results do not establish aggregate resource
qualification.

The fixed resident-memory ceiling stopped the 300-second case after 52ms,
before it produced any server request or inference result. Baseline was
272,498,688B; peak 1,405,517,824B; delta 1,133,019,136B, exceeding the 1 GiB
delta limit by 59,277,312B (56.53 MiB). There were 135 samples with maximum
sample/active-epoch gap 109ms. A secondary shutdown-sampling-gap classification
and unavailable final cooperative model/cache cleanup are preserved in the
raw outcome. No cap was relaxed or attempt repeated.

In the preceding three active cancellations and project replacement, the
client terminated each worker and immediately reported zero JS worker owners.
The last resident samples then increased from 903,233,536B to 1,103,413,248B,
1,249,099,776B and 1,405,517,824B. This suggests resource overlap around rapid
worker replacement, but the current evidence does not identify a retained
allocation or prove a leak. Termination is not evidence of immediate physical
memory reclamation. The long-job and offline gates remain incomplete; no
overall speech GO is claimed.

Independent release at 2026-09-08T22:25:20.677897Z found runner 63642 and
browser PIDs 63671, 63672, 63673, 63674 absent, port 5201 refused (61), and
profile06 absent. No owned awake helper or slot remains. Five exact raw
final/journal/marker/release/outer files are retained as gzip with identities
in raw-records.json. All earlier outcomes remain unchanged.
