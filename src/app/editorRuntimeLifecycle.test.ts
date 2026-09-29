import { expect, test } from 'vitest'
import { loadedEditorRuntimeTeardown } from './editorRuntimeLifecycle'
import { teardownAvCaptureForProjectChange } from './avCaptureOwner'
import { resetMediaImportController } from './mediaImportController'
import { disposeMediaVisuals } from './mediaVisualsController'
import { disposeMulticamMonitor } from './multicamMonitorController'
import { disposePreview } from './previewController'
import { disposeSourcePlayback } from './sourceMonitorPlaybackController'
import { disposeSourcePreview } from './sourceMonitorPreviewController'
import { disposeTransport } from './transportController'
import { teardownVoiceoverForProjectChange } from './voiceoverCaptureOwner'

test('every editor runtime owner registers its own teardown as it loads', () => {
  expect(loadedEditorRuntimeTeardown('voiceoverCapture')).toBe(teardownVoiceoverForProjectChange)
  expect(loadedEditorRuntimeTeardown('avCapture')).toBe(teardownAvCaptureForProjectChange)
  expect(loadedEditorRuntimeTeardown('sourcePlayback')).toBe(disposeSourcePlayback)
  expect(loadedEditorRuntimeTeardown('transport')).toBe(disposeTransport)
  expect(loadedEditorRuntimeTeardown('multicamMonitor')).toBe(disposeMulticamMonitor)
  expect(loadedEditorRuntimeTeardown('sourcePreview')).toBe(disposeSourcePreview)
  expect(loadedEditorRuntimeTeardown('preview')).toBe(disposePreview)
  expect(loadedEditorRuntimeTeardown('mediaVisuals')).toBe(disposeMediaVisuals)
  expect(loadedEditorRuntimeTeardown('mediaImport')).toBe(resetMediaImportController)
})
