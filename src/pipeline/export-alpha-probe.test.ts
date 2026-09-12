import { describe, expect, test } from 'vitest'
import { proveAlphaVideoCodec } from './export-alpha-probe'

describe('proveAlphaVideoCodec', () => {
  test('rethrows the abort reason instead of reporting unsupported', async () => {
    const abort = new AbortController()
    const reason = new DOMException('Export cancelled', 'AbortError')
    abort.abort(reason)
    await expect(proveAlphaVideoCodec('vp9', abort.signal)).rejects.toBe(reason)
  })
})
