/** Pure disjoint source-frame coverage for nested sequence export checks. */
export interface SequenceFrameInterval { start: number; end: number }

/** Record visited frame coverage so overlapping/repeated instances do not repeat
 * a child's work. Gaps remain gaps; no widening to a bounding interval.
 */
export function admitSequenceFrameRange(seen: Map<string, SequenceFrameInterval[]>, id: string, input: SequenceFrameInterval): SequenceFrameInterval[] {
  const covered = seen.get(id) ?? []
  let pending = [input]
  for (const range of covered) pending = pending.flatMap((part) => {
    if (part.end <= range.start || part.start >= range.end) return [part]
    return [...(part.start < range.start ? [{ start: part.start, end: range.start }] : []),
      ...(part.end > range.end ? [{ start: range.end, end: part.end }] : [])]
  })
  if (!pending.length) return pending
  const merged: SequenceFrameInterval[] = []
  for (const range of [...covered, ...pending].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  seen.set(id, merged)
  return pending
}

