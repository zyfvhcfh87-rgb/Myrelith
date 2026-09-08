import { defineConfig } from '@playwright/test'
import base from './playwright.config'

const url = 'http://127.0.0.1:5198'
export default defineConfig({
  ...base,
  testMatch: 'issue-198-static-mask.spec.ts',
  outputDir: '.tmp/playwright-issue198',
  use: { ...base.use, baseURL: url },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5198 --strictPort',
    url, reuseExistingServer: false, timeout: 120_000,
  },
})
