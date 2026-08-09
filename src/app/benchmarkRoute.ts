export const PERFORMANCE_BENCHMARK_PATH = '/__myrelith/performance'

export interface BenchmarkRouteEnvironment {
  readonly development: boolean
  readonly explicitlyEnabled: boolean
}

/** The route is opt-in by URL in dev and additionally build-gated in production. */
export function performanceBenchmarkRouteEnabled(
  pathname: string,
  environment: BenchmarkRouteEnvironment,
): boolean {
  if (pathname !== PERFORMANCE_BENCHMARK_PATH) return false
  return environment.development || environment.explicitlyEnabled
}
