/**
 * Synchronous OS-file drag boundary.
 *
 * During dragover the drag data store is protected: callers may read item
 * kinds/types, but File payloads exist only in the drop handler. MIME is a
 * hint, never compatibility evidence. This module copies ordinary File
 * objects and never stores them.
 */

export const FILES_DRAG_TYPE = 'Files'

export interface FileDragItem {
  readonly kind: string
  readonly type?: string
  getAsFile?(): File | null
  webkitGetAsEntry?(): { isDirectory: boolean; isFile: boolean } | null
}

export interface FileDragData {
  readonly items?: ArrayLike<FileDragItem>
  readonly files?: ArrayLike<File>
  readonly types?: ArrayLike<string> | readonly string[]
}

function listTypes(types: FileDragData['types']): string[] {
  return types ? Array.from(types) : []
}

function entryIsDirectory(item: FileDragItem): boolean {
  if (typeof item.webkitGetAsEntry !== 'function') return false
  try {
    return item.webkitGetAsEntry()?.isDirectory === true
  } catch {
    return false
  }
}

/** True when the in-flight drag carries at least one `kind === 'file'` item. */
export function isFileDrag(data: FileDragData | null | undefined): boolean {
  if (!data) return false
  if (data.items && data.items.length > 0) {
    return Array.from(data.items).some((item) => item.kind === 'file')
  }
  return listTypes(data.types).includes(FILES_DRAG_TYPE)
}

/**
 * Copy ordinary files from a drop DataTransfer before any await.
 * Directories are skipped; MIME is not used as a compatibility filter.
 */
export function extractDroppedFiles(data: FileDragData | null | undefined): File[] {
  if (!data) return []
  if (data.items && data.items.length > 0) {
    const files: File[] = []
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file' || entryIsDirectory(item)) continue
      const file = item.getAsFile?.() ?? null
      if (file) files.push(file)
    }
    return files
  }
  return data.files ? Array.from(data.files) : []
}

export function isEditorFileDropTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('.media-pool')) return true
  const lane = target.closest('.timeline-track')
  return lane instanceof HTMLElement && lane.dataset.trackLocked !== 'true'
}
