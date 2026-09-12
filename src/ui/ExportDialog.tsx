import { RenderQueuePanel } from './RenderQueuePanel'
/**
 * ui/ExportDialog.tsx — Phase 5.2b export settings/progress/download flow.
 *
 * Preset hints and custom-profile checks stay behind the app capability
 * facade. The pre-start export controller remains authoritative; this
 * component owns only view state, progress, and download URL lifetime.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import {
  DEFAULT_EXPORT_PROFILE,
  EXPORT_PRESETS,
  updateExportProfile,
  type ExportProfile,
  type ExportSelectionId,
} from '../domain/exportProfile'
import {
  DEFAULT_ALPHA_VIDEO_PROFILE,
  DEFAULT_AUDIO_ONLY_PROFILE,
  DEFAULT_IMAGE_SEQUENCE_PROFILE,
  exportSettingsIncludesAudio,
  exportSettingsIncludesVisual,
  isDeliveryProfile,
  parseExportSettings,
  type AlphaVideoCodec,
  type AudioOnlyContainer,
  type ChapterMode,
  type ExportSettingsUnion,
} from '../domain/deliveryProduct'
import {
  getExportFilePickerAvailability,
  requestExportFileDestination,
  type ExportFileDestinationCapability,
} from '../app/exportFilePicker'
import {
  getExportDirectoryPickerAvailability,
  requestExportDirectoryDestination,
  type ExportDirectoryDestinationCapability,
} from '../app/exportDirectoryPicker'
import type { TimelineDoc } from '../domain/schema'
import {
  docDurationFrames,
  projectHasOutputPluginEffects,
  projectOutputMediaAssetIds,
} from '../domain/selectors'
import { useDocumentStore } from '../state/documentStore'
import { useMediaStore } from '../state/mediaStore'
import { usePreferencesStore } from '../state/preferencesStore'
import type { ExportPresetAvailability } from './ExportProfilePicker'
import {
  ExportConfiguration,
  ExportDialogActions,
  ExportDialogHeader,
  ExportPhaseContent,
  type DeliveryKindUi,
  type DownloadReady,
  type ExportPhase,
  type SavedFileReady,
} from './ExportDialogSections'
import {
  estimateExportBytes,
  exportFileName,
  formatEstimatedFileSize,
  profileForSelectionFallback,
  type ExportUiSelectionId,
} from './exportProfileUi'
import { PluginExportBlockBody } from './plugins/PluginExportBlockDialog'
import type { PluginEffectIssueView } from './plugins/pluginUiTypes'
import type { PluginPreparedExportPort } from '../app/pluginPreparedExportOwner'

type ExportControllerModule = typeof import('../app/exportController')
type ExportCapabilitiesModule =
  typeof import('../app/exportCapabilitiesController')
type ExportCapabilitySnapshot = Awaited<ReturnType<
  ExportCapabilitiesModule['getExportPresetCapabilities']
>>
type ExportCapabilityResult = Awaited<ReturnType<
  ExportCapabilitiesModule['checkCurrentExportProfile']
>>
type PluginPreparedExportSnapshot = ReturnType<
  PluginPreparedExportPort['getSnapshot']
>

type PresetCapabilityState =
  | {
      readonly status: 'loading'
      readonly doc: TimelineDoc
    }
  | {
      readonly status: 'ready'
      readonly doc: TimelineDoc
      readonly snapshot: Readonly<ExportCapabilitySnapshot>
    }
  | {
      readonly status: 'error'
      readonly doc: TimelineDoc
      readonly error: string
    }

type CustomCapabilityState =
  | {
      readonly status: 'loading'
      readonly doc: TimelineDoc
      readonly profile: Readonly<ExportProfile>
    }
  | {
      readonly status: 'ready'
      readonly doc: TimelineDoc
      readonly profile: Readonly<ExportProfile>
      readonly result: Readonly<ExportCapabilityResult>
    }

let controllerPromise: Promise<ExportControllerModule> | null = null
let capabilitiesPromise: Promise<ExportCapabilitiesModule> | null = null
let preparedExportModulePromise: Promise<typeof import('../app/pluginPreparedExportOwner')> | null = null

/** Capability code is also excluded from the initial editor bundle. */
function loadExportCapabilities(): Promise<ExportCapabilitiesModule> {
  capabilitiesPromise ??= import('../app/exportCapabilitiesController')
    .catch((cause) => {
      capabilitiesPromise = null
      throw cause
    })
  return capabilitiesPromise
}

function loadPreparedExportPort(): Promise<PluginPreparedExportPort> {
  preparedExportModulePromise ??= import('../app/pluginPreparedExportOwner')
    .catch((cause) => {
      preparedExportModulePromise = null
      throw cause
    })
  return preparedExportModulePromise.then(
    ({ getPluginPreparedExportPort }) => getPluginPreparedExportPort(),
  )
}

function blockerIssues(snapshot: PluginPreparedExportSnapshot): readonly PluginEffectIssueView[] {
  if (snapshot.status !== 'blocked') return []
  return snapshot.attempt.blockers.map((blocker) => {
    const effect = snapshot.attempt.effects.find((candidate) => candidate.key === blocker.key)
    return {
      effectInstanceId: blocker.descriptorId,
      effectLabel: effect?.effectType ?? blocker.descriptorId,
      pluginId: blocker.pluginId ?? 'unknown-plugin',
      pluginName: blocker.pluginId ?? 'Unknown plugin',
      pluginVersion: effect?.pluginVersion ?? null,
      packageDigest: effect?.packageDigest ?? null,
      status: blocker.status as PluginEffectIssueView['status'],
      reason: blocker.reason,
      blocksExport: true,
    }
  })
}

interface ExportDialogProps {
  onClose(): void
}

function deliverySettings(
  kind: DeliveryKindUi,
  drafts: {
    readonly pngPrefix: string
    readonly pngOverwrite: boolean
    readonly pngDestination: 'download' | 'directory'
    readonly audioContainer: AudioOnlyContainer
    readonly alphaCodec: AlphaVideoCodec
    readonly chapterMode: ChapterMode
    readonly videoAudio: Readonly<ExportProfile>
  },
): ExportSettingsUnion {
  if (kind === 'image-sequence') {
    return parseExportSettings({
      ...DEFAULT_IMAGE_SEQUENCE_PROFILE,
      fileNamePrefix: drafts.pngPrefix,
      overwriteExisting: drafts.pngOverwrite,
      destination: drafts.pngDestination,
      chapters: { mode: drafts.chapterMode },
    })
  }
  if (kind === 'audio-only') {
    const base = drafts.audioContainer === 'wav'
      ? DEFAULT_AUDIO_ONLY_PROFILE
      : drafts.audioContainer === 'mp4'
        ? {
            ...DEFAULT_AUDIO_ONLY_PROFILE,
            container: 'mp4' as const,
            codec: 'aac' as const,
            audioBitrate: 192_000,
            audioBitrateMode: 'variable' as const,
            mimeType: 'audio/mp4' as const,
            fileExtension: 'm4a' as const,
          }
        : {
            ...DEFAULT_AUDIO_ONLY_PROFILE,
            container: 'webm' as const,
            codec: 'opus' as const,
            audioBitrate: 128_000,
            audioBitrateMode: 'variable' as const,
            mimeType: 'audio/webm' as const,
            fileExtension: 'webm' as const,
          }
    return parseExportSettings({
      ...base,
      destination: drafts.videoAudio.destination === 'file' ? 'file' : 'download',
      chapters: { mode: drafts.chapterMode },
    })
  }
  if (kind === 'alpha-video') {
    const audioOff = drafts.videoAudio.audioChannelLayout === 'off'
    return parseExportSettings({
      ...DEFAULT_ALPHA_VIDEO_PROFILE,
      videoCodec: drafts.alphaCodec,
      audioCodec: audioOff ? null : 'opus',
      audioChannelLayout: audioOff ? 'off' : drafts.videoAudio.audioChannelLayout,
      audioBitrate: audioOff ? null : (drafts.videoAudio.audioBitrate ?? 192_000),
      audioBitrateMode: audioOff ? null : (drafts.videoAudio.audioBitrateMode ?? 'variable'),
      destination: drafts.videoAudio.destination,
      chapters: { mode: drafts.chapterMode },
    })
  }
  return drafts.videoAudio
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== '') {
    return cause.message
  }
  return 'Export failed. Please try again.'
}

function resultLabel(result: {
  readonly label?: string
  readonly completion?: 'complete' | 'partial'
  readonly profile?: { readonly container: string }
}): string {
  if (result.label) {
    return result.completion === 'partial' ? `${result.label} (partial)` : result.label
  }
  if (result.profile?.container === 'webm') return 'WebM'
  if (result.profile?.container === 'mp4') return 'MP4'
  return 'Export'
}

function directFileFailureMessage(cause: unknown): string {
  const message = errorMessage(cause)
  if (/selected file may be incomplete/i.test(message)) {
    return message
  }
  return `${message} No partial video was kept; the selected file may remain empty.`
}

export default function ExportDialog({ onClose }: ExportDialogProps) {
  const doc = useDocumentStore((state) => state.doc)
  const activeSequenceId = useDocumentStore((state) => state.activeSequenceId)
  const rootSequenceId = useDocumentStore((state) => state.project.rootSequenceId)
  const project = useDocumentStore((state) => state.project)
  const hasContent = docDurationFrames(doc) > 0
  const mediaAssets = useMediaStore((state) => state.assets)
  const mediaDescriptors = useMediaStore((state) => state.descriptors)
  const setExportSelectionPreference = usePreferencesStore(
    (state) => state.setExportSelection,
  )
  const [initialPreference] = useState(
    () => usePreferencesStore.getState().exportSelection,
  )
  const [filePickerAvailability] = useState(
    getExportFilePickerAvailability,
  )
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const selectedProfileRef = useRef<HTMLInputElement | null>(null)
  const startButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const phaseStatusRef = useRef<HTMLSpanElement | null>(null)
  const capabilityStatusRef = useRef<HTMLDivElement | null>(null)
  const downloadLinkRef = useRef<HTMLAnchorElement | null>(null)
  const backButtonRef = useRef<HTMLButtonElement | null>(null)
  const mountedRef = useRef(false)
  const runningRef = useRef(false)
  const controllerRunStartedRef = useRef(false)
  const cancelRequestedRef = useRef(false)
  const runTokenRef = useRef(0)
  const progressFrameRef = useRef<number | null>(null)
  const latestProgressRef = useRef(0)
  const downloadUrlRef = useRef<string | null>(null)
  const preparedPortRef = useRef<PluginPreparedExportPort | null>(null)
  const preparedTokenRef = useRef<string | null>(null)
  const preparationGenerationRef = useRef(0)
  const preparationAbortRef = useRef<AbortController | null>(null)
  const preparationInFlightRef = useRef(false)
  const capabilityTokenRef = useRef(0)
  const customCapabilityTokenRef = useRef(0)
  const previousSelectedSupportedRef = useRef<boolean | null>(null)
  const runDestinationRef = useRef<'download' | 'file' | 'directory'>('download')
  const [phase, setPhase] = useState<ExportPhase>('configure')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [download, setDownload] = useState<DownloadReady | null>(null)
  const [savedFile, setSavedFile] = useState<SavedFileReady | null>(null)
  const [pluginBlock, setPluginBlock] = useState<PluginPreparedExportSnapshot | null>(null)
  const [preparingPluginExport, setPreparingPluginExport] = useState(false)
  const [filePickerMessage, setFilePickerMessage] = useState<string | null>(
    () => initialPreference.profile?.destination === 'file'
      && !filePickerAvailability.available
      ? `${filePickerAvailability.reason} Choose Browser download explicitly to use it here.`
      : null,
  )
  const [selectionId, setSelectionId] = useState<ExportUiSelectionId>(
    initialPreference.selectionId,
  )
  const [customProfile, setCustomProfile] = useState<Readonly<ExportProfile>>(
    initialPreference.profile ?? DEFAULT_EXPORT_PROFILE,
  )
  const [presetCapabilityState, setPresetCapabilityState] =
    useState<Readonly<PresetCapabilityState>>(() => ({
      status: 'loading',
      doc,
    }))
  const [customCapabilityState, setCustomCapabilityState] =
    useState<Readonly<CustomCapabilityState> | null>(null)
  const [advancedDraftsValid, setAdvancedDraftsValid] = useState(true)
  const [deliveryKind, setDeliveryKind] = useState<DeliveryKindUi>('video')
  const [chapterMode, setChapterMode] = useState<ChapterMode>('off')
  const [pngPrefix, setPngPrefix] = useState('frame')
  const [pngOverwrite, setPngOverwrite] = useState(false)
  const [pngDestination, setPngDestination] = useState<'download' | 'directory'>('download')
  const [audioContainer, setAudioContainer] = useState<AudioOnlyContainer>('wav')
  const [alphaCodec, setAlphaCodec] = useState<AlphaVideoCodec>('vp9')
  const [alphaVp9Supported, setAlphaVp9Supported] = useState<boolean | null>(null)
  const [alphaAv1Supported, setAlphaAv1Supported] = useState<boolean | null>(null)
  const [alphaReason, setAlphaReason] = useState<string | null>(null)
  const [deliveryCapability, setDeliveryCapability] = useState<{
    readonly supported: boolean | null
    readonly reason: string | null
  }>({ supported: null, reason: null })
  const [directoryPickerAvailability] = useState(
    () => getExportDirectoryPickerAvailability(),
  )
  const titleId = useId()
  const descriptionId = useId()
  const progressId = useId()

  const cancelProgressFrame = useCallback((): void => {
    if (progressFrameRef.current === null) return
    cancelAnimationFrame(progressFrameRef.current)
    progressFrameRef.current = null
  }, [])

  const revokeDownload = useCallback((): void => {
    const url = downloadUrlRef.current
    if (!url) return
    downloadUrlRef.current = null
    URL.revokeObjectURL(url)
  }, [])

  const publishProgress = useCallback(
    (token: number, value: number): void => {
      if (token !== runTokenRef.current || !Number.isFinite(value)) return
      const next = Math.min(1, Math.max(0, value))
      latestProgressRef.current = next
      if (next === 1) {
        cancelProgressFrame()
        if (mountedRef.current) setProgress(1)
        return
      }
      if (progressFrameRef.current !== null) return
      progressFrameRef.current = requestAnimationFrame(() => {
        progressFrameRef.current = null
        if (mountedRef.current && token === runTokenRef.current) {
          setProgress(latestProgressRef.current)
        }
      })
    },
    [cancelProgressFrame],
  )

  const invalidateRun = useCallback((): void => {
    runTokenRef.current++
  }, [])

  const invalidatePluginPreparation = useCallback((reason: string): void => {
    preparationGenerationRef.current++
    preparationInFlightRef.current = false
    preparationAbortRef.current?.abort(reason)
    preparationAbortRef.current = null
    preparedTokenRef.current = null
    if (mountedRef.current) setPreparingPluginExport(false)
    if (preparedPortRef.current) void preparedPortRef.current.cancel(reason).catch(() => undefined)
  }, [])

  const cancelActiveControllerRun = useCallback((): void => {
    if (!runningRef.current || !controllerRunStartedRef.current) return
    if (preparedPortRef.current) {
      void preparedPortRef.current.cancel('user-cancel').catch(() => undefined)
    } else {
      void loadExportController().then((controller) => controller.cancelExport()).catch(() => undefined)
    }
  }, [])

  const refreshCapabilities = useCallback((requestDoc: TimelineDoc): void => {
    const token = ++capabilityTokenRef.current
    setPresetCapabilityState({ status: 'loading', doc: requestDoc })
    void loadExportCapabilities()
      .then(async (controller) => {
        const snapshot = await controller.getExportPresetCapabilities()
        if (!mountedRef.current || token !== capabilityTokenRef.current) return
        setPresetCapabilityState({
          status: 'ready',
          doc: requestDoc,
          snapshot,
        })
        try {
          const checkSettings = controller.checkCurrentExportSettings
          if (typeof checkSettings !== 'function') {
            setAlphaVp9Supported(false)
            setAlphaAv1Supported(false)
            setAlphaReason(
              'Alpha video is offered only after a local encode/decode proof.',
            )
            return
          }
          const [vp9, av1] = await Promise.all([
            checkSettings({
              ...DEFAULT_ALPHA_VIDEO_PROFILE,
              videoCodec: 'vp9',
              chapters: { mode: 'off' },
            }),
            checkSettings({
              ...DEFAULT_ALPHA_VIDEO_PROFILE,
              videoCodec: 'av1',
              chapters: { mode: 'off' },
            }),
          ])
          if (!mountedRef.current || token !== capabilityTokenRef.current) return
          setAlphaVp9Supported(vp9.supported)
          setAlphaAv1Supported(av1.supported)
          setAlphaReason(
            vp9.supported || av1.supported
              ? null
              : vp9.reason ?? av1.reason,
          )
          if (vp9.supported) setAlphaCodec('vp9')
          else if (av1.supported) setAlphaCodec('av1')
        } catch {
          if (!mountedRef.current || token !== capabilityTokenRef.current) return
          setAlphaVp9Supported(false)
          setAlphaAv1Supported(false)
          setAlphaReason(
            'Alpha video is offered only after a local encode/decode proof.',
          )
        }
      })
      .catch((cause) => {
        if (!mountedRef.current || token !== capabilityTokenRef.current) return
        setPresetCapabilityState({
          status: 'error',
          doc: requestDoc,
          error: errorMessage(cause),
        })
      })
  }, [])

  const selectRecommendedProfile = useCallback((
    nextSelectionId: ExportSelectionId,
  ): void => {
    invalidatePluginPreparation('plugin-export-profile-changed')
    setPluginBlock(null)
    setSelectionId(nextSelectionId)
    setAdvancedDraftsValid(true)
    setError(null)
    setFilePickerMessage(null)
  }, [invalidatePluginPreparation])

  const selectCustomProfile = useCallback((
    profile: Readonly<ExportProfile>,
  ): void => {
    invalidatePluginPreparation('plugin-export-profile-changed')
    setPluginBlock(null)
    setCustomCapabilityState(null)
    setCustomProfile(profile)
    setSelectionId('custom')
    setDeliveryKind('video')
    setError(null)
    setFilePickerMessage(null)
  }, [invalidatePluginPreparation])

  const applyExportSettings = useCallback((
    profile: Readonly<ExportSettingsUnion>,
  ): void => {
    if (isDeliveryProfile(profile)) {
      invalidatePluginPreparation('plugin-export-profile-changed')
      setPluginBlock(null)
      setDeliveryKind(profile.kind)
      setChapterMode(profile.chapters.mode)
      if (profile.kind === 'image-sequence') {
        setPngPrefix(profile.fileNamePrefix)
        setPngOverwrite(profile.overwriteExisting)
        setPngDestination(profile.destination)
      } else if (profile.kind === 'audio-only') {
        setAudioContainer(profile.container)
        setCustomProfile(updateExportProfile(customProfile, {
          destination: profile.destination,
        }))
      } else {
        setAlphaCodec(profile.videoCodec)
        setCustomProfile(updateExportProfile(customProfile, {
          destination: profile.destination,
        }))
      }
      setError(null)
      setFilePickerMessage(null)
      return
    }
    selectCustomProfile(profile)
  }, [customProfile, invalidatePluginPreparation, selectCustomProfile])

  const currentPresetCapability = presetCapabilityState.doc === doc
    ? presetCapabilityState
    : null
  const capabilitySnapshot = currentPresetCapability?.status === 'ready'
    ? currentPresetCapability.snapshot
    : null
  const capabilityError = currentPresetCapability?.status === 'error'
    ? currentPresetCapability.error
    : null
  const capabilityLoading = currentPresetCapability === null
    || currentPresetCapability.status === 'loading'
  const customCapability = customCapabilityState?.status === 'ready'
    && customCapabilityState.doc === doc
    && customCapabilityState.profile === customProfile
    ? customCapabilityState.result
    : null

  let displayProfile = profileForSelectionFallback(selectionId, customProfile)
  let activeProfile: Readonly<ExportProfile> | null = null
  let selectedSupported: boolean | null = capabilityLoading ? null : false
  let selectedReason: string | null = capabilityError

  if (selectionId === 'custom') {
    displayProfile = customProfile
    if (customCapability) {
      selectedSupported = customCapability.supported
      selectedReason = customCapability.reason
      activeProfile = customCapability.supported ? customCapability.profile : null
    } else {
      selectedSupported = null
      selectedReason = null
    }
  } else if (capabilitySnapshot) {
    const presetId = selectionId === 'auto'
      ? capabilitySnapshot.autoPresetId
      : selectionId
    if (presetId === null) {
      selectedSupported = false
      selectedReason = 'No export profile supports this project in this browser.'
    } else {
      const result = capabilitySnapshot.presets.find(
        (candidate) => candidate.presetId === presetId,
      )
      if (!result) {
        selectedSupported = false
        selectedReason = `Capability results are missing ${presetId}.`
      } else {
        displayProfile = result.profile
        selectedSupported = result.supported
        selectedReason = result.reason
        activeProfile = result.supported ? result.profile : null
      }
    }
  }

  if (
    displayProfile.destination === 'file'
    && !filePickerAvailability.available
  ) {
    selectedSupported = false
    selectedReason = filePickerAvailability.reason
    activeProfile = null
  }

  const builtDelivery = deliverySettings(deliveryKind, {
    pngPrefix,
    pngOverwrite,
    pngDestination,
    audioContainer,
    alphaCodec,
    chapterMode,
    videoAudio: displayProfile,
  })
  const exportSettings: Readonly<ExportSettingsUnion> | null = deliveryKind === 'video'
    ? activeProfile
    : builtDelivery

  if (deliveryKind !== 'video') {
    if (
      pngDestination === 'directory'
      && deliveryKind === 'image-sequence'
      && !directoryPickerAvailability.available
    ) {
      selectedSupported = false
      selectedReason = directoryPickerAvailability.reason
    } else if (deliveryKind === 'alpha-video' && alphaVp9Supported !== true && alphaAv1Supported !== true) {
      selectedSupported = false
      selectedReason = alphaReason ?? 'Alpha video is unavailable on this browser.'
    } else {
      selectedSupported = deliveryCapability.supported
      selectedReason = deliveryCapability.reason
    }
  }

  const presetAvailability: readonly Readonly<ExportPresetAvailability>[] = [
    {
      selectionId: 'auto',
      supported: capabilitySnapshot
        ? capabilitySnapshot.autoPresetId !== null
        : capabilityError ? false : null,
      reason: capabilitySnapshot?.autoPresetId === null
        ? 'No documented profile is supported on this browser.'
        : capabilityError,
      autoPresetId: capabilitySnapshot?.autoPresetId,
    },
    ...EXPORT_PRESETS.map((preset) => {
      const result = capabilitySnapshot?.presets.find(
        (candidate) => candidate.presetId === preset.id,
      )
      return {
        selectionId: preset.id,
        supported: result?.supported ?? (capabilityError ? false : null),
        reason: result?.reason ?? capabilityError,
      }
    }),
  ]

  const offline = [...projectOutputMediaAssetIds(
    project,
    activeSequenceId,
    exportSettings
      ? exportSettingsIncludesAudio(doc, exportSettings)
      : displayProfile.audioChannelLayout !== 'off',
    exportSettings ? exportSettingsIncludesVisual(exportSettings) : true,
  )].filter((assetId) => !mediaAssets.has(assetId))
  const offlineExportMessage = offline.length === 0
    ? null
    : `Reconnect ${offline.length} offline source${
        offline.length === 1 ? '' : 's'
      } before exporting: ${offline.map(
        (assetId) => mediaDescriptors.get(assetId)?.fileName ?? assetId,
      ).join(', ')}.`

  const canStart = !preparingPluginExport
    && hasContent
    && offlineExportMessage === null
    && selectedSupported === true
    && exportSettings !== null
    && (deliveryKind !== 'video' || advancedDraftsValid)
  const requiresPreparedExport = deliveryKind !== 'audio-only' && projectHasOutputPluginEffects(
    project,
    activeSequenceId,
  )
  const estimatedSize = formatEstimatedFileSize(
    estimateExportBytes(doc, displayProfile),
  )

  const resetToConfigure = (): void => {
    invalidatePluginPreparation('plugin-export-reset')
    invalidateRun()
    cancelProgressFrame()
    revokeDownload()
    setDownload(null)
    setSavedFile(null)
    setProgress(0)
    latestProgressRef.current = 0
    setError(null)
    setFilePickerMessage(null)
    setPhase('configure')
  }

  const closeDialog = (): void => {
    if (runningRef.current) return
    invalidatePluginPreparation('plugin-export-dialog-closed')
    invalidateRun()
    cancelProgressFrame()
    revokeDownload()
    onClose()
  }

  const requestCancel = (): void => {
    if (preparationInFlightRef.current) {
      invalidatePluginPreparation('user-cancel')
      setPluginBlock(null)
      return
    }
    if (!runningRef.current || cancelRequestedRef.current) return
    cancelRequestedRef.current = true
    // If the export-only controller chunk has not started a run yet, there is
    // no external resource to clean up. Cancel locally and invalidate the
    // pending import continuation instead of waiting on the network.
    if (!controllerRunStartedRef.current) {
      runningRef.current = false
      cancelRequestedRef.current = false
      invalidateRun()
      cancelProgressFrame()
      setPhase('cancelled')
      return
    }
    setPhase('cancelling')
    // startExport's original promise is the terminal-state owner and surfaces
    // the shared cleanup error. Swallow this duplicate observer promise.
    cancelActiveControllerRun()
  }

  const beginExport = async (): Promise<void> => {
    const runSettings = exportSettings
    if (
      runningRef.current
      || preparationInFlightRef.current
      || !canStart
      || runSettings === null
    ) return
    if (requiresPreparedExport && preparedTokenRef.current === null) {
      preparationInFlightRef.current = true
      const generation = ++preparationGenerationRef.current
      const abort = new AbortController()
      preparationAbortRef.current?.abort('plugin-export-replaced')
      preparationAbortRef.current = abort
      setPreparingPluginExport(true)
      try {
        const port = await loadPreparedExportPort()
        if (!mountedRef.current || generation !== preparationGenerationRef.current) {
          void port.cancel('plugin-export-stale-load').catch(() => undefined)
          return
        }
        preparedPortRef.current = port
        const prepared = await port.prepare(runSettings, abort.signal)
        if (!mountedRef.current || generation !== preparationGenerationRef.current) {
          void port.cancel('plugin-export-stale-prepare').catch(() => undefined)
          return
        }
        if (prepared.status === 'blocked') {
          setPluginBlock(prepared)
          return
        }
        if (prepared.status !== 'ready') throw new Error('Plugin export checks did not produce a ready attempt.')
        preparedTokenRef.current = prepared.token
        if (runSettings.destination === 'file') {
          setFilePickerMessage('Plugin checks complete. Choose a file to begin this prepared export.')
          return
        }
      } catch (cause) {
        if (!mountedRef.current || generation !== preparationGenerationRef.current) return
        setError(errorMessage(cause))
        return
      } finally {
        if (generation === preparationGenerationRef.current) {
          preparationAbortRef.current = null
          preparationInFlightRef.current = false
          if (mountedRef.current) setPreparingPluginExport(false)
        }
      }
    }
    const preparedPort = preparedPortRef.current
    const preparedToken = preparedTokenRef.current
    if (requiresPreparedExport && (!preparedPort || !preparedToken)) return
    runningRef.current = true
    cancelRequestedRef.current = false
    runDestinationRef.current = runSettings.destination
    const token = ++runTokenRef.current
    cancelProgressFrame()
    revokeDownload()
    setDownload(null)
    setSavedFile(null)
    setProgress(0)
    latestProgressRef.current = 0
    setError(null)
    setFilePickerMessage(null)

    let fileDestination: ExportFileDestinationCapability | undefined
    let directoryDestination: ExportDirectoryDestinationCapability | undefined

    try {
      if (runSettings.destination === 'file') {
        const extension = 'fileExtension' in runSettings ? runSettings.fileExtension : 'bin'
        const pickerPromise = requestExportFileDestination(
          runSettings,
          exportFileName(doc.name, extension),
        )
        setPhase('choosing-file')
        const pickerResult = await pickerPromise
        if (!mountedRef.current || token !== runTokenRef.current) return
        if (pickerResult.status === 'cancelled') {
          runningRef.current = false
          setFilePickerMessage('No file selected.')
          setPhase('configure')
          return
        }
        if (pickerResult.status !== 'selected') {
          runningRef.current = false
          setError(pickerResult.reason)
          setPhase('configure')
          return
        }
        fileDestination = pickerResult.destination
      }

      if (runSettings.destination === 'directory') {
        const pickerPromise = requestExportDirectoryDestination()
        setPhase('choosing-directory')
        const pickerResult = await pickerPromise
        if (!mountedRef.current || token !== runTokenRef.current) return
        if (pickerResult.status === 'cancelled') {
          runningRef.current = false
          setFilePickerMessage('No folder selected.')
          setPhase('configure')
          return
        }
        if (pickerResult.status !== 'selected') {
          runningRef.current = false
          setError(pickerResult.reason)
          setPhase('configure')
          return
        }
        directoryDestination = pickerResult.destination
      }

      setPhase('running')
      const controller = requiresPreparedExport ? null : await loadExportController()
      if (!mountedRef.current || token !== runTokenRef.current) {
        return
      }
      // Cancel may win while the export-only chunk is loading. In that case
      // no controller run exists yet, so finish locally without starting one.
      if (cancelRequestedRef.current) {
        runningRef.current = false
        cancelRequestedRef.current = false
        setPhase('cancelled')
        return
      }

      controllerRunStartedRef.current = true
      const callbacks = {
        onProgress: (value: number) => publishProgress(token, value),
        ...(chapterMode === 'sidecar' ? { chapters: { mode: 'sidecar' as const } } : {}),
        ...(fileDestination ? { fileDestination } : {}),
        ...(directoryDestination ? { directoryDestination } : {}),
      }
      if (requiresPreparedExport) preparedTokenRef.current = null
      const result = requiresPreparedExport
        ? await preparedPort!.start(preparedToken!, callbacks)
        : await controller!.startExport(runSettings, callbacks)
      controllerRunStartedRef.current = false
      runningRef.current = false
      cancelRequestedRef.current = false
      if (!mountedRef.current || token !== runTokenRef.current) return
      cancelProgressFrame()

      if (result === undefined) {
        setPhase('cancelled')
        return
      }

      setProgress(1)
      latestProgressRef.current = 1
      const formatLabel = resultLabel(result)
      if (result.destination === 'directory') {
        setSavedFile({
          fileName: result.directoryName,
          formatLabel,
        })
        setPhase('saved')
        return
      }
      if (result.destination === 'file') {
        setSavedFile({
          fileName: result.fileName,
          formatLabel,
        })
        setPhase('saved')
        return
      }
      const url = URL.createObjectURL(
        new Blob([result.buffer], { type: result.mimeType }),
      )
      downloadUrlRef.current = url
      setDownload({
        url,
        fileName: exportFileName(doc.name, result.fileExtension),
        formatLabel,
        linkLabel: `Download ${formatLabel}`,
      })
      setPhase('download')
    } catch (cause) {
      if (!mountedRef.current || token !== runTokenRef.current) return
      if (requiresPreparedExport) {
        invalidatePluginPreparation('plugin-export-start-failed')
      }
      controllerRunStartedRef.current = false
      runningRef.current = false
      cancelRequestedRef.current = false
      cancelProgressFrame()
      setProgress(0)
      latestProgressRef.current = 0
      setError(fileDestination
        ? directFileFailureMessage(cause)
        : errorMessage(cause))
      setPhase('configure')
    }
  }

  const approvePluginBlockers = async (reviewToken: string): Promise<void> => {
    const port = preparedPortRef.current
    if (!port || preparationInFlightRef.current) return
    preparationInFlightRef.current = true
    const generation = ++preparationGenerationRef.current
    const abort = new AbortController()
    preparationAbortRef.current?.abort('plugin-export-approval-replaced')
    preparationAbortRef.current = abort
    setPreparingPluginExport(true)
    let startPreparedExport = false
    try {
      const prepared = await port.approveReviewedBlockers(reviewToken, abort.signal)
      if (!mountedRef.current || generation !== preparationGenerationRef.current) {
        void port.cancel('plugin-export-stale-approval').catch(() => undefined)
        return
      }
      if (prepared.status === 'blocked') {
        setPluginBlock(prepared)
        return
      }
      if (prepared.status !== 'ready') throw new Error('Plugin export review did not produce a ready attempt.')
      setPluginBlock(null)
      preparedTokenRef.current = prepared.token
      if (prepared.attempt.settings.destination === 'file') {
        setFilePickerMessage('Plugin review complete. Choose a file to begin this prepared export.')
      } else {
        startPreparedExport = true
      }
    } catch (cause) {
      if (!mountedRef.current || generation !== preparationGenerationRef.current) return
      setError(errorMessage(cause))
    } finally {
      if (generation === preparationGenerationRef.current) {
        preparationAbortRef.current = null
        preparationInFlightRef.current = false
        if (mountedRef.current) setPreparingPluginExport(false)
      }
    }
    if (
      startPreparedExport
      && mountedRef.current
      && generation === preparationGenerationRef.current
    ) {
      void beginExport()
    }
  }

  // Open the native modal safely under StrictMode. jsdom lacks showModal(),
  // so the attribute fallback keeps focused RTL tests faithful to the UI.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal()
    } else {
      dialog.setAttribute('open', '')
    }
    return () => {
      if (typeof dialog.close === 'function') {
        if (dialog.open) dialog.close()
      } else {
        dialog.removeAttribute('open')
      }
    }
  }, [])

  useEffect(() => {
    const capabilityToken = capabilityTokenRef
    const customCapabilityToken = customCapabilityTokenRef
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      capabilityToken.current++
      customCapabilityToken.current++
      invalidateRun()
      invalidatePluginPreparation('plugin-export-dialog-unmounted')
      cancelProgressFrame()
      revokeDownload()
      cancelActiveControllerRun()
    }
  }, [
    cancelActiveControllerRun,
    cancelProgressFrame,
    invalidatePluginPreparation,
    invalidateRun,
    revokeDownload,
  ])

  useEffect(() => {
    refreshCapabilities(doc)
  }, [doc, refreshCapabilities])

  useEffect(() => {
    if (deliveryKind === 'video') {
      setDeliveryCapability({ supported: true, reason: null })
      return
    }
    let cancelled = false
    const settings = deliverySettings(deliveryKind, {
      pngPrefix,
      pngOverwrite,
      pngDestination,
      audioContainer,
      alphaCodec,
      chapterMode,
      videoAudio: profileForSelectionFallback(selectionId, customProfile),
    })
    void loadExportCapabilities()
      .then(async (controller) => {
        let check: ExportCapabilitiesModule['checkCurrentExportSettings'] | undefined
        try {
          check = controller.checkCurrentExportSettings
        } catch {
          check = undefined
        }
        if (typeof check !== 'function') {
          if (deliveryKind === 'alpha-video') {
            return {
              supported: false,
              reason: 'Alpha video is offered only after a local encode/decode proof.',
            }
          }
          if (deliveryKind === 'audio-only' && audioContainer !== 'wav') {
            return {
              supported: false,
              reason: 'Compressed audio-only requires a local encoder proof. No codec was substituted.',
            }
          }
          return { supported: true, reason: null as string | null }
        }
        return check(settings)
      })
      .then((result) => {
        if (!cancelled) {
          setDeliveryCapability({
            supported: result.supported,
            reason: result.reason,
          })
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setDeliveryCapability({
            supported: false,
            reason: errorMessage(cause),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    deliveryKind,
    pngPrefix,
    pngOverwrite,
    pngDestination,
    audioContainer,
    alphaCodec,
    chapterMode,
    selectionId,
    customProfile,
  ])

  useEffect(() => {
    if (selectionId !== 'custom') {
      customCapabilityTokenRef.current++
      setCustomCapabilityState(null)
      return
    }
    const token = ++customCapabilityTokenRef.current
    const requestDoc = doc
    const requestProfile = customProfile
    setCustomCapabilityState({
      status: 'loading',
      doc: requestDoc,
      profile: requestProfile,
    })
    void loadExportCapabilities()
      .then(async (controller) => {
        return controller.checkCurrentExportProfile(requestProfile)
      })
      .then((result) => {
        if (
          !mountedRef.current
          || token !== customCapabilityTokenRef.current
        ) return
        setCustomCapabilityState({
          status: 'ready',
          doc: requestDoc,
          profile: requestProfile,
          result,
        })
      })
      .catch((cause) => {
        if (
          !mountedRef.current
          || token !== customCapabilityTokenRef.current
        ) return
        setCustomCapabilityState({
          status: 'ready',
          doc: requestDoc,
          profile: requestProfile,
          result: {
            profile: requestProfile,
            supported: false,
            reason: errorMessage(cause),
          },
        })
      })
  }, [customProfile, doc, selectionId])

  useEffect(() => {
    if (selectedSupported !== true || activeProfile === null) return
    setExportSelectionPreference({
      selectionId,
      profile: selectionId === 'custom' ? activeProfile : null,
    })
  }, [
    activeProfile,
    selectedSupported,
    selectionId,
    setExportSelectionPreference,
  ])

  useEffect(() => {
    const focusFrame = requestAnimationFrame(() => {
      switch (phase) {
        case 'configure':
          selectedProfileRef.current?.focus()
          break
        case 'choosing-file':
          phaseStatusRef.current?.focus()
          break
        case 'running':
          cancelButtonRef.current?.focus()
          break
        case 'cancelling':
          phaseStatusRef.current?.focus()
          break
        case 'download':
          downloadLinkRef.current?.focus()
          break
        case 'saved':
          backButtonRef.current?.focus()
          break
        case 'cancelled':
          backButtonRef.current?.focus()
          break
      }
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [phase])

  useEffect(() => {
    const previous = previousSelectedSupportedRef.current
    previousSelectedSupportedRef.current = selectedSupported
    if (
      phase !== 'configure'
      || selectedSupported !== false
      || previous === false
    ) return
    const focusFrame = requestAnimationFrame(() => {
      const active = document.activeElement
      if (active === selectedProfileRef.current || active === document.body) {
        capabilityStatusRef.current?.focus()
      }
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [phase, selectedSupported])

  const busy = preparingPluginExport
    || phase === 'choosing-file'
    || phase === 'choosing-directory'
    || phase === 'running'
    || phase === 'cancelling'
  const percent = Math.round(progress * 100)

  return (
    <dialog
      ref={dialogRef}
      className="export-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault()
        if (busy) requestCancel()
        else closeDialog()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        if (!busy) closeDialog()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="export-dialog-card">
        <ExportDialogHeader
          titleId={titleId}
          busy={phase === 'choosing-file' || phase === 'choosing-directory' || phase === 'running' || phase === 'cancelling'}
          closeButtonRef={closeButtonRef}
          onClose={closeDialog}
        />

        <p className="export-sequence-target">
          Export target: active sequence <strong>{doc.name}</strong>
          {activeSequenceId === rootSequenceId ? ' (project root)' : ''}.
        </p>

        <div className="export-dialog-body">
          <ExportConfiguration
            descriptionId={descriptionId}
            doc={doc}
            displayProfile={displayProfile}
            estimatedSize={estimatedSize}
            selectionId={selectionId}
            presetAvailability={presetAvailability}
            selectedSupported={selectedSupported}
            selectedReason={selectedReason}
            filePickerAvailability={filePickerAvailability}
            phase={phase}
            selectedProfileRef={selectedProfileRef}
            capabilityStatusRef={capabilityStatusRef}
            capabilityLoading={capabilityLoading}
            capabilityError={capabilityError}
            autoPresetId={capabilitySnapshot?.autoPresetId}
            advancedDraftsValid={advancedDraftsValid}
            hasContent={hasContent}
            offlineExportMessage={offlineExportMessage}
            filePickerMessage={filePickerMessage}
            error={error}
            onSelect={selectRecommendedProfile}
            onChangeProfile={selectCustomProfile}
            onDraftValidityChange={setAdvancedDraftsValid}
            onRetryCapabilities={() => refreshCapabilities(doc)}
            deliveryKind={deliveryKind}
            onDeliveryKind={(kind) => {
              invalidatePluginPreparation('plugin-export-product-changed')
              setDeliveryKind(kind)
              setError(null)
              setDeliveryCapability({ supported: kind === 'video' ? true : null, reason: null })
            }}
            chapterMode={chapterMode}
            onChapterMode={setChapterMode}
            pngPrefix={pngPrefix}
            onPngPrefix={setPngPrefix}
            pngOverwrite={pngOverwrite}
            onPngOverwrite={setPngOverwrite}
            pngDestination={pngDestination}
            onPngDestination={setPngDestination}
            audioContainer={audioContainer}
            onAudioContainer={setAudioContainer}
            alphaCodec={alphaCodec}
            onAlphaCodec={setAlphaCodec}
            alphaVp9Supported={alphaVp9Supported}
            alphaAv1Supported={alphaAv1Supported}
            alphaReason={alphaReason}
            directoryPickerAvailability={directoryPickerAvailability}
          />

          <RenderQueuePanel
            profile={exportSettings}
            onProfile={applyExportSettings}
            disabled={phase !== 'configure' || (deliveryKind === 'video' && !advancedDraftsValid)}
            chapters={{ mode: chapterMode }}
          />

          <ExportPhaseContent
            phase={phase}
            phaseStatusRef={phaseStatusRef}
            progressId={progressId}
            progress={progress}
            percent={percent}
            download={download}
            savedFile={savedFile}
            runDestination={runDestinationRef.current}
          />
          {pluginBlock?.status === 'blocked' ? (
            <PluginExportBlockBody
              issues={blockerIssues(pluginBlock)}
              reviewToken={pluginBlock.token}
              documentRevision={String(pluginBlock.attempt.documentGeneration)}
              busy={preparingPluginExport}
              error={error}
              onCancel={() => {
                invalidatePluginPreparation('plugin-export-review-dismissed')
                setPluginBlock(null)
              }}
              onRetry={() => {
                invalidatePluginPreparation('plugin-export-review-retry')
                setPluginBlock(null)
                void beginExport()
              }}
              onExportBypassed={(reviewToken) => { void approvePluginBlockers(reviewToken) }}
            />
          ) : null}
        </div>

        <ExportDialogActions
          phase={phase}
          startButtonRef={startButtonRef}
          cancelButtonRef={cancelButtonRef}
          downloadLinkRef={downloadLinkRef}
          backButtonRef={backButtonRef}
          canStart={canStart}
          offlineExportMessage={offlineExportMessage}
          capabilityLoading={capabilityLoading}
          selectedSupported={selectedSupported}
          advancedDraftsValid={advancedDraftsValid}
          error={error}
          outputDestination={exportSettings?.destination ?? displayProfile.destination}
          download={download}
          savedFile={savedFile}
          onClose={closeDialog}
          onStart={() => void beginExport()}
          onCancel={requestCancel}
          onReset={resetToConfigure}
        />
      </div>
    </dialog>
  )
}
function loadExportController(): Promise<ExportControllerModule> {
  controllerPromise ??= import('../app/exportController').catch((cause) => {
    controllerPromise = null
    throw cause
  })
  return controllerPromise
}
