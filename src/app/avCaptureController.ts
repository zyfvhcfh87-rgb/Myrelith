/**
 * UI facade for camera and screen recording. Components call these; streams,
 * the capture worker, and files stay with the app-owned capture owner.
 */
import { refreshVoiceoverDrafts } from './voiceoverController'
import { getAvCaptureOwner, type AvCaptureStartOptions } from './avCaptureOwner'

/** Must run synchronously inside the Record click (browser prompt activation). */
export function startAvCapture(options: AvCaptureStartOptions) {
  return getAvCaptureOwner().start(options)
}

export function stopAvCapture(): Promise<void> { return getAvCaptureOwner().stop() }
export function cancelAvCapture(): Promise<void> { return getAvCaptureOwner().cancel() }
export function retryAvCaptureCleanup(): Promise<void> { return getAvCaptureOwner().retryCleanup() }

export async function keepAvCapture(): Promise<void> {
  await getAvCaptureOwner().keepTake()
  void refreshVoiceoverDrafts()
}

/**
 * Show a muted live preview of the take in `element` (or detach with null).
 * The element receives a clone of the recorded track, stopped on detach.
 */
export function attachAvPreview(element: HTMLVideoElement | null): () => void {
  if (!element) return () => {}
  const track = getAvCaptureOwner().previewTrack()
  if (!track) return () => {}
  element.muted = true
  element.srcObject = new MediaStream([track])
  void element.play().catch(() => {})
  return () => {
    track.stop()
    if (element.srcObject) element.srcObject = null
  }
}

/** Cameras known to the browser; opens nothing. Labels appear after a grant. */
export async function listVideoInputDevices(): Promise<ReadonlyArray<{ deviceId: string; label: string }>> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  let unnamed = 0
  return devices.filter((device) => device.kind === 'videoinput' && device.deviceId !== '')
    .map((device) => ({ deviceId: device.deviceId, label: device.label || `Camera ${++unnamed}` }))
}
