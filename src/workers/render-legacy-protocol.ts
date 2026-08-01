/**
 * Deprecated keyframe-batch messages retained as a named compatibility
 * boundary. Current preview code uses openAsset/openImage/renderFrame instead.
 */

import type { AssetId } from '../domain/schema'
import type { VideoCompositionPlan } from '../domain/videoCompositionPlan'
import type { ChunkPayload } from './decode-types'

/** @deprecated Use StreamingCompositeSourceEntry through RenderFrameMessage. */
export interface CompositeSourceEntry {
  assetId: AssetId
  sourceFrame: number
  targetTimestampUs: number
  toleranceUs: number
  chunks: ChunkPayload[]
}

/** @deprecated Use OpenAssetMessage. */
export interface LegacyConfigureAssetMessage {
  type: 'configureAsset'
  assetId: AssetId
  setupId: number
  config: VideoDecoderConfig
}

/** @deprecated Use RenderFrameMessage. */
export interface LegacyCompositeMessage {
  type: 'composite'
  requestId: number
  frame: number
  plan: VideoCompositionPlan
  sources: CompositeSourceEntry[]
}
