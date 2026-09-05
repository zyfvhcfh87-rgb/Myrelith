import { expect, test } from 'vitest'
import { readMulticamTimecode } from './multicamTimecodeMetadata'
import { makeTimecodeMovie } from '../test/fixtures/timecodeMovie'

const read = (patch = {}, confirmed = true) => readMulticamTimecode(
  new Blob([makeTimecodeMovie(patch)]), { num: 30, den: 1 }, confirmed, new AbortController().signal)
test('reads a source-bound 32-bit non-drop sample with exact track association and identity edit', async () => {
  await expect(read({ frameCount: 108065 })).resolves.toMatchObject({ label: '01:00:02:05', rate: { num: 30, den: 1 } })
  await expect(read({ identityEdit: true })).resolves.toMatchObject({ label: '01:00:00:00' })
})
test.each([
  { flags: 1 }, { flags: 4 }, { flags: 8 }, { flags: 16 }, { frameCount: -1 }, { frameCount: 2591900 },
  { referenceId: 99 }, { sampleOffset: 0 }, { mediaTime: 1, identityEdit: true }, { videoDelta: 1001 },
  { external: true }, { sampleCount: 2 }, { compositionOffset: true }, { handlerVersion: 1 },
])('refuses unproven timecode semantics: %j', async (patch) => { await expect(read(patch)).rejects.toThrow() })
test('does not infer a shared clock/day, read oversized moov or continue after abort', async () => {
  await expect(read({}, false)).rejects.toThrow(/Confirm/)
  const bad = new Uint8Array(8 + 4 * 1024 * 1024 + 1)
  new DataView(bad.buffer).setUint32(0, bad.length)
  bad.set(new TextEncoder().encode('moov'), 4)
  await expect(readMulticamTimecode(new Blob([bad]), { num: 30, den: 1 }, true, new AbortController().signal)).rejects.toThrow(/bounded/)
  const abort = new AbortController(); abort.abort()
  await expect(readMulticamTimecode(new Blob([makeTimecodeMovie()]), { num: 30, den: 1 }, true, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
