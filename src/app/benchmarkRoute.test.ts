import { describe, expect, test } from 'vitest'
import {
  PERFORMANCE_BENCHMARK_PATH,
  performanceBenchmarkRouteEnabled,
} from './benchmarkRoute'

describe('performance benchmark route gate', () => {
  test('keeps ordinary application routes on the product UI', () => {
    expect(performanceBenchmarkRouteEnabled('/', {
      development: true,
      explicitlyEnabled: true,
    })).toBe(false)
  })

  test('allows the explicit route during development', () => {
    expect(performanceBenchmarkRouteEnabled(PERFORMANCE_BENCHMARK_PATH, {
      development: true,
      explicitlyEnabled: false,
    })).toBe(true)
  })

  test('requires an explicit production build flag', () => {
    expect(performanceBenchmarkRouteEnabled(PERFORMANCE_BENCHMARK_PATH, {
      development: false,
      explicitlyEnabled: false,
    })).toBe(false)
    expect(performanceBenchmarkRouteEnabled(PERFORMANCE_BENCHMARK_PATH, {
      development: false,
      explicitlyEnabled: true,
    })).toBe(true)
  })
})
