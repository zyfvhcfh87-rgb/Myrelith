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

export function useScrubScheduler(
  commit: (value: number) => void,
): (value: number) => void {
  const latestValue = useRef(0)
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

  return useCallback((value: number) => {
    latestValue.current = value
    if (rafPending.current) return
    rafPending.current = true
    rafId.current = requestAnimationFrame(() => {
      rafPending.current = false
      commitRef.current(latestValue.current)
    })
  }, [])
}
