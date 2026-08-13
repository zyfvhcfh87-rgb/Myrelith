import { describe, expect, it } from 'vitest'
import {
  type MotionAnalysisWorkerRunMessage,
  validateMotionAnalysisWorkerRunMessage,
} from './motionAnalysisProtocol'

function runMessage(
  overrides: Partial<MotionAnalysisWorkerRunMessage> = {},
): MotionAnalysisWorkerRunMessage {
  return {
    type: 'run',
    requestId: 1,
    blob: new Blob(['video']),
    sourceId: 'source-1',
    videoStreamIndex: 0,
    budget: {
      fileBytes: 5,
      durationMicroseconds: 1_000_000,
      width: 320,
      height: 180,
      framesPerSecond: 30,
    },
    startTimestampUs: 0,
    endTimestampUs: 1_000_000,
    samplingIntervalFrames: 2,
    ...overrides,
  }
}

describe('validateMotionAnalysisWorkerRunMessage', () => {
  it('accepts signed exact primary-stream bounds', () => {
    expect(() => validateMotionAnalysisWorkerRunMessage(runMessage({
      startTimestampUs: -250_000,
      endTimestampUs: -1,
    }))).not.toThrow()
  })

  it('rejects fractional and reversed signed bounds', () => {
    expect(() => validateMotionAnalysisWorkerRunMessage(runMessage({
      startTimestampUs: -1.5,
    }))).toThrow('startTimestampUs must be a safe integer')
    expect(() => validateMotionAnalysisWorkerRunMessage(runMessage({
      startTimestampUs: -1,
      endTimestampUs: -2,
    }))).toThrow('Analysis source range must be non-empty')
  })
})
