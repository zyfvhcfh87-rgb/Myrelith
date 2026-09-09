// Private candidate patch helper. Copy into pinned whisper.cpp/src only when
// source preparation has passed review. Not an upstream ABI promise.
#pragma once
struct myrelith_token_budget {
    int limit;
    int used;
};

static inline bool myrelith_reserve_token(struct myrelith_token_budget * budget) {
    if (budget->used >= budget->limit) return false;
    budget->used += 1;
    return true;
}
