/** Source-only native-matrix geometry; no surface, pixel or decoder allocation. */
import { DEFAULT_MANUAL_LENS_CORRECTION } from '../../src/domain/lensCorrection'
import { createTimelineDoc, DEFAULT_PROJECT_SETTINGS } from '../../src/domain/projectSettings'
import { matrixFixture } from './maskPerformanceGate'

export const ADMISSION_OUTPUT = { width: 3840, height: 2160 } as const
export interface AdmissionGeometryCase {
  readonly id: string
  readonly maskBounds: readonly [number, number]
  readonly sourceSize: readonly [number, number] | null
  readonly usage: 'preview' | 'export'
  readonly expectedBytes: number
  readonly expectedAllowed: boolean
}

/** Expected totals are fixed independently from the production budget result. */
export const ADMISSION_GEOMETRY_CASES: readonly AdmissionGeometryCase[] = [
  { id: 'full-none-preview', maskBounds: [3840, 2160], sourceSize: null, usage: 'preview', expectedBytes: 207_360_000, expectedAllowed: true },
  { id: 'full-none-export', maskBounds: [3840, 2160], sourceSize: null, usage: 'export', expectedBytes: 240_537_600, expectedAllowed: true },
  { id: 'full-hd-preview', maskBounds: [3840, 2160], sourceSize: [1920, 1080], usage: 'preview', expectedBytes: 223_948_800, expectedAllowed: true },
  { id: 'full-hd-export', maskBounds: [3840, 2160], sourceSize: [1920, 1080], usage: 'export', expectedBytes: 257_126_400, expectedAllowed: true },
  { id: 'full-uhd-preview', maskBounds: [3840, 2160], sourceSize: [3840, 2160], usage: 'preview', expectedBytes: 273_715_200, expectedAllowed: false },
  { id: 'full-uhd-export', maskBounds: [3840, 2160], sourceSize: [3840, 2160], usage: 'export', expectedBytes: 306_892_800, expectedAllowed: false },
  { id: 'clipped-none-preview', maskBounds: [960, 540], sourceSize: null, usage: 'preview', expectedBytes: 168_480_000, expectedAllowed: true },
  { id: 'clipped-none-export', maskBounds: [960, 540], sourceSize: null, usage: 'export', expectedBytes: 201_657_600, expectedAllowed: true },
  { id: 'clipped-hd-preview', maskBounds: [960, 540], sourceSize: [1920, 1080], usage: 'preview', expectedBytes: 185_068_800, expectedAllowed: true },
  { id: 'clipped-hd-export', maskBounds: [960, 540], sourceSize: [1920, 1080], usage: 'export', expectedBytes: 218_246_400, expectedAllowed: true },
  { id: 'clipped-uhd-preview', maskBounds: [960, 540], sourceSize: [3840, 2160], usage: 'preview', expectedBytes: 234_835_200, expectedAllowed: true },
  { id: 'clipped-uhd-export', maskBounds: [960, 540], sourceSize: [3840, 2160], usage: 'export', expectedBytes: 268_012_800, expectedAllowed: true },
  { id: 'cap-preview', maskBounds: [3840, 2160], sourceSize: [3224, 2368], usage: 'preview', expectedBytes: 268_435_456, expectedAllowed: true },
  { id: 'cap-plus-one-preview', maskBounds: [3827, 2159], sourceSize: [4673, 1638], usage: 'preview', expectedBytes: 268_435_457, expectedAllowed: false },
  { id: 'cap-export', maskBounds: [3840, 2160], sourceSize: [1946, 1792], usage: 'export', expectedBytes: 268_435_456, expectedAllowed: true },
  { id: 'cap-plus-one-export', maskBounds: [3819, 2159], sourceSize: [4039, 871], usage: 'export', expectedBytes: 268_435_457, expectedAllowed: false },
]

export function admissionGeometryFixture(cell: AdmissionGeometryCase) {
  const { width, height } = ADMISSION_OUTPUT
  const doc = structuredClone(createTimelineDoc('Admission geometry', DEFAULT_PROJECT_SETTINGS, 'admission-geometry'))
  doc.width = width; doc.height = height
  const { clip } = matrixFixture({ width, height, shape: 8, feather: 0.05, invert: false, offCanvas: false })
  clip.effects[0]!.params.width = cell.maskBounds[0] / width
  clip.effects[0]!.params.height = cell.maskBounds[1] / height
  clip.lensCorrection = cell.sourceSize ? { ...DEFAULT_MANUAL_LENS_CORRECTION } : null
  doc.tracks[0]!.clips = [clip]
  return { doc, clip }
}
