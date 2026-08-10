import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('Docker build context', () => {
  test('is allowlisted so private local files are never sent to a builder', () => {
    const rules = readFileSync(resolve(process.cwd(), '.dockerignore'), 'utf8')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))

    expect(rules).toEqual([
      '**',
      '!package.json',
      '!package-lock.json',
      '!patches',
      '!patches/**',
      '!public',
      '!public/**',
      '!src',
      '!src/**',
      '!index.html',
      '!tsconfig.json',
      '!tsconfig.app.json',
      '!tsconfig.node.json',
      '!vite.config.ts',
      '!nginx.conf',
    ])
  })
})
