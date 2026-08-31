/** App-owned cancellable loudness job. Analysis never writes gain. */

import { createSourceBoundsCatalog } from '../domain/crossfadePlan'
import type { LoudnessMeasurementRange } from '../domain/audioLoudness'
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

function createResolver(signal: AbortSignal): ExportAssetResolver {
  const assets = useMediaStore.getState().assets
  const cache = new Map<string, ReturnType<ExportAssetResolver>>()
  return (assetId) => {
    const cached = cache.get(assetId)
    if (cached) return cached
    const asset = assets.get(assetId)
    if (!asset) {
      return Promise.reject(new Error(`Media asset "${assetId}" is missing`))
    }
    const pending = fetch(asset.objectUrl, { signal })
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

export async function startLoudnessScan(range: LoudnessMeasurementRange): Promise<void> {
  cancelLoudnessScan()
  const nextGeneration = ++generation
  const controller = new AbortController()
  active = controller
  const doc = useDocumentStore.getState().doc
  useLoudnessStore.getState().setRunning(nextGeneration, range)
  const source = createMediabunnyExportAudioSource(createResolver(controller.signal))
  let measurement: Awaited<ReturnType<typeof scanTimelineLoudness>> | undefined
  let failure: unknown
  try {
    measurement = await scanTimelineLoudness(doc, source, {
      range,
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
  } catch (cause) {
    failure = cause
  } finally {
    if (active === controller) active = null
    try {
      await source.close()
    } catch (cause) {
      failure ??= cause
    }
  }
  if (
    controller.signal.aborted
    || (failure instanceof DOMException && failure.name === 'AbortError')
  ) {
    useLoudnessStore.getState().setCancelled(nextGeneration)
    return
  }
  if (failure !== undefined) {
    const message = failure instanceof Error ? failure.message : 'Loudness scan failed'
    useLoudnessStore.getState().setFailed(nextGeneration, message)
    return
  }
  if (!measurement) throw new Error('Loudness scan completed without a measurement')
  useLoudnessStore.getState().setResult(nextGeneration, measurement)
}

useDocumentStore.subscribe((state, previous) => {
  if (state.doc === previous.doc) return
  cancelLoudnessScan()
  useLoudnessStore.getState().reset()
})
