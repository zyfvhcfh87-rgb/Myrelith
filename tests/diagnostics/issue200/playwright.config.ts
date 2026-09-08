import { defineConfig } from '@playwright/test'
import frozen from '../../../playwright.issue200.config'
import { resolve } from 'node:path'

const artifacts = process.env.ISSUE200_DIAGNOSTIC_ARTIFACTS
if (!artifacts || !artifacts.startsWith('/private/tmp/issue200-')) throw new Error('Set a fresh /private/tmp/issue200-* artifact directory')
export default defineConfig({
  ...frozen, testDir: '.', testMatch: 'diagnostic.spec.ts', maxFailures: 1,
  outputDir: resolve(artifacts, 'results'), reporter: [['list'], ['json', { outputFile: resolve(artifacts, 'playwright-report.json') }]],
  // Lossless raw samples plus full metadata replace a trace containing ~140 MB of binding payloads.
  use: { ...frozen.use, trace: 'off' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5200 --strictPort', url: 'http://127.0.0.1:5200', reuseExistingServer: false,
    cwd: process.cwd(), gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
})
