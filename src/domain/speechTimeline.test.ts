import { expect, test } from 'vitest'
import { projectSpeechCue } from './speechTimeline'
test.each([{ num: 24, den: 1 }, { num: 30000, den: 1001 }])('10–20 ms cues retain one frame with exact 11025 Hz projection at %o', rate => {
  expect(projectSpeechCue(0, 1, 2, 11025, rate, 100)).toEqual({ startFrame: 100, endFrame: 101 })
})
test('window sample offsets and centiseconds combine without intermediate rounding', () => {
  const result = projectSpeechCue(11026, 1, 2, 11025, { num: 30000, den: 1001 }, 0)
  expect(result).toEqual({ startFrame: 30, endFrame: 31 })
  expect(projectSpeechCue(0, 0, 100, 48000, { num: 30, den: 1 }, 100)).toEqual({ startFrame: 100, endFrame: 130 })
})
