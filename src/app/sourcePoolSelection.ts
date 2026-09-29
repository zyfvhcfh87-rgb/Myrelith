/**
 * The Media Pool asset that Source Monitor commands open. It lives apart from
 * the Source Monitor runtime so project teardown can clear it without loading
 * source playback; sourceMonitorController re-exports it as the public facade.
 */

let selectedPoolAssetId: string | null = null

export function getSelectedPoolAssetId(): string | null {
  return selectedPoolAssetId
}

export function setSelectedPoolAssetId(assetId: string | null): void {
  selectedPoolAssetId = assetId
}

export function clearSelectedPoolAssetId(): void {
  selectedPoolAssetId = null
}
