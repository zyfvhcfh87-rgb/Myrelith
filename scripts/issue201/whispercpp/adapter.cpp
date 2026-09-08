// Source-preparation candidate only. No compiled artifact is approved yet.
#include "whisper.h"
#include <emscripten/emscripten.h>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>

#if !defined(__EMSCRIPTEN__) || defined(__EMSCRIPTEN_PTHREADS__)
#error "This adapter requires the non-pthread Emscripten target"
#endif

namespace {
constexpr int model_bytes = 43537433;
constexpr int max_samples = 480000;
constexpr double timeout_ms = 120000.0;
whisper_context * context = nullptr;
void * model_input = nullptr;
float * pcm = nullptr;
int pcm_count = 0;
int generated = 0;
int ready_segments = 0;
bool busy = false;
bool deadline_hit = false;
double deadline = 0;

void clear_pcm() { std::free(pcm); pcm = nullptr; pcm_count = 0; }
void quiet_log(ggml_log_level, const char *, void *) {}
bool should_abort(void *) {
    if (emscripten_get_now() >= deadline) deadline_hit = true;
    return deadline_hit;
}
bool encoder_begin(whisper_context *, whisper_state *, void *) { return !should_abort(nullptr); }
struct pcm_cleanup { ~pcm_cleanup() { clear_pcm(); busy = false; } };

int validate_output(int sample_count) {
    const int count = whisper_full_n_segments(context);
    if (count < 0 || count > 1000) return -94;
    int64_t previous_end = 0;
    size_t total_bytes = 0;
    for (int i = 0; i < count; ++i) {
        const int64_t t0 = whisper_full_get_segment_t0(context, i);
        const int64_t t1 = whisper_full_get_segment_t1(context, i);
        // Centiseconds are integer multiples of 160 samples at 16 kHz.
        // Reject overhang; do not clip, fabricate, or epsilon-repair endpoints.
        if (t0 < previous_end || t1 <= t0 || t1 > sample_count / 160) return -94;
        const char * text = whisper_full_get_segment_text(context, i);
        if (!text) return -94;
        const size_t n = strnlen(text, 16001);
        if (n == 0 || n > 16000 || total_bytes + n > 80000) return -94;
        total_bytes += n; previous_end = t1;
    }
    ready_segments = count;
    return 0;
}
}

extern "C" {
// Only these bounded allocators are exported. JS never calls general malloc.
EMSCRIPTEN_KEEPALIVE uintptr_t speech_model_alloc(int bytes) {
    if (busy || context || model_input || bytes != model_bytes) return 0;
    model_input = std::malloc(model_bytes);
    return reinterpret_cast<uintptr_t>(model_input);
}

EMSCRIPTEN_KEEPALIVE int speech_load() {
    if (busy || context || !model_input) return -92;
    busy = true;
    int result = -92;
    whisper_log_set(quiet_log, nullptr);
    try {
        auto p = whisper_context_default_params();
        p.use_gpu = false;
        p.flash_attn = true;
        p.dtw_token_timestamps = false;
        context = whisper_init_from_buffer_with_params(model_input, model_bytes, p);
        if (context && whisper_is_multilingual(context) && whisper_n_vocab(context) == 51865 &&
            whisper_n_audio_ctx(context) == 1500 && whisper_n_text_ctx(context) == 448) result = 0;
    } catch (const std::exception &) { result = -92; }
    std::free(model_input); model_input = nullptr; busy = false;
    if (result && context) { whisper_free(context); context = nullptr; }
    return result;
}

EMSCRIPTEN_KEEPALIVE uintptr_t speech_pcm_alloc(int count) {
    if (busy || !context || pcm || count < 1600 || count > max_samples) return 0;
    ready_segments = 0; generated = 0;
    pcm = static_cast<float *>(std::malloc(static_cast<size_t>(count) * sizeof(float)));
    pcm_count = pcm ? count : 0;
    return reinterpret_cast<uintptr_t>(pcm);
}

EMSCRIPTEN_KEEPALIVE int speech_run(int language) {
    if (busy || !context || !pcm || (language != 0 && language != 1)) return -92;
    busy = true; pcm_cleanup cleanup;
    const int sample_count = pcm_count;
    ready_segments = 0; generated = 0; deadline_hit = false;
    deadline = emscripten_get_now() + timeout_ms;
    for (int i = 0; i < sample_count; ++i) if (!std::isfinite(pcm[i])) return -94;
    try {
        auto p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        p.n_threads = 1; p.n_max_text_ctx = 0; p.no_context = true;
        p.offset_ms = 0; p.duration_ms = 0;
        p.translate = false; p.language = language == 0 ? "en" : "fr";
        p.detect_language = false; p.no_timestamps = false; p.single_segment = false;
        p.print_special = false; p.print_progress = false;
        p.print_realtime = false; p.print_timestamps = false;
        p.token_timestamps = false; p.max_len = 0; p.split_on_word = false;
        p.max_tokens = 0; p.max_tokens_total = 448; p.tokens_generated = &generated;
        p.debug_mode = false; p.audio_ctx = 0; p.tdrz_enable = false;
        p.suppress_regex = nullptr; p.initial_prompt = nullptr; p.carry_initial_prompt = false;
        p.prompt_tokens = nullptr; p.prompt_n_tokens = 0;
        p.suppress_blank = true; p.suppress_nst = false;
        p.temperature = 0; p.temperature_inc = 0; p.max_initial_ts = 1;
        p.length_penalty = -1; p.entropy_thold = 2.4f;
        p.logprob_thold = -1; p.no_speech_thold = 0.6f;
        p.greedy.best_of = 1; p.beam_search.beam_size = 1; p.beam_search.patience = -1;
        p.vad = false; p.vad_model_path = nullptr;
        p.encoder_begin_callback = encoder_begin;
        p.abort_callback = should_abort;
        const int status = whisper_full(context, p, pcm, sample_count);
        // encoder_begin=false can yield a nominal zero with partial upstream
        // output. The owned sticky deadline always takes precedence.
        if (should_abort(nullptr)) return -93;
        if (status != 0) return status;
        if (generated < 0 || generated > 448) return -94;
        return validate_output(sample_count);
    } catch (const std::exception &) { return -92; }
}

EMSCRIPTEN_KEEPALIVE int speech_tokens() { return generated; }
EMSCRIPTEN_KEEPALIVE int speech_segment_count() { return ready_segments; }
EMSCRIPTEN_KEEPALIVE double speech_segment_t0(int i) {
    return i >= 0 && i < ready_segments ? static_cast<double>(whisper_full_get_segment_t0(context, i)) : -1;
}
EMSCRIPTEN_KEEPALIVE double speech_segment_t1(int i) {
    return i >= 0 && i < ready_segments ? static_cast<double>(whisper_full_get_segment_t1(context, i)) : -1;
}
EMSCRIPTEN_KEEPALIVE uintptr_t speech_segment_text(int i) {
    return i >= 0 && i < ready_segments ? reinterpret_cast<uintptr_t>(whisper_full_get_segment_text(context, i)) : 0;
}
EMSCRIPTEN_KEEPALIVE int speech_close() {
    if (busy) return -92;
    clear_pcm(); std::free(model_input); model_input = nullptr;
    if (context) { whisper_free(context); context = nullptr; }
    ready_segments = 0; generated = 0;
    return 0;
}
// Counts explicit owned resources; allocator/linear-memory capacity is separate.
EMSCRIPTEN_KEEPALIVE int speech_owned() { return !!context + !!model_input + !!pcm; }
}
