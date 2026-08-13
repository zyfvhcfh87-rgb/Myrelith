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

  it('accepts only bounded strictly increasing sparse timestamps inside the lane', () => {
    expect(() => validateMotionAnalysisWorkerRunMessage(runMessage({
      samplingIntervalFrames: 1,
      sampleTimestampsUs: [0, 41_667, 125_000],
    }))).not.toThrow()
    expect(() => validateMotionAnalysisWorkerRunMessage(runMessage({
      sampleTimestampsUs: [0, 41_667],
    }))).toThrow(/sample envelope/)
    expect(() => validateMotionAnalysisWorkerRunMessage(runMessage({
      samplingIntervalFrames: 1,
      sampleTimestampsUs: [0, 0],
    }))).toThrow(/strictly increasing/)
    expect(() => validateMotionAnalysisWorkerRunMessage(runMessage({
      samplingIntervalFrames: 1,
      sampleTimestampsUs: [1_000_000],
    }))).toThrow(/within the source range/)
  })
})
