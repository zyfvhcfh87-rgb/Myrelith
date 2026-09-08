import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { beginAnimationKeyDrag, animationCommandResult } from '../../app/animationWorkspaceController'
import { animationKeyKey, type AnimationLaneIndex, type AnimationLaneRow } from '../../state/animationEditor'
import { useTransportStore } from '../../state/transportStore'

export function useAnimationPointer(index: AnimationLaneIndex, zoom: number, select: (row: AnimationLaneRow, offset: number, extend: boolean, toggle: boolean) => void) {
  const session = useRef<{ pointer: number; startX: number; moved: boolean; target: SVGElement; drag: ReturnType<typeof beginAnimationKeyDrag> } | null>(null)
  const [capturedGlyph, setCapturedGlyph] = useState<{ rowId: string; offset: number } | null>(null)
  const cancel = () => session.current?.drag.cancel()
  useEffect(() => () => { session.current?.drag.cancel() }, [index, zoom])
  return {
    capturedGlyph,
    cancel,
    down(event: ReactPointerEvent<SVGElement>, row: AnimationLaneRow, offset: number, glyphOffset: number) {
      if (event.button !== 0 || row.owner.track.locked) return
      event.preventDefault(); event.stopPropagation(); cancel()
      const key = { lane: row.address, frame: row.frames[offset] }, state = useTransportStore.getState()
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey && state.animationSelection.some((item) => animationKeyKey(item) === animationKeyKey(key))) state.setAnimationSelection(state.animationSelection, key)
      else select(row, offset, event.shiftKey, event.ctrlKey || event.metaKey)
      if (!useTransportStore.getState().animationSelection.some((item) => animationKeyKey(item) === animationKeyKey(key))) return
      if (!useTransportStore.getState().animationSelection.length) return
      const target = event.currentTarget, pointer = event.pointerId
      try {
        const drag = beginAnimationKeyDrag(index, () => {
          session.current = null
          setCapturedGlyph(null)
          if (target.hasPointerCapture?.(pointer)) target.releasePointerCapture(pointer)
        })
        session.current = { pointer, startX: event.clientX, moved: false, target, drag }
        setCapturedGlyph({ rowId: row.id, offset: glyphOffset })
        target.setPointerCapture?.(pointer)
      } catch (error) { animationCommandResult(error instanceof Error ? error.message : 'Cannot move these keys.', '') }
    },
    move(event: ReactPointerEvent<SVGElement>) {
      const current = session.current
      if (current?.pointer === event.pointerId) {
        current.moved ||= Math.abs(event.clientX - current.startX) >= 3
        if (current.moved) current.drag.preview(Math.round((event.clientX - current.startX) / zoom), event.altKey)
      }
    },
    up(event: ReactPointerEvent<SVGElement>) {
      const current = session.current
      if (current?.pointer !== event.pointerId) return
      event.stopPropagation()
      if (!current.moved) { current.drag.cancel(); return }
      animationCommandResult(current.drag.commit(Math.round((event.clientX - current.startX) / zoom), event.altKey), 'Selected keys moved.')
    },
  }
}
