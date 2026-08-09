import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowDown,
  ArrowUp,
  FolderSimple,
  FolderSimplePlus,
  PencilSimple,
  Trash,
} from '@phosphor-icons/react'
import { useMediaStore } from '../state/mediaStore'
import { ASSET_DRAG_TYPE } from './dnd'

interface MediaCollectionsPanelProps {
  readonly selectedCollectionId: string | null
  readonly onSelectCollection: (id: string | null) => void
}

function dragCarriesMedia(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(ASSET_DRAG_TYPE)
}

export default function MediaCollectionsPanel({
  selectedCollectionId,
  onSelectCollection,
}: MediaCollectionsPanelProps) {
  const collections = useMediaStore((state) => state.collections)
  const assetCount = useMediaStore((state) => state.descriptors.size)
  const canUndo = useMediaStore((state) => state.collectionPast.length > 0)
  const canRedo = useMediaStore((state) => state.collectionFuture.length > 0)
  const createCollection = useMediaStore((state) => state.createCollection)
  const renameCollection = useMediaStore((state) => state.renameCollection)
  const reorderCollection = useMediaStore((state) => state.reorderCollection)
  const deleteCollection = useMediaStore((state) => state.deleteCollection)
  const setMembership = useMediaStore((state) => state.setCollectionMembership)
  const undo = useMediaStore((state) => state.undoCollectionEdit)
  const redo = useMediaStore((state) => state.redoCollectionEdit)
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState('')
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const createInputRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const selectedCollection = collections.find(
    (collection) => collection.id === selectedCollectionId,
  ) ?? null
  const selectedIndex = selectedCollection
    ? collections.findIndex((collection) => collection.id === selectedCollection.id)
    : -1

  useEffect(() => {
    if (creating) createInputRef.current?.focus()
  }, [creating])

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus()
  }, [renaming])

  const submitCreate = (event: FormEvent): void => {
    event.preventDefault()
    const id = createCollection(createDraft)
    if (!id) {
      setMessage('Use a unique collection name between 1 and 120 characters.')
      return
    }
    setCreating(false)
    setCreateDraft('')
    setMessage(`Created ${useMediaStore.getState().collections.at(-1)?.name ?? 'collection'}.`)
    onSelectCollection(id)
  }

  const submitRename = (event: FormEvent): void => {
    event.preventDefault()
    if (!selectedCollection) return
    if (!renameCollection(selectedCollection.id, renameDraft)) {
      setMessage('Use a unique collection name between 1 and 120 characters.')
      return
    }
    setRenaming(false)
    setMessage(`Renamed collection to ${renameDraft.trim()}.`)
  }

  const handleDrop = (
    event: DragEvent<HTMLButtonElement>,
    collectionId: string,
  ): void => {
    if (!dragCarriesMedia(event)) return
    event.preventDefault()
    setDropTargetId(null)
    const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE)
    const collection = collections.find((candidate) => candidate.id === collectionId)
    const descriptor = useMediaStore.getState().descriptors.get(assetId)
    if (!collection || !descriptor) return
    if (setMembership(collectionId, assetId, true)) {
      setMessage(`Added ${descriptor.fileName} to ${collection.name}.`)
    } else {
      setMessage(`${descriptor.fileName} is already in ${collection.name}.`)
    }
  }

  const handleTabKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const tabs = [...(tabsRef.current?.querySelectorAll<HTMLButtonElement>(
      '[role="tab"]',
    ) ?? [])]
    const current = tabs.indexOf(event.target as HTMLButtonElement)
    if (current < 0) return
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = current + 1
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = current - 1
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = tabs.length - 1
    if (next === null) return
    event.preventDefault()
    const bounded = (next + tabs.length) % tabs.length
    tabs[bounded]?.focus()
    tabs[bounded]?.click()
  }

  return (
    <section className="media-collections" aria-labelledby="media-collections-title">
      <div className="media-collections-heading">
        <span id="media-collections-title">Collections</span>
        <div className="media-collection-history" aria-label="Collection history">
          <button
            type="button"
            aria-label="Undo collection change"
            aria-keyshortcuts="Control+Z Meta+Z"
            disabled={!canUndo}
            onClick={() => {
              if (undo()) setMessage('Undid collection change.')
            }}
          >
            <ArrowCounterClockwise aria-hidden="true" size={13} />
          </button>
          <button
            type="button"
            aria-label="Redo collection change"
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y"
            disabled={!canRedo}
            onClick={() => {
              if (redo()) setMessage('Redid collection change.')
            }}
          >
            <ArrowClockwise aria-hidden="true" size={13} />
          </button>
          <button
            type="button"
            aria-label="New collection"
            onClick={() => {
              setCreating(true)
              setRenaming(false)
              setMessage('')
            }}
          >
            <FolderSimplePlus aria-hidden="true" size={13} />
          </button>
        </div>
      </div>

      {creating ? (
        <form className="media-collection-form" aria-label="Create collection" onSubmit={submitCreate}>
          <input
            ref={createInputRef}
            aria-label="Collection name"
            maxLength={120}
            value={createDraft}
            onChange={(event) => setCreateDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setCreating(false)
                setCreateDraft('')
              }
            }}
          />
          <button type="submit">Create</button>
          <button
            type="button"
            onClick={() => {
              setCreating(false)
              setCreateDraft('')
            }}
          >
            Cancel
          </button>
        </form>
      ) : null}

      <div
        ref={tabsRef}
        className="media-collection-tabs"
        role="tablist"
        aria-label="Media collections"
        onKeyDown={handleTabKeys}
      >
        <button
          type="button"
          role="tab"
          aria-label="All media"
          aria-selected={selectedCollectionId === null}
          aria-controls="media-pool-list"
          tabIndex={selectedCollectionId === null ? 0 : -1}
          onClick={() => onSelectCollection(null)}
        >
          <FolderSimple aria-hidden="true" size={13} />
          <span>All media</span>
          <span className="media-collection-count">{assetCount}</span>
        </button>
        {collections.map((collection) => (
          <button
            key={collection.id}
            type="button"
            role="tab"
            aria-selected={selectedCollectionId === collection.id}
            aria-controls="media-pool-list"
            aria-label={`${collection.name}, ${collection.assetIds.length} ${collection.assetIds.length === 1 ? 'asset' : 'assets'}`}
            tabIndex={selectedCollectionId === collection.id ? 0 : -1}
            data-drop-target={dropTargetId === collection.id || undefined}
            title="Select this collection, or drop a media card here"
            onClick={() => onSelectCollection(collection.id)}
            onDragEnter={(event) => {
              if (!dragCarriesMedia(event)) return
              event.preventDefault()
              setDropTargetId(collection.id)
            }}
            onDragOver={(event) => {
              if (!dragCarriesMedia(event)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDropTargetId(null)
              }
            }}
            onDrop={(event) => handleDrop(event, collection.id)}
          >
            <FolderSimple aria-hidden="true" size={13} />
            <span>{collection.name}</span>
            <span className="media-collection-count">{collection.assetIds.length}</span>
          </button>
        ))}
      </div>

      {selectedCollection ? (
        <div className="media-collection-manage" aria-label={`Manage ${selectedCollection.name}`}>
          {renaming ? (
            <form className="media-collection-form" aria-label="Rename collection" onSubmit={submitRename}>
              <input
                ref={renameInputRef}
                aria-label="New collection name"
                maxLength={120}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setRenaming(false)
                    setRenameDraft(selectedCollection.name)
                  }
                }}
              />
              <button type="submit">Save</button>
              <button type="button" onClick={() => setRenaming(false)}>Cancel</button>
            </form>
          ) : (
            <>
              <span>{selectedCollection.assetIds.length} {selectedCollection.assetIds.length === 1 ? 'asset' : 'assets'}</span>
              <button
                type="button"
                aria-label={`Rename ${selectedCollection.name}`}
                onClick={() => {
                  setRenameDraft(selectedCollection.name)
                  setRenaming(true)
                  setCreating(false)
                }}
              >
                <PencilSimple aria-hidden="true" size={13} />
              </button>
              <button
                type="button"
                aria-label={`Move ${selectedCollection.name} earlier`}
                disabled={selectedIndex <= 0}
                onClick={() => reorderCollection(selectedCollection.id, selectedIndex - 1)}
              >
                <ArrowUp aria-hidden="true" size={13} />
              </button>
              <button
                type="button"
                aria-label={`Move ${selectedCollection.name} later`}
                disabled={selectedIndex < 0 || selectedIndex >= collections.length - 1}
                onClick={() => reorderCollection(selectedCollection.id, selectedIndex + 1)}
              >
                <ArrowDown aria-hidden="true" size={13} />
              </button>
              <button
                type="button"
                aria-label={`Delete ${selectedCollection.name}`}
                title="Delete this collection; its media stays in the project"
                onClick={() => {
                  const name = selectedCollection.name
                  if (!deleteCollection(selectedCollection.id)) return
                  onSelectCollection(null)
                  setRenaming(false)
                  setMessage(`Deleted ${name}. Its media stays in the project.`)
                }}
              >
                <Trash aria-hidden="true" size={13} />
              </button>
            </>
          )}
        </div>
      ) : null}

      <span className="media-collection-status" aria-live="polite">
        {message}
      </span>
    </section>
  )
}

export function MediaCollectionMembership({
  assetId,
  fileName,
}: {
  readonly assetId: string
  readonly fileName: string
}) {
  const panelId = useId()
  const collections = useMediaStore((state) => state.collections)
  const setMembership = useMediaStore((state) => state.setCollectionMembership)
  const [open, setOpen] = useState(false)
  const membershipCount = collections.reduce(
    (count, collection) => count + Number(collection.assetIds.includes(assetId)),
    0,
  )

  useEffect(() => {
    if (collections.length === 0) setOpen(false)
  }, [collections.length])

  return (
    <div className="media-membership">
      <button
        type="button"
        aria-label={`Organize ${fileName} in collections`}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={collections.length === 0}
        title={collections.length === 0
          ? 'Create a collection first'
          : 'Add or remove this asset from collections'}
        onClick={() => setOpen((current) => !current)}
      >
        <FolderSimple aria-hidden="true" size={12} />
        {membershipCount > 0 ? `${membershipCount}` : 'Organize'}
      </button>
      {open ? (
        <div id={panelId} className="media-membership-options" role="group" aria-label={`${fileName} collections`}>
          {collections.map((collection) => (
            <label key={collection.id}>
              <input
                type="checkbox"
                checked={collection.assetIds.includes(assetId)}
                onChange={(event) => setMembership(
                  collection.id,
                  assetId,
                  event.target.checked,
                )}
              />
              <span>{collection.name}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  )
}
