/**
 * Pixel-golden tests for the shared preview/export compositor.
 *
 * jsdom has no Canvas2D implementation, so this file supplies the smallest
 * deterministic premultiplied-RGBA surface that exercises compositeFrame's
 * real transform, opacity, source-over, and Porter-Duff plus call sequence.
 */

import { describe, expect, test } from 'vitest'
import type {
  AdjustmentItem,
  Clip,
  EffectDescriptor,
  TimelineDoc,
  Track,
} from '../domain/schema'
import { createColorAdjustEffect } from '../domain/effectStack'
import {
  createPluginVideoEffectContributionSnapshot,
  type PluginVideoEffectContributionSnapshot,
} from '../domain/pluginVideoEffectStagePlan'
import { videoCompositionPlanAtFrame } from '../domain/videoCompositionPlan'
import {
  compositeFrame,
  type Composite2D,
  type FrameSource,
  type RenderFrameSource,
  type TransitionSurfaceProvider,
} from './render'
import type { VideoEffectStageExecutor } from './videoEffectStageExecution'

type Matrix = [number, number, number, number, number, number]
type Pixel = [number, number, number, number]

interface RasterSource {
  width: number
  height: number
  rgba: Uint8ClampedArray
}

interface CanvasState {
  alpha: number
  operation: GlobalCompositeOperation
  fillStyle: Composite2D['fillStyle']
  transform: Matrix
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function multiply(left: Matrix, right: Matrix): Matrix {
  const [a, b, c, d, e, f] = left
  const [g, h, i, j, k, l] = right
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ]
}

function inverse(matrix: Matrix): Matrix {
  const [a, b, c, d, e, f] = matrix
  const determinant = a * d - b * c
  if (Math.abs(determinant) < 1e-12) return [0, 0, 0, 0, 0, 0]
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ]
}

function transformPoint(matrix: Matrix, x: number, y: number): [number, number] {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ]
}

class PixelCanvas {
  readonly width: number
  readonly height: number
  readonly premultiplied: Float64Array
  readonly context: Composite2D
  private state: CanvasState
  private readonly stack: CanvasState[] = []

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.premultiplied = new Float64Array(width * height * 4)
    this.state = {
      alpha: 1,
      operation: 'source-over',
      fillStyle: '#000000',
      transform: [...IDENTITY],
    }
    const currentState = (): CanvasState => this.state

    this.context = {
      canvas: this as unknown as CanvasImageSource,
      get globalAlpha() {
        return currentState().alpha
      },
      set globalAlpha(value) {
        currentState().alpha = value
      },
      get globalCompositeOperation() {
        return currentState().operation
      },
      set globalCompositeOperation(value) {
        currentState().operation = value
      },
      get fillStyle() {
        return currentState().fillStyle
      },
      set fillStyle(value) {
        currentState().fillStyle = value
      },
      save: () => {
        this.stack.push({
          alpha: this.state.alpha,
          operation: this.state.operation,
          fillStyle: this.state.fillStyle,
          transform: [...this.state.transform],
        })
      },
      restore: () => {
        const restored = this.stack.pop()
        if (restored) this.state = restored
      },
      translate: (x, y) => {
        this.state.transform = multiply(
          this.state.transform,
          [1, 0, 0, 1, x, y],
        )
      },
      rotate: (angle) => {
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        this.state.transform = multiply(
          this.state.transform,
          [cos, sin, -sin, cos, 0, 0],
        )
      },
      scale: (x, y) => {
        this.state.transform = multiply(
          this.state.transform,
          [x, 0, 0, y, 0, 0],
        )
      },
      clearRect: (x, y, widthToClear, heightToClear) => {
        this.forEachCoveredPixel(
          x,
          y,
          widthToClear,
          heightToClear,
          (offset) => this.premultiplied.fill(0, offset, offset + 4),
        )
      },
      fillRect: (x, y, fillWidth, fillHeight) => {
        const straight = parseColor(this.state.fillStyle)
        const alpha = straight[3] * this.state.alpha
        const source: Pixel = [
          straight[0] * alpha,
          straight[1] * alpha,
          straight[2] * alpha,
          alpha,
        ]
        this.forEachCoveredPixel(
          x,
          y,
          fillWidth,
          fillHeight,
          (offset) => this.blend(offset, source),
        )
      },
      drawImage: (image, ...args) => {
        if (args.length === 2) {
          this.draw(image, 0, 0, undefined, undefined, args[0], args[1])
          return
        }
        if (args.length === 8) {
          const values = args as [number, number, number, number, number, number, number, number]
          this.draw(
            image,
            values[0],
            values[1],
            values[2],
            values[3],
            values[4],
            values[5],
            values[6],
            values[7],
          )
          return
        }
        throw new Error(`Unsupported pixel-test drawImage arity: ${args.length + 1}`)
      },
      getImageData: (sx, sy, width, height) => this.readPixels(sx, sy, width, height),
      putImageData: (imageData, dx, dy) => this.writePixels(imageData, dx, dy),
    }
  }

  private readPixels(sx: number, sy: number, width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sourceX = sx + x
        const sourceY = sy + y
        if (
          sourceX < 0
          || sourceX >= this.width
          || sourceY < 0
          || sourceY >= this.height
        ) continue
        const sourceOffset = (sourceY * this.width + sourceX) * 4
        const destinationOffset = (y * width + x) * 4
        const alpha = Math.min(1, Math.max(0, this.premultiplied[sourceOffset + 3]))
        data[destinationOffset + 3] = Math.round(alpha * 255)
        if (alpha === 0) continue
        for (let channel = 0; channel < 3; channel++) {
          data[destinationOffset + channel] = Math.round(
            Math.min(1, Math.max(0, this.premultiplied[sourceOffset + channel] / alpha)) * 255,
          )
        }
      }
    }
    return { data, width, height, colorSpace: 'srgb' } as ImageData
  }

  private writePixels(imageData: ImageData, dx: number, dy: number): void {
    for (let y = 0; y < imageData.height; y++) {
      for (let x = 0; x < imageData.width; x++) {
        const destinationX = dx + x
        const destinationY = dy + y
        if (
          destinationX < 0
          || destinationX >= this.width
          || destinationY < 0
          || destinationY >= this.height
        ) continue
        const sourceOffset = (y * imageData.width + x) * 4
        const destinationOffset = (destinationY * this.width + destinationX) * 4
        const alpha = imageData.data[sourceOffset + 3] / 255
        for (let channel = 0; channel < 3; channel++) {
          this.premultiplied[destinationOffset + channel] =
            (imageData.data[sourceOffset + channel] / 255) * alpha
        }
        this.premultiplied[destinationOffset + 3] = alpha
      }
    }
  }

  private forEachCoveredPixel(
    x: number,
    y: number,
    width: number,
    height: number,
    visit: (offset: number) => void,
  ): void {
    const inv = inverse(this.state.transform)
    for (let py = 0; py < this.height; py++) {
      for (let px = 0; px < this.width; px++) {
        const [localX, localY] = transformPoint(inv, px + 0.5, py + 0.5)
        if (
          localX >= x
          && localX < x + width
          && localY >= y
          && localY < y + height
        ) {
          visit((py * this.width + px) * 4)
        }
      }
    }
  }

  private draw(
    image: CanvasImageSource,
    sourceX: number,
    sourceY: number,
    sourceWidth: number | undefined,
    sourceHeight: number | undefined,
    dx: number,
    dy: number,
    destinationWidth?: number,
    destinationHeight?: number,
  ): void {
    const source = image as unknown as PixelCanvas | RasterSource
    const sampledWidth = sourceWidth ?? source.width
    const sampledHeight = sourceHeight ?? source.height
    const drawnWidth = destinationWidth ?? sampledWidth
    const drawnHeight = destinationHeight ?? sampledHeight
    const inv = inverse(this.state.transform)
    for (let py = 0; py < this.height; py++) {
      for (let px = 0; px < this.width; px++) {
        const [localX, localY] = transformPoint(inv, px + 0.5, py + 0.5)
        if (
          localX < dx
          || localX >= dx + drawnWidth
          || localY < dy
          || localY >= dy + drawnHeight
        ) continue
        const sampledX = Math.floor(
          sourceX + ((localX - dx) / drawnWidth) * sampledWidth + 1e-10,
        )
        const sampledY = Math.floor(
          sourceY + ((localY - dy) / drawnHeight) * sampledHeight + 1e-10,
        )
        if (
          sampledX < sourceX
          || sampledX >= sourceX + sampledWidth
          || sampledX < 0
          || sampledX >= source.width
          || sampledY < sourceY
          || sampledY >= sourceY + sampledHeight
          || sampledY < 0
          || sampledY >= source.height
        ) {
          continue
        }

        const sourceOffset = (sampledY * source.width + sampledX) * 4
        let pixel: Pixel
        if (source instanceof PixelCanvas) {
          pixel = [
            source.premultiplied[sourceOffset],
            source.premultiplied[sourceOffset + 1],
            source.premultiplied[sourceOffset + 2],
            source.premultiplied[sourceOffset + 3],
          ]
        } else {
          const alpha = source.rgba[sourceOffset + 3] / 255
          pixel = [
            (source.rgba[sourceOffset] / 255) * alpha,
            (source.rgba[sourceOffset + 1] / 255) * alpha,
            (source.rgba[sourceOffset + 2] / 255) * alpha,
            alpha,
          ]
        }
        const weighted: Pixel = [
          pixel[0] * this.state.alpha,
          pixel[1] * this.state.alpha,
          pixel[2] * this.state.alpha,
          pixel[3] * this.state.alpha,
        ]
        this.blend((py * this.width + px) * 4, weighted)
      }
    }
  }

  private blend(offset: number, source: Pixel): void {
    const destination: Pixel = [
      this.premultiplied[offset],
      this.premultiplied[offset + 1],
      this.premultiplied[offset + 2],
      this.premultiplied[offset + 3],
    ]
    if (this.state.operation === 'lighter') {
      for (let channel = 0; channel < 4; channel++) {
        this.premultiplied[offset + channel] = Math.min(
          1,
          source[channel] + destination[channel],
        )
      }
      return
    }
    const operation = this.state.operation
    if (
      operation !== 'source-over'
      && operation !== 'multiply'
      && operation !== 'screen'
      && operation !== 'overlay'
    ) {
      throw new Error(`Unsupported pixel-test operation: ${this.state.operation}`)
    }
    if (operation !== 'source-over') {
      const sourceAlpha = source[3]
      const destinationAlpha = destination[3]
      const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha)
      for (let channel = 0; channel < 3; channel++) {
        const sourceStraight = sourceAlpha > 0 ? source[channel] / sourceAlpha : 0
        const destinationStraight = destinationAlpha > 0
          ? destination[channel] / destinationAlpha
          : 0
        let blended = sourceStraight
        if (operation === 'multiply') blended = destinationStraight * sourceStraight
        if (operation === 'screen') {
          blended = destinationStraight + sourceStraight
            - destinationStraight * sourceStraight
        }
        if (operation === 'overlay') {
          blended = destinationStraight <= 0.5
            ? 2 * destinationStraight * sourceStraight
            : 1 - 2 * (1 - destinationStraight) * (1 - sourceStraight)
        }
        const isolatedSource = (1 - destinationAlpha) * sourceStraight
          + destinationAlpha * blended
        this.premultiplied[offset + channel] = sourceAlpha * isolatedSource
          + destination[channel] * (1 - sourceAlpha)
      }
      this.premultiplied[offset + 3] = outputAlpha
      return
    }
    const inverseSourceAlpha = 1 - source[3]
    for (let channel = 0; channel < 3; channel++) {
      this.premultiplied[offset + channel] =
        source[channel] + destination[channel] * inverseSourceAlpha
    }
    this.premultiplied[offset + 3] =
      source[3] + destination[3] * inverseSourceAlpha
  }

  rgbaAt(x: number, y: number): [number, number, number, number] {
    const offset = (y * this.width + x) * 4
    const alpha = this.premultiplied[offset + 3]
    if (alpha <= 0) return [0, 0, 0, 0]
    return [
      Math.round((this.premultiplied[offset] / alpha) * 255),
      Math.round((this.premultiplied[offset + 1] / alpha) * 255),
      Math.round((this.premultiplied[offset + 2] / alpha) * 255),
      Math.round(alpha * 255),
    ]
  }
}

function parseColor(fillStyle: Composite2D['fillStyle']): Pixel {
  if (fillStyle === '#000000') return [0, 0, 0, 1]
  throw new Error(`Unsupported pixel-test fill: ${String(fillStyle)}`)
}

function solid(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): RenderFrameSource {
  const bytes = new Uint8ClampedArray(width * height * 4)
  for (let offset = 0; offset < bytes.length; offset += 4) {
    bytes.set(rgba, offset)
  }
  return { width, height, rgba: bytes } as unknown as ImageBitmap
}

function horizontalColors(
  colors: Array<[number, number, number, number]>,
  height: number,
): RenderFrameSource {
  const bytes = new Uint8ClampedArray(colors.length * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < colors.length; x++) {
      bytes.set(colors[x], (y * colors.length + x) * 4)
    }
  }
  return { width: colors.length, height, rgba: bytes } as unknown as ImageBitmap
}

const PLUGIN_EFFECT_TYPE = 'plugin:com.example.pixel-test/channel-shift'

function pluginEffect(id = 'plugin-effect'): EffectDescriptor {
  return {
    id,
    type: PLUGIN_EFFECT_TYPE,
    version: 1,
    enabled: true,
    params: { amount: 1 },
  }
}

function pluginSnapshot(): PluginVideoEffectContributionSnapshot {
  return createPluginVideoEffectContributionSnapshot(8, [{
    signerFingerprint: `sha256:${'3'.repeat(64)}`,
    packageDigest: `sha256:${'4'.repeat(64)}`,
    pluginId: 'com.example.pixel-test',
    pluginVersion: '1.0.0',
    kind: 'video-effect',
    contributionVersion: 1,
    contributionId: 'channel-shift',
    contributionName: 'Channel Shift',
    descriptorVersion: 1,
    entrypoint: 'myrelith_effect_channel_shift',
    parameters: [{
      key: 'amount',
      name: 'Amount',
      kind: 'number',
      default: 1,
      min: 0,
      max: 1,
      step: 0.1,
      animatable: false,
    }],
    availability: 'ready',
    detail: 'Ready.',
  }])
}

function makeClip(
  id: string,
  assetId: string,
  timelineStart: number,
  durationFrames: number,
  overrides: Partial<Clip> = {},
): Clip {
  return {
    id,
    assetId,
    name: id,
    sourceMode: 'timed',
    sourceRange: { startFrame: 0, durationFrames },
    timelineRange: { startFrame: timelineStart, durationFrames },
    transform: {
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      anchorX: 0.5,
      anchorY: 0.5,
    },
    opacity: 1,
    volume: 1,
    effects: [],
    ...overrides,
  }
}

function makeTrack(
  id: string,
  clips: Clip[],
  overrides: Partial<Track> = {},
): Track {
  return {
    id,
    kind: 'video',
    name: id,
    clips,
    transitions: [],
    hidden: false,
    muted: false,
    solo: false,
    locked: false,
    ...overrides,
  }
}

function makeAdjustment(
  id: string,
  effect: EffectDescriptor,
  opacity = 1,
): AdjustmentItem {
  return {
    kind: 'adjustment',
    id,
    name: id,
    timelineRange: { startFrame: 0, durationFrames: 10 },
    enabled: true,
    opacity,
    animation: { tracks: [], effectTracks: [] },
    effects: [effect],
  }
}

function makeDoc(tracks: Track[], width = 5, height = 5): TimelineDoc {
  return {
    schemaVersion: 16,
    id: 'pixel-doc',
    name: 'pixel-doc',
    frameRate: { num: 30, den: 1 },
    width,
    height,
    audioSampleRate: 48_000,
    tracks,
  }
}

function transitionTrack(
  from: Clip,
  to: Clip,
  durationFrames: number,
  id = 'transition-track',
): Track {
  return makeTrack(id, [from, to], {
    transitions: [{
      id: `${id}-dissolve`,
      type: 'crossfade',
      fromClipId: from.id,
      toClipId: to.id,
      durationFrames,
      audio: { enabled: true, curve: 'equal-power' },
    }],
  })
}

function makeProvider(width: number, height: number) {
  const leg = new PixelCanvas(width, height)
  const group = new PixelCanvas(width, height)
  let gets = 0
  const provider: TransitionSurfaceProvider = {
    get: () => {
      gets++
      return {
        leg: {
          canvas: leg as unknown as CanvasImageSource,
          ctx: leg.context,
        },
        group: {
          canvas: group as unknown as CanvasImageSource,
          ctx: group.context,
        },
      }
    },
  }
  return { provider, leg, group, gets: () => gets }
}

function makeSource(frames: Record<string, RenderFrameSource | null>) {
  const requests: string[] = []
  const source: FrameSource = {
    getFrame: async (assetId, sourceFrame) => {
      requests.push(`${assetId}@${sourceFrame}`)
      return frames[assetId] ?? null
    },
  }
  return { source, requests }
}

async function render(
  doc: TimelineDoc,
  frame: number,
  frames: Record<string, RenderFrameSource | null>,
  pluginContributions?: PluginVideoEffectContributionSnapshot,
  videoEffectStageExecutor?: VideoEffectStageExecutor | null,
) {
  const output = new PixelCanvas(doc.width, doc.height)
  const surfaces = makeProvider(doc.width, doc.height)
  const source = makeSource(frames)
  const result = await compositeFrame(
    doc,
    videoCompositionPlanAtFrame(doc, frame, new Map(
      doc.tracks.flatMap((track) => track.clips.map((clip) => [
        clip.assetId,
        {
          video: {
            status: 'exact' as const,
            firstTimestampUs: 0,
            endTimestampUs: 1_000_000_000,
          },
          audio: null,
        },
      ] as const)),
    ), pluginContributions),
    output.context,
    source.source,
    surfaces.provider,
    undefined,
    undefined,
    videoEffectStageExecutor,
  )
  return { output, surfaces, requests: source.requests, result }
}

describe('compositeFrame pixel goldens', () => {
  test.each([
    ['normal', [192, 96, 32, 255]],
    ['multiply', [48, 48, 24, 255]],
    ['screen', [208, 176, 200, 255]],
    ['overlay', [96, 97, 145, 255]],
  ] as const)('matches the opaque %s reference pixel through the shared compositor', async (
    blendMode,
    expected,
  ) => {
    const lower = makeClip('lower', 'backdrop', 0, 1)
    const upper = makeClip('upper', 'source', 0, 1, { blendMode })
    const rendered = await render(
      makeDoc([makeTrack('lower-track', [lower]), makeTrack('upper-track', [upper])], 1, 1),
      0,
      {
        backdrop: solid(1, 1, [64, 128, 192, 255]),
        source: solid(1, 1, [192, 96, 32, 255]),
      },
    )

    expect(rendered.output.rgbaAt(0, 0)).toEqual(expected)
    expect(rendered.surfaces.gets()).toBe(0)
  })

  test('applies source opacity to premultiplied overlay alpha exactly once', async () => {
    const lower = makeClip('lower', 'backdrop', 0, 1)
    const upper = makeClip('upper', 'source', 0, 1, {
      blendMode: 'overlay',
      opacity: 0.5,
    })
    const rendered = await render(
      makeDoc([makeTrack('lower-track', [lower]), makeTrack('upper-track', [upper])], 1, 1),
      0,
      {
        backdrop: solid(1, 1, [64, 128, 192, 255]),
        source: solid(1, 1, [192, 96, 32, 128]),
      },
    )

    expect(rendered.output.rgbaAt(0, 0)).toEqual([72, 120, 180, 255])
  })

  test('adjusts the completed lower composite before painting upper tracks', async () => {
    const lower = makeClip('lower', 'gray', 0, 1)
    const upper = makeClip('upper', 'red', 0, 1, { opacity: 0.5 })
    const exposure = createColorAdjustEffect('exposure')
    exposure.params.exposure = 1
    const adjustmentTrack = makeTrack('adjustment-track', [], {
      adjustments: [makeAdjustment('grade', exposure)],
    })
    const rendered = await render(
      makeDoc([
        makeTrack('lower-track', [lower]),
        adjustmentTrack,
        makeTrack('upper-track', [upper]),
      ], 1, 1),
      0,
      {
        gray: solid(1, 1, [64, 64, 64, 255]),
        red: solid(1, 1, [255, 0, 0, 255]),
      },
    )

    expect(rendered.output.rgbaAt(0, 0)).toEqual([192, 64, 64, 255])
    expect(rendered.requests).toEqual(['gray@0', 'red@0'])
    expect(rendered.result).toEqual({ drawn: ['lower', 'upper'], missing: [] })
    expect(rendered.surfaces.gets()).toBe(1)
    expect(rendered.surfaces.group.rgbaAt(0, 0)).toEqual([0, 0, 0, 0])
  })

  test('mixes adjustment opacity once and visibly bypasses unknown effects', async () => {
    const lower = makeClip('lower', 'gray', 0, 1)
    const exposure = createColorAdjustEffect('exposure')
    exposure.params.exposure = 1
    const half = makeTrack('half-grade', [], {
      adjustments: [makeAdjustment('half', exposure, 0.5)],
    })
    const halfRendered = await render(
      makeDoc([makeTrack('lower-track', [lower]), half], 1, 1),
      0,
      { gray: solid(1, 1, [64, 64, 64, 255]) },
    )
    expect(halfRendered.output.rgbaAt(0, 0)).toEqual([96, 96, 96, 255])

    const unknown: EffectDescriptor = {
      id: 'future',
      type: 'future.full-frame-look',
      version: 9,
      enabled: true,
      params: { intent: 'preserve-me' },
    }
    const bypass = makeTrack('unknown-grade', [], {
      adjustments: [makeAdjustment('future-grade', unknown)],
    })
    const bypassed = await render(
      makeDoc([makeTrack('lower-track', [lower]), bypass], 1, 1),
      0,
      { gray: solid(1, 1, [64, 64, 64, 255]) },
    )
    expect(bypassed.output.rgbaAt(0, 0)).toEqual([64, 64, 64, 255])
    expect(bypass.adjustments?.[0]?.effects[0]).toEqual(unknown)
  })

  test('keeps transformed and cropped blend coverage isolated from uncovered pixels', async () => {
    const lower = makeClip('lower', 'backdrop', 0, 1)
    const transformed = makeClip('transformed', 'source', 0, 1, {
      blendMode: 'multiply',
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 90,
        anchorX: 0.5,
        anchorY: 0.5,
      },
      visual: {
        crop: { left: 1 / 3, right: 1 / 3, top: 0, bottom: 0 },
        flipHorizontal: false,
        flipVertical: false,
        scaleLocked: true,
      },
    })
    const rendered = await render(
      makeDoc([
        makeTrack('lower-track', [lower]),
        makeTrack('upper-track', [transformed]),
      ]),
      0,
      {
        backdrop: solid(5, 5, [64, 128, 192, 255]),
        source: solid(3, 1, [192, 96, 32, 255]),
      },
    )

    expect(rendered.output.rgbaAt(2, 2)).toEqual([48, 48, 24, 255])
    expect(rendered.output.rgbaAt(2, 1)).toEqual([64, 128, 192, 255])
    expect(rendered.output.rgbaAt(0, 0)).toEqual([64, 128, 192, 255])
  })

  test('composites an agreeing transition as one isolated blend group', async () => {
    const lower = makeClip('lower', 'backdrop', 0, 4)
    const from = makeClip('from', 'red', 0, 2, { blendMode: 'multiply' })
    const to = makeClip('to', 'blue', 2, 2, { blendMode: 'multiply' })
    const rendered = await render(
      makeDoc([makeTrack('lower-track', [lower]), transitionTrack(from, to, 1)]),
      2,
      {
        backdrop: solid(5, 5, [64, 128, 192, 255]),
        red: solid(5, 5, [255, 0, 0, 255]),
        blue: solid(5, 5, [0, 0, 255, 255]),
      },
    )

    expect(rendered.output.rgbaAt(2, 2)).toEqual([32, 0, 96, 255])
    expect(rendered.surfaces.gets()).toBe(1)
    expect(rendered.surfaces.leg.rgbaAt(2, 2)).toEqual([0, 0, 0, 0])
    expect(rendered.surfaces.group.rgbaAt(2, 2)).toEqual([0, 0, 0, 0])
  })

  test('preserves unknown intent while rendering the safe normal path', async () => {
    const lower = makeClip('lower', 'green', 0, 1)
    const upper = makeClip('upper', 'red', 0, 1, {
      blendMode: 'future-soft-light',
      opacity: 0.5,
    })
    const rendered = await render(
      makeDoc([makeTrack('lower-track', [lower]), makeTrack('upper-track', [upper])]),
      0,
      {
        green: solid(5, 5, [0, 255, 0, 255]),
        red: solid(5, 5, [255, 0, 0, 255]),
      },
    )

    expect(rendered.output.rgbaAt(2, 2)).toEqual([128, 128, 0, 255])
    expect(upper.blendMode).toBe('future-soft-light')
  })

  test('opaque crossfade follows the exact quarter/midpoint/quarter sweep', async () => {
    const from = makeClip('from', 'red', 0, 3, {
      sourceRange: { startFrame: 10, durationFrames: 3 },
    })
    const to = makeClip('to', 'blue', 3, 3, {
      sourceRange: { startFrame: 20, durationFrames: 3 },
    })
    const doc = makeDoc([transitionTrack(from, to, 3)])
    const frames = {
      red: solid(5, 5, [255, 0, 0, 255]),
      blue: solid(5, 5, [0, 0, 255, 255]),
    }

    const first = await render(doc, 2, frames)
    const middle = await render(doc, 3, frames)
    const last = await render(doc, 4, frames)

    expect(first.output.rgbaAt(2, 2)).toEqual([191, 0, 64, 255])
    expect(middle.output.rgbaAt(2, 2)).toEqual([128, 0, 128, 255])
    expect(last.output.rgbaAt(2, 2)).toEqual([64, 0, 191, 255])
  })

  test('transparent legs blend with each other before the lower track once', async () => {
    const lower = makeClip('lower', 'green', 0, 4)
    const from = makeClip('from', 'red-half-alpha', 0, 2)
    const to = makeClip('to', 'blue-half-alpha', 2, 2)
    const doc = makeDoc([
      makeTrack('lower-track', [lower]),
      transitionTrack(from, to, 1),
    ])

    const rendered = await render(doc, 2, {
      green: solid(5, 5, [0, 255, 0, 255]),
      'red-half-alpha': solid(5, 5, [255, 0, 0, 128]),
      'blue-half-alpha': solid(5, 5, [0, 0, 255, 128]),
    })

    expect(rendered.output.rgbaAt(2, 2)).toEqual([64, 127, 64, 255])
    expect(rendered.result).toEqual({ drawn: ['lower', 'from', 'to'], missing: [] })
  })

  test('clip opacity is applied once before transition weighting and layering', async () => {
    const lower = makeClip('lower', 'lower-color', 0, 4)
    const from = makeClip('from', 'red', 0, 2, { opacity: 0.5 })
    const to = makeClip('to', 'blue', 2, 2, { opacity: 0.25 })
    const rendered = await render(
      makeDoc([
        makeTrack('lower-track', [lower]),
        transitionTrack(from, to, 1),
      ]),
      2,
      {
        'lower-color': solid(5, 5, [16, 32, 64, 255]),
        red: solid(5, 5, [255, 0, 0, 255]),
        blue: solid(5, 5, [0, 0, 255, 255]),
      },
    )

    expect(rendered.output.rgbaAt(2, 2)).toEqual([74, 20, 72, 255])
  })

  test('transformed overlap, uncovered pixels, and lower layering stay exact', async () => {
    const lower = makeClip('lower', 'green', 0, 4)
    const from = makeClip('from', 'red-line', 0, 2, {
      transform: {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 90,
        anchorX: 0.5,
        anchorY: 0.5,
      },
    })
    const to = makeClip('to', 'blue-line', 2, 2)
    const doc = makeDoc([
      makeTrack('lower-track', [lower]),
      transitionTrack(from, to, 1),
    ])

    const rendered = await render(doc, 2, {
      green: solid(5, 5, [0, 255, 0, 255]),
      'red-line': solid(3, 1, [255, 0, 0, 255]),
      'blue-line': solid(3, 1, [0, 0, 255, 255]),
    })

    expect(rendered.output.rgbaAt(0, 0)).toEqual([0, 255, 0, 255])
    expect(rendered.output.rgbaAt(2, 1)).toEqual([128, 128, 0, 255])
    expect(rendered.output.rgbaAt(2, 2)).toEqual([128, 0, 128, 255])
    expect(rendered.output.rgbaAt(1, 2)).toEqual([0, 128, 128, 255])
    expect(rendered.output.rgbaAt(2, 3)).toEqual([128, 128, 0, 255])
    expect(rendered.output.rgbaAt(3, 2)).toEqual([0, 128, 128, 255])
  })

  test('normalized crop preserves source position and explicit flips mirror it', async () => {
    const source = horizontalColors([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [255, 255, 0, 255],
    ], 2)
    const visual = {
      crop: { left: 0.25, right: 0.25, top: 0, bottom: 0 },
      flipHorizontal: false,
      flipVertical: false,
      scaleLocked: true,
    }
    const ordinary = await render(
      makeDoc([makeTrack('V1', [makeClip('crop', 'colors', 0, 1, { visual })])], 4, 2),
      0,
      { colors: source },
    )
    expect([0, 1, 2, 3].map((x) => ordinary.output.rgbaAt(x, 0))).toEqual([
      [0, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [0, 0, 0, 255],
    ])

    const flipped = await render(
      makeDoc([makeTrack('V1', [makeClip('flip', 'colors', 0, 1, {
        visual: { ...visual, flipHorizontal: true },
      })])], 4, 2),
      0,
      { colors: source },
    )
    expect([0, 1, 2, 3].map((x) => flipped.output.rgbaAt(x, 0))).toEqual([
      [0, 0, 0, 255],
      [0, 0, 255, 255],
      [0, 255, 0, 255],
      [0, 0, 0, 255],
    ])
  })

  test.each([
    ['still', 'timed', ['A@0', 'B@20']],
    ['timed', 'still', ['A@12', 'B@0']],
    ['still', 'still', ['A@0', 'B@0']],
  ] as const)(
    '%s to %s shares the same midpoint pixels and canonical source frames',
    async (fromMode, toMode, expectedRequests) => {
      const from = makeClip('from', 'A', 0, 2, {
        sourceMode: fromMode,
        sourceRange: fromMode === 'still'
          ? { startFrame: 0, durationFrames: 1 }
          : { startFrame: 10, durationFrames: 2 },
      })
      const to = makeClip('to', 'B', 2, 2, {
        sourceMode: toMode,
        sourceRange: toMode === 'still'
          ? { startFrame: 0, durationFrames: 1 }
          : { startFrame: 20, durationFrames: 2 },
      })
      const rendered = await render(
        makeDoc([transitionTrack(from, to, 1)]),
        2,
        {
          A: solid(5, 5, [255, 0, 0, 255]),
          B: solid(5, 5, [0, 0, 255, 255]),
        },
      )

      expect(rendered.requests).toEqual(expectedRequests)
      expect(rendered.output.rgbaAt(2, 2)).toEqual([128, 0, 128, 255])
    },
  )

  test('a missing leg preserves its weight and fades through transparency', async () => {
    const lower = makeClip('lower', 'green', 0, 4)
    const from = makeClip('from', 'missing', 0, 2)
    const to = makeClip('to', 'blue', 2, 2)
    const rendered = await render(
      makeDoc([
        makeTrack('lower-track', [lower]),
        transitionTrack(from, to, 1),
      ]),
      2,
      {
        green: solid(5, 5, [0, 255, 0, 255]),
        missing: null,
        blue: solid(5, 5, [0, 0, 255, 255]),
      },
    )

    expect(rendered.output.rgbaAt(2, 2)).toEqual([0, 128, 128, 255])
    expect(rendered.result).toEqual({
      drawn: ['lower', 'to'],
      missing: ['from'],
    })
  })

  test('applies a mixed built-in/plugin plan to an ordinary full-surface layer', async () => {
    const builtIn = createColorAdjustEffect('ordinary-warm')
    builtIn.params.temperature = 1
    const clip = makeClip('ordinary-plugin', 'source', 0, 1, {
      effects: [builtIn, pluginEffect('ordinary-channel-shift')],
    })
    const calls: Array<{ id: string; input: number[] }> = []
    const executor: VideoEffectStageExecutor = {
      applyPluginEffect: async (request) => {
        calls.push({ id: request.effect.id, input: [...request.rgba] })
        const output = new Uint8Array(request.rgba)
        output.set([91, 128, 181, 255])
        return { status: 'applied', rgba: output }
      },
    }

    const rendered = await render(
      makeDoc([makeTrack('V1', [clip])], 1, 1),
      0,
      { source: solid(1, 1, [128, 128, 128, 255]) },
      pluginSnapshot(),
      executor,
    )

    expect(calls).toEqual([{
      id: 'ordinary-channel-shift',
      input: [181, 128, 91, 255],
    }])
    expect(rendered.output.rgbaAt(0, 0)).toEqual([91, 128, 181, 255])
    expect(rendered.surfaces.gets()).toBe(1)
    expect(rendered.result).toEqual({ drawn: ['ordinary-plugin'], missing: [] })
  })

  test('continues authored built-ins after a visibly bypassed preview plugin', async () => {
    const before = createColorAdjustEffect('before-bypass')
    before.params.temperature = 1
    const after = createColorAdjustEffect('after-bypass')
    after.params.tint = 1
    const withPlugin = makeClip('bypassed-plugin', 'source', 0, 1, {
      effects: [before, pluginEffect('preview-bypass'), after],
    })
    const builtInsOnly = makeClip('built-ins-only', 'source', 0, 1, {
      effects: [before, after],
    })
    const executor: VideoEffectStageExecutor = {
      applyPluginEffect: async () => ({ status: 'bypassed' }),
    }
    const frame = solid(1, 1, [128, 128, 128, 255])

    const bypassed = await render(
      makeDoc([makeTrack('V1', [withPlugin])], 1, 1),
      0,
      { source: frame },
      pluginSnapshot(),
      executor,
    )
    const control = await render(
      makeDoc([makeTrack('V1', [builtInsOnly])], 1, 1),
      0,
      { source: frame },
    )

    expect(bypassed.output.rgbaAt(0, 0)).toEqual(control.output.rgbaAt(0, 0))
    expect(bypassed.result).toEqual({ drawn: ['bypassed-plugin'], missing: [] })
  })

  test('uses each crossfade leg\'s mixed built-in/plugin plan before weighting', async () => {
    const outgoingBuiltIn = createColorAdjustEffect('outgoing-warm')
    outgoingBuiltIn.params.temperature = 1
    const incomingBuiltIn = createColorAdjustEffect('incoming-tint')
    incomingBuiltIn.params.tint = 1
    const from = makeClip('from-plugin', 'A', 0, 10, {
      effects: [outgoingBuiltIn, pluginEffect('from-channel-shift')],
    })
    const to = makeClip('to-plugin', 'B', 10, 10, {
      effects: [incomingBuiltIn, pluginEffect('to-channel-shift')],
    })
    const calls: Array<{ id: string; input: number[] }> = []
    const executor: VideoEffectStageExecutor = {
      applyPluginEffect: async (request) => {
        calls.push({ id: request.effect.id, input: [...request.rgba] })
        const output = new Uint8Array(request.rgba)
        output.set(request.effect.id === 'from-channel-shift'
          ? [255, 0, 0, 255]
          : [0, 0, 255, 255])
        return { status: 'applied', rgba: output }
      },
    }

    const rendered = await render(
      makeDoc([transitionTrack(from, to, 1)], 1, 1),
      10,
      {
        A: solid(1, 1, [128, 128, 128, 255]),
        B: solid(1, 1, [128, 128, 128, 255]),
      },
      pluginSnapshot(),
      executor,
    )

    expect(calls).toEqual([
      { id: 'from-channel-shift', input: [181, 128, 91, 255] },
      { id: 'to-channel-shift', input: [140, 108, 140, 255] },
    ])
    expect(rendered.output.rgbaAt(0, 0)).toEqual([128, 0, 128, 255])
    expect(rendered.result).toEqual({ drawn: ['from-plugin', 'to-plugin'], missing: [] })
  })

  test('ordinary video keeps source-over pixels and never allocates surfaces', async () => {
    const lower = makeClip('lower', 'green', 0, 2)
    const ordinary = makeClip('ordinary', 'red', 0, 2, { opacity: 0.5 })
    const rendered = await render(
      makeDoc([
        makeTrack('lower-track', [lower]),
        makeTrack('ordinary-track', [ordinary]),
      ]),
      0,
      {
        green: solid(5, 5, [0, 255, 0, 255]),
        red: solid(5, 5, [255, 0, 0, 255]),
      },
    )

    expect(rendered.output.rgbaAt(2, 2)).toEqual([128, 128, 0, 255])
    expect(rendered.surfaces.gets()).toBe(0)
  })
})
