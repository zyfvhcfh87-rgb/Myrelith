/**
 * The Issue #54 route is opt-in by URL in dev and additionally build-gated in
 * production. main.tsx keeps that environment check inline beside its dynamic
 * import so ordinary production builds remove the whole benchmark chunk.
 */
export const PERFORMANCE_BENCHMARK_PATH = '/__myrelith/performance'
