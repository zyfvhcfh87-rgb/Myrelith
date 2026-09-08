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

/** Exact aliases for the already verified pinned files, never a basename fallback. */
export function pinnedModelFileLookup(model, origin) {
  return new Map(model.files.flatMap((file) => [
    [file.url, file],
    [`${origin}/models/${model.id}/${file.path}`, file],
    [`/models/${model.id}/${file.path}`, file],
    [`${model.id}/${file.path}`, file],
  ]))
}

export function initializationFailure(events) {
  return events.find((event) => event.type === 'error' && event.code === 'initialization-failed') ?? null
}

export function corruptAudioReachedDecode(error, state) {
  return error?.code === 'transcription-failed' && error.phase === 'decode-setup'
    && state.workerOwners === 0
    && state.events.some((event) => event.type === 'ready' && event.ledger?.modelOwners === 1)
}

export const LAB_CASE_NAMES = Object.freeze([
  'no-model-and-lazy-runtime', 'cancel-acquisition', 'verified-model-install',
  'cancel-cache-write-restores-committed-model', 'cancel-cache-commit-restores-committed-model',
  'corrupt-cache-rejected-before-inference', 'selected-local-files-install', 'capacity-rejection-preserves-model',
  'transcribe-english-8', 'transcribe-english-9', 'transcribe-french-10', 'transcribe-silence-11',
  'one-second-speech-window', 'corrupt-audio-rejection', 'cancel-model-load', 'cancel-prepare', 'cancel-infer',
  'project-replacement', '300-second-bounded-workload', 'offline-loaded-app-and-fresh-worker',
  'offline-page-reload', 'offline-persistent-browser-reopen', 'remove-model-and-offline-no-model',
])

export function assessLabRun(results, problems, stopReason) {
  const seen = new Set(results.map((result) => result.name))
  const missing = LAB_CASE_NAMES.filter((name) => !seen.has(name))
  const failed = results.filter((result) => !result.passed).map((result) => result.name)
  const unexpected = results.filter((result) => !LAB_CASE_NAMES.includes(result.name)).map((result) => result.name)
  const duplicateNames = results.length !== seen.size
  return { automatedStatus: missing.length || stopReason ? 'failed-incomplete'
    : failed.length || problems.length || unexpected.length || duplicateNames ? 'failed' : 'passed',
  expectedCases: LAB_CASE_NAMES.length, completedCases: results.length, missing, failed, unexpected, duplicateNames,
  qualification: 'Automatic laboratory checks only; no production/model enablement verdict.' }
}
