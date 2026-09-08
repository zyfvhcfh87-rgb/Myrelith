/** Pure evidence predicates; no production imports or browser mutations. */
export const MAX_TARGET_TABS = 128
export const MAX_CASE_TABS = 512
export const MAX_SESSION_EVENTS = 256
export const MAX_NATIVE_KEYS = 2048
export type Rect = { x: number; y: number; width: number; height: number }
export type Color = readonly [number, number, number, number]
export type PaintLayer = { background: string; opacity: number; image: string }

export function inside(inner: Rect, outer: Rect, tolerance = 1): boolean {
  return [inner, outer].every((r) => Object.values(r).every(Number.isFinite) && r.width > 0 && r.height > 0)
    && inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance
    && inner.x + inner.width <= outer.x + outer.width + tolerance
    && inner.y + inner.height <= outer.y + outer.height + tolerance
}
export function clippedRegion(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) }
}
export function requireTabBudget(target: number, total: number) {
  if (!Number.isInteger(target) || !Number.isInteger(total) || target < 0 || total < target || target > MAX_TARGET_TABS || total > MAX_CASE_TABS) throw new Error('Native traversal budget exceeded')
}
export function parseColor(raw: string): Color {
  if (raw === 'transparent') return [0, 0, 0, 0]
  const rgb = raw.match(/^rgba?\(([^)]+)\)$/), srgb = raw.match(/^color\(srgb ([^)]+)\)$/)
  if (!rgb && !srgb) throw new Error(`Unresolved computed color: ${raw}`)
  const values = (rgb?.[1] ?? srgb![1]).split(/[\s,/]+/).filter(Boolean)
  if (values.length !== 3 && values.length !== 4) throw new Error(`Invalid color: ${raw}`)
  const channels = values.map((value, i) => value.endsWith('%') ? Number.parseFloat(value) / 100 : Number(value) / (i < 3 && rgb ? 255 : 1))
  if (channels.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`Invalid color channels: ${raw}`)
  return [channels[0], channels[1], channels[2], channels[3] ?? 1]
}
function over(top: Color, bottom: Color): Color {
  const alpha = top[3] + bottom[3] * (1 - top[3])
  if (!alpha) return [0, 0, 0, 0]
  return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha).concat(alpha) as [number, number, number, number]
}
function opacity(color: Color, amount: number): Color { return [color[0], color[1], color[2], color[3] * amount] }
function luminance(color: Color) {
  return color.slice(0, 3).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
}
/** Leaf-to-root layers preserve nested group opacity, including label small text. */
export function contrast(foreground: string, layers: readonly PaintLayer[]) {
  let foregroundPaint = parseColor(foreground), backgroundPaint: Color = [0, 0, 0, 0]
  if (!layers.length) throw new Error('Missing background evidence')
  for (const layer of layers) {
    if (layer.image !== 'none' || !Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) throw new Error('Unsupported/invalid background or opacity')
    const background = parseColor(layer.background)
    foregroundPaint = opacity(over(foregroundPaint, background), layer.opacity)
    backgroundPaint = opacity(over(backgroundPaint, background), layer.opacity)
  }
  // The test requires an observed opaque ancestor, rather than guessing the UA canvas.
  if (backgroundPaint[3] !== 1) throw new Error('No opaque observed background')
  const a = luminance(foregroundPaint), b = luminance(backgroundPaint)
  return { ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), foregroundPaint, backgroundPaint }
}
export function healthySession(s: { error: unknown; saveError: unknown; recoveryError: unknown; phase: string; savePhase: string; recoveryPhase: string }) {
  return !s.error && !s.saveError && !s.recoveryError && ![s.phase, s.savePhase, s.recoveryPhase].includes('error')
}
export function requireSessionLedger(events: readonly { healthy: boolean }[], dropped: number, issues: readonly string[]) {
  if (!events.length || events.some((event) => !event.healthy) || dropped || issues.length) throw new Error('Incomplete or unhealthy session evidence')
}
export function requireNativeKeys(events: readonly { trusted: boolean }[], dropped: number) {
  if (!events.length || dropped || events.some((event) => !event.trusted)) throw new Error('Missing, synthetic or truncated native-key evidence')
}
