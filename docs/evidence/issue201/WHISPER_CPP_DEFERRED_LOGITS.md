# Defer eager output-logit capacity

Runtime03 measured a failed94,318,336-byte backend chunk. Source inspection finds
an avoidable earlier reservation in whisper_init_state (src/whisper.cpp3469):
`state->logits.reserve(n_vocab * n_text_ctx)`. This empty float vector reserves
51,865 ×448 ×4 =92,942,080 payload bytes before any of the four graph allocators.
The adapter requests one greedy decoder, no prompt/history and fixed language.

The proposed single-line change removes only that eager capacity reservation.
whisper_decode_internal already calls logits_out.resize(n_tokens*n_vocab) at2956
before any tensor copy into logits_out.data(). Logit processing follows successful
decode; language auto-detection also decodes before reading this vector. No size,
values, token budget, graph reservation, model, backend, heap or RSS limit changes.
This avoids the unnecessary initial reservation and preserves on-demand resizing.

This is a source-supported reduction in initialization demand, not proof that the
next candidate fits or that the measured refusal was solely heap exhaustion.
Inference may allocate or grow the vector later; the existing runtime resource
limits and first-failure stop remain mandatory. No automatic retry is proposed.

Keep the already accepted reserve-result guard and numeric allocation diagnostic.
The model staging lifetime is a separate possible optimization; it is deliberately
unchanged in this candidate to keep the measured change small. The patch and exact
before/after identity are beside this report. No compiler or runtime has run.

Source is staged separately in .tmp/issue201-whispercpp-deferred-logits-build.
The previous accepted source inventory and two guard/diagnostic patches are
reused, followed by this one-line patch. Actual patch application and the full
staged inventory pass the existing builder. Recipe/adapter/token helper remain
identical. A30-line wrapper changes only the accepted builder's evidence and
private attempt paths. Its original guards,180s/600s caps,two jobs,offline tools,
exclusive compile marker and no-runtime policy are reused without modification.
Compilation needs an explicit new slot and the exact checkpoint hash in
ISSUE201_BUILD_CHECKPOINT_SHA256; --compile remains unexecuted.
