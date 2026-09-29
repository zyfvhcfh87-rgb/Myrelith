/**
 * Transform properties owned by stabilization and motion-tracking plans.
 * A dependency-free leaf, so ordinary edit operations can check ownership
 * without pulling the analysis modules into the application entry graph.
 */

import type { ClipAnimationProperty } from './schema'

export const VIDEO_STABILIZATION_PROPERTIES = [
  'position-x',
  'position-y',
  'rotation',
  'scale-x',
  'scale-y',
] as const satisfies readonly ClipAnimationProperty[]

export const POINT_TRACKING_PROPERTIES = [
  'position-x',
  'position-y',
] as const satisfies readonly ClipAnimationProperty[]

export const BOX_TRACKING_PROPERTIES = [
  ...POINT_TRACKING_PROPERTIES,
  'scale-x',
  'scale-y',
] as const satisfies readonly ClipAnimationProperty[]
