export function bounded(label, milliseconds, action) {
  let timer
  return Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: deadline ${milliseconds}ms`)), milliseconds) })]).finally(() => clearTimeout(timer))
}
/** Each cleanup must run even if an earlier one stalls. */
export async function cleanupInOrder(steps, milliseconds, report) {
  for (const [name, action] of steps) try { await bounded(name, milliseconds, action) } catch (error) { report[name] = String(error) }
}
/** Runs in the independent supervisor process, outside the browser driver's event loop. */
export async function superviseChild(child, milliseconds, onExpired) {
  let timer, expiredStarted = false
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { if (!expiredStarted) resolve({ code, signal, expired: false }) }) })
  const expired = new Promise((resolve, reject) => { timer = setTimeout(() => { expiredStarted = true; Promise.resolve().then(onExpired).then(() => resolve({ code: null, signal: null, expired: true }), reject) }, milliseconds) })
  try { return await Promise.race([closed, expired]) } finally { clearTimeout(timer) }
}
