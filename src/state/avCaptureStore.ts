/** Small serializable view of the app-owned camera/screen capture session. */
import { create } from 'zustand'
import type { AvCaptureMode, AvCaptureSession } from '../domain/avCaptureSession'

export interface AvCaptureProgressView {
  bytes: number
  durationUs: number
  videoFrames: number
  droppedVideoFrames: number
  audioSamples: number
  audioSampleRate: number | null
  width: number | null
  height: number | null
}

export interface AvCaptureStatus {
  session: AvCaptureSession | null
  videoLabel: string | null
  /** Label of the recorded audio source, or null when the take has no audio. */
  audioLabel: string | null
  /** The browser offered display audio but it was not requested, or vice versa. */
  audioNote: string | null
  /** How video and audio clocks were joined (see avClockCalibration). */
  clockMethod: 'capture-time' | 'delivery-estimate' | null
  progress: AvCaptureProgressView | null
  /** Plain-language A/V drift or gap report from the recorder. */
  clockNote: string | null
  diagnostic: string | null
}

export const useAvCaptureStore = create<AvCaptureStatus>(() => ({
  session: null,
  videoLabel: null,
  audioLabel: null,
  audioNote: null,
  clockMethod: null,
  progress: null,
  clockNote: null,
  diagnostic: null,
}))

export type ScreenAudioChoice = 'none' | 'display' | 'microphone'

/** Recording setup choices for camera and screen modes (editor session only). */
export interface AvCaptureSetup {
  mode: 'voiceover' | AvCaptureMode
  cameraId: string | null
  /** Microphone for camera takes; 'none' records video only. */
  cameraMicrophoneId: string | null | 'none'
  screenAudio: ScreenAudioChoice
  screenMicrophoneId: string | null
}

export const useAvCaptureSetupStore = create<AvCaptureSetup>(() => ({
  mode: 'voiceover',
  cameraId: null,
  cameraMicrophoneId: null,
  screenAudio: 'none',
  screenMicrophoneId: null,
}))
