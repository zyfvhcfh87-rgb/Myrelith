import { describe, expect, test, vi } from 'vitest'
import {
  directoryWriterFromHandle,
  getExportDirectoryPickerAvailability,
  requestExportDirectoryDestination,
  type ExportDirectoryPickerHost,
} from './exportDirectoryPicker'

function namedError(name: string): Error {
  const error = new Error(name)
  error.name = name
  return error
}

describe('export directory picker', () => {
  test('requires a secure context and showDirectoryPicker', () => {
    expect(getExportDirectoryPickerAvailability({
      isSecureContext: false,
      showDirectoryPicker: vi.fn(),
    })).toEqual({
      available: false,
      reason: expect.stringMatching(/secure browser context/i),
    })
    expect(getExportDirectoryPickerAvailability({
      isSecureContext: true,
    })).toEqual({
      available: false,
      reason: expect.stringMatching(/cannot write/i),
    })
    expect(getExportDirectoryPickerAvailability({
      isSecureContext: true,
      showDirectoryPicker: vi.fn(),
    })).toEqual({ available: true, reason: null })
  })

  test('returns cancelled and security errors without throwing', async () => {
    const cancelledHost: ExportDirectoryPickerHost = {
      isSecureContext: true,
      showDirectoryPicker: vi.fn(async () => {
        throw namedError('AbortError')
      }),
    }
    await expect(requestExportDirectoryDestination(cancelledHost)).resolves.toEqual({
      status: 'cancelled',
    })

    const blockedHost: ExportDirectoryPickerHost = {
      isSecureContext: true,
      showDirectoryPicker: vi.fn(async () => {
        throw namedError('SecurityError')
      }),
    }
    await expect(requestExportDirectoryDestination(blockedHost)).resolves.toMatchObject({
      status: 'security-error',
    })
  })

  test('exposes a one-shot directory writer', async () => {
    const written: Array<{ name: string; bytes: Uint8Array }> = []
    const handle = {
      name: 'plates',
      getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
        if (!options?.create && name === 'missing.png') {
          throw namedError('NotFoundError')
        }
        return {
          createWritable: async () => ({
            write: async (bytes: Uint8Array) => {
              written.push({ name, bytes })
            },
            close: async () => undefined,
            abort: async () => undefined,
          }),
        }
      }),
    } as unknown as FileSystemDirectoryHandle
    const writer = directoryWriterFromHandle(handle)
    expect(writer.directoryName).toBe('plates')
    expect(await writer.exists('missing.png')).toBe(false)
    await writer.write('frame_00000.png', new Uint8Array([1, 2, 3]))
    expect(written[0]?.name).toBe('frame_00000.png')
  })
})
