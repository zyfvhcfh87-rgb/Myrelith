import { COLOR_LUT_LIMITS, parseCube, portableColorLut } from '../domain/colorLut'
import type { ColorLutImportReply, ColorLutImportRequest } from '../domain/colorLutImport'

let started = false
self.onmessage = (event: MessageEvent<ColorLutImportRequest>) => {
  if (started) return
  started = true
  void (async (): Promise<ColorLutImportReply> => {
    const { file, name, id } = event.data
    if (file.size > COLOR_LUT_LIMITS.fileBytes) throw new Error('LUT file exceeds 4 MiB.')
    const bytes = await file.arrayBuffer()
    if (bytes.byteLength > COLOR_LUT_LIMITS.fileBytes) throw new Error('LUT file exceeds 4 MiB.')
    const parsed = parseCube(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
    return { table: portableColorLut(id, parsed.title || name, parsed) }
  })().catch((cause): ColorLutImportReply => ({ error: cause instanceof Error ? cause.message : 'The LUT could not be read.' }))
    .then((reply) => self.postMessage(reply))
}
