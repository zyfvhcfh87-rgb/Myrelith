import { describe, expect, test, vi } from 'vitest'
import { useDocumentStore } from '../state/documentStore'
import { watchProjectScope } from './captionProjectScope'

describe('caption project scope', () => {
  test('fires for project, generation and sequence changes but not ordinary edits', () => {
    const onChange = vi.fn()
    const stop = watchProjectScope(onChange)
    const initial = useDocumentStore.getState()

    useDocumentStore.setState({ past: [] })
    expect(onChange).not.toHaveBeenCalled()
    useDocumentStore.setState({ projectGeneration: initial.projectGeneration + 1 })
    useDocumentStore.setState({ activeSequenceId: 'other-sequence' })
    useDocumentStore.setState({ project: { ...initial.project } })
    expect(onChange).toHaveBeenCalledTimes(3)

    stop()
    useDocumentStore.setState(initial, true)
    expect(onChange).toHaveBeenCalledTimes(3)
  })
})
