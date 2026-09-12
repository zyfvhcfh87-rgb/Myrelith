/** On-disk sizes for the already-shipped lazy decoder payloads. */

import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const TARGETS = Object.freeze([
  Object.freeze({
    id: 'ac3',
    packageName: '@mediabunny/ac3',
    license: 'MPL-2.0 wrapper; inlined FFmpeg LGPL 2.1+ WASM',
    notes: 'Decode is wired. Encoder exists in the package and must stay unwired.',
  }),
  Object.freeze({
    id: 'prores',
    packageName: '@mediabunny/prores',
    license: 'MPL-2.0',
    notes: 'Decode-only. TurboRes is a separate MPL-2.0 payload.',
  }),
  Object.freeze({
    id: 'turbores',
    packageName: 'turbores',
    license: 'MPL-2.0',
    notes: 'ProRes WASM helper. Shared-memory threads need COOP/COEP; product uses the slower path.',
  }),
])

function walkFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walkFiles(path, files)
    else files.push(path)
  }
  return files
}

export function measureDecoderPayloads(root = process.cwd()) {
  const measured = []
  for (const target of TARGETS) {
    const directory = resolve(root, 'node_modules', target.packageName)
    const files = walkFiles(directory).map((path) => ({
      path: path.slice(root.length + 1),
      bytes: statSync(path).size,
    }))
    const bundle = files
      .filter((file) => /dist\/bundles\/.*\.(mjs|js)$/.test(file.path) && !file.path.includes('.min.'))
      .sort((left, right) => right.bytes - left.bytes)[0] ?? null
    measured.push({
      ...target,
      directory: directory.slice(root.length + 1),
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      primaryBundle: bundle,
    })
  }
  return {
    reference: {
      acceptableLazyAudioFallbackBytes: 1_200_000,
      rejectedConverterCoreBytes: 32_232_419,
    },
    payloads: measured,
  }
}
