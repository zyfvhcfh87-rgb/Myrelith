import { describe, expect, test } from 'vitest'
import type { MediaSourceBounds, SourceTimestampBounds } from './schema'
import {
  cloneMediaSourceBounds,
  mediaSourceBoundsAcceptAnalyzed,
  mediaSourceBoundsEqual,
  sourceTimestampBoundsEqual,
} from './sourceBounds'

const UNKNOWN: SourceTimestampBounds = { status: 'unknown' }
const VIDEO: SourceTimestampBounds = {
  status: 'exact',
  firstTimestampUs: 1_000,
  endTimestampUs: 9_000,
}
const AUDIO: SourceTimestampBounds = {
  status: 'exact',
  firstTimestampUs: 2_000,
  endTimestampUs: 8_000,
}

function bounds(
  video: SourceTimestampBounds | null,
  audio: SourceTimestampBounds | null,
): MediaSourceBounds {
  return { video, audio }
}

describe('source timestamp bounds equality', () => {
  test('unknown facts compare equal only to unknown facts', () => {
    expect(sourceTimestampBoundsEqual(UNKNOWN, { status: 'unknown' })).toBe(true)
    expect(sourceTimestampBoundsEqual(UNKNOWN, VIDEO)).toBe(false)
    expect(sourceTimestampBoundsEqual(VIDEO, UNKNOWN)).toBe(false)
  })

  test('exact facts require both timestamp boundaries to match', () => {
    expect(sourceTimestampBoundsEqual(VIDEO, { ...VIDEO })).toBe(true)
    expect(sourceTimestampBoundsEqual(VIDEO, {
      ...VIDEO,
      firstTimestampUs: VIDEO.firstTimestampUs + 1,
    })).toBe(false)
    expect(sourceTimestampBoundsEqual(VIDEO, {
      ...VIDEO,
      endTimestampUs: VIDEO.endTimestampUs + 1,
    })).toBe(false)
  })
})

describe('media source bounds equality', () => {
  test('compares stream presence and each stream independently', () => {
    expect(mediaSourceBoundsEqual(
      bounds(VIDEO, AUDIO),
      bounds({ ...VIDEO }, { ...AUDIO }),
    )).toBe(true)
    expect(mediaSourceBoundsEqual(bounds(VIDEO, null), bounds(VIDEO, AUDIO)))
      .toBe(false)
    expect(mediaSourceBoundsEqual(bounds(VIDEO, AUDIO), bounds(AUDIO, VIDEO)))
      .toBe(false)
  })
})

describe('accepting newly analyzed bounds', () => {
  test('keeps exact durable facts strict', () => {
    expect(mediaSourceBoundsAcceptAnalyzed(
      bounds(VIDEO, AUDIO),
      bounds({ ...VIDEO }, { ...AUDIO }),
    )).toBe(true)
    expect(mediaSourceBoundsAcceptAnalyzed(
      bounds(VIDEO, AUDIO),
      bounds({ ...VIDEO, endTimestampUs: 9_001 }, AUDIO),
    )).toBe(false)
    expect(mediaSourceBoundsAcceptAnalyzed(
      bounds(VIDEO, AUDIO),
      bounds(UNKNOWN, AUDIO),
    )).toBe(false)
  })

  test('allows a legacy unknown fact to upgrade only to an exact fact', () => {
    expect(mediaSourceBoundsAcceptAnalyzed(
      bounds(UNKNOWN, null),
      bounds(VIDEO, null),
    )).toBe(true)
    expect(mediaSourceBoundsAcceptAnalyzed(
      bounds(UNKNOWN, null),
      bounds(UNKNOWN, null),
    )).toBe(false)
  })

  test('never invents or removes stream presence', () => {
    expect(mediaSourceBoundsAcceptAnalyzed(
      bounds(null, AUDIO),
      bounds(null, { ...AUDIO }),
    )).toBe(true)
    expect(mediaSourceBoundsAcceptAnalyzed(
      bounds(null, AUDIO),
      bounds(VIDEO, AUDIO),
    )).toBe(false)
    expect(mediaSourceBoundsAcceptAnalyzed(
      bounds(VIDEO, AUDIO),
      bounds(VIDEO, null),
    )).toBe(false)
  })

  test('rejects the whole projection when either stream is incompatible', () => {
    expect(mediaSourceBoundsAcceptAnalyzed(
      bounds(UNKNOWN, AUDIO),
      bounds(VIDEO, { ...AUDIO, firstTimestampUs: 2_001 }),
    )).toBe(false)
  })
})

describe('cloning media source bounds', () => {
  test('copies present stream facts and preserves absent streams', () => {
    const original = bounds(VIDEO, null)
    const cloned = cloneMediaSourceBounds(original)

    expect(cloned).toEqual(original)
    expect(cloned).not.toBe(original)
    expect(cloned.video).not.toBe(original.video)
    expect(cloned.audio).toBeNull()
  })
})
