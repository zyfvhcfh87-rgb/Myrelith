// Pinned laboratory adapter: select the encoder result actually consumed by
// Transformers generation, without modifying model bytes or decoder sessions.
export function installEncoderFetchPolicy(session, policy, observe = () => {}) {
  const sameNames = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
    && new Set(actual).size === actual.length && expected.every((name) => actual.includes(name))
  if (!policy || policy.sessionKey !== 'model'
    || !sameNames(policy.inputNames, ['input_features'])
    || !sameNames(policy.expectedOutputNames, ['last_hidden_state', 'encoder_attentions.0',
      'encoder_attentions.1', 'encoder_attentions.2', 'encoder_attentions.3'])
    || !sameNames(policy.fetchNames, ['last_hidden_state'])) throw new Error('Unrecognized pinned encoder fetch policy')
  if (!session || typeof session.run !== 'function' || typeof session.release !== 'function'
    || !sameNames(session.inputNames, policy.inputNames)
    || !sameNames(session.outputNames, policy.expectedOutputNames)) throw new Error('Pinned encoder session interface changed')
  const run = session.run
  const fetchNames = Object.freeze([...policy.fetchNames])
  const omitted = policy.expectedOutputNames.filter((name) => !fetchNames.includes(name))
  let call = 0
  session.run = async function (feeds, ...rest) {
    if (this !== session || rest.length) throw new Error('Pinned encoder call contract changed')
    const features = feeds?.input_features
    if (!sameNames(Object.keys(feeds ?? {}), policy.inputNames)
      || features?.type !== 'float32' || !Array.isArray(features.dims)
      || features.dims.length !== 3 || features.dims[0] !== 1 || features.dims[1] !== 80 || features.dims[2] !== 3000) {
      throw new Error('Pinned encoder requires one complete 30-second feature matrix')
    }
    const index = ++call
    observe({ type: 'encoder-fetch-start', index, requested: [...fetchNames], omitted })
    // Public ORT run(feeds, fetches) API. Preserve receiver, feed tensors and
    // native result ownership; no wrapper tensor copies or cache-output changes.
    const result = await Reflect.apply(run, session, [feeds, fetchNames])
    if (!result || !sameNames(Object.keys(result), fetchNames)) throw new Error('Pinned encoder returned unexpected outputs')
    observe({ type: 'encoder-fetch-complete', index, returned: Object.keys(result) })
    return result
  }
}
