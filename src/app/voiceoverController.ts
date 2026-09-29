/**
 * UI facade for microphone voiceover. Components call these functions; the
 * capture owner, recovery worker, streams, and file handles stay app-owned.
 */
import { errorMessage } from '../domain/errors'
import { MAX_VOICEOVER_COMPENSATION_SECONDS } from '../domain/voiceoverClock'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { useVoiceoverDraftStore, type VoiceoverInputDevice } from '../state/voiceoverCaptureStore'
import { getVoiceoverCaptureOwner } from './voiceoverCaptureOwner'
import { getVoiceoverDraftRecovery, type VoiceoverDraftAction } from './voiceoverDraftRecovery'

export interface VoiceoverStartRequest {
  readonly trackId: string
  /** Whole seconds of count-in; converted to integer frames at the document rate. */
  readonly countInSeconds: number
  /** Signed input-latency offset in milliseconds; converted to exact samples. */
  readonly compensationMs: number
  readonly mutePlayback: boolean
  /** null lets the browser choose its default microphone. */
  readonly deviceId: string | null
}

export const VOICEOVER_COUNT_IN_SECONDS = Object.freeze([0, 1, 2, 3, 4] as const)
export const VOICEOVER_COMPENSATION_MS_LIMIT = MAX_VOICEOVER_COMPENSATION_SECONDS * 1000

/**
 * Must run synchronously inside the Record click: the owner requests the
 * microphone before its first await so the browser keeps the activation.
 */
export function startVoiceover(request: VoiceoverStartRequest):
  { status: 'started'; sessionId: string } | { status: 'rejected'; reason: string } {
  const doc = useDocumentStore.getState().doc
  if (!Number.isSafeInteger(request.countInSeconds) || request.countInSeconds < 0 || request.countInSeconds > 4) {
    return { status: 'rejected', reason: 'Count-in must be between 0 and 4 seconds.' }
  }
  if (!Number.isSafeInteger(request.compensationMs) ||
    Math.abs(request.compensationMs) > VOICEOVER_COMPENSATION_MS_LIMIT) {
    return { status: 'rejected', reason: `Latency offset must be whole milliseconds within ±${VOICEOVER_COMPENSATION_MS_LIMIT}.` }
  }
  // Integer rounding of seconds × rate to frames, and ms × sample rate to samples.
  const { num, den } = doc.frameRate
  const countInFrames = Math.floor((2 * request.countInSeconds * num + den) / (2 * den))
  const compensationSamples = Math.round(request.compensationMs * doc.audioSampleRate / 1000)
  return getVoiceoverCaptureOwner().start(request.trackId, useTransportStore.getState().playheadFrame, {
    countInFrames, compensationSamples, mutePlayback: request.mutePlayback, deviceId: request.deviceId,
  })
}

export function stopVoiceover(): Promise<void> { return getVoiceoverCaptureOwner().stop() }
export function cancelVoiceover(): Promise<void> { return getVoiceoverCaptureOwner().cancel() }
export function retryVoiceoverCleanup(): Promise<void> { return getVoiceoverCaptureOwner().retryCleanup() }

export async function keepVoiceover(placeOnTimeline: boolean): Promise<void> {
  await getVoiceoverCaptureOwner().keep(placeOnTimeline)
  // The kept file is now referenced by a remembered handle; refresh the list.
  if (useVoiceoverDraftStore.getState().drafts !== null) void refreshVoiceoverDrafts()
}

/**
 * Microphones known to the browser. This never opens a device; labels stay
 * empty until the user has granted microphone access at least once.
 */
export async function listVoiceoverInputDevices(): Promise<readonly VoiceoverInputDevice[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  let unnamed = 0
  return devices
    .filter((device) => device.kind === 'audioinput' && device.deviceId !== '' &&
      device.deviceId !== 'default' && device.deviceId !== 'communications')
    .map((device) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${++unnamed}` }))
}

let surveyToken = 0

/** OPFS plus a module worker are required to list or write recordings. */
export function voiceoverStorageAvailable(): boolean {
  return typeof Worker !== 'undefined' && typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
}

/** Read-only enumeration of the recordings directory; nothing is imported or deleted. */
export async function refreshVoiceoverDrafts(): Promise<void> {
  if (!voiceoverStorageAvailable()) {
    useVoiceoverDraftStore.setState({ drafts: [], busy: false,
      error: 'This browser has no origin-private storage for recordings.' })
    return
  }
  const token = ++surveyToken
  useVoiceoverDraftStore.setState({ busy: true, error: null })
  try {
    const survey = await getVoiceoverDraftRecovery().survey()
    if (token !== surveyToken) return
    useVoiceoverDraftStore.setState({ drafts: survey.drafts, busy: false })
  } catch (cause) {
    if (token !== surveyToken) return
    useVoiceoverDraftStore.setState({ busy: false,
      error: errorMessage(cause) })
  }
}

async function draftAction(run: () => Promise<VoiceoverDraftAction>): Promise<VoiceoverDraftAction> {
  useVoiceoverDraftStore.setState({ busy: true, error: null })
  let result: VoiceoverDraftAction
  try { result = await run() }
  catch (cause) { result = { status: 'failed', message: errorMessage(cause) } }
  useVoiceoverDraftStore.setState({ lastAction: result })
  await refreshVoiceoverDrafts()
  return result
}

export function recoverVoiceoverDraft(draftId: string): Promise<VoiceoverDraftAction> {
  return draftAction(() => getVoiceoverDraftRecovery().recoverDraft(draftId))
}

export function discardVoiceoverDraft(draftId: string): Promise<VoiceoverDraftAction> {
  return draftAction(() => getVoiceoverDraftRecovery().discardDraft(draftId))
}

export function removeVoiceoverOriginal(assetId: string): Promise<VoiceoverDraftAction> {
  return draftAction(() => getVoiceoverDraftRecovery().removeKeptOriginal(assetId))
}
