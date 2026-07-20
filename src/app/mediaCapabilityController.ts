/**
 * Window-realm lifecycle for session-only decoder capability facts.
 *
 * Durable media state remains the source of truth. This controller only
 * invalidates the codecs leaf cache when a connected source changes, a
 * provisional source disappears, or the browser resumes from a suspended
 * runtime. Nothing here is serialized into a .webcut project.
 */

import type { PortableAssetDescriptor } from '../domain/projectFile'
import {
  invalidateMediaDecoderRuntime,
  invalidateMediaDecoderSource,
} from '../codecs/mediaCodecFallbacks'
import { useMediaStore, type MediaState } from '../state/mediaStore'

type MediaCapabilitySnapshot = Pick<
  MediaState,
  'assets' | 'compatibility' | 'descriptors'
>

export interface MediaCapabilityLifecycleDeps {
  subscribe(
    listener: (
      current: MediaCapabilitySnapshot,
      previous: MediaCapabilitySnapshot,
    ) => void,
  ): () => void
  documentEvents: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  windowEvents: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  visibilityState(): DocumentVisibilityState
  invalidateSource(sourceId: string): void
  invalidateRuntime(): void
}

const realDeps: MediaCapabilityLifecycleDeps = {
  subscribe: (listener) => useMediaStore.subscribe((current, previous) => {
    listener(current, previous)
  }),
  documentEvents: document,
  windowEvents: window,
  visibilityState: () => document.visibilityState,
  invalidateSource: invalidateMediaDecoderSource,
  invalidateRuntime: invalidateMediaDecoderRuntime,
}

function ratesMatch(
  left: PortableAssetDescriptor['nativeFrameRate'],
  right: PortableAssetDescriptor['nativeFrameRate'],
): boolean {
  return left === null || right === null
    ? left === right
    : left.num === right.num && left.den === right.den
}

function descriptorsMatch(
  left: PortableAssetDescriptor,
  right: PortableAssetDescriptor,
): boolean {
  return left.id === right.id
    && left.fileName === right.fileName
    && left.mimeType === right.mimeType
    && left.size === right.size
    && left.lastModified === right.lastModified
    && left.kind === right.kind
    && left.partialTrackSelection === right.partialTrackSelection
    && left.durationMicroseconds === right.durationMicroseconds
    && ratesMatch(left.nativeFrameRate, right.nativeFrameRate)
    && left.width === right.width
    && left.height === right.height
    && left.hasAudio === right.hasAudio
    && left.audioSampleRate === right.audioSampleRate
    && left.audioChannels === right.audioChannels
}

function changedSourceIds(
  current: MediaCapabilitySnapshot,
  previous: MediaCapabilitySnapshot,
): Set<string> {
  const changed = new Set<string>()

  if (current.descriptors !== previous.descriptors) {
    for (const [id, descriptor] of previous.descriptors) {
      const next = current.descriptors.get(id)
      if (!next || !descriptorsMatch(descriptor, next)) changed.add(id)
    }
  }
  if (current.assets !== previous.assets) {
    for (const [id, asset] of previous.assets) {
      const next = current.assets.get(id)
      if (!next || next.objectUrl !== asset.objectUrl) changed.add(id)
    }
  }
  if (current.compatibility !== previous.compatibility) {
    for (const id of previous.compatibility.keys()) {
      if (
        !current.compatibility.has(id)
        && !current.assets.has(id)
      ) changed.add(id)
    }
  }

  return changed
}

interface ActiveLifecycle {
  refs: number
  dispose(): void
}

let activeLifecycle: ActiveLifecycle | null = null

/** Install one idempotent lifecycle observer for the current window realm. */
export function initMediaCapabilityLifecycle(
  deps: MediaCapabilityLifecycleDeps = realDeps,
): () => void {
  if (activeLifecycle) {
    activeLifecycle.refs++
    const shared = activeLifecycle
    return () => releaseLifecycle(shared)
  }

  const unsubscribe = deps.subscribe((current, previous) => {
    if (
      current.assets === previous.assets
      && current.compatibility === previous.compatibility
      && current.descriptors === previous.descriptors
    ) return
    for (const sourceId of changedSourceIds(current, previous)) {
      deps.invalidateSource(sourceId)
    }
  })
  const onVisibilityChange: EventListener = () => {
    if (deps.visibilityState() === 'visible') deps.invalidateRuntime()
  }
  const onPageShow: EventListener = (event) => {
    if ((event as PageTransitionEvent).persisted === true) {
      deps.invalidateRuntime()
    }
  }
  deps.documentEvents.addEventListener('visibilitychange', onVisibilityChange)
  deps.windowEvents.addEventListener('pageshow', onPageShow)

  const lifecycle: ActiveLifecycle = {
    refs: 1,
    dispose: () => {
      unsubscribe()
      deps.documentEvents.removeEventListener(
        'visibilitychange',
        onVisibilityChange,
      )
      deps.windowEvents.removeEventListener('pageshow', onPageShow)
    },
  }
  activeLifecycle = lifecycle
  return () => releaseLifecycle(lifecycle)
}

function releaseLifecycle(lifecycle: ActiveLifecycle): void {
  if (activeLifecycle !== lifecycle || lifecycle.refs === 0) return
  lifecycle.refs--
  if (lifecycle.refs > 0) return
  lifecycle.dispose()
  activeLifecycle = null
}

/** Test/HMR seam that tears down the active listener set immediately. */
export function resetMediaCapabilityLifecycle(): void {
  const lifecycle = activeLifecycle
  if (!lifecycle) return
  lifecycle.refs = 0
  lifecycle.dispose()
  activeLifecycle = null
}
