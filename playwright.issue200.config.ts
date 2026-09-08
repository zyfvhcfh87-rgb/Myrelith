import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/browser', testMatch: 'issue-200-*.spec.ts', fullyParallel: false, workers: 1, retries: 0,
  reporter: 'list', outputDir: '.tmp/issue200-browser', timeout: 120_000,
  use: { baseURL: 'http://127.0.0.1:5200', headless: true, launchOptions: { args: ['--mute-audio'] },
    viewport: { width: 1280, height: 720 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } }],
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5200 --strictPort', url: 'http://127.0.0.1:5200', reuseExistingServer: false },
})
