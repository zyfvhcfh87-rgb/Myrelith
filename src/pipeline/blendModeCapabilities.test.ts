import { describe, expect, test } from 'vitest'
import { BLEND_MODE_NAMES, resolveBlendMode } from '../domain/blendModes'
import {
  probeCanvasBlendMode,
  selectBlendModeBackend,
  type CanvasBlendProbeContext,
} from './blendModeCapabilities'

class CanvasProbeFake implements CanvasBlendProbeContext {
  private operation: GlobalCompositeOperation = 'destination-over'
  readonly rejected: Set<GlobalCompositeOperation>
  throwOnSet = false

  constructor(rejected: readonly GlobalCompositeOperation[] = []) {
    this.rejected = new Set(rejected)
  }

  get globalCompositeOperation(): GlobalCompositeOperation {
    return this.operation
  }

  set globalCompositeOperation(value: GlobalCompositeOperation) {
    if (this.throwOnSet) throw new Error('host setter failed')
    if (!this.rejected.has(value)) this.operation = value
  }
}

describe('blend-mode capability adapter', () => {
  test('probes Canvas2D support and restores the exact incoming operation', () => {
    const context = new CanvasProbeFake()
    expect(probeCanvasBlendMode(context, 'multiply')).toEqual({
      supported: true,
      operation: 'multiply',
    })
    expect(context.globalCompositeOperation).toBe('destination-over')
  })

  test('falls back to source-over and restores state when Canvas rejects a mode', () => {
    const context = new CanvasProbeFake(['overlay'])
    expect(probeCanvasBlendMode(context, 'overlay')).toEqual({
      supported: false,
      operation: 'source-over',
    })
    expect(context.globalCompositeOperation).toBe('destination-over')
  })

  test('contains a hostile setter without leaking the exception', () => {
    const context = new CanvasProbeFake()
    context.throwOnSet = true
    expect(probeCanvasBlendMode(context, 'screen')).toEqual({
      supported: false,
      operation: 'source-over',
    })
  })

  test('selects Canvas, registered WebGL parity, then compatibility in order', () => {
    const mode = resolveBlendMode('screen')
    expect(selectBlendModeBackend(mode, {
      supportsCanvas2D: () => true,
      supportsWebGL: () => true,
    })).toEqual({ backend: 'canvas2d', effective: 'screen' })
    expect(selectBlendModeBackend(mode, {
      supportsCanvas2D: () => false,
      supportsWebGL: () => true,
    })).toEqual({ backend: 'webgl', effective: 'screen' })
    expect(selectBlendModeBackend(mode, {
      supportsCanvas2D: () => false,
      supportsWebGL: () => false,
    })).toEqual({ backend: 'compatibility', effective: 'normal' })
    expect(selectBlendModeBackend(resolveBlendMode('future-soft-light'), {
      supportsCanvas2D: () => true,
      supportsWebGL: () => true,
    })).toEqual({ backend: 'compatibility', effective: 'normal' })
  })
})

test.each(BLEND_MODE_NAMES)('%s probes success, rejection and thrown setter without changing authored intent', (mode) => {
  const operation = mode === 'normal' ? 'source-over' : mode
  expect(probeCanvasBlendMode(new CanvasProbeFake(), mode)).toEqual({ supported: true, operation })
  const rejected = new CanvasProbeFake([operation])
  expect(probeCanvasBlendMode(rejected, mode)).toEqual({ supported: false, operation: 'source-over' })
  expect(rejected.globalCompositeOperation).toBe('destination-over')
  const hostile = new CanvasProbeFake(); hostile.throwOnSet = true
  expect(probeCanvasBlendMode(hostile, mode).supported).toBe(false)
})
