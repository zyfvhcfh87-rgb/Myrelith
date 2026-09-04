import { renderHook } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { DEFAULT_MEDIA_POOL_ROW_LAYOUT } from './mediaPoolModel'
import { useMediaPoolVirtualizer } from './useMediaPoolVirtualizer'

describe('useMediaPoolVirtualizer', () => {
  test('keeps its facade stable when inputs and measurements are unchanged', () => {
    const items = Object.freeze([])
    const { result, rerender } = renderHook(
      ({ layout }) => useMediaPoolVirtualizer(items, layout),
      { initialProps: { layout: DEFAULT_MEDIA_POOL_ROW_LAYOUT } },
    )
    const first = result.current

    rerender({ layout: DEFAULT_MEDIA_POOL_ROW_LAYOUT })

    expect(result.current).toBe(first)

    rerender({
      layout: {
        ...DEFAULT_MEDIA_POOL_ROW_LAYOUT,
        viewMode: 'details',
      },
    })
    expect(result.current.ensureRowVisible).toBe(first.ensureRowVisible)
  })
})
