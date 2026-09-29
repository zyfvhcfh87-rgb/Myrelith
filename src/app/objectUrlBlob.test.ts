import { afterEach, describe, expect, test, vi } from 'vitest'
import { createMediaBlobFetcher, fetchObjectUrlBlob } from './objectUrlBlob'

function stubFetch(response: Response) {
  const fetchMock = vi.fn(async () => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('object URL blob reads', () => {
  test('returns the Blob and forwards a signal only when one is given', async () => {
    const fetchMock = stubFetch(new Response('bytes'))
    const blob = await fetchObjectUrlBlob('blob:source')
    expect(await blob.text()).toBe('bytes')
    expect(fetchMock).toHaveBeenLastCalledWith('blob:source')

    stubFetch(new Response('bytes'))
    const signal = new AbortController().signal
    await fetchObjectUrlBlob('blob:source', signal)
    expect(fetch).toHaveBeenLastCalledWith('blob:source', { signal })
  })

  test('a non-ok response fails with the default or the owner-provided text', async () => {
    stubFetch(new Response('missing', { status: 404 }))
    await expect(fetchObjectUrlBlob('blob:gone')).rejects.toThrow('Media source returned HTTP 404')

    stubFetch(new Response('missing', { status: 404 }))
    await expect(fetchObjectUrlBlob('blob:gone', undefined, () => 'Connected source cannot be read'))
      .rejects.toThrow('Connected source cannot be read')
  })

  test('a labelled reader names the reader and the full status line', async () => {
    stubFetch(new Response('missing', { status: 404, statusText: 'Not Found' }))
    await expect(createMediaBlobFetcher('export media')('blob:gone'))
      .rejects.toThrow('Could not read export media (404 Not Found)')
  })
})
