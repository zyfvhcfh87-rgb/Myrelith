/** Browser-only Issue #77 gate: the audited archive crosses the real app boundary. */

import {
  createPluginAppAcceptanceSession,
  type PluginAppFile,
} from '../../app/pluginAppController'
import { createPluginLifecycleEvidence, type PluginLifecycleEvidence } from './pluginLifecycleEvidence'

const SAMPLE_PLUGIN_ID = 'com.myrelith.sample.audited-invert'

export interface PluginAcceptanceEvidence {
  readonly pluginId: string
  readonly packageDigest: string
  readonly signerFingerprint: string
  readonly contributionCount: number
  readonly lifecycle: PluginLifecycleEvidence
}

function archiveFile(bytes: ArrayBuffer): PluginAppFile {
  const owned = bytes.slice(0)
  return Object.freeze({
    size: owned.byteLength,
    arrayBuffer: async () => owned.slice(0),
  })
}

export async function runPluginAcceptanceBrowserGate(
  archiveBytes: ArrayBuffer,
): Promise<PluginAcceptanceEvidence> {
  const lifecycle = createPluginLifecycleEvidence()
  const acceptance = createPluginAppAcceptanceSession(lifecycle.observer)
  try {
    const review = await acceptance.controller.inspectFile(archiveFile(archiveBytes))
    if (review.id !== SAMPLE_PLUGIN_ID || review.signatureState !== 'valid') {
      throw new Error('The app-owned inspection did not accept the audited sample identity')
    }
    await acceptance.controller.installPlugin({
      reviewToken: review.reviewToken,
      trustSigner: true,
      grantedPermissionIds: review.permissions.filter((permission) => permission.required).map((permission) => permission.id),
      confirmDowngrade: false,
      confirmSameVersionReplacement: false,
    })
    const catalog = await acceptance.exportFacade.getDeclarationCatalog()
    const declaration = catalog.declarations.find((candidate) => candidate.pluginId === SAMPLE_PLUGIN_ID)
    if (!declaration || declaration.availability !== 'ready') {
      throw new Error('The installed audited sample is absent from the ready app-owned declaration catalog')
    }
    await acceptance.exportFacade.preflightAndCloseExport({
      requiredEffects: [Object.freeze({
        catalogGeneration: catalog.generation,
        pluginId: declaration.pluginId,
        pluginVersion: declaration.pluginVersion,
        packageDigest: declaration.packageDigest,
        signerFingerprint: declaration.signerFingerprint,
        kind: declaration.kind,
        contributionId: declaration.contributionId,
        contributionVersion: declaration.contributionVersion,
        descriptorVersion: declaration.descriptorVersion,
        entrypoint: declaration.entrypoint,
        maximumSurfaceWidth: 1,
        maximumSurfaceHeight: 1,
        maximumSurfaceStride: 4,
        maximumSurfaceByteLength: 4,
      })],
    })
    await acceptance.controller.uninstallPlugin(SAMPLE_PLUGIN_ID)
    await acceptance.close('issue77-browser-gate-complete')
    return Object.freeze({
      pluginId: review.id,
      packageDigest: review.packageDigest,
      signerFingerprint: review.signerFingerprint,
      contributionCount: catalog.declarations.length,
      lifecycle: lifecycle.assertTerminal(),
    })
  } catch (cause) {
    await acceptance.close('issue77-browser-gate-failed').catch(() => {})
    throw cause
  }
}
