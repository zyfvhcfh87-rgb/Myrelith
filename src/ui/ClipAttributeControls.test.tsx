import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { attributeProject } from '../test/clipAttributeFixtures'
import { useDocumentStore } from '../state/documentStore'
import { useTransportStore } from '../state/transportStore'
import { initClipAttributeClipboard } from '../app/clipAttributeController'
import ClipAttributeControls from './ClipAttributeControls'

let release: () => void
beforeEach(() => {
  useDocumentStore.getState().setProject(attributeProject())
  useTransportStore.setState({ selectedClipIds: ['source'], selectedClipId: 'source' })
  release = initClipAttributeClipboard()
})
afterEach(() => { cleanup(); release() })

test('native dialog selects groups, applies one batch and exposes its result', () => {
  const rendered = render(<ClipAttributeControls clipId="source" />)
  expect(screen.getByRole('button', { name: 'Paste attributes…' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Copy attributes' }))
  act(() => useTransportStore.setState({ selectedClipIds: ['first', 'second'], selectedClipId: 'second' }))
  rendered.rerender(<ClipAttributeControls clipId="second" />)
  fireEvent.click(screen.getByRole('button', { name: 'Paste attributes…' }))
  const dialog = screen.getByRole('dialog', { name: 'Paste attributes' })
  expect(within(dialog).getByText(/first, second/)).toBeVisible()
  fireEvent.change(within(dialog).getByLabelText('Effect stack'), { target: { value: 'replace' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Apply paste' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('status')).toHaveTextContent('Pasted attributes on 2 clips')
  expect(useDocumentStore.getState().past).toHaveLength(1)
})

test('project replacement keeps a stale dialog from pasting and exposes a reason', () => {
  render(<ClipAttributeControls clipId="source" />)
  fireEvent.click(screen.getByRole('button', { name: 'Copy attributes' }))
  fireEvent.click(screen.getByRole('button', { name: 'Paste attributes…' }))
  act(() => useDocumentStore.getState().setProject(attributeProject()))
  fireEvent.click(screen.getByRole('button', { name: 'Apply paste' }))
  expect(screen.getByRole('alert')).toHaveTextContent('project or selection changed')
  expect(useDocumentStore.getState().past).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})
