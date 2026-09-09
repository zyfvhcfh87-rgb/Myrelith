# Runtime09 proposal: distinguish app opening from offline transcription

Runtime08 is preserved in `bb366b168e130d85e3e4d6f02272cacd18ad5bdb`:
20 passing cases, offline page navigation failure, two unrun cases. Its
complete five-minute transcription review and memory results remain valid
for that observed run; no overall GO is claimed.

Source inspection confirms model bytes and provenance live in Cache Storage.
Application files use ordinary HTTP caching, and the server marks immutable
assets with a one-year cache lifetime. Neither the laboratory nor current
production app installs a service worker. These paths do not guarantee an
offline page reload. Runtime08's fresh-worker transcription while the app
was loaded did pass; its later failure occurred at page navigation.

The explicit supported behavior is: opening/reopening the editor requires
its application files to be served; an already loaded editor with a verified
cached model can transcribe offline. The model stays local across reopening.
This does not add PWA/service-worker support or promise offline navigation.

The smallest runner revision preserves the original 23 cases, workload and
resource/quality limits. Reload and persistent-reopen cases first attempt
offline navigation and record the known disconnected result (or incidental
browser-cache navigation, without treating it as a supported guarantee).
They then reconnect to serve app files, with every model-download URL blocked
at the owned server; any attempted model download fails the run. Before/after
model metadata must match, including the same cache identity. The existing
cache reader rehashes the bytes and verifies complete provenance. Each case
then switches offline again and requires valid timed English transcription
from a fresh worker and acknowledged cleanup.

The final removal case additionally verifies no model cache remains, no
worker/acquisition starts, and offline transcription reports no installed
model. Pure app-file recovery is the only permitted online step in these
cases. Arbitrary navigation errors remain fatal. Runtime08 assets, generated
code, candidate manifest and source modules are unchanged; no new native
build, inventory, or model is involved. A fresh09 profile/marker and one
explicit root runtime grant are required. No automatic retry or product
enablement is authorized by this proposal.
