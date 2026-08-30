/** App-owned cancellable loudness job. Analysis never writes gain. */

import { createSourceBoundsCatalog } from '../domain/crossfadePlan'
import { docDurationFrames } from '../domain/selectors'
import {
  createMediabunnyExportAudioSource,
  type ExportAssetResolver,
} from '../pipeline/export-mediabunny'
import { scanTimelineLoudness } from '../pipeline/loudnessScan'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { useLoudnessStore } from '../state/loudnessStore'
import { mediaAssetDecoderBudget } from '../codecs/mediaCodecFallbacks'

let generation = 0
let active: AbortController | null = null

function createResolver(): ExportAssetResolver {
  const assets = useMediaStore.getState().assets
  const cache = new Map<string, ReturnType<ExportAssetResolver>>()
  return (assetId) => {
    const cached = cache.get(assetId)
    if (cached) return cached
    const asset = assets.get(assetId)
    if (!asset) {
      return Promise.reject(new Error(`Media asset "${assetId}" is missing`))
    }
    const pending = fetch(asset.objectUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to read ${asset.fileName}`)
        return response.blob()
      })
      .then((blob) => ({
        blob,
        budget: mediaAssetDecoderBudget(asset, blob.size),
        kind: asset.kind,
      }))
    cache.set(assetId, pending)
    return pending
  }
}

export function cancelLoudnessScan(): void {
  active?.abort()
  active = null
}

export async function startLoudnessScan(): Promise<void> {
  cancelLoudnessScan()
  const nextGeneration = ++generation
  const controller = new AbortController()
  active = controller
  const doc = useDocumentStore.getState().doc
  const frameCount = docDurationFrames(doc)
  useLoudnessStore.getState().setRunning(nextGeneration, frameCount)
  const source = createMediabunnyExportAudioSource(createResolver())
  try {
    const measurement = await scanTimelineLoudness(doc, source, {
      catalog: createSourceBoundsCatalog(useMediaStore.getState().assets.values()),
      signal: controller.signal,
      onProgress: (progress) => {
        useLoudnessStore.getState().setProgress(
          nextGeneration,
          progress.framesDone,
          progress.frameCount,
        )
      },
    })
    if (controller.signal.aborted) {
      useLoudnessStore.getState().setCancelled(nextGeneration)
      return
    }
    useLoudnessStore.getState().setResult(nextGeneration, measurement)
  } catch (cause) {
    if (controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) {
      useLoudnessStore.getState().setCancelled(nextGeneration)
      return
    }
    const message = cause instanceof Error ? cause.message : 'Loudness scan failed'
    useLoudnessStore.getState().setFailed(nextGeneration, message)
  } finally {
    if (active === controller) active = null
    await source.close()
  }
}

useDocumentStore.subscribe((state, previous) => {
  if (state.doc === previous.doc) return
  cancelLoudnessScan()
  useLoudnessStore.getState().reset()
})
