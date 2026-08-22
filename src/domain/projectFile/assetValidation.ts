
import { isProceduralTextAssetId } from '../textOverlay';
import { mediaCollectionNameKey, normalizeMediaCollectionName, type MediaCollection } from '../mediaCollections';
import { PROJECT_FILE_LIMITS, type PortableAssetDescriptor } from './projectTypes';
import { booleanValue, boundedArray, exactKeys, fail, record, safeInteger, stringValue, validateMediaSourceBounds, validateNullableFrameRate, validateNullableSafeInteger } from './validationPrimitives';

export function validateAsset(value: unknown, path: string): asserts value is PortableAssetDescriptor {
  const asset = record(value, path)
  exactKeys(
    asset,
    [
      'id',
      'fileName',
      'mimeType',
      'size',
      'lastModified',
      'kind',
      'durationMicroseconds',
      'sourceBounds',
      'nativeFrameRate',
      'width',
      'height',
      'hasAudio',
      'audioSampleRate',
      'audioChannels',
    ],
    ['partialTrackSelection'],
    path,
  )
  stringValue(asset.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
  if (isProceduralTextAssetId(asset.id)) {
    fail(`${path}.id`, 'procedural text ids cannot be media asset ids')
  }
  stringValue(asset.fileName, `${path}.fileName`, PROJECT_FILE_LIMITS.maxFileNameCharacters)
  stringValue(asset.mimeType, `${path}.mimeType`, PROJECT_FILE_LIMITS.maxMimeTypeCharacters, true)
  safeInteger(asset.size, `${path}.size`, 0)
  safeInteger(asset.lastModified, `${path}.lastModified`, 0)
  if (asset.kind !== 'video' && asset.kind !== 'audio' && asset.kind !== 'image') {
    fail(`${path}.kind`, 'expected video, audio, or image')
  }
  if (
    asset.partialTrackSelection !== undefined
    && asset.partialTrackSelection !== 'video-only'
    && asset.partialTrackSelection !== 'audio-only'
  ) {
    fail(`${path}.partialTrackSelection`, 'expected video-only or audio-only')
  }
  safeInteger(asset.durationMicroseconds, `${path}.durationMicroseconds`, 0)
  validateMediaSourceBounds(asset.sourceBounds, `${path}.sourceBounds`)
  for (const [kind, bounds] of Object.entries(asset.sourceBounds)) {
    if (
      bounds?.status === 'exact'
      && bounds.endTimestampUs > asset.durationMicroseconds
    ) {
      fail(
        `${path}.sourceBounds.${kind}.endTimestampUs`,
        'cannot exceed the asset duration endpoint',
      )
    }
  }
  validateNullableFrameRate(asset.nativeFrameRate, `${path}.nativeFrameRate`)
  validateNullableSafeInteger(asset.width, `${path}.width`, 1, PROJECT_FILE_LIMITS.maxDimension)
  validateNullableSafeInteger(asset.height, `${path}.height`, 1, PROJECT_FILE_LIMITS.maxDimension)
  booleanValue(asset.hasAudio, `${path}.hasAudio`)
  validateNullableSafeInteger(
    asset.audioSampleRate,
    `${path}.audioSampleRate`,
    1,
    PROJECT_FILE_LIMITS.maxAudioSampleRate,
  )
  validateNullableSafeInteger(
    asset.audioChannels,
    `${path}.audioChannels`,
    1,
    PROJECT_FILE_LIMITS.maxAudioChannels,
  )

  const dimensionsBothNull = asset.width === null && asset.height === null
  const dimensionsBothPresent = asset.width !== null && asset.height !== null
  if (!dimensionsBothNull && !dimensionsBothPresent) {
    fail(path, 'width and height must both be present or both be null')
  }
  if (asset.kind === 'audio' && !dimensionsBothNull) {
    fail(path, 'audio-only assets cannot have visual dimensions')
  }
  if (asset.kind === 'image' && !dimensionsBothPresent) {
    fail(path, 'image assets require dimensions')
  }
  if (asset.kind !== 'video' && asset.nativeFrameRate !== null) {
    fail(path, 'only video assets may have a native frame rate')
  }
  if (asset.kind === 'audio' && !asset.hasAudio) {
    fail(path, 'audio assets must contain audio')
  }
  if (
    asset.partialTrackSelection === 'video-only'
    && (asset.kind !== 'video' || asset.hasAudio)
  ) {
    fail(path, 'video-only imports must be video assets without audio')
  }
  if (
    asset.partialTrackSelection === 'audio-only'
    && asset.kind !== 'audio'
  ) {
    fail(path, 'audio-only imports must be audio assets')
  }
  const audioMetadataPresent = asset.audioSampleRate !== null && asset.audioChannels !== null
  if (asset.hasAudio !== audioMetadataPresent) {
    fail(path, 'audio metadata must match hasAudio')
  }
  if (asset.kind === 'image' && (asset.sourceBounds.video !== null || asset.sourceBounds.audio !== null)) {
    fail(path, 'image assets cannot have timed source bounds')
  }
  if (asset.kind === 'video' && asset.sourceBounds.video === null) {
    fail(path, 'video assets require video source bounds')
  }
  if (asset.kind === 'audio' && asset.sourceBounds.video !== null) {
    fail(path, 'audio assets cannot have video source bounds')
  }
  if (asset.hasAudio !== (asset.sourceBounds.audio !== null)) {
    fail(path, 'audio source bounds must match hasAudio')
  }
}

export function validateMediaCollections(
  value: unknown,
  assetIds: ReadonlySet<string>,
): asserts value is MediaCollection[] {
  boundedArray(value, '$.collections', PROJECT_FILE_LIMITS.maxCollections)
  const collectionIds = new Set<string>()
  const collectionNames = new Set<string>()
  let totalMemberships = 0
  for (let index = 0; index < value.length; index++) {
    const path = `$.collections[${index}]`
    const collection = record(value[index], path)
    exactKeys(collection, ['id', 'name', 'assetIds'], [], path)
    stringValue(collection.id, `${path}.id`, PROJECT_FILE_LIMITS.maxIdCharacters)
    if (collection.id.trim().length === 0) {
      fail(`${path}.id`, 'must not be empty')
    }
    stringValue(
      collection.name,
      `${path}.name`,
      PROJECT_FILE_LIMITS.maxCollectionNameCharacters,
    )
    const normalizedName = normalizeMediaCollectionName(collection.name)
    if (normalizedName.length === 0) {
      fail(`${path}.name`, 'must not be empty')
    }
    if (normalizedName !== collection.name) {
      fail(`${path}.name`, 'must use normalized non-empty spacing')
    }
    if (collectionIds.has(collection.id)) {
      fail(`${path}.id`, 'duplicate collection id')
    }
    const nameKey = mediaCollectionNameKey(collection.name)
    if (collectionNames.has(nameKey)) {
      fail(`${path}.name`, 'duplicate collection name')
    }
    collectionIds.add(collection.id)
    collectionNames.add(nameKey)
    boundedArray(
      collection.assetIds,
      `${path}.assetIds`,
      PROJECT_FILE_LIMITS.maxCollectionMemberships,
    )
    const membershipIds = new Set<string>()
    for (let assetIndex = 0; assetIndex < collection.assetIds.length; assetIndex++) {
      const membershipPath = `${path}.assetIds[${assetIndex}]`
      const assetId = collection.assetIds[assetIndex]
      stringValue(assetId, membershipPath, PROJECT_FILE_LIMITS.maxIdCharacters)
      if (!assetIds.has(assetId)) fail(membershipPath, 'unknown media asset id')
      if (membershipIds.has(assetId)) fail(membershipPath, 'duplicate media asset id')
      membershipIds.add(assetId)
    }
    totalMemberships += collection.assetIds.length
    if (totalMemberships > PROJECT_FILE_LIMITS.maxTotalCollectionMemberships) {
      fail(
        '$.collections',
        `exceeds ${PROJECT_FILE_LIMITS.maxTotalCollectionMemberships} memberships in total`,
      )
    }
  }
}
