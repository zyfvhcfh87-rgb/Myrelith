// Pure laboratory acceptance checks, shared by the executable worker/runner/tests.
export function speechSegments(result, durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0
    || typeof result.text !== 'string' || result.text.length > 20_000
    || !Array.isArray(result.chunks) || result.chunks.length > 1_000) throw new Error('Unbounded or malformed inference result')
  let chunkCharacters = 0
  let previousEnd = 0
  return result.chunks.map((chunk) => {
    if (typeof chunk.text !== 'string' || chunk.text.length > 4_000 || !Array.isArray(chunk.timestamp) || chunk.timestamp.length !== 2) throw new Error('Malformed speech segment')
    chunkCharacters += chunk.text.length
    if (chunkCharacters > 20_000) throw new Error('Speech segment aggregate exceeded its character budget')
    const [from, to] = chunk.timestamp
    const timed = Number.isFinite(from) && Number.isFinite(to) && from >= previousEnd
      && to > from && to <= durationSeconds
    if (timed) previousEnd = to
    return { text: chunk.text, timestamp: [from, to], timed }
  })
}

export function withinSourceCoverage(requestedSeconds, coverageSeconds) {
  return Number.isFinite(requestedSeconds) && Number.isFinite(coverageSeconds)
    && requestedSeconds > 0 && requestedSeconds <= coverageSeconds
}

export function declaredLabRequest(url, method, servedUrls) {
  return method === 'GET' && (servedUrls.has(url) || url === 'http://127.0.0.1:5201/favicon.ico')
}

export function residentCeilingBreached(baseline, sample, ceiling) {
  return Number.isFinite(baseline) && Number.isFinite(sample) && sample - baseline > ceiling
}

/** Periodic requests coalesce; every named request queues a fresh observation. */
export function createLabSampleQueue(capture, stopped) {
  let tail = null
  function take(label) {
    if (label === undefined && tail) return tail
    const predecessor = tail
    const work = (async () => {
      await predecessor
      if (stopped()) return
      return capture(label)
    })()
    tail = work
    const release = () => { if (tail === work) tail = null }
    void work.then(release, release)
    return work
  }
  return { take, drain: () => tail ?? Promise.resolve() }
}
