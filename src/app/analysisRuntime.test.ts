import { describe, expect, test } from 'vitest'
import { exactKeys, jsonDigest, textDigest } from './analysisRuntime'

describe('analysis runtime helpers', () => {
  test('hashing serialized JSON equals hashing its parsed value (durable projection digests)', async () => {
    const snapshot = JSON.stringify({
      canvas: { width: 1920, height: 1080, frameRate: { num: 30000, den: 1001 } },
      clip: { id: 'clip-é', transform: { x: 0.1 + 0.2, y: -0, rotation: 1e-7, scale: 1e21 }, animation: undefined },
      source: { width: 3840, height: 2160, firstTimestampUs: -33_366 },
      request: { selection: { kind: 'box', box: { x: 1 / 3, y: 2 / 3 } }, text: 'quote " slash \\   \ud800 😀' },
      ordered: { b: 1, a: 2, 10: 'ten', 2: 'two' },
      list: [null, true, 0, [], {}],
    })
    expect(await textDigest(snapshot)).toBe(await jsonDigest(JSON.parse(snapshot)))
  })

  test('exact key checks ignore order but not extra or missing keys', () => {
    expect(exactKeys({ a: 1, b: 2 }, ['b', 'a'])).toBe(true)
    expect(exactKeys({ a: 1 }, ['a', 'b'])).toBe(false)
    expect(exactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false)
  })
})
