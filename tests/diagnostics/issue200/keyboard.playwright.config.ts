import { defineConfig } from '@playwright/test'
import frozen from '../../../playwright.issue200.config'
import { resolve } from 'node:path'
const artifacts = process.env.ISSUE200_KEYBOARD_ARTIFACTS
if (!artifacts?.startsWith('/private/tmp/issue200-')) throw new Error('Set a fresh /private/tmp/issue200-* artifact directory')
export default defineConfig({ ...frozen, testDir: '.', testMatch: 'keyboard.gate.ts', maxFailures: 1, timeout: 60000,
  use: { ...frozen.use, trace: 'on', screenshot: 'only-on-failure' },
  outputDir: resolve(artifacts, 'results'), reporter: [['list'], ['json', { outputFile: resolve(artifacts, 'playwright-report.json') }]],
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5200 --strictPort', url: 'http://127.0.0.1:5200', reuseExistingServer: false,
    cwd: process.cwd(), gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 } },
})
