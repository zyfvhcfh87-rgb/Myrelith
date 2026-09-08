// Proposed laboratory-only diagnostic seam. No runtime is created by import.
// It must be separately wired, pinned and granted before any native execution.
export const DIAGNOSTIC_LIMITS = Object.freeze({ records: 64, characters: 32768, perRecordCharacters: 2048 })

export function observeModuleFactory(createModule) {
  let phase = 'not-started', characters = 0, omittedRecords = 0, truncatedRecords = 0, invoked = false
  const records = []
  function record(kind, value) {
    // Never stringify arbitrary runtime objects or retain errors/heap views.
    const raw = typeof value === 'string' ? value : value === undefined ? '(undefined)' : '(non-string diagnostic)'
    const text = raw.slice(0, DIAGNOSTIC_LIMITS.perRecordCharacters)
    const truncated = text.length < raw.length
    if (truncated) truncatedRecords++
    const row = { kind, phase, text, truncated }
    while (records.length >= DIAGNOSTIC_LIMITS.records || characters + text.length > DIAGNOSTIC_LIMITS.characters) {
      characters -= records.shift().text.length; omittedRecords++
    }
    records.push(row); characters += text.length
  }
  const errorDetail = error => typeof error?.stack === 'string' ? error.stack : typeof error?.message === 'string' ? error.message : undefined
  const snapshot = () => ({ phase, invoked, characters, omittedRecords, truncatedRecords,
    limits: DIAGNOSTIC_LIMITS, records: records.map(row => ({ ...row })) })
  async function observed(options) {
    if (invoked) throw new Error('Diagnostic factory is single use')
    invoked = true; phase = 'factory'; record('enter', phase)
    let module
    try {
      module = await createModule({ ...options,
        printErr: value => { record('stderr', value); options.printErr?.(value) },
        onAbort: value => {
          record('abort', value)
          record('abort-stack', new Error('Native abort callback').stack)
          options.onAbort?.(value)
        },
      })
      record('return', phase)
    } catch (error) { record('exception', errorDetail(error)); throw error }
    // Generated exports are ordinary writable own properties. Keep the original
    // module object and live heap getters; add no allocation or native calls.
    for (const name of ['_speech_model_alloc', '_speech_load', '_speech_close']) {
      const descriptor = Object.getOwnPropertyDescriptor(module, name)
      if (!descriptor?.writable || typeof descriptor.value !== 'function') throw new Error('Unexpected diagnostic export shape: ' + name)
    }
    for (const name of ['_speech_model_alloc', '_speech_load', '_speech_close']) {
      const original = module[name]
      module[name] = function (...args) {
        phase = name; record('enter', name)
        try {
          const result = Reflect.apply(original, this, args)
          record('return', typeof result === 'number' ? String(result) : '(non-numeric result)')
          return result
        } catch (error) { record('exception', errorDetail(error)); throw error }
      }
    }
    phase = 'factory-returned'
    return module
  }
  return { createModule: observed, snapshot }
}
