import { describe, expect, test, vi } from 'vitest'
import { createFrameIndex } from './frameIndex'

interface Item {
  readonly id: string
  readonly startFrame: number
  readonly endFrame: number
}

const boundsOf = (item: Item) => ({
  startFrame: item.startFrame,
  endFrame: item.endFrame,
})

describe('immutable frame index', () => {
  test('uses exact half-open boundaries across dense touching items', () => {
    const items = [
      { id: 'A', startFrame: 0, endFrame: 10 },
      { id: 'B', startFrame: 10, endFrame: 20 },
      { id: 'C', startFrame: 20, endFrame: 30 },
    ]
    const index = createFrameIndex(items, boundsOf)

    expect(index.activeAt(-1)).toBeNull()
    expect(index.activeAt(0)?.id).toBe('A')
    expect(index.activeAt(9)?.id).toBe('A')
    expect(index.activeAt(10)?.id).toBe('B')
    expect(index.activeAt(20)?.id).toBe('C')
    expect(index.activeAt(29)?.id).toBe('C')
    expect(index.activeAt(30)).toBeNull()
  })

  test('finds sparse late items and preserves gaps', () => {
    const items = [
      { id: 'early', startFrame: 100, endFrame: 120 },
      { id: 'middle', startFrame: 10_000, endFrame: 10_010 },
      { id: 'late', startFrame: 9_000_000, endFrame: 9_000_002 },
    ]
    const index = createFrameIndex(items, boundsOf)

    expect(index.activeAt(0)).toBeNull()
    expect(index.activeAt(9_999)).toBeNull()
    expect(index.activeAt(10_000)?.id).toBe('middle')
    expect(index.activeAt(8_999_999)).toBeNull()
    expect(index.activeAt(9_000_001)?.id).toBe('late')
  })

  test('snapshots bounds once and never mutates the authored list', () => {
    const items = [
      { id: 'A', startFrame: 0, endFrame: 10 },
      { id: 'B', startFrame: 20, endFrame: 30 },
    ]
    const original = [...items]
    const bounds = vi.fn(boundsOf)
    const index = createFrameIndex(items, bounds)

    expect(index.activeAt(1)).toBe(items[0])
    expect(index.activeAt(21)).toBe(items[1])
    expect(index.activeAt(25)).toBe(items[1])
    expect(bounds).toHaveBeenCalledTimes(items.length)
    expect(items).toEqual(original)
    expect(Object.isFrozen(index)).toBe(true)
  })

  test('retains deterministic first-match behavior for malformed overlap', () => {
    const items = [
      { id: 'first', startFrame: 0, endFrame: 20 },
      { id: 'overlap', startFrame: 10, endFrame: 30 },
    ]
    const index = createFrameIndex(items, boundsOf)

    expect(index.activeAt(15)?.id).toBe('first')
    expect(index.activeAt(25)?.id).toBe('overlap')
  })

  test('returns an immutable empty index without reading bounds', () => {
    const bounds = vi.fn(boundsOf)
    const index = createFrameIndex<Item>([], bounds)

    expect(index.size).toBe(0)
    expect(index.activeAt(0)).toBeNull()
    expect(bounds).not.toHaveBeenCalled()
    expect(Object.isFrozen(index)).toBe(true)
  })
})
