/** Pure, bounded manual lens-correction model shared by authoring and renderers. */

export const LENS_CORRECTION_MODEL_VERSION = 1 as const
export const LENS_CORRECTION_VALIDATION_GRID = 33
export const LENS_REMAP_BACKEND_VERSION = 'webgl2-rgba8-manual-bilinear-v1'

/** Serializable capability shared by worker protocol and UI state. */
export type LensRemapAvailability =
  | {
      readonly status: 'available'
      readonly backendVersion: typeof LENS_REMAP_BACKEND_VERSION
      readonly maximumTextureSize: number
      readonly reason: null
    }
  | {
      readonly status: 'unavailable'
      readonly backendVersion: typeof LENS_REMAP_BACKEND_VERSION
      readonly maximumTextureSize: number | null
      readonly reason: string
    }

export interface ManualLensCorrectionModel {
  readonly version: typeof LENS_CORRECTION_MODEL_VERSION
  /** Principal point in normalized source-image coordinates. */
  readonly centerX: number
  readonly centerY: number
  /** Focal lengths as fractions of source width/height. */
  readonly focalX: number
  readonly focalY: number
  readonly k1: number
  readonly k2: number
  readonly k3: number
  readonly p1: number
  readonly p2: number
  readonly strength: number
  /** Explicit user crop/zoom used to hide undefined corrected edges. */
  readonly outputScale: number
}

/**
 * Forward-compatible durable intent. Current code understands version 1 and
 * keeps any bounded future object opaque so an older editor never erases it.
 */
export interface UnknownLensCorrectionIntent {
  readonly version: number
  readonly [key: string]: unknown
}

export type LensCorrectionIntent =
  | ManualLensCorrectionModel
  | UnknownLensCorrectionIntent

export const MANUAL_LENS_CORRECTION_LIMITS = Object.freeze({
  centerMinimum: 0,
  centerMaximum: 1,
  focalMinimum: 0.1,
  focalMaximum: 4,
  radialMinimum: -2,
  radialMaximum: 2,
  tangentialMinimum: -0.5,
  tangentialMaximum: 0.5,
  strengthMinimum: 0,
  strengthMaximum: 1,
  outputScaleMinimum: 1,
  outputScaleMaximum: 4,
})

export const DEFAULT_MANUAL_LENS_CORRECTION = Object.freeze({
  version: LENS_CORRECTION_MODEL_VERSION,
  centerX: 0.5,
  centerY: 0.5,
  focalX: 0.5,
  focalY: 0.5,
  k1: 0,
  k2: 0,
  k3: 0,
  p1: 0,
  p2: 0,
  strength: 1,
  outputScale: 1,
}) satisfies ManualLensCorrectionModel

export interface NormalizedLensPoint {
  readonly x: number
  readonly y: number
}

export interface LensCorrectionCoverage {
  readonly covered: boolean
  readonly minimumSourceX: number
  readonly maximumSourceX: number
  readonly minimumSourceY: number
  readonly maximumSourceY: number
  readonly maximumOverscan: number
}

export interface ValidatedLensCorrectionMap {
  readonly model: Readonly<ManualLensCorrectionModel>
  map(output: NormalizedLensPoint): NormalizedLensPoint
}

const MIN_JACOBIAN_DETERMINANT = 0.05
const MAX_NORMALIZED_MAPPING_MAGNITUDE = 8

export function isManualLensCorrectionModel(
  value: LensCorrectionIntent | null | undefined,
): value is ManualLensCorrectionModel {
  return value?.version === LENS_CORRECTION_MODEL_VERSION
}

export function sameManualLensCorrectionModel(
  left: Readonly<ManualLensCorrectionModel>,
  right: Readonly<ManualLensCorrectionModel>,
): boolean {
  return left.version === right.version
    && left.centerX === right.centerX
    && left.centerY === right.centerY
    && left.focalX === right.focalX
    && left.focalY === right.focalY
    && left.k1 === right.k1
    && left.k2 === right.k2
    && left.k3 === right.k3
    && left.p1 === right.p1
    && left.p2 === right.p2
    && left.strength === right.strength
    && left.outputScale === right.outputScale
}

function finiteInRange(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum
}

interface DistortionResult extends NormalizedLensPoint {
  readonly dxdx: number
  readonly dxdy: number
  readonly dydx: number
  readonly dydy: number
}

function distortCameraPoint(
  model: ManualLensCorrectionModel,
  x: number,
  y: number,
): DistortionResult {
  const radius2 = x * x + y * y
  const radius4 = radius2 * radius2
  const radius6 = radius4 * radius2
  const radial = 1 + model.k1 * radius2 + model.k2 * radius4 + model.k3 * radius6
  const radialSlope = model.k1 + 2 * model.k2 * radius2 + 3 * model.k3 * radius4
  const radialX = 2 * x * radialSlope
  const radialY = 2 * y * radialSlope
  const distortedX = x * radial
    + 2 * model.p1 * x * y
    + model.p2 * (radius2 + 2 * x * x)
  const distortedY = y * radial
    + model.p1 * (radius2 + 2 * y * y)
    + 2 * model.p2 * x * y
  const dxdx = radial + x * radialX + 2 * model.p1 * y + 6 * model.p2 * x
  const dxdy = x * radialY + 2 * model.p1 * x + 2 * model.p2 * y
  const dydx = y * radialX + 2 * model.p1 * x + 2 * model.p2 * y
  const dydy = radial + y * radialY + 6 * model.p1 * y + 2 * model.p2 * x
  return {
    x: x + (distortedX - x) * model.strength,
    y: y + (distortedY - y) * model.strength,
    dxdx: 1 + (dxdx - 1) * model.strength,
    dxdy: dxdy * model.strength,
    dydx: dydx * model.strength,
    dydy: 1 + (dydy - 1) * model.strength,
  }
}

function basicLensCorrectionValidationError(
  model: ManualLensCorrectionModel,
): string | null {
  if (model.version !== LENS_CORRECTION_MODEL_VERSION) {
    return 'Unsupported manual lens-correction model version'
  }
  if (!finiteInRange(model.centerX, 0, 1) || !finiteInRange(model.centerY, 0, 1)) {
    return 'Lens principal point must stay inside normalized source bounds'
  }
  if (
    !finiteInRange(
      model.focalX,
      MANUAL_LENS_CORRECTION_LIMITS.focalMinimum,
      MANUAL_LENS_CORRECTION_LIMITS.focalMaximum,
    )
    || !finiteInRange(
      model.focalY,
      MANUAL_LENS_CORRECTION_LIMITS.focalMinimum,
      MANUAL_LENS_CORRECTION_LIMITS.focalMaximum,
    )
  ) return 'Lens focal fractions are outside the reviewed range'
  for (const coefficient of [model.k1, model.k2, model.k3]) {
    if (!finiteInRange(
      coefficient,
      MANUAL_LENS_CORRECTION_LIMITS.radialMinimum,
      MANUAL_LENS_CORRECTION_LIMITS.radialMaximum,
    )) return 'Lens radial coefficient is outside the reviewed range'
  }
  for (const coefficient of [model.p1, model.p2]) {
    if (!finiteInRange(
      coefficient,
      MANUAL_LENS_CORRECTION_LIMITS.tangentialMinimum,
      MANUAL_LENS_CORRECTION_LIMITS.tangentialMaximum,
    )) return 'Lens tangential coefficient is outside the reviewed range'
  }
  if (!finiteInRange(model.strength, 0, 1)) {
    return 'Lens correction strength must be from 0 to 1'
  }
  if (!finiteInRange(
    model.outputScale,
    MANUAL_LENS_CORRECTION_LIMITS.outputScaleMinimum,
    MANUAL_LENS_CORRECTION_LIMITS.outputScaleMaximum,
  )) {
    return `Lens correction output scale must be from 1 to ${MANUAL_LENS_CORRECTION_LIMITS.outputScaleMaximum}`
  }
  return null
}

function mapValidatedLensCorrectionPoint(
  model: ManualLensCorrectionModel,
  output: NormalizedLensPoint,
): NormalizedLensPoint {
  if (
    !Number.isFinite(output.x)
    || !Number.isFinite(output.y)
    || output.x < 0
    || output.x > 1
    || output.y < 0
    || output.y > 1
  ) throw new RangeError('Lens output point must be inside normalized output bounds')
  const unscaledX = model.centerX + (output.x - model.centerX) / model.outputScale
  const unscaledY = model.centerY + (output.y - model.centerY) / model.outputScale
  const cameraX = (unscaledX - model.centerX) / model.focalX
  const cameraY = (unscaledY - model.centerY) / model.focalY
  const distorted = distortCameraPoint(model, cameraX, cameraY)
  return {
    x: model.centerX + distorted.x * model.focalX,
    y: model.centerY + distorted.y * model.focalY,
  }
}

/**
 * Rejects foldovers as well as obviously explosive mappings. A fixed grid is
 * intentional: validation cost is bounded and the accepted domain is explicit.
 */
export function lensCorrectionValidationError(
  model: ManualLensCorrectionModel,
): string | null {
  const basicError = basicLensCorrectionValidationError(model)
  if (basicError) return basicError
  for (let row = 0; row < LENS_CORRECTION_VALIDATION_GRID; row++) {
    const sourceY = row / (LENS_CORRECTION_VALIDATION_GRID - 1)
    const y = (sourceY - model.centerY) / model.focalY
    for (let column = 0; column < LENS_CORRECTION_VALIDATION_GRID; column++) {
      const sourceX = column / (LENS_CORRECTION_VALIDATION_GRID - 1)
      const x = (sourceX - model.centerX) / model.focalX
      const mapped = distortCameraPoint(model, x, y)
      const determinant = mapped.dxdx * mapped.dydy - mapped.dxdy * mapped.dydx
      if (
        !Number.isFinite(mapped.x)
        || !Number.isFinite(mapped.y)
        || Math.abs(mapped.x) > MAX_NORMALIZED_MAPPING_MAGNITUDE
        || Math.abs(mapped.y) > MAX_NORMALIZED_MAPPING_MAGNITUDE
      ) return 'Lens mapping exceeds the reviewed finite coordinate envelope'
      if (!Number.isFinite(determinant) || determinant < MIN_JACOBIAN_DETERMINANT) {
        return 'Lens mapping folds or becomes non-bijective inside the source image'
      }
    }
  }
  return null
}

/**
 * Maps one output pixel to the distorted source sample coordinate. A renderer
 * may bilinearly sample this point; undefined edges remain explicit.
 */
export function mapLensCorrectionPoint(
  model: ManualLensCorrectionModel,
  output: NormalizedLensPoint,
): NormalizedLensPoint {
  return createValidatedLensCorrectionMap(model).map(output)
}

/**
 * Validates one immutable model once for bounded per-pixel research hosts.
 * Every mapped point is still range-checked, but the fixed 33x33 model safety
 * grid is never repeated inside a frame loop.
 */
export function createValidatedLensCorrectionMap(
  model: ManualLensCorrectionModel,
): ValidatedLensCorrectionMap {
  const validationError = lensCorrectionValidationError(model)
  if (validationError) throw new RangeError(validationError)
  const validated = Object.freeze({ ...model })
  return Object.freeze({
    model: validated,
    map: (output: NormalizedLensPoint) => (
      mapValidatedLensCorrectionPoint(validated, output)
    ),
  })
}

export function lensCorrectionCoverage(
  model: ManualLensCorrectionModel,
  edgeSamples = 65,
): LensCorrectionCoverage {
  if (!Number.isSafeInteger(edgeSamples) || edgeSamples < 3 || edgeSamples > 257) {
    throw new RangeError('Lens coverage edge-sample count must be from 3 to 257')
  }
  const points: NormalizedLensPoint[] = []
  for (let index = 0; index < edgeSamples; index++) {
    const position = index / (edgeSamples - 1)
    points.push(
      { x: position, y: 0 },
      { x: position, y: 1 },
      { x: 0, y: position },
      { x: 1, y: position },
    )
  }
  const mapper = createValidatedLensCorrectionMap(model)
  const mapped = points.map((point) => mapper.map(point))
  const minimumSourceX = Math.min(...mapped.map((point) => point.x))
  const maximumSourceX = Math.max(...mapped.map((point) => point.x))
  const minimumSourceY = Math.min(...mapped.map((point) => point.y))
  const maximumSourceY = Math.max(...mapped.map((point) => point.y))
  const maximumOverscan = Math.max(
    0,
    -minimumSourceX,
    maximumSourceX - 1,
    -minimumSourceY,
    maximumSourceY - 1,
  )
  return {
    covered: maximumOverscan <= 1e-9,
    minimumSourceX,
    maximumSourceX,
    minimumSourceY,
    maximumSourceY,
    maximumOverscan,
  }
}
