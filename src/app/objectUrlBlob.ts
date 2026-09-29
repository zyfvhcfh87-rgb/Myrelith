/**
 * app/objectUrlBlob.ts — read a connected local source through its object URL.
 * Each owner keeps its own failure text for a non-ok response.
 */

function httpStatusFailure(response: Response): string {
  return `Media source returned HTTP ${response.status}`
}

/** Fetch `url` once and return its Blob; a non-ok response throws. */
export async function fetchObjectUrlBlob(
  url: string,
  signal?: AbortSignal,
  failureMessage: (response: Response) => string = httpStatusFailure,
): Promise<Blob> {
  const response = signal === undefined
    ? await fetch(url)
    : await fetch(url, { signal })
  if (!response.ok) throw new Error(failureMessage(response))
  return response.blob()
}

/** Signal-free reader whose failure names `label` and the HTTP status line. */
export function createMediaBlobFetcher(label: string): (url: string) => Promise<Blob> {
  return (url) => fetchObjectUrlBlob(
    url,
    undefined,
    (response) => `Could not read ${label} (${response.status} ${response.statusText})`,
  )
}
