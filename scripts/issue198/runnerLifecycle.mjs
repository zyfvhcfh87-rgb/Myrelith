export async function bounded(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

/** A stalled owner must not prevent later owners or the evidence store from closing. */
export async function closeOwnedResources(owners, { closeMs = 10_000, forceMs = 10_000 } = {}) {
  const cleanup = []
  let failure
  for (const { name, close, force } of owners) {
    try {
      await bounded(Promise.resolve().then(close), closeMs, `${name} close`)
      cleanup.push({ name, status: 'closed' })
    } catch (cause) {
      failure ??= cause
      cleanup.push({ name, status: 'failed', error: cause.message })
      if (force) {
        try {
          await bounded(Promise.resolve().then(force), forceMs, `${name} force close`)
          cleanup.push({ name, action: 'force', status: 'closed' })
        } catch (forcedCause) {
          cleanup.push({ name, action: 'force', status: 'failed', error: forcedCause.message })
        }
      }
    }
  }
  return { cleanup, failure }
}

/** The operation finishes durable teardown first; failed owners may still hold Node handles. */
export async function runCommand(operation) {
  try { await operation() }
  catch (cause) {
    await bounded(new Promise((accept) => process.stderr.write(`${cause?.stack ?? cause}\n`, accept)), 1000, 'Failure output').catch(() => {})
    process.exit(1)
  }
}
