/**
 * Main-thread compatibility delegate for the retired keyframe-batch render
 * protocol. The current RenderWorkerBridge keeps its public overloads, but all
 * chunk fetching and transfer construction stays quarantined here.
 */

import type { AssetId, FrameRate, TimelineDoc } from '../domain/schema'
import {
  videoCompositionRequests,
  type VideoCompositionPlan,
} from '../domain/videoCompositionPlan'
import { framesToSeconds } from '../domain/time'
import type { ChunkPayload } from '../workers/decode-types'
import type { LegacyCompositeMessage } from '../workers/render-legacy-protocol'
import type { ChunkProvider } from './worker-types'

export interface LegacyRenderAssetSource {
  protocol: 'legacy'
  rate: FrameRate
  chunkProvider: ChunkProvider
  runtimeToken: object
}

export function createLegacyRenderAssetSource(
  rate: FrameRate,
  chunkProvider: ChunkProvider,
): LegacyRenderAssetSource {
  return {
    protocol: 'legacy',
    rate,
    chunkProvider,
    runtimeToken: {},
  }
}

export interface LegacyRenderRequest {
  message: LegacyCompositeMessage
  transfer: Transferable[]
  sources: Map<AssetId, LegacyRenderAssetSource>
}

interface LegacyRenderRequestOptions {
  doc: TimelineDoc
  plan: VideoCompositionPlan
  frame: number
  requestId: number
  sourceForAsset(assetId: AssetId): LegacyRenderAssetSource | undefined
  isCurrent(): boolean
}

/** Build one compatibility request, or null when newer state overtook it. */
export async function buildLegacyRenderRequest({
  doc,
  plan,
  frame,
  requestId,
  sourceForAsset,
  isCurrent,
}: LegacyRenderRequestOptions): Promise<LegacyRenderRequest | null> {
  const wants = new Map<
    string,
    { assetId: AssetId; sourceFrame: number; source: LegacyRenderAssetSource }
  >()
  for (const request of videoCompositionRequests(plan)) {
    const source = sourceForAsset(request.clip.assetId)
    if (!source) continue
    wants.set(`${request.clip.assetId}@${request.sourceFrame}`, {
      assetId: request.clip.assetId,
      sourceFrame: request.sourceFrame,
      source,
    })
  }

  const entries = await Promise.all(
    [...wants.values()].map(async ({ assetId, sourceFrame, source }) => {
      const targetSec = framesToSeconds(sourceFrame, doc.frameRate)
      const toleranceSec = source.rate.den / source.rate.num / 2
      let chunks: ChunkPayload[] = []
      try {
        chunks = await source.chunkProvider.chunksForTimestamp(
          targetSec,
          toleranceSec,
        )
      } catch (error) {
        console.warn(
          `[render-bridge] chunk fetch failed for asset ${assetId}:`,
          error instanceof Error ? error.message : error,
        )
      }
      return {
        assetId,
        sourceFrame,
        targetTimestampUs: Math.round(targetSec * 1e6),
        toleranceUs: Math.round(toleranceSec * 1e6),
        chunks,
      }
    }),
  )

  if (!isCurrent()) return null

  return {
    message: { type: 'composite', requestId, frame, plan, sources: entries },
    transfer: entries.flatMap((entry) => (
      entry.chunks.map((chunk) => chunk.data)
    )),
    sources: new Map(
      [...wants.values()].map(({ assetId, source }) => [assetId, source]),
    ),
  }
}
