import { act } from '@testing-library/react'
import type { TimelineDoc } from '../domain/schema'
import { useDocumentStore } from '../state/documentStore'
import type { MediaState } from '../state/mediaStore'
import { useMediaStore } from '../state/mediaStore'
import {
  INITIAL_TRANSPORT_STATE,
  type TransportState,
  useTransportStore,
} from '../state/transportStore'

type TransportSnapshot = Pick<
  TransportState,
  keyof typeof INITIAL_TRANSPORT_STATE
>

type MediaSnapshot = Pick<
  MediaState,
  'descriptors' | 'assets' | 'visuals' | 'compatibility'
>

/** Restore every ephemeral transport field, including newly added fields. */
export function resetTransportStoreForTest(
  overrides: Partial<TransportSnapshot> = {},
): void {
  act(() => {
    useTransportStore.setState({
      ...INITIAL_TRANSPORT_STATE,
      ...overrides,
    })
  })
}

/** Install a document without carrying history between tests. */
export function resetDocumentStoreForTest(document: TimelineDoc): void {
  act(() => {
    useDocumentStore.getState().setDoc(document)
  })
}

/** Restore all media maps with fresh identities, optionally seeding a fixture. */
export function resetMediaStoreForTest(
  overrides: Partial<MediaSnapshot> = {},
): void {
  act(() => {
    useMediaStore.setState({
      descriptors: new Map(),
      assets: new Map(),
      visuals: new Map(),
      compatibility: new Map(),
      ...overrides,
    })
  })
}
