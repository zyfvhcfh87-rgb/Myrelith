/**
 * ui/timeline/useScrubScheduler.ts — rAF coalescing for scrub/drag input.
 * Phase 3.2 (the plan's useScrubScheduler pattern; reused by ClipView in 3.3).
 *
 * Pointer events fire far faster than the display refreshes. Writing to a
 * store on every pointermove floods every subscriber with dead updates, so:
 * remember only the LATEST value and commit it once per animation frame.
 * The returned scheduler is referentially stable across renders.
 */

import { useCallback, useEffect, useRef } from 'react'

export function useScrubScheduler<Value = number>(
  commit: (value: Value) => void,
): (value: Value) => void {
  const latestValue = useRef<{ value: Value } | null>(null)
  const rafPending = useRef(false)
  const rafId = useRef(0)
  const commitRef = useRef(commit)
  commitRef.current = commit

  // Never fire a stale commit after unmount.
  useEffect(
    () => () => {
      if (rafPending.current) cancelAnimationFrame(rafId.current)
    },
    [],
  )

  return useCallback((value: Value) => {
    latestValue.current = { value }
    if (rafPending.current) return
    rafPending.current = true
    rafId.current = requestAnimationFrame(() => {
      rafPending.current = false
      const latest = latestValue.current
      if (latest !== null) commitRef.current(latest.value)
    })
  }, [])
}
