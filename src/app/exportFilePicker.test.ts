import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_EXPORT_PROFILE,
  exportPresetById,
  updateExportProfile,
  type ExportProfile,
} from '../domain/exportProfile'
import {
  getExportFilePickerAvailability,
  requestExportFileDestination,
  type ExportFilePickerHost,
  type ExportSaveFilePicker,
} from './exportFilePicker'

function directProfile(
  profile: Readonly<ExportProfile> = DEFAULT_EXPORT_PROFILE,
): Readonly<ExportProfile> {
  return updateExportProfile(profile, { destination: 'file' })
}

function makeHandle(name: string): FileSystemFileHandle {
  return { name, kind: 'file' } as FileSystemFileHandle
}

function pickerHost(
  picker?: ExportSaveFilePicker,
  isSecureContext = true,
): ExportFilePickerHost {
  return { isSecureContext, showSaveFilePicker: picker }
}

describe('export file picker', () => {
  test('requires both a secure context and the picker API without UA sniffing', () => {
    const picker = vi.fn<ExportSaveFilePicker>()

    expect(getExportFilePickerAvailability(pickerHost(picker, false))).toEqual({
      available: false,
      reason: 'Direct file export requires a secure browser context (HTTPS or localhost).',
    })
    expect(getExportFilePickerAvailability(pickerHost(undefined, true))).toEqual({
      available: false,
      reason: 'This browser cannot write an export directly to a chosen file.',
    })
    expect(getExportFilePickerAvailability(pickerHost(picker, true))).toEqual({
      available: true,
      reason: null,
    })
  })

  test('invokes the MP4 picker synchronously with exact profile metadata', async () => {
    const handle = makeHandle('Actually chosen.mp4')
    const events: string[] = []
    const picker = vi.fn<ExportSaveFilePicker>(() => {
      events.push('picker')
      return Promise.resolve(handle)
    })
    const host = pickerHost(picker)

    const pending = requestExportFileDestination(
      directProfile(),
      'Issue 16 enchantment.mp4',
      host,
    )
    events.push('returned')

    expect(events).toEqual(['picker', 'returned'])
    expect(picker).toHaveBeenCalledOnce()
    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'Issue 16 enchantment.mp4',
      excludeAcceptAllOption: true,
      types: [{
        description: 'MP4 video',
        accept: { 'video/mp4': ['.mp4'] },
      }],
    })

    const result = await pending
    expect(result.status).toBe('selected')
    if (result.status !== 'selected') throw new Error('Expected a destination')
    expect(result.destination.fileName).toBe('Actually chosen.mp4')
    expect(JSON.stringify(result.destination)).toBe('{}')
    expect(result.destination.takeFileHandle()).toBe(handle)
    expect(() => result.destination.takeFileHandle()).toThrow(/already been consumed/)
  })

  test('uses exact WebM MIME and extension metadata', async () => {
    const handle = makeHandle('Chosen.webm')
    const picker = vi.fn<ExportSaveFilePicker>(async () => handle)

    await requestExportFileDestination(
      directProfile(exportPresetById('web').profile),
      'Web export.webm',
      pickerHost(picker),
    )

    expect(picker).toHaveBeenCalledWith({
      suggestedName: 'Web export.webm',
      excludeAcceptAllOption: true,
      types: [{
        description: 'WebM video',
        accept: { 'video/webm': ['.webm'] },
      }],
    })
  })

  test('returns unavailable without invoking a picker', async () => {
    const picker = vi.fn<ExportSaveFilePicker>()

    await expect(requestExportFileDestination(
      directProfile(),
      'Export.mp4',
      pickerHost(picker, false),
    )).resolves.toEqual({
      status: 'unavailable',
      reason: 'Direct file export requires a secure browser context (HTTPS or localhost).',
    })
    expect(picker).not.toHaveBeenCalled()
  })

  test('separates cancellation and browser security failures', async () => {
    const cancellation = new DOMException('cancelled', 'AbortError')
    const blocked = new DOMException('blocked', 'SecurityError')

    await expect(requestExportFileDestination(
      directProfile(),
      'Export.mp4',
      pickerHost(() => Promise.reject(cancellation)),
    )).resolves.toEqual({ status: 'cancelled' })
    await expect(requestExportFileDestination(
      directProfile(),
      'Export.mp4',
      pickerHost(() => Promise.reject(blocked)),
    )).resolves.toEqual({
      status: 'security-error',
      reason: 'The browser blocked the file picker. Start export directly from this button in a secure top-level page.',
    })
  })

  test('classifies synchronous picker errors and rejects unexpected failures', async () => {
    const cancellation = new DOMException('cancelled', 'AbortError')
    const failure = new Error('picker exploded')

    await expect(requestExportFileDestination(
      directProfile(),
      'Export.mp4',
      pickerHost(() => { throw cancellation }),
    )).resolves.toEqual({ status: 'cancelled' })
    await expect(requestExportFileDestination(
      directProfile(),
      'Export.mp4',
      pickerHost(() => Promise.reject(failure)),
    )).rejects.toBe(failure)
  })

  test('rejects non-file profiles before asking the user', () => {
    const picker = vi.fn<ExportSaveFilePicker>()

    expect(() => requestExportFileDestination(
      DEFAULT_EXPORT_PROFILE,
      'Export.mp4',
      pickerHost(picker),
    )).toThrow(/requires the file destination/)
    expect(picker).not.toHaveBeenCalled()
  })
})
