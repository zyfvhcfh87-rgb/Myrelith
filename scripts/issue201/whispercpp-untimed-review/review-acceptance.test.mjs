import assert from 'node:assert/strict'
import test from 'node:test'
import { assessReviewWindows } from './review-acceptance.mjs'

const timed = (start = 0, end = 30) => ({ start, end, timing: 'model', text: ' words',
  chunks: [{ text: ' words', timestamp: [0, 1], timed: true }] })
const untimed = (start = 0, end = 30) => ({ start, end, timing: 'unavailable',
  reason: 'timestamp-coverage', text: ' words need timing', chunks: [] })
test('mixed review accounts for all twelve original windows without treating source coverage as cue timing', () => {
  const windows = Array.from({ length: 12 }, (_, index) => (index === 2 ? untimed : timed)(index * 25, Math.min(300, index * 25 + 30)))
  assert.deepEqual(assessReviewWindows(windows, 300), { windows: 12, timedWindows: 11, untimedWindows: 1, timedCues: 11 })
  assert.deepEqual(assessReviewWindows([untimed(0, 1)], 1), { windows: 1, timedWindows: 0, untimedWindows: 1, timedCues: 0 })
})
test('partial plans, fabricated timed cues, invalid timing and silent text omission cannot pass the gate', () => {
  for (const windows of [
    [], [timed(25, 30)], [{ ...untimed(), chunks: timed().chunks }],
    [{ ...untimed(), reason: 'unknown' }], [{ ...untimed(), text: '' }],
    [{ ...untimed(), timestamp: [0, 30] }], [{ ...timed(), timing: undefined }],
    [{ ...timed(), text: ' lost text' }],
    [{ ...timed(), chunks: [{ text: ' words', timestamp: [0, 30.01], timed: true }] }],
    [{ ...timed(), chunks: [{ text: ' words', timestamp: [0, 1], timed: false }] }],
  ]) assert.throws(() => assessReviewWindows(windows, 30))
})
test('known repeated speech cannot pass with empty windows while ordinary silence remains valid', () => {
  const silence = { start: 0, end: 1, timing: 'model', text: '', chunks: [], digitalSilenceSkipped: true }
  assert.equal(assessReviewWindows([silence], 1).timedCues, 0)
  assert.throws(() => assessReviewWindows([silence], 1, { requireSpeech: true }), /no review text/)
})
