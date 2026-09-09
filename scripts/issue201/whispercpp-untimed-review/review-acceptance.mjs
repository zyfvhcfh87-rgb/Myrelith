// Laboratory acceptance only. Source-window coverage is not cue timing.
export function assessReviewWindows(windows, seconds, { requireSpeech = false } = {}) {
  const fail = message => { throw new Error(message) }
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300 || !Array.isArray(windows)) fail('Malformed review window plan')
  const planned = []
  for (let start = 0; start < seconds; start += 25) {
    const end = Math.min(seconds, start + 30)
    planned.push({ start, end })
    if (end === seconds) break
  }
  if (windows.length !== planned.length) fail('Review omitted or added a source window')
  let timedWindows = 0, untimedWindows = 0, timedCues = 0
  windows.forEach((window, index) => {
    const plan = planned[index]
    if (window.start !== plan.start || window.end !== plan.end || 'timestamp' in window
      || typeof window.text !== 'string' || window.text.length > 20_000
      || !Array.isArray(window.chunks) || window.chunks.length > 1000) fail('Malformed review window')
    if (requireSpeech && !window.text.trim()) fail('Known speech window returned no review text')
    if (window.timing === 'unavailable') {
      if (window.reason !== 'timestamp-coverage' || !window.text.trim() || window.chunks.length) fail('Untimed text exposed cues or lost its reason/text')
      untimedWindows++
    } else if (window.timing === 'model') {
      let previousEnd = 0, text = ''
      for (const chunk of window.chunks) {
        if (typeof chunk.text !== 'string' || !chunk.text.trim() || chunk.text.length > 4000
          || chunk.timed !== true || !Array.isArray(chunk.timestamp) || chunk.timestamp.length !== 2) fail('Malformed timed cue')
        const [from, to] = chunk.timestamp
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < previousEnd || to <= from
          || to > plan.end - plan.start) fail('Timed cue exceeds source coverage or ordering')
        previousEnd = to; text += chunk.text
      }
      if (text !== window.text) fail('Timed review dropped or added transcript text')
      timedWindows++; timedCues += window.chunks.length
    } else fail('Unknown review timing status')
  })
  return { windows: windows.length, timedWindows, untimedWindows, timedCues }
}
