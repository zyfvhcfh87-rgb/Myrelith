import { describe, expect, test } from 'vitest'
import { defaultClipTransform, defaultClipVisualSettings } from './clipInspector'
import { utf8ByteLength } from './documentMemory'
import { defaultTextProps } from './textOverlay'
import { readTitleDefinition, TITLE_LIMITS, type TitleDefinitionV1, type TitleTextElementV1 } from './titleElements'
import { retainedTitleDataBudget, titlePayloadBudget, TITLE_BUDGET_LIMITS, type TitleBudgetOwner, type TitleDataRetention } from './titleBudgets'

function element(): TitleTextElementV1 {
  const { fontFamily, ...text } = defaultTextProps(1920, 1080, 'Hello 世界 😀\n')
  return {
    id: 'text-1', version: 1, kind: 'text', name: 'Text', enabled: false,
    transform: defaultClipTransform(), visual: defaultClipVisualSettings(), opacity: 1,
    text, font: { family: fontFamily, fallbackFamily: null },
  }
}
function title(): TitleDefinitionV1 { return { version: 1, elements: [element()] } }
function key(frame: number) {
  return { frame, value: frame + 0.125, sourceTimeTicks: frame * 1_000_000, easing: { type: 'linear' } }
}
function track(keys = 1) {
  return { elementId: 'text-1', propertyVersion: 1, property: 'position-x', keyframes: Array.from({ length: keys }, (_, index) => key(index)) }
}
function bytes(value: unknown): number { return utf8ByteLength(JSON.stringify(value)) }
function retained(overrides: Partial<TitleDataRetention> = {}): TitleDataRetention {
  return { candidate: [], current: [], past: [], future: [], clipboards: { titles: [], elements: [], keys: [] }, ...overrides }
}

/** Exact measured JSON fixture, not an assumed migration/serializer allowance. */
function opaqueTitleWithBytes(size: number) {
  const count = Math.ceil(size / 20_000)
  const payload: string[] = []
  const emptyBytes = bytes({ version: 2, payload })
  let characters = size - emptyBytes - (3 * count - 1)
  for (let index = 0; index < count; index++) {
    const length = Math.min(20_000, characters)
    payload.push('a'.repeat(length))
    characters -= length
  }
  const result = { version: 2, payload }
  expect(bytes(result)).toBe(size)
  return result
}

describe('expanded title payload admission', () => {
  test('counts full UTF-8 title and track data and omits unused collection overhead', () => {
    const owner = { title: title(), titleTracks: [track(2)] }
    expect(titlePayloadBudget(owner)).toEqual({ ok: true, usage: {
      serializedUtf8Bytes: bytes(owner.title) + bytes(owner.titleTracks), tracks: 1, keyframes: 2,
    } })
    expect(titlePayloadBudget({ title: owner.title })).toEqual(titlePayloadBudget({ title: owner.title, titleTracks: [] }))
    expect(titlePayloadBudget({ title: owner.title })).toEqual({ ok: true, usage: {
      serializedUtf8Bytes: bytes(owner.title), tracks: 0, keyframes: 0,
    } })
  })

  test('admits an ordinary 1,024-key track without the opaque-title entry cap', () => {
    const owner = { title: title(), titleTracks: [track(1024)] }
    expect(titlePayloadBudget(owner)).toMatchObject({ ok: true, usage: { tracks: 1, keyframes: 1024 } })
    expect(titlePayloadBudget({ ...owner, titleTracks: [track(1025)] })).toMatchObject({ ok: false, reason: expect.stringContaining('1,024') })
  })

  test('bounds track count and includes future and dangling targets without interpreting them', () => {
    const tracks = Array.from({ length: 256 }, (_, index) => ({
      ...track(), elementId: `unavailable-${index}`, propertyVersion: 99, property: 'future-property', extra: { value: 1e200 },
    }))
    const owner = { title: title(), titleTracks: tracks }
    expect(titlePayloadBudget(owner)).toMatchObject({ ok: true, usage: { tracks: 256, keyframes: 256 } })
    expect(titlePayloadBudget({ ...owner, titleTracks: [...tracks, track()] })).toMatchObject({ ok: false, reason: expect.stringContaining('256') })
    expect(bytes(tracks)).toBeGreaterThan(bytes(tracks.map(({ extra: _extra, ...rest }) => rest)))
  })

  test('admits exact 1 MiB and rejects one byte over, including track bytes in the same cap', () => {
    const exact = opaqueTitleWithBytes(TITLE_LIMITS.serializedBytes)
    expect(readTitleDefinition(exact).status).toBe('unsupported')
    expect(titlePayloadBudget({ title: exact })).toMatchObject({ ok: true, usage: { serializedUtf8Bytes: TITLE_LIMITS.serializedBytes } })
    expect(titlePayloadBudget({ title: opaqueTitleWithBytes(TITLE_LIMITS.serializedBytes + 1) })).toMatchObject({ ok: false, reason: expect.stringContaining('1 MiB') })
    const titleTracks = [track()]
    const available = TITLE_LIMITS.serializedBytes - bytes(titleTracks)
    expect(titlePayloadBudget({ title: opaqueTitleWithBytes(available), titleTracks })).toMatchObject({ ok: true, usage: { serializedUtf8Bytes: TITLE_LIMITS.serializedBytes } })
    expect(titlePayloadBudget({ title: opaqueTitleWithBytes(available + 1), titleTracks }).ok).toBe(false)
  })

  test('accounts for escaped, multibyte and lone surrogate strings by actual JSON UTF-8', () => {
    for (const content of ['\u0000'.repeat(20_000), '界'.repeat(20_000), '😀'.repeat(10_000), '\ud800'.repeat(20_000)]) {
      const definition = { version: 2, payload: [content] }
      expect(titlePayloadBudget({ title: definition })).toMatchObject({ ok: true, usage: { serializedUtf8Bytes: bytes(definition) } })
    }
    expect(titlePayloadBudget({ title: { version: 2, payload: Array(9).fill('\u0000'.repeat(20_000)) } }).ok).toBe(false)
  })

  test('rejects malformed JSON without running getter or toJSON code', () => {
    let called = false
    const accessor = Object.defineProperty({ version: 2 }, 'payload', { enumerable: true, get() { called = true; throw new Error('Do not invoke') } })
    const serializer = { version: 2, toJSON() { called = true; throw new Error('Do not invoke') } }
    const cycle: { version: number; payload?: unknown } = { version: 2 }
    cycle.payload = cycle
    const sparse = [1, 2]
    delete sparse[0]
    for (const definition of [accessor, serializer, cycle, { version: 2, payload: sparse },
      { version: 2, payload: NaN }, { version: 2, payload: new Date() },
      { version: 2, payload: undefined }, { version: 2, [Symbol('x')]: 1 },
      Object.defineProperty({ version: 2 }, 'hidden', { value: 1 }),
      { version: 2, payload: Object.assign([1], { extra: 2 }) },
      JSON.parse('{"version":2,"constructor":1}'),
    ]) expect(titlePayloadBudget({ title: definition }).ok).toBe(false)
    expect(called).toBe(false)
  })

  test('checks declared track/key counts before scanning payload and bounds future nesting', () => {
    let called = false
    const excessive = Object.defineProperty({ keyframes: Array(1025).fill(null) }, 'payload', {
      enumerable: true, get() { called = true; throw new Error('Do not invoke') },
    })
    expect(titlePayloadBudget({ title: title(), titleTracks: [excessive] })).toMatchObject({ ok: false, reason: expect.stringContaining('1,024') })
    expect(called).toBe(false)
    let nested: unknown = 1
    for (let index = 0; index < 7; index++) nested = { next: nested }
    expect(titlePayloadBudget({ title: { version: 2, nested } }).ok).toBe(true)
    expect(titlePayloadBudget({ title: { version: 2, nested: { next: nested } } })).toMatchObject({ ok: false, reason: expect.stringContaining('eight nested') })
  })
})

describe('immutable expanded-title retention', () => {
  test('charges shared title/track roots only once across all owners and clipboard paths', () => {
    const definition = title()
    const titleTracks = [track(2)]
    const owner = { title: definition, titleTracks }
    const input = retained({
      candidate: [owner], current: [{ ...owner }], past: [[owner]], future: [[{ ...owner }]],
      clipboards: { titles: [{ ...owner }], elements: definition.elements, keys: titleTracks[0].keyframes },
    })
    expect(retainedTitleDataBudget(input)).toEqual({ ok: true, retainedBytes: 2 * (bytes(definition) + bytes(titleTracks)) })
  })

  test('deduplicates nested immutable records and charges distinct equal copies separately', () => {
    const shared = element()
    const first: TitleDefinitionV1 = { version: 1, elements: [shared] }
    const second: TitleDefinitionV1 = { version: 1, elements: [shared] }
    const result = retainedTitleDataBudget(retained({ candidate: [{ title: first }], current: [{ title: second }] }))
    expect(result).toEqual({ ok: true, retainedBytes: 2 * (bytes(first) + bytes(second) - bytes(shared)) })
    const copied = JSON.parse(JSON.stringify(second))
    expect(retainedTitleDataBudget(retained({ candidate: [{ title: first }], current: [{ title: copied }] }))).toEqual({
      ok: true, retainedBytes: 2 * (bytes(first) + bytes(copied)),
    })
  })

  test('charges a new element shell while retaining shared authored content/style by reference', () => {
    const original = element()
    const changed = { ...original, opacity: 0.5 }
    const input = retained({ clipboards: { titles: [], elements: [original, changed], keys: [] } })
    const sharedBytes = bytes(original.transform) + bytes(original.visual) + bytes(original.text) + bytes(original.font)
    expect(retainedTitleDataBudget(input)).toEqual({ ok: true, retainedBytes: 2 * (bytes(original) + bytes(changed) - sharedBytes) })
  })

  test('has no compact-legacy payload cost and does not apply history bytes to legacy-only edits', () => {
    // These are the projections of any number/size of valid compact legacy text
    // clips across all sequences. The schema23 traversal must prove that omission.
    const empty: readonly TitleBudgetOwner[] = []
    expect(retainedTitleDataBudget(retained({ candidate: empty, current: empty, past: Array(100).fill(empty), future: Array(100).fill(empty) }))).toEqual({ ok: true, retainedBytes: 0 })
    expect(retainedTitleDataBudget(retained({ past: Array(101).fill(empty), future: Array(100).fill(empty) })).ok).toBe(false)
    expect(retainedTitleDataBudget(retained({ past: Array(100).fill(empty), future: Array(101).fill(empty) })).ok).toBe(false)
  })

  test('scans a shared 20k-character subtree once per invocation for both one and 200 distinct wrappers', () => {
    let scans = 0
    const payloadData = Object.freeze({ content: 'x'.repeat(20_000) })
    // Instrument reads only; the target and all authored values are real immutable data.
    const payload = new Proxy(payloadData, { ownKeys(target) { scans++; return Reflect.ownKeys(target) } })
    const owners = Array.from({ length: 200 }, () => ({ title: { version: 2, payload } }))
    expect(retainedTitleDataBudget(retained({ candidate: owners.slice(0, 1) })).ok).toBe(true)
    expect(scans).toBe(1)
    scans = 0
    const result = retainedTitleDataBudget(retained({ current: owners.slice(0, 100), past: [owners.slice(100)] }))
    expect(scans).toBe(1)
    const payloadBytes = bytes(payloadData)
    const wrapperBytes = bytes({ version: 2, payload: payloadData }) - payloadBytes
    expect(result).toEqual({ ok: true, retainedBytes: 2 * (payloadBytes + 200 * wrapperBytes) })
  })

  test('retains per-owner byte and per-root entry multiplicity when cached nested data is shared', () => {
    const shared = { content: 'a'.repeat(20_000) }
    const exact = { version: 2, parts: Array(50).fill(shared) }
    expect(titlePayloadBudget({ title: exact })).toMatchObject({ ok: true, usage: { serializedUtf8Bytes: bytes(exact) } })
    expect(retainedTitleDataBudget(retained({ candidate: [{ title: exact }] }))).toEqual({
      ok: true, retainedBytes: 2 * (bytes(exact) - 49 * bytes(shared)),
    })
    const over = { version: 2, parts: Array(53).fill(shared) }
    expect(bytes(over)).toBeGreaterThan(TITLE_LIMITS.serializedBytes)
    expect(retainedTitleDataBudget(retained({ current: [{ title: { version: 2, shared } }], past: [[{ title: over }]] }))).toMatchObject({ ok: false, reason: expect.stringContaining('1 MiB') })
    const entries = Array(100_000).fill(0)
    const tooMany = { version: 2, parts: Array(6).fill(entries) }
    expect(titlePayloadBudget({ title: tooMany })).toMatchObject({ ok: false, reason: expect.stringContaining('too many entries') })
  })

  test('rechecks cached subtree height at deeper owners and still rejects cycles after cache hits', () => {
    const payload = { content: 'shared' }
    const owner = { title: { version: 2, payload } }
    const wrap = (levels: number): unknown => {
      let nested: unknown = payload
      for (let index = 0; index < levels; index++) nested = { next: nested }
      return nested
    }
    expect(retainedTitleDataBudget(retained({ candidate: [owner], current: [{ title: { version: 2, payload: wrap(6) } }] })).ok).toBe(true)
    expect(retainedTitleDataBudget(retained({ candidate: [owner], current: [{ title: { version: 2, payload: wrap(7) } }] }))).toMatchObject({ ok: false, reason: expect.stringContaining('eight nested') })
    const cycle: { version: number; payload: typeof payload; self?: unknown } = { version: 2, payload }
    cycle.self = cycle
    expect(retainedTitleDataBudget(retained({ candidate: [owner], current: [{ title: cycle }] }))).toMatchObject({ ok: false, reason: expect.stringContaining('cycles') })
  })

  test('admits exact 64 MiB across current/history/clipboard and rejects the next two bytes before redo clearing', () => {
    const full = opaqueTitleWithBytes(TITLE_LIMITS.serializedBytes)
    const owners = Array.from({ length: 32 }, () => ({ title: { ...full, payload: [...full.payload] } }))
    const input = retained({
      candidate: owners.slice(0, 8), current: owners.slice(8, 16), past: [owners.slice(16, 24)],
      future: [owners.slice(24, 28)], clipboards: { titles: owners.slice(28), elements: [], keys: [] },
    })
    expect(retainedTitleDataBudget(input)).toEqual({ ok: true, retainedBytes: TITLE_BUDGET_LIMITS.retainedBytes })
    const smallest = { version: 2 }
    const more = opaqueTitleWithBytes(TITLE_LIMITS.serializedBytes - bytes(smallest) + 1)
    const over = retained({ ...input, candidate: [{ title: more }, ...input.candidate.slice(1), { title: smallest }] })
    expect(retainedTitleDataBudget(over)).toMatchObject({ ok: false, reason: expect.stringContaining('64 MiB') })
    expect(retainedTitleDataBudget({ ...over, future: [] }).ok).toBe(true)
    expect(input.future[0]).toHaveLength(4)
    expect(input.clipboards.titles).toHaveLength(4)
  })

  test('counts independent element/key clipboard and future intent, with no cache surviving calls', () => {
    const copiedElement = element()
    const copiedKey = { ...key(42), target: { elementId: 'missing', propertyVersion: 99, property: 'future' }, unknown: { payload: 'preserved' } }
    const input = retained({ clipboards: { titles: [], elements: [copiedElement], keys: [copiedKey] } })
    expect(retainedTitleDataBudget(input)).toEqual({ ok: true, retainedBytes: 2 * (bytes(copiedElement) + bytes(copiedKey)) })
    expect(retainedTitleDataBudget(retained())).toEqual({ ok: true, retainedBytes: 0 })
    expect(retainedTitleDataBudget(input)).toEqual({ ok: true, retainedBytes: 2 * (bytes(copiedElement) + bytes(copiedKey)) })
    expect(retainedTitleDataBudget(retained({ clipboards: { titles: [], elements: [], keys: [{ value: 'a'.repeat(20_001) }] } })).ok).toBe(false)
  })
})
